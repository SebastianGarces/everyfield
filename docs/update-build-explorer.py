#!/usr/bin/env python3
"""Maintain evidence-backed explorer progress. Python standard library only."""

import argparse
import copy
import datetime as dt
import fcntl
import hashlib
import json
import os
from pathlib import Path
import re
import sys
import tempfile
from html.parser import HTMLParser


STATES = {"not_started", "in_progress", "blocked", "done"}
RESULTS = {"passed", "failed", "not_run", "in_progress"}
PACKAGE_FIELDS = {"status", "evidence", "notes", "owner", "revision", "updated_at"}
PATCH_FIELDS = {"schema_version", "package_id", "base_revision", "status",
                "evidence", "notes", "updated_by", "updated_at"}
EVIDENCE_FIELDS = {"path", "commit", "test", "result", "note"}
ROOT_FIELDS = {"schema_version", "project_id", "revision", "updated_at", "packages"}
HTML_NAME = "everyfield-build-explorer.html"
SCRIPT_RE = re.compile(r"<script\b(?P<attrs>[^>]*)>(?P<body>.*?)</script\s*>",
                       re.IGNORECASE | re.DOTALL)


class Invalid(Exception):
    pass


def require(condition, message):
    if not condition:
        raise Invalid(message)


def integer(value):
    return isinstance(value, int) and not isinstance(value, bool) and value >= 0


def string(value, label, limit=8000, nonempty=False):
    require(isinstance(value, str) and len(value) <= limit, f"{label}: expected a bounded string")
    require(not nonempty or bool(value.strip()), f"{label}: must not be blank")
    return value.strip()


def meaningful(value):
    # A reference plus a short explanation, or a named actual test result, is required.
    return len(value.strip()) >= 12 and len(value.strip().split()) >= 2


def timestamp(value, label):
    string(value, label, 64, nonempty=True)
    try:
        if re.fullmatch(r"\d{4}-\d{2}-\d{2}", value):
            return dt.datetime.combine(dt.date.fromisoformat(value), dt.time(), dt.timezone.utc)
        require(bool(re.fullmatch(r"\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,6})?(?:Z|[+-]\d{2}:\d{2})", value)),
                f"{label}: use ISO date or timezone-aware ISO timestamp")
        result = dt.datetime.fromisoformat(value.replace("Z", "+00:00"))
        require(result.tzinfo is not None, f"{label}: timezone required")
        return result.astimezone(dt.timezone.utc)
    except ValueError as exc:
        raise Invalid(f"{label}: invalid date or timestamp") from exc


def confined(root, relative):
    path = root / relative
    require(path.resolve().is_relative_to(root), f"path escapes --root: {relative}")
    cursor = path
    while cursor != root:
        require(not cursor.is_symlink(), f"symlink is not permitted: {relative}")
        cursor = cursor.parent
    return path


def read_bytes(path, limit=16 * 1024 * 1024):
    require(path.is_file(), f"missing file: {path}")
    require(path.stat().st_size <= limit, f"file exceeds size limit: {path}")
    return path.read_bytes()


def json_value(raw, label):
    def unique(pairs):
        result = {}
        for key, value in pairs:
            require(key not in result, f"{label}: duplicate JSON key {key}")
            result[key] = value
        return result
    try:
        return json.loads(raw, object_pairs_hook=unique,
                          parse_constant=lambda value: (_ for _ in ()).throw(Invalid(f"{label}: invalid number {value}")))
    except (ValueError, UnicodeError) as exc:
        raise Invalid(f"{label}: invalid JSON") from exc


def load_dag(root):
    value = json_value(read_bytes(confined(root, "docs/plan/dag.json")), "DAG")
    require(isinstance(value, dict) and isinstance(value.get("packages"), list), "DAG: packages array required")
    require(0 < len(value["packages"]) <= 1000, "DAG: invalid package count")
    packages = {}
    for package in value["packages"]:
        require(isinstance(package, dict), "DAG: package must be an object")
        key = package.get("id")
        require(isinstance(key, str) and bool(re.fullmatch(r"WP-\d{3}", key)), "DAG: invalid package ID")
        require(key not in packages, f"DAG: duplicate {key}")
        deps = package.get("depends_on")
        require(isinstance(deps, list) and all(isinstance(dep, str) for dep in deps), f"DAG: {key} dependencies must be IDs")
        require(len(set(deps)) == len(deps), f"DAG: duplicate prerequisite for {key}")
        packages[key] = package
    for key, package in packages.items():
        require(all(dep in packages and dep != key for dep in package["depends_on"]), f"DAG: unknown/self prerequisite for {key}")
    remaining, visited = set(packages), set()
    while remaining:
        ready = {key for key in remaining if set(packages[key]["depends_on"]) <= visited}
        require(bool(ready), "DAG: prerequisite cycle")
        remaining -= ready
        visited |= ready
    return packages


