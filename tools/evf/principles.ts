import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { evfDataDir, fail, loadConfig, requireWorktree, run, type TaskRef } from "./lib.ts";

type Upstream = { repo: string; path: string; prefix: string; ref: string; license?: string; checkEveryDays?: number };
type LockEntry = { source?: string; sourceType?: string; upstreamCommit?: string; upstreamPath?: string; policy?: string; sha256?: string; [k: string]: unknown };
type TreeEntry = { path: string; type: string; sha: string };

type Comparison = {
  commit: string;
  date: string;
  added: string[];
  changed: string[];
  removed: string[];
  skills: Map<string, TreeEntry[]>;
  tree: TreeEntry[];
};

export type CheckCache = { checkedAt: string; commit: string; added: string[]; changed: string[]; removed: string[] };

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

/** Git's blob ID for file content; matches the upstream tree entry when the bytes are equal. */
const gitBlobId = (data: Buffer) => createHash("sha1").update(`blob ${data.length}\0`).update(data).digest("hex");

function upstreamOf(root: string): Upstream {
  const up = (loadConfig(root) as ReturnType<typeof loadConfig> & { principles?: Upstream }).principles;
  if (!up) fail('evf.config.json has no "principles" upstream.');
  return up;
}

/** Two GitHub API calls, no file downloads: compares git blob IDs. */
function compare(root: string, up: Upstream, ref?: string): Comparison {
  const commit = ghJson<{ sha: string; commit: { committer: { date: string } } }>([`repos/${up.repo}/commits/${ref ?? up.ref}`]);
  const tree = ghJson<{ tree: TreeEntry[]; truncated: boolean }>([`repos/${up.repo}/git/trees/${commit.sha}?recursive=1`]);
  if (tree.truncated) fail("Upstream tree listing was truncated; sync by hand.");

  const base = `${up.path}/`;
  const skills = new Map<string, TreeEntry[]>();
  for (const f of tree.tree.filter((e) => e.type === "blob" && e.path.startsWith(`${base}${up.prefix}`))) {
    const name = f.path.slice(base.length).split("/")[0];
    skills.set(name, [...(skills.get(name) ?? []), f]);
  }

  const skillsDir = join(root, ".agents/skills");
  const local = readdirSync(skillsDir).filter((n) => n.startsWith(up.prefix));
  const added = [...skills.keys()].filter((n) => !local.includes(n));
  const removed = local.filter((n) => !skills.has(n));
  const changed = [...skills.entries()]
    .filter(([name]) => !added.includes(name))
    .filter(([name, entries]) =>
      entries.some((e) => {
        const f = join(skillsDir, name, e.path.slice(base.length + name.length + 1));
        return !existsSync(f) || gitBlobId(readFileSync(f)) !== e.sha;
      }),
    )
    .map(([name]) => name);
  return { commit: commit.sha, date: commit.commit.committer.date, added, changed, removed, skills, tree: tree.tree };
}

const cachePath = (root: string) => join(evfDataDir(root), "principles-check.json");

function saveCache(root: string, c: Comparison): void {
  mkdirSync(evfDataDir(root), { recursive: true });
  const cache: CheckCache = { checkedAt: new Date().toISOString(), commit: c.commit, added: c.added, changed: c.changed, removed: c.removed };
  writeFileSync(cachePath(root), `${JSON.stringify(cache, null, 2)}\n`);
}

/**
 * Throttled upstream check for `evf doctor`. Calls GitHub at most once per `checkEveryDays`
 * (default 7); otherwise returns the cached result. Never throws.
 */
export function principlesStatus(root: string): { level: "PASS" | "WARN"; message: string } {
  try {
    const up = upstreamOf(root);
    const days = up.checkEveryDays ?? 7;
    let cache: CheckCache | null = existsSync(cachePath(root)) ? (JSON.parse(readFileSync(cachePath(root), "utf8")) as CheckCache) : null;
    const age = cache ? (Date.now() - Date.parse(cache.checkedAt)) / 86_400_000 : Infinity;
    if (age >= days && process.env.EVF_OFFLINE !== "1") {
      saveCache(root, compare(root, up));
      cache = JSON.parse(readFileSync(cachePath(root), "utf8")) as CheckCache;
    }
    if (!cache) return { level: "WARN", message: "principles: never checked against upstream (EVF_OFFLINE=1)" };
    const when = cache.checkedAt.slice(0, 10);
    const n = cache.added.length + cache.changed.length + cache.removed.length;
    if (n === 0) return { level: "PASS", message: `principles match ${up.repo} ${up.path} (checked ${when}, every ${days} days)` };
    return {
      level: "WARN",
      message: `principles are behind upstream: ${cache.added.length} new, ${cache.changed.length} changed, ${cache.removed.length} removed (checked ${when}). Plan an OPS task, then run: bin/evf principles --apply OPS-<n>`,
    };
  } catch (e) {
    return { level: "WARN", message: `principles: upstream check failed (${e instanceof Error ? e.message.slice(0, 120) : "unknown"}); will retry next run` };
  }
}

