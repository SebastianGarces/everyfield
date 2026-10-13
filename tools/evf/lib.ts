import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join, resolve, sep } from "node:path";

export type Argv = string[];

export type CheckDef = {
  name: string;
  run: Argv;
  modes?: Array<"full" | "quick">;
};

export type StackDef = {
  up?: Argv;
  down?: Argv;
  status?: Argv;
  traces?: Argv;
  logs?: Argv;
};

export type Config = {
  baseBranch: string;
  remote: string;
  worktreeDir: string;
  statusContext: string;
  maxAgentsMdLines: number;
  stack: StackDef | null;
  checks: CheckDef[];
};

export type Package = {
  id: string;
  title: string;
  lane: string;
  domain: string;
  depends_on: string[];
  estimate_engineer_days: number;
  inputs: string[];
  outputs: string[];
  owning_paths: string[];
  interfaces: string[];
  acceptance_gates: string[];
  feature_ids: string[];
  integration_rule: string;
};

export type Dag = {
  packages: Package[];
  vertical_slices: Array<{ id: string; required_packages: string[] }>;
};

export type AcceptanceEntry = {
  id: string;
  shared_gate_id: string;
  feature_id: string;
  spec: string;
  work_packages: string[];
  positive_obligation: string;
  operations?: string[];
  validation_obligations?: string[];
  permission_denial_obligations?: string[];
  state_history_obligations?: string[];
  failure_recovery_obligations?: string[];
  required_test_layers?: string[];
};

export type Ruling = {
  id: string;
  decision_id: string;
  title: string;
  ruling: string;
  work_packages: string[];
  status: string;
};

export type Part = "contract" | "api" | "ui" | null;

export type TaskRef = {
  id: string;
  wp: string;
  part: Part;
  slug: string;
  branch: string;
};

export class EvfError extends Error {}

export function fail(message: string): never {
  throw new EvfError(message);
}

export type RunResult = { code: number; stdout: string; stderr: string };