def validate_evidence(value, status, label):
    require(isinstance(value, list) and len(value) <= 100, f"{label}: evidence must be a bounded array")
    referenced, done_evidence = False, False
    for index, row in enumerate(value):
        here = f"{label}[{index}]"
        require(isinstance(row, dict) and set(row) == EVIDENCE_FIELDS, f"{here}: expected path, commit, test, result, note")
        fields = {key: string(item, f"{here}.{key}") for key, item in row.items()}
        require(fields["result"] in RESULTS, f"{here}: invalid result")
        if fields["path"]:
            parts = fields["path"].split("/")
            require(not fields["path"].startswith(("/", "~")) and ".." not in parts
                    and not re.match(r"^[A-Za-z][A-Za-z0-9+.-]*:", fields["path"])
                    and "\\" not in fields["path"], f"{here}.path: use a repository-relative reference")
        has_reference = bool(fields["path"] or fields["commit"] or fields["test"])
        has_result = bool(fields["test"]) and fields["result"] in {"passed", "failed", "in_progress"}
        referenced |= has_reference and (meaningful(fields["note"]) or has_result)
        done_evidence |= bool(fields["path"] or fields["commit"]) and bool(fields["test"]) \
            and fields["result"] == "passed" and meaningful(fields["note"])
    if status != "not_started":
        require(referenced, f"{label}: {status} needs a reference and meaningful note or named actual test result")
    if status == "done":
        require(done_evidence, f"{label}: done needs substantive path/commit, named passed test, and explanatory note together")


def validate_progress(value, dag):
    require(isinstance(value, dict) and ROOT_FIELDS <= set(value)
            and set(value) <= ROOT_FIELDS | {"applied_patches"}, "progress: unexpected or missing fields")
    require(type(value["schema_version"]) is int and value["schema_version"] == 1, "progress: schema_version must be 1")
    require(value["project_id"] == "everyfield-v3", "progress: wrong project_id")
    require(integer(value["revision"]), "progress: invalid revision")
    updated = timestamp(value["updated_at"], "progress.updated_at")
    require(isinstance(value["packages"], dict) and set(value["packages"]) == set(dag), "progress: package IDs must exactly match DAG")
    for key, package in value["packages"].items():
        label = f"progress.{key}"
        require(isinstance(package, dict) and set(package) == PACKAGE_FIELDS, f"{label}: unexpected or missing fields")
        require(package["status"] in STATES, f"{label}: invalid status")
        string(package["notes"], f"{label}.notes")
        require(package["owner"] is None or bool(string(package["owner"], f"{label}.owner", 256, True)), f"{label}: invalid owner")
        require(integer(package["revision"]) and package["revision"] <= value["revision"], f"{label}: invalid revision")
        if package["updated_at"] is not None:
            require(timestamp(package["updated_at"], f"{label}.updated_at") <= updated, f"{label}: timestamp exceeds project timestamp")
        if package["revision"] > 0:
            require(package["updated_at"] is not None and package["owner"] is not None, f"{label}: updated package needs owner and timestamp")
        validate_evidence(package["evidence"], package["status"], f"{label}.evidence")
        if package["status"] == "done":
            require(all(value["packages"][dep]["status"] == "done" for dep in dag[key]["depends_on"]),
                    f"{label}: direct prerequisites must be done")
    applied = value.get("applied_patches", {})
    require(isinstance(applied, dict), "progress.applied_patches: expected SHA-256 map")
    for sha, record in applied.items():
        require(bool(re.fullmatch(r"[0-9a-f]{64}", sha)), "progress.applied_patches: invalid SHA-256")
        require(isinstance(record, dict) and set(record) == {"package_id", "package_revision"}, "progress.applied_patches: invalid record")
        require(record["package_id"] in dag and integer(record["package_revision"])
                and 0 < record["package_revision"] <= value["packages"][record["package_id"]]["revision"], "progress.applied_patches: invalid package revision")


