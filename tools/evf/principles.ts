import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fail, loadConfig, run } from "./lib.ts";

type Upstream = { repo: string; path: string; prefix: string; ref: string; license?: string };
type LockEntry = { source?: string; sourceType?: string; upstreamCommit?: string; upstreamPath?: string; policy?: string; sha256?: string; [k: string]: unknown };
type TreeEntry = { path: string; type: string; sha: string };

function ghJson<T>(args: string[]): T {
  const r = run("gh", ["api", ...args]);
  if (r.code !== 0) fail(`gh api ${args.join(" ")} failed: ${(r.stderr || r.stdout).trim()}`);
  return JSON.parse(r.stdout) as T;
}

function blob(repo: string, sha: string): Buffer {
  const b = ghJson<{ content: string; encoding: string }>([`repos/${repo}/git/blobs/${sha}`]);
  return Buffer.from(b.content, b.encoding === "base64" ? "base64" : "utf8");
}

const sha256 = (data: Buffer | string) => createHash("sha256").update(data).digest("hex");

/** Compares local principle skills with upstream pstack; `apply` makes them identical. */
export function principles(root: string, opts: { apply: boolean; ref?: string }): number {
  const cfg = loadConfig(root) as ReturnType<typeof loadConfig> & { principles?: Upstream };
  const up = cfg.principles;
  if (!up) fail('evf.config.json has no "principles" upstream.');
  const commit = ghJson<{ sha: string; commit: { committer: { date: string } } }>([`repos/${up.repo}/commits/${opts.ref ?? up.ref}`]);
  const tree = ghJson<{ tree: TreeEntry[]; truncated: boolean }>([`repos/${up.repo}/git/trees/${commit.sha}?recursive=1`]);
  if (tree.truncated) fail("Upstream tree listing was truncated; sync by hand.");

  const base = `${up.path}/`;
  const files = tree.tree.filter((e) => e.type === "blob" && e.path.startsWith(`${base}${up.prefix}`));
  const upstreamSkills = new Map<string, TreeEntry[]>();
  for (const f of files) {
    const name = f.path.slice(base.length).split("/")[0];
    upstreamSkills.set(name, [...(upstreamSkills.get(name) ?? []), f]);
  }

  const skillsDir = join(root, ".agents/skills");
  const lockPath = join(root, "skills-lock.json");
  const lock = JSON.parse(readFileSync(lockPath, "utf8")) as { version: number; skills: Record<string, LockEntry> };
  const local = readdirSync(skillsDir).filter((n) => n.startsWith(up.prefix));

  const added = [...upstreamSkills.keys()].filter((n) => !local.includes(n));
  const removed = local.filter((n) => !upstreamSkills.has(n));
  const changed: string[] = [];
  const contents = new Map<string, Array<{ rel: string; data: Buffer }>>();
  for (const [name, entries] of upstreamSkills) {
    const got = entries.map((e) => ({ rel: e.path.slice(base.length + name.length + 1), data: blob(up.repo, e.sha) }));
    contents.set(name, got);
    if (added.includes(name)) continue;
    const differs = got.some(({ rel, data }) => {
      const f = join(skillsDir, name, rel);
      return !existsSync(f) || sha256(readFileSync(f)) !== sha256(data);
    });
    if (differs) changed.push(name);
  }

  console.log(`upstream: ${up.repo}/${up.path} at ${commit.sha.slice(0, 10)} (${commit.commit.committer.date})`);
  console.log(`  ${upstreamSkills.size} upstream, ${local.length} local`);
  for (const n of added) console.log(`  NEW      ${n}`);
  for (const n of changed) console.log(`  CHANGED  ${n}`);
  for (const n of removed) console.log(`  REMOVED  ${n} (gone upstream)`);
  if (!added.length && !changed.length && !removed.length) {
    console.log("  in sync");
    return 0;
  }
  if (!opts.apply) {
    console.log("Dry run. Apply with: bin/evf principles --apply");
    return 1;
  }

  for (const name of [...added, ...changed]) {
    rmSync(join(skillsDir, name), { recursive: true, force: true });
    for (const { rel, data } of contents.get(name) ?? []) {
      const f = join(skillsDir, name, rel);
      mkdirSync(dirname(f), { recursive: true });
      writeFileSync(f, data);
    }
  }
  for (const name of removed) {
    rmSync(join(skillsDir, name), { recursive: true, force: true });
    delete lock.skills[name];
  }
  for (const [name] of upstreamSkills) {
    lock.skills[name] = {
      source: `${up.repo} (${up.path}), MIT`,
      sourceType: "github",
      upstreamPath: `${up.path}/${name}`,
      upstreamCommit: commit.sha,
      policy: "verbatim: do not edit; update with `bin/evf principles --apply`; put EveryField rules in .agents/roles/ or workflow skills",
      sha256: sha256(readFileSync(join(skillsDir, name, "SKILL.md"))),
    };
  }
  lock.skills = Object.fromEntries(Object.entries(lock.skills).sort(([a], [b]) => a.localeCompare(b)));
  writeFileSync(lockPath, `${JSON.stringify(lock, null, 2)}\n`);

  if (up.license) {
    const lic = tree.tree.find((e) => e.path === up.license);
    if (lic) {
      const f = join(root, ".agents/licenses", `${up.license.split("/")[0]}-LICENSE`);
      mkdirSync(dirname(f), { recursive: true });
      writeFileSync(f, blob(up.repo, lic.sha));
    }
  }

  console.log("applied. Next:");
  if (added.length) console.log(`  - Add one line for each new principle to the AGENTS.md list: ${added.join(", ")}`);
  if (removed.length) console.log(`  - Remove ${removed.join(", ")} from AGENTS.md and the role files.`);
  console.log("  - Read the changed principles; adjust role files if a role's core list should change.");
  console.log("  - Run bin/evf doctor.");
  return 0;
}
