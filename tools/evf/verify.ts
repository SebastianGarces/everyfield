import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  acceptanceFor,
  baseRef,
  evidenceDir,
  evfDataDir,
  fill,
  git,
  gitOk,
  hasRemote,
  isClean,
  loadConfig,
  loadRegistry,
  requireWorktree,
  run,
  runtimeDir,
  type TaskRef,
} from "./lib.ts";
import { stackEnv, stackInfo } from "./task.ts";
import { fbAcceptance } from "./feedback.ts";

export type Role = "author" | "verifier";
export type Mode = "full" | "quick";

export type CheckResult = { name: string; command: string[]; exitCode: number; durationMs: number; log: string; passed: boolean };

export type Proof = {
  schema: 1;
  task: string;
  role: Role;
  mode: Mode;
  sha: string;
  clean: boolean;
  base: { ref: string; sha: string; included: boolean };
  acceptance: string[];
  checks: CheckResult[];
  passed: boolean;
  startedAt: string;
  finishedAt: string;
  evidenceDir: string;
};

export function verify(root: string, task: TaskRef, role: Role, mode: Mode): Proof {
  const cfg = loadConfig(root);
  const wt = requireWorktree(root, cfg, task);
  if (hasRemote(root, cfg)) git(root, "fetch", "--quiet", cfg.remote, cfg.baseBranch);
  const ref = baseRef(root, cfg);
  const baseSha = git(root, "rev-parse", ref);
  const sha = git(wt, "rev-parse", "HEAD");
  const clean = isClean(wt);
  const included = gitOk(wt, "merge-base", "--is-ancestor", baseSha, "HEAD");
  const dir = evidenceDir(root, task, sha, `${role}-${mode}${clean ? "" : "-dirty"}`);
  mkdirSync(dir, { recursive: true });

  const entries = task.kind === "fb" ? fbAcceptance(root, task) : acceptanceFor(loadRegistry(root), task.wp);
  const acceptance = [...new Set(entries.map((e) => e.shared_gate_id))];
  const vars: Record<string, string> = {
    task: task.id,
    taskSlug: task.slug,
    wp: task.wp,
    part: task.part ?? "",
    sha,
    worktree: wt,
    evidenceDir: dir,
    runtimeDir: runtimeDir(root, task),
    acGrep: [...acceptance, task.kind === "fb" ? `BUG-FB-${task.issue}` : ""].filter(Boolean).join("|") || task.wp,
    baseUrl: stackInfo(root, task).url ?? "",
    role,
    mode,
  };
  const env = { ...stackEnv(root, task, wt), EVF_SHA: sha, EVF_EVIDENCE_DIR: dir, EVF_ROLE: role, EVF_MODE: mode, EVF_BASE_URL: vars.baseUrl };

  const startedAt = new Date().toISOString();
  console.log(`verify ${task.id} as ${role}, ${mode}, at ${sha.slice(0, 10)}${clean ? "" : " (DIRTY: this proof cannot ship)"}`);
  if (!included) console.log(`  FAIL  sync: HEAD does not include ${ref} (${baseSha.slice(0, 10)}). Merge or rebase ${ref} first.`);

  const checks: CheckResult[] = [];
  for (const c of cfg.checks.filter((c) => !c.modes || c.modes.includes(mode))) {
    const argv = fill(c.run, vars);
    const t0 = Date.now();
    const r = run(argv[0], argv.slice(1), { cwd: wt, env });
    const log = join(dir, `${c.name.replace(/[^\w.-]+/g, "_")}.log`);
    writeFileSync(log, `$ ${argv.join(" ")}\n\n${r.stdout}\n${r.stderr}`);
    const res = { name: c.name, command: argv, exitCode: r.code, durationMs: Date.now() - t0, log, passed: r.code === 0 };
    checks.push(res);
    console.log(`  ${res.passed ? "PASS" : "FAIL"}  ${c.name} (${Math.round(res.durationMs / 100) / 10}s)${res.passed ? "" : `  log: ${log}`}`);
  }

  const proof: Proof = {
    schema: 1,
    task: task.id,
    role,
    mode,
    sha,
    clean,
    base: { ref, sha: baseSha, included },
    acceptance,
    checks,
    passed: included && checks.length > 0 && checks.every((c) => c.passed),
    startedAt,
    finishedAt: new Date().toISOString(),
    evidenceDir: dir,
  };
  writeFileSync(join(dir, "proof.json"), `${JSON.stringify(proof, null, 2)}\n`);
  console.log(`${proof.passed ? "PASSED" : "FAILED"}. proof: ${join(dir, "proof.json")}`);
  if (!checks.length) console.log("No checks ran. Add checks to evf.config.json.");
  return proof;
}

/** All proofs recorded for a task, newest first. */
export function proofsFor(root: string, task: TaskRef): Proof[] {
  const base = join(evfDataDir(root), "evidence", task.slug);
  if (!existsSync(base)) return [];
  const out: Proof[] = [];
  for (const sha of readdirSync(base)) {
    for (const label of readdirSync(join(base, sha))) {
      const p = join(base, sha, label, "proof.json");
      if (existsSync(p)) out.push(JSON.parse(readFileSync(p, "utf8")) as Proof);
    }
  }
  return out.sort((a, b) => b.finishedAt.localeCompare(a.finishedAt));
}

export function shippable(p: Proof): boolean {
  return p.passed && p.clean && p.base.included;
}
