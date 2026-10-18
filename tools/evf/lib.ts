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
  usesPaidProviders: boolean;
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
  maintenanceTasks?: Record<string, { title: string; owningPaths: string[]; checks: CheckDef[]; risk?: "ordinary" | "sensitive" | "security" | "privacy" | "irreversible" }>;
  taskRisks?: Record<string, "ordinary" | "sensitive" | "security" | "privacy" | "irreversible">;
  mergePolicy: MergePolicy;
};

export const FEEDBACK_BUG_CLASSES = ["p0", "p1", "p2", "p3"] as const;
export type FeedbackBugClass = typeof FEEDBACK_BUG_CLASSES[number];
/** Feedback bug classes that merge through the verifier, and those the verifier passes before Sebastian approves. */
export type MergePolicy = { ordinary: string; feedbackVerifierMerge: FeedbackBugClass[]; feedbackOwnerAfterVerifier: FeedbackBugClass[] };

export type Package = {
  id: string;
  title: string;
  goal: string;
  lane: string;
  domain: string;
  depends_on: string[];
  ui_depends_on?: string[];
  root_outputs?: string[];
  estimate_engineer_days: number;
  inputs: string[];
  outputs: string[];
  owning_paths: string[];
  interfaces: string[];
  acceptance_gates: string[];
  integration_rule: string;
  context_scope: { proof_stage: string };
  ui_specialist?: 'ui-designer';
  ui_model?: string;
  ui_composition_rule?: string;
  fast_track?: { owner: string; scope: string; checks: string; signed_evf_proof_required: boolean };
};

export type Dag = {
  packages: Package[];
  vertical_slices: Array<{ id: string; required_packages: string[] }>;
};

export type AcceptanceEntry = {
  id: string; shared_gate_id: string; feature_id: string;
  requirement_ids: string[]; case_ids: string[]; work_packages: string[];
  operations: string[]; required_test_layers: string[];
};
export type Catalog = {
  feature_source: string; acceptance_source: string; operation_source: string;
  requirement_files: string[]; case_files: string[];
};
export type Requirement = { id: string; text: string; spec: string };
export type Case = { id: string; description: string; given: Record<string, unknown>; actor: Record<string, unknown>; clock: Record<string, unknown>; action: Record<string, unknown>; expected: Record<string, unknown>; group?: string; subcases?: Array<Record<string, unknown>>; work_packages: string[] };
export type Context = { id: string; acceptance_ids: string[]; case_ids: string[]; requirement_ids: string[]; own_requirement_ids: string[]; own_case_ids: string[]; [key: string]: unknown };

export type Part = "contract" | "api" | "ui" | null;

export type TaskRef = {
  id: string;
  kind: "wp" | "fb" | "ops";
  /** Public feedback issue number for FB tasks. */
  issue: number | null;
  /** Work package for WP tasks; empty for FB tasks. */
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
  const cfg = readJson<Config>(path);
  parseMergePolicy(cfg.mergePolicy);
  return cfg;
}

function parseMergePolicy(policy: unknown): asserts policy is MergePolicy {
  if (typeof policy !== "object" || policy === null || Array.isArray(policy)) fail("evf.config.json mergePolicy must be an object.");
  const p = policy as Record<string, unknown>;
  const seen = new Set<string>();
  for (const field of ["feedbackVerifierMerge", "feedbackOwnerAfterVerifier"]) {
    const v = p[field];
    if (!Array.isArray(v) || v.some((c) => !(FEEDBACK_BUG_CLASSES as readonly unknown[]).includes(c)) || new Set(v).size !== v.length)
      fail(`evf.config.json mergePolicy.${field} must be a list of distinct classes from ${FEEDBACK_BUG_CLASSES.join(", ")}; got ${JSON.stringify(v)}.`);
    for (const c of v as string[]) {
      if (seen.has(c)) fail(`evf.config.json lists ${c} in both mergePolicy.feedbackVerifierMerge and mergePolicy.feedbackOwnerAfterVerifier; give each class one route.`);
      seen.add(c);
    }
  }
}

export function loadDag(root: string): Dag {
  const dag = readJson<Dag>(join(root, "docs/plan/dag.json"));
  if(dag.packages.some(p=>p.fast_track!==undefined&&p.id!=='WP-097'))fail('Only WP-097 may declare fast_track.');
  const by = new Map(dag.packages.map(p => [p.id, p]));
  const visiting = new Set<string>(), done = new Set<string>();
  const visit = (id: string) => {
    if (visiting.has(id)) fail(`Cyclic package dependency at ${id}.`);
    if (done.has(id)) return;
    const p = by.get(id); if (!p) fail(`Unknown prerequisite ${id}.`);
    visiting.add(id); [...p.depends_on,...(p.ui_depends_on??[])].forEach(visit); visiting.delete(id); done.add(id);
  };
  dag.packages.forEach(p => visit(p.id));
  return dag;
}