class Tag(HTMLParser):
    def __init__(self):
        super().__init__()
        self.attrs = {}

    def handle_starttag(self, tag, attrs):
        self.attrs = dict(attrs)


def html_parts(raw, dag):
    try:
        source = raw.decode("utf-8")
    except UnicodeError as exc:
        raise Invalid("HTML must be UTF-8") from exc
    found = {}
    for match in SCRIPT_RE.finditer(source):
        tag = Tag()
        tag.feed("<script" + match["attrs"] + ">")
        require("src" not in tag.attrs, "HTML must keep all scripts inline")
        key = tag.attrs.get("id")
        if key in {"canonical-data", "canonical-progress", "embedded-local-state"}:
            require(key not in found, f"HTML: duplicate script {key}")
            require(tag.attrs.get("type", "").lower() == "application/json", f"HTML: {key} must be application/json")
            found[key] = match
    require(set(found) == {"canonical-data", "canonical-progress", "embedded-local-state"}, "HTML: required JSON scripts missing")
    data = json_value(found["canonical-data"]["body"], "HTML canonical-data")
    require(isinstance(data, dict) and isinstance(data.get("packages"), list), "HTML: canonical-data packages required")
    graph = {}
    for package in data["packages"]:
        require(isinstance(package, dict) and isinstance(package.get("id"), str), "HTML: invalid graph package")
        key = package["id"]
        require(key not in graph, f"HTML: duplicate graph package {key}")
        graph[key] = package.get("depends_on")
    require(set(graph) == set(dag), "HTML: DAG package IDs differ")
    require(all(graph[key] == dag[key]["depends_on"] for key in dag), "HTML: DAG prerequisites differ")
    return source, found


def render_html(source, parts, progress):
    encoded = json.dumps(progress, ensure_ascii=True, indent=2).replace("<", "\\u003c").replace(">", "\\u003e").replace("&", "\\u0026")
    replacements = [(parts["canonical-progress"].span("body"), "\n" + encoded + "\n"),
                    (parts["embedded-local-state"].span("body"), "{}")]
    for (start, end), replacement in sorted(replacements, reverse=True):
        source = source[:start] + replacement + source[end:]
    return source.encode("utf-8")


def candidate_progress(root, progress, dag):
    folder = confined(root, "docs/build-progress-updates")
    if not folder.exists():
        return progress, 0, 0
    require(folder.is_dir(), "build-progress-updates must be a directory")
    candidate = copy.deepcopy(progress)
    fresh, skipped = [], 0
    for path in sorted(folder.glob("*.json")):
        path = confined(root, path.relative_to(root))
        require(bool(re.fullmatch(r"WP-\d{3}\.json", path.name)), f"patch: invalid filename {path.name}")
        raw = read_bytes(path, 1024 * 1024)
        sha = hashlib.sha256(raw).hexdigest()
        patch = json_value(raw, f"patch {path.name}")
        require(isinstance(patch, dict) and set(patch) == PATCH_FIELDS, f"patch {path.name}: unexpected or missing fields")
        require(type(patch["schema_version"]) is int and patch["schema_version"] == 1, f"patch {path.name}: schema_version must be 1")
        key = patch["package_id"]
        require(isinstance(key, str) and key in dag and path.name == key + ".json", f"patch {path.name}: unknown/mismatched package ID")
        require(integer(patch["base_revision"]), f"patch {key}: invalid base_revision")
        require(patch["status"] in STATES, f"patch {key}: invalid status")
        string(patch["notes"], f"patch {key}.notes")
        string(patch["updated_by"], f"patch {key}.updated_by", 256, True)
        patch_time = timestamp(patch["updated_at"], f"patch {key}.updated_at")
        validate_evidence(patch["evidence"], patch["status"], f"patch {key}.evidence")
        record = progress.get("applied_patches", {}).get(sha)
        if record is not None:
            require(record["package_id"] == key and record["package_revision"] == patch["base_revision"] + 1,
                    f"patch {key}: applied SHA record mismatch")
            skipped += 1
            continue
        current = progress["packages"][key]
        require(patch["base_revision"] == current["revision"], f"patch {key}: stale base_revision {patch['base_revision']}; current {current['revision']}")
        if current["updated_at"] is not None:
            require(patch_time >= timestamp(current["updated_at"], f"progress.{key}.updated_at"), f"patch {key}: timestamp moves backward")
        candidate["packages"][key] = {"status": patch["status"], "evidence": patch["evidence"], "notes": patch["notes"],
                                      "owner": patch["updated_by"], "revision": current["revision"] + 1,
                                      "updated_at": patch["updated_at"]}
        fresh.append((key, sha, patch["updated_at"]))
    if fresh:
        candidate["revision"] += 1
        candidate["updated_at"] = max([progress["updated_at"]] + [item[2] for item in fresh],
                                      key=lambda item: (timestamp(item, "updated_at"), item))
        applied = candidate.setdefault("applied_patches", {})
        for key, sha, _ in fresh:
            applied[sha] = {"package_id": key, "package_revision": candidate["packages"][key]["revision"]}
    validate_progress(candidate, dag)  # All dependency gates checked against the whole proposed batch.
    return candidate, len(fresh), skipped