export function run(cmd: string, args: Argv, opts: { cwd?: string; env?: NodeJS.ProcessEnv; inherit?: boolean } = {}): RunResult {
  const r = spawnSync(cmd, args, {
    cwd: opts.cwd,
    env: opts.env ?? process.env,
    encoding: "utf8",
    stdio: opts.inherit ? "inherit" : "pipe",
    maxBuffer: 64 * 1024 * 1024,
  });
  if (r.error) return { code: 127, stdout: "", stderr: String(r.error.message) };
  return { code: r.status ?? 1, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
}

export function git(cwd: string, ...args: string[]): string {
  const r = run("git", args, { cwd });
  if (r.code !== 0) fail(`git ${args.join(" ")} failed: ${r.stderr.trim() || r.stdout.trim()}`);
  return r.stdout.trim();
}

export function gitOk(cwd: string, ...args: string[]): boolean {
  return run("git", args, { cwd }).code === 0;
}

/** The checkout that owns `.worktrees/`: the Intent workspace root, never a task worktree. */
export function homeRoot(): string {
  const top = run("git", ["rev-parse", "--show-toplevel"]);
  if (top.code !== 0) fail("evf must run inside the everyfield-v3 repository.");
  const path = top.stdout.trim();
  const marker = `${sep}.worktrees${sep}`;
  const at = path.indexOf(marker);
  return at === -1 ? path : path.slice(0, at);
}

export function commonDir(root: string): string {
  return resolve(root, git(root, "rev-parse", "--git-common-dir"));
}

export function readJson<T>(path: string): T {
  return JSON.parse(readFileSync(path, "utf8")) as T;
}

export function loadConfig(root: string): Config {
  const path = join(root, "evf.config.json");
  if (!existsSync(path)) fail(`Missing ${path}.`);
  return readJson<Config>(path);
}

export function loadDag(root: string): Dag {
  return readJson<Dag>(join(root, "docs/plan/dag.json"));
}

export function loadRegistry(root: string): AcceptanceEntry[] {
  const path = join(root, "docs/evidence/acceptance-registry.json");
  return existsSync(path) ? readJson<AcceptanceEntry[]>(path) : [];
}

export function loadRulings(root: string): Ruling[] {
  const path = join(root, "docs/decisions/user-rulings.json");
  return existsSync(path) ? readJson<{ rulings: Ruling[] }>(path).rulings : [];
}

export function loadProgress(root: string): Record<string, { status: string }> {
  const path = join(root, "docs/build-progress.json");
  return existsSync(path) ? readJson<{ packages: Record<string, { status: string }> }>(path).packages : {};
}

export function parseTask(raw: string | undefined): TaskRef {
  if (!raw) fail("Give a task ID, for example WP-022 or WP-022/ui.");
  const m = /^(WP-\d{3})(?:\/(contract|api|ui))?$/i.exec(raw.trim());
  if (!m) fail(`Bad task ID "${raw}". Use WP-NNN or WP-NNN/contract|api|ui.`);
  const wp = m[1].toUpperCase();
  const part = (m[2]?.toLowerCase() ?? null) as Part;
  const slug = part ? `${wp.toLowerCase()}-${part}` : wp.toLowerCase();
  return { id: part ? `${wp}/${part}` : wp, wp, part, slug, branch: `task/${slug}` };
}

export function findPackage(dag: Dag, wp: string): Package {
  const p = dag.packages.find((x) => x.id === wp);
  if (!p) fail(`${wp} is not in docs/plan/dag.json.`);
  return p;
}

const isWeb = (p: string) => p.startsWith("apps/web/");
const isContract = (p: string) => p.startsWith("packages/contracts/") || p.startsWith("tests/contracts/");

/** Splits a package into the parts that ship as separate tasks. */
export function partsOf(pkg: Package): Part[] {
  const web = pkg.owning_paths.some(isWeb);
  const nonWeb = pkg.owning_paths.some((p) => !isWeb(p));
  if (!web || !nonWeb) return [null];
  const contract = pkg.owning_paths.some(isContract);
  const backend = pkg.owning_paths.some((p) => !isWeb(p) && !isContract(p));
  const parts: Part[] = [];
  if (contract && backend) parts.push("contract");
  parts.push("api", "ui");
  return parts;
}

export function pathsForPart(pkg: Package, part: Part): string[] {
  const parts = partsOf(pkg);
  if (part === null) return pkg.owning_paths;
  if (!parts.includes(part)) fail(`${pkg.id} does not split into a "${part}" task. Valid: ${parts.map((p) => p ?? "(none)").join(", ")}.`);
  if (part === "ui") return pkg.owning_paths.filter(isWeb);
  if (part === "contract") return pkg.owning_paths.filter(isContract);
  return pkg.owning_paths.filter((p) => !isWeb(p) && (parts.includes("contract") ? !isContract(p) : true));
}

export function hasRemote(root: string, cfg: Config): boolean {
  return gitOk(root, "remote", "get-url", cfg.remote);
}

export function baseRef(root: string, cfg: Config): string {
  return hasRemote(root, cfg) ? `${cfg.remote}/${cfg.baseBranch}` : cfg.baseBranch;
}

export function worktreePath(root: string, cfg: Config, task: TaskRef): string {
  return join(root, cfg.worktreeDir, task.slug);
}

export function requireWorktree(root: string, cfg: Config, task: TaskRef): string {
  const wt = worktreePath(root, cfg, task);
  if (!existsSync(wt)) fail(`No worktree for ${task.id}. Run: evf task start ${task.id}`);
  return wt;
}

export function evfDataDir(root: string): string {
  return join(commonDir(root), "evf");
}

export function runtimeDir(root: string, task: TaskRef): string {
  return join(evfDataDir(root), "runtime", task.slug);
}

export function evidenceDir(root: string, task: TaskRef, sha: string, label: string): string {
  return join(evfDataDir(root), "evidence", task.slug, sha, label);
}

export function isClean(wt: string): boolean {
  return git(wt, "status", "--porcelain") === "";
}

export function oneLine(text: string, max = 220): string {
  const t = text.replace(/\s+/g, " ").trim();
  return t.length > max ? `${t.slice(0, max - 1)}…` : t;
}

export function fill(argv: Argv, vars: Record<string, string>): Argv {
  return argv.map((a) => a.replace(/\{(\w+)\}/g, (_, k: string) => (k in vars ? vars[k] : `{${k}}`)));
}

export function acceptanceFor(registry: AcceptanceEntry[], wp: string): AcceptanceEntry[] {
  return registry.filter((e) => e.work_packages?.includes(wp));
}
