import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { renderBrief } from "./brief.ts";
import {
  baseRef,
  fail,
  findPackage,
  git,
  gitOk,
  hasRemote,
  loadConfig,
  loadDag,
  loadProgress,
  pathsForPart,
  requireWorktree,
  run,
  runtimeDir,
  worktreePath,
  type Config,
  type TaskRef,
} from "./lib.ts";

export function stackEnv(root: string, task: TaskRef, wt: string): NodeJS.ProcessEnv {
  return {
    ...process.env,
    EVF_TASK: task.id,
    EVF_TASK_SLUG: task.slug,
    EVF_WORKTREE: wt,
    EVF_RUNTIME_DIR: runtimeDir(root, task),
    EVF_DB_NAME: `evf_${task.slug.replace(/-/g, "_")}`,
  };
}

export function stackInfo(root: string, task: TaskRef): Record<string, string> {
  const path = join(runtimeDir(root, task), "stack.json");
  return existsSync(path) ? (JSON.parse(readFileSync(path, "utf8")) as Record<string, string>) : {};
}

function stackCmd(cfg: Config, name: "up" | "down" | "status" | "traces" | "logs"): string[] | null {
  return cfg.stack?.[name] ?? null;
}

export function stack(root: string, task: TaskRef, action: "up" | "down" | "status", optional = false): number {
  const cfg = loadConfig(root);
  const argv = stackCmd(cfg, action);
  if (!argv) {
    const msg = `No stack "${action}" command in evf.config.json yet. The runtime packages (WP-003, WP-004) define it.`;
    if (optional) {
      console.log(`stack: skipped. ${msg}`);
      return 0;
    }
    fail(msg);
  }
  const wt = requireWorktree(root, cfg, task);
  mkdirSync(runtimeDir(root, task), { recursive: true });
  const r = run(argv[0], argv.slice(1), { cwd: wt, env: stackEnv(root, task, wt), inherit: true });
  if (r.code === 0 && action !== "down") {
    const info = stackInfo(root, task);
    if (Object.keys(info).length) console.log(`stack: ${JSON.stringify(info)}`);
  }
  return r.code;
}

export function debugCmd(root: string, task: TaskRef, name: "traces" | "logs", extra: string[]): number {
  const cfg = loadConfig(root);
  const argv = stackCmd(cfg, name);
  if (!argv) fail(`No stack "${name}" command in evf.config.json yet. The observability setup (WP-003, WP-050) defines it.`);
  const wt = requireWorktree(root, cfg, task);
  return run(argv[0], [...argv.slice(1), ...extra], { cwd: wt, env: stackEnv(root, task, wt), inherit: true }).code;
}

export function taskStart(root: string, task: TaskRef, opts: { allowUnready: boolean; noStack: boolean; uiTier?: string }): number {
  const cfg = loadConfig(root);
  const dag = loadDag(root);
  const pkg = findPackage(dag, task.wp);
  pathsForPart(pkg, task.part);

  const progress = loadProgress(root);
  const unready = pkg.depends_on.filter((d) => progress[d]?.status !== "done");
  if (unready.length && !opts.allowUnready) {
    fail(`${task.wp} prerequisites are not canonically done: ${unready.join(", ")}. Ask the coordinator. Override only with --allow-unready.`);
  }

  if (hasRemote(root, cfg)) git(root, "fetch", "--quiet", cfg.remote, cfg.baseBranch);
  const base = baseRef(root, cfg);
  const wt = worktreePath(root, cfg, task);

  if (existsSync(wt)) {
    const behind = git(wt, "rev-list", "--count", `HEAD..${base}`);
    console.log(`worktree: reusing ${wt} (${behind} commits behind ${base}).`);
  } else if (gitOk(root, "show-ref", "--verify", "--quiet", `refs/heads/${task.branch}`)) {
    git(root, "worktree", "add", "--quiet", wt, task.branch);
    console.log(`worktree: ${wt} on existing branch ${task.branch}.`);
  } else {
    git(root, "worktree", "add", "--quiet", "-b", task.branch, wt, base);
    console.log(`worktree: ${wt} on new branch ${task.branch} from ${base}.`);
  }
  console.log(`intent: call ws.git.registerRoot(${JSON.stringify(wt)}) so Intent shows this worktree.`);
  console.log("shell: your shell starts in the workspace root. evf commands find the worktree from the task ID; for other commands use `git -C` or the worktree path.");

  if (!opts.noStack) stack(root, task, "up", true);
  console.log("");
  console.log(renderBrief(root, task, { uiTier: opts.uiTier }));
  return 0;
}