/** Compares principle skills with upstream pstack; `apply` makes the task worktree's copy identical. */
export function principles(home: string, opts: { apply: boolean; ref?: string; task?: TaskRef }): number {
  if (opts.apply && !opts.task) fail("Give the maintenance task: evf principles --apply OPS-<n>. It writes into that task's worktree, never the home checkout.");
  const root = opts.task ? requireWorktree(home, loadConfig(home), opts.task) : home;
  const up = upstreamOf(root);
  const c = compare(root, up, opts.ref);
  saveCache(root, c);
  const skillsDir = join(root, ".agents/skills");
  const base = `${up.path}/`;

  console.log(`upstream: ${up.repo}/${up.path} at ${c.commit.slice(0, 10)} (${c.date})`);
  console.log(`  ${c.skills.size} upstream`);
  for (const n of c.added) console.log(`  NEW      ${n}`);
  for (const n of c.changed) console.log(`  CHANGED  ${n}`);
  for (const n of c.removed) console.log(`  REMOVED  ${n} (gone upstream)`);
  if (!c.added.length && !c.changed.length && !c.removed.length) {
    console.log("  in sync");
    return 0;
  }
  if (!opts.apply) {
    console.log("Dry run. In a registered OPS task, apply with: bin/evf principles --apply OPS-<n>");
    return 1;
  }

  for (const name of [...c.added, ...c.changed]) {
    rmSync(join(skillsDir, name), { recursive: true, force: true });
    for (const e of c.skills.get(name) ?? []) {
      const f = join(skillsDir, name, e.path.slice(base.length + name.length + 1));
      mkdirSync(dirname(f), { recursive: true });
      writeFileSync(f, blob(up.repo, e.sha));
    }
  }
  const lockPath = join(root, "skills-lock.json");
  const lock = JSON.parse(readFileSync(lockPath, "utf8")) as { version: number; skills: Record<string, LockEntry> };
  for (const name of c.removed) {
    rmSync(join(skillsDir, name), { recursive: true, force: true });
    delete lock.skills[name];
  }
  for (const [name] of c.skills) {
    lock.skills[name] = {
      source: `${up.repo} (${up.path}), MIT`,
      sourceType: "github",
      upstreamPath: `${up.path}/${name}`,
      upstreamCommit: c.commit,
      policy: "verbatim: do not edit; update with `bin/evf principles --apply`; put EveryField rules in .agents/roles/ or workflow skills",
      sha256: sha256(readFileSync(join(skillsDir, name, "SKILL.md"))),
    };
  }
  lock.skills = Object.fromEntries(Object.entries(lock.skills).sort(([a], [b]) => a.localeCompare(b)));
  writeFileSync(lockPath, `${JSON.stringify(lock, null, 2)}\n`);

  if (up.license) {
    const lic = c.tree.find((e) => e.path === up.license);
    if (lic) {
      const f = join(root, ".agents/licenses", `${up.license.split("/")[0]}-LICENSE`);
      mkdirSync(dirname(f), { recursive: true });
      writeFileSync(f, blob(up.repo, lic.sha));
    }
  }
  saveCache(root, compare(root, up, c.commit));

  console.log("applied. Next:");
  if (c.added.length) console.log(`  - Add one line for each new principle to the AGENTS.md list: ${c.added.join(", ")}`);
  if (c.removed.length) console.log(`  - Remove ${c.removed.join(", ")} from AGENTS.md and the role files.`);
  console.log("  - Read the changed principles; adjust role files if a role's core list should change.");
  console.log("  - Run bin/evf doctor.");
  return 0;
}