def atomic_files(changes):
    staged = []
    try:
        for destination, content in changes:
            if destination.read_bytes() == content:
                continue
            with tempfile.NamedTemporaryFile(prefix=".build-progress-", dir=destination.parent, delete=False) as handle:
                temp = Path(handle.name)
                staged.append((temp, destination))
                handle.write(content)
                handle.flush()
                os.fsync(handle.fileno())
            os.chmod(temp, destination.stat().st_mode & 0o777)
        for temp, destination in staged:
            os.replace(temp, destination)
            descriptor = os.open(destination.parent, os.O_RDONLY)
            try:
                os.fsync(descriptor)
            finally:
                os.close(descriptor)
    finally:
        for temp, _ in staged:
            temp.unlink(missing_ok=True)


def run(args):
    root = Path(args.root).resolve(strict=True)
    require(root.is_dir(), "--root must be a project directory")
    lock = confined(root, "docs/.build-progress.lock")
    require(lock.parent.is_dir(), "--root/docs must exist")
    with lock.open("a+b") as handle:
        try:
            fcntl.flock(handle, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError as exc:
            raise Invalid("another integration owner holds docs/.build-progress.lock") from exc
        dag = load_dag(root)
        progress_path = confined(root, "docs/build-progress.json")
        progress = json_value(read_bytes(progress_path), "progress")
        validate_progress(progress, dag)
        html_path = confined(root, HTML_NAME)
        html_raw = read_bytes(html_path)
        source, parts = html_parts(html_raw, dag)
        if args.refresh_html:
            atomic_files([(html_path, render_html(source, parts, progress))])
            print(f"Refreshed {HTML_NAME} from canonical revision {progress['revision']}; embedded local state cleared.")
            return
        candidate, fresh, skipped = candidate_progress(root, progress, dag)
        if args.check:
            require(json_value(parts["canonical-progress"]["body"], "HTML canonical-progress") == progress, "HTML progress differs from canonical JSON; use --refresh-html")
            require(json_value(parts["embedded-local-state"]["body"], "HTML embedded-local-state") == {}, "source HTML contains local overrides; use --refresh-html")
            print(f"Valid: {len(dag)} packages; canonical/HTML revision {progress['revision']}; {fresh} pending, {skipped} previously applied patches.")
            return
        encoded = (json.dumps(candidate, ensure_ascii=True, indent=2) + "\n").encode("utf-8")
        # Publish canonical state first. If interrupted between replacements, --refresh-html repairs the view.
        changes = [(progress_path, encoded)] if fresh else []
        changes.append((html_path, render_html(source, parts, candidate)))
        atomic_files(changes)
        print(f"Applied {fresh} patches; skipped {skipped} previously applied; canonical/HTML revision {candidate['revision']}. Patches preserved.")


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--root", default=str(Path(__file__).resolve().parent.parent), help="project root (also supports a disposable fixture)")
    modes = parser.add_mutually_exclusive_group(required=True)
    modes.add_argument("--check", action="store_true", help="validate canonical state, HTML and all pending patches without applying")
    modes.add_argument("--apply", action="store_true", help="apply all valid pending package patches and refresh HTML")
    modes.add_argument("--refresh-html", action="store_true", help="refresh only the HTML progress JSON and clear embedded local overrides")
    args = parser.parse_args()
    try:
        run(args)
    except (Invalid, OSError, TypeError) as exc:
        print(f"ERROR: {exc}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
