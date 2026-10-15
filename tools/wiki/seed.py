"""Seed byte/hash boundary. No database access; call through bin/wiki."""
import argparse
import hashlib
import json
import os
from pathlib import Path
import sys
from datetime import datetime, timezone


def digest(data):
    return hashlib.sha256(data).hexdigest()


def record(row):
    return digest(json.dumps(row, sort_keys=True, separators=(",", ":"), ensure_ascii=False).encode())


def formatted(value):
    # Proven byte-identical against the original payload before implementing promotion.
    return (json.dumps(value, sort_keys=True, indent=2, ensure_ascii=True) + "\n").encode()


def load(directory):
    payload_path = directory / "seed.json"
    manifest_path = directory / "manifest.json"
    return payload_path, manifest_path, json.loads(payload_path.read_bytes()), json.loads(manifest_path.read_bytes())


def check(directory, playbook, bootstrap):
    pp, mp, payload, manifest = load(directory)
    errors = []
    original_hash = "7933b93d693b73b3d8768aa2f7e2ad91fa665b6ec23127cb8b4856466d936f59"
    if digest(bootstrap.read_bytes()) != original_hash:
        errors.append("Original bootstrap payload SHA-256 mismatch")
    if manifest.get("derivedFrom") != {"path": "docs/reference/bootstrap/global-seed-payload.json", "sha256": original_hash}:
        errors.append("derivedFrom bootstrap provenance mismatch")
    if digest(pp.read_bytes()) != manifest["seedPayloadSHA256"]:
        errors.append("seedPayloadSHA256 mismatch")
    if digest(playbook.read_bytes()) != manifest["playbookSHA256"]:
        errors.append("playbookSHA256 mismatch")
    for group, key in [("articles", "id"), ("sections", "id"), ("templates", "name")]:
        entries = manifest[group]
        items = payload[group]
        for label, values in [("payload", items), ("manifest", entries)]:
            if len({r[key] for r in values}) != len(values):
                errors.append(f"duplicate {group} {key} in {label}")
            if group != "templates" and len({r["slug"] for r in values}) != len(values):
                errors.append(f"duplicate {group} slug in {label}")
        index = {r[key]: r for r in entries}
        if set(index) != {r[key] for r in items}:
            errors.append(f"{group} manifest membership mismatch")
        for row in items:
            entry = index.get(row[key])
            if entry is None:
                continue
            if group == "templates":
                # Original SYSTEM_TEMPLATES source order, documented in verification.json.
                order = ["name", "invitesMeetingType", "description", "category", "channel", "subject", "body", "mergeFields"]
                source = {k: row[k] for k in order if k in row}
                actual = digest(json.dumps(source, ensure_ascii=False, separators=(",", ":")).encode())
                if actual != entry["sha256"] or row["churchId"] is not None or row["isSystem"] is not True or row["sourceTemplateId"] is not None:
                    errors.append(f"template hash/scope mismatch: {row[key]}")
                if set(row) - set(order) - {"churchId", "isSystem", "sourceTemplateId"}:
                    errors.append(f"unknown template fields: {row[key]}")
            else:
                if record(row) != entry["recordSHA256"] or row["slug"] != entry["slug"]:
                    errors.append(f"{group} record/slug mismatch: {row[key]}")
                if group == "articles":
                    if digest(row["content"].encode()) != entry["contentSHA256"] or row["section_id"] != entry["sectionId"]:
                        errors.append(f"article content/section mismatch: {row[key]}")
                    if row["church_id"] is not None or row["status"] != "published":
                        errors.append(f"article scope mismatch: {row[key]}")
                elif row["parent_section_id"] != entry["parent"]:
                    errors.append(f"section parent mismatch: {row[key]}")
    sections = {r["id"]: r for r in payload["sections"]}
    for section in sections.values():
        parent = section["parent_section_id"]
        if parent is not None and (parent not in sections or not section["slug"].startswith(sections[parent]["slug"] + "/")):
            errors.append(f"section ancestry mismatch: {section['slug']}")
    for article in payload["articles"]:
        section = sections.get(article["section_id"])
        if not section or not article["slug"].startswith(section["slug"] + "/"):
            errors.append(f"article section path mismatch: {article['slug']}")
    if errors:
        raise ValueError("\n".join(errors))
    return len(payload["articles"])