export function currentCatalog(root: string): { catalog: Catalog; requirements: Map<string, Requirement>; cases: Map<string, Case>; registry: AcceptanceEntry[] } {
  const catalog = readJson<Catalog>(join(root, "docs/catalog/index.json"));
  const requirements = new Map(catalog.requirement_files.flatMap(path => readJson<{requirements: Requirement[]}>(join(root,path)).requirements).map(r => [r.id,r]));
  const cases = new Map(catalog.case_files.flatMap(path => readJson<{cases: Case[]}>(join(root,path)).cases).map(r => [r.id,r]));
  const expanded = run("python3", [join(root,"docs/package-context.py"), "--acceptance", "--root", root], {cwd:root});
  if (expanded.code !== 0) fail(`Invalid acceptance inventory: ${expanded.stderr || expanded.stdout}`);
  const registry = JSON.parse(expanded.stdout) as AcceptanceEntry[];
  if (!registry.length || !requirements.size || !cases.size) fail("Empty current context is not a valid implementation contract.");
  for (const entry of registry) {
    for (const id of entry.requirement_ids) if (!requirements.has(id)) fail(`Missing clause ${id} in ${entry.id}.`);
    for (const id of entry.case_ids) if (!cases.has(id)) fail(`Missing case ${id} in ${entry.id}.`);
  }
  // These are current source contracts, even when no operation is selected by this task.
  for (const path of [catalog.feature_source,catalog.operation_source,'docs/catalog/shared-contracts.json','docs/schema/target.json','docs/plan/context-manifest.json']) readJson<unknown>(join(root,path));
  return {catalog,requirements,cases,registry};
}
export function loadRegistry(root: string): AcceptanceEntry[] { return currentCatalog(root).registry; }
export function loadContexts(root: string): Context[] {
  currentCatalog(root);
  const check = run("python3", ["docs/package-context.py", "--check-manifest", "--root", root], {cwd:root});
  if (check.code !== 0) fail(`Invalid current package context: ${check.stderr || check.stdout}`);
  const manifest = readJson<{packages: Context[]}>(join(root,"docs/plan/context-manifest.json"));
  return manifest.packages;
}
export function packageContext(root: string, wp: string): Context {
  const context = loadContexts(root).find(p => p.id === wp);
  if (!context) fail(`No current context for ${wp}.`);
  return context;
}
export function loadProgress(root: string): Record<string, { status: string }> {
  const path = join(root, "docs/build-progress.json");
  return existsSync(path) ? readJson<{ packages: Record<string, { status: string }> }>(path).packages : {};
}

export function parseTask(raw: string | undefined): TaskRef {
  if (!raw) fail("Give a task ID, for example WP-022, WP-022/ui or FB-12.");
  const ops = /^OPS-([1-9]\d*)$/i.exec(raw.trim());
  if (ops) return { id: `OPS-${ops[1]}`, kind: 'ops', issue: null, wp: '', part: null, slug: `ops-${ops[1]}`, branch: `task/ops-${ops[1]}` };
  const fb = /^FB-(\d+)$/i.exec(raw.trim());
  if (fb) {
    const n = Number(fb[1]);
    return { id: `FB-${n}`, kind: "fb", issue: n, wp: "", part: null, slug: `fb-${n}`, branch: `task/fb-${n}` };
  }
  const m = /^(WP-\d{3})(?:\/(contract|api|ui))?$/i.exec(raw.trim());
  if (!m) fail(`Bad task ID "${raw}". Use WP-NNN, WP-NNN/contract|api|ui, FB-<issue> or OPS-<n>.`);
  const wp = m[1].toUpperCase();
  const part = (m[2]?.toLowerCase() ?? null) as Part;
  const slug = part ? `${wp.toLowerCase()}-${part}` : wp.toLowerCase();
  return { id: part ? `${wp}/${part}` : wp, kind: "wp", issue: null, wp, part, slug, branch: `task/${slug}` };
}

export function findPackage(dag: Dag, wp: string): Package {
  const p = dag.packages.find((x) => x.id === wp);
  if (!p) fail(`${wp} is not in docs/plan/dag.json.`);
  return p;
}

export const isUiPath = (p: string) => p.startsWith("apps/web/src/features/") || p.startsWith("apps/web/src/components/") || (p.startsWith("apps/web/src/app/") && !p.startsWith("apps/web/src/app/api/")) || p.startsWith("tests/browser/") || p.startsWith("packages/ui/") || p.startsWith("tests/ui/");
const isContract = (p: string) => p.startsWith("packages/contracts/") || p.startsWith("tests/contracts/");

/** Splits a package into the parts that ship as separate tasks. */
export function partsOf(pkg: Package): Part[] {
  const web = pkg.owning_paths.some(isUiPath);
  const nonWeb = pkg.owning_paths.some((p) => !isUiPath(p));
  if (!web || !nonWeb) return [null];
  const contract = pkg.owning_paths.some(isContract);
  const backend = pkg.owning_paths.some((p) => !isUiPath(p) && !isContract(p));
  const parts: Part[] = [];
  if (contract && backend) parts.push("contract");
  parts.push("api", "ui");
  return parts;
}

export function pathsForPart(pkg: Package, part: Part): string[] {
  const parts = partsOf(pkg);
  if (part === null) return [...pkg.owning_paths,...(pkg.root_outputs??[])];
  if (!parts.includes(part)) fail(`${pkg.id} does not split into a "${part}" task. Valid: ${parts.map((p) => p ?? "(none)").join(", ")}.`);
  if (part === "ui") return pkg.owning_paths.filter(isUiPath);
  if (part === "contract") return pkg.owning_paths.filter(isContract);
  return pkg.owning_paths.filter((p) => !isUiPath(p) && (parts.includes("contract") ? !isContract(p) : true));
}

/** Design milestones gate only presentation; server/contracts can proceed independently. */
export function prerequisitesForPart(pkg: Package, part: Part): string[] {
  const ui = part === "ui" || part === null && pkg.owning_paths.some(isUiPath);
  return [...pkg.depends_on, ...(ui ? pkg.ui_depends_on ?? [] : [])];
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