def promote(args):
    directory = Path(args.seed_dir)
    check(directory, Path(args.playbook), Path(args.bootstrap))
    pp, mp, payload, manifest = load(directory)
    path = Path(args.draft)
    draft_bytes = path.read_bytes()
    if digest(draft_bytes) != args.draft_sha256:
        raise ValueError("Draft changed since lint/review comparison; nothing written")
    row = json.loads(draft_bytes)
    metadata = row.pop("draft")
    previous = next((a for a in payload["articles"] if a["id"] == row["id"]), None)
    if metadata["replaces_id"] is not None:
        if metadata["replaces_id"] != row["id"] or previous is None:
            raise ValueError("Replacement must retain an existing id")
    elif previous is not None:
        raise ValueError("New article id already exists")
    if any(a["slug"] == row["slug"] and a["id"] != row["id"] for a in payload["articles"]):
        raise ValueError("Article slug already exists")
    now = datetime.now(timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z")
    row.update(status="published", published_at=now, updated_at=now)
    if previous is None:
        payload["articles"].append(row)
    else:
        payload["articles"][payload["articles"].index(previous)] = row
    entry = {"id": row["id"], "slug": row["slug"], "sectionId": row["section_id"], "contentSHA256": digest(row["content"].encode()), "recordSHA256": record(row)}
    old_entry = next((a for a in manifest["articles"] if a["id"] == row["id"]), None)
    if old_entry is None:
        manifest["articles"].append(entry)
    else:
        manifest["articles"][manifest["articles"].index(old_entry)] = entry
    manifest.setdefault("releases", []).append({"id": row["id"], "slug": row["slug"], "previousRecordSHA256": record(previous) if previous else None, "recordSHA256": record(row), "approvedBy": args.approved_by, "pr": args.pr, "date": now})
    payload_bytes = formatted(payload)
    manifest["seedPayloadSHA256"] = digest(payload_bytes)
    # Stage both files before replacing either. Never write into the imported verification record.
    staged = []
    try:
        for target, data in [(pp, payload_bytes), (mp, formatted(manifest))]:
            temp = target.with_name(target.name + ".wiki-tmp")
            with temp.open("xb") as out:
                out.write(data)
                out.flush()
                os.fsync(out.fileno())
            staged.append((temp, target))
        for temp, target in staged:
            os.replace(temp, target)
        check(directory, Path(args.playbook), Path(args.bootstrap))
        path.unlink()
    finally:
        for temp, _ in staged:
            temp.unlink(missing_ok=True)
    print(f"Promoted {row['slug']}; recorded approval by {args.approved_by}, PR #{args.pr}")


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("command", choices=["check", "promote", "roundtrip"])
    parser.add_argument("--seed-dir", required=True)
    parser.add_argument("--playbook", required=True)
    parser.add_argument("--bootstrap", required=True)
    parser.add_argument("--draft")
    parser.add_argument("--draft-sha256")
    parser.add_argument("--approved-by")
    parser.add_argument("--pr", type=int)
    args = parser.parse_args()
    if args.command == "promote":
        promote(args)
    elif args.command == "roundtrip":
        pp, _, payload, _ = load(Path(args.seed_dir))
        before = pp.read_bytes()
        if formatted(payload) != before:
            raise ValueError("Payload round trip changed bytes")
        print(f"PASS byte-identical round trip: {len(before)} bytes, SHA-256 {digest(before)}")
    else:
        print(f"PASS check-seed: {check(Path(args.seed_dir), Path(args.playbook), Path(args.bootstrap))} articles; article, section, template, Playbook and payload hashes match")


if __name__ == "__main__":
    try:
        main()
    except (ValueError, KeyError, OSError, TypeError) as error:
        print(f"wiki: {error}", file=sys.stderr)
        sys.exit(1)
