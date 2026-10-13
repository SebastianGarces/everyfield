import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  evfDataDir,
  fail,
  findPackage,
  git,
  hasRemote,
  isClean,
  loadConfig,
  loadDag,
  pathsForPart,
  requireWorktree,
  run,
  type Config,
  type TaskRef,
} from "./lib.ts";
import { stack } from "./task.ts";
import { proofsFor, shippable, verify, type Proof } from "./verify.ts";

function gh(cwd: string, args: string[]): string {
  const r = run("gh", args, { cwd });
  if (r.code !== 0) fail(`gh ${args.join(" ")} failed: ${(r.stderr || r.stdout).trim()}`);
  return r.stdout.trim();
}

function requireRemote(root: string, cfg: Config): void {
  if (!hasRemote(root, cfg)) fail(`No "${cfg.remote}" git remote yet. Create the GitHub repository, add the remote, then run: evf github setup`);
}

function nameWithOwner(cwd: string): string {
  return gh(cwd, ["repo", "view", "--json", "nameWithOwner", "-q", ".nameWithOwner"]);
}

function postStatus(cwd: string, cfg: Config, sha: string, state: "pending" | "success" | "failure", description: string): void {
  gh(cwd, ["api", "-X", "POST", `repos/${nameWithOwner(cwd)}/statuses/${sha}`, "-f", `state=${state}`, "-f", `context=${cfg.statusContext}`, "-f", `description=${description.slice(0, 140)}`]);
}

function pushBranch(wt: string, cfg: Config, task: TaskRef): void {
  git(wt, "push", "--quiet", "-u", cfg.remote, `HEAD:refs/heads/${task.branch}`);
}

function prFor(wt: string, task: TaskRef): { number: number; url: string; state: string } | null {
  const r = run("gh", ["pr", "view", task.branch, "--json", "number,url,state"], { cwd: wt });
  return r.code === 0 ? (JSON.parse(r.stdout) as { number: number; url: string; state: string }) : null;
}

function prBody(root: string, task: TaskRef, proof: Proof): string {
  const pkg = findPackage(loadDag(root), task.wp);
  const rows = proof.checks.map((c) => `| ${c.name} | ${c.passed ? "pass" : "FAIL"} | ${Math.round(c.durationMs / 1000)}s |`);
  return [
    `Task \`${task.id}\`: ${pkg.title}${task.part ? ` (${task.part})` : ""}.`,
    "",
    `Owning paths: ${pathsForPart(pkg, task.part).map((p) => `\`${p}\``).join(", ")}.`,
    `Acceptance criteria covered: ${proof.acceptance.length ? proof.acceptance.join(", ") : "package gates (no registry entries)"}.`,
    "",
    `Author proof at \`${proof.sha.slice(0, 10)}\` (${proof.mode}, base \`${proof.base.ref}\` ${proof.base.sha.slice(0, 10)} included):`,
    "",
    "| Check | Result | Time |",
    "|---|---|---|",
    ...rows,
    "",
    `Evidence (local): \`${proof.evidenceDir}\``,
    "",
    "This PR merges after the cross-model verifier reproduces the proof and runs `evf ship`. No human review is required.",
    "",
    "Rulings and shared changes made in this task:",
    "- (author: list them here, or write \"none\")",
  ].join("\n");
}

export function prOpen(root: string, task: TaskRef): number {
  const cfg = loadConfig(root);
  requireRemote(root, cfg);
  const wt = requireWorktree(root, cfg, task);
  if (!isClean(wt)) fail("Commit your work first. The worktree is not clean.");
  const sha = git(wt, "rev-parse", "HEAD");
  const proof = proofsFor(root, task).find((p) => p.sha === sha && p.role === "author" && p.mode === "full" && shippable(p));
  if (!proof) fail(`No passing full author proof for ${sha.slice(0, 10)}. Run: evf verify ${task.id}`);

  pushBranch(wt, cfg, task);
  const bodyFile = join(tmpdir(), `evf-pr-${task.slug}.md`);
  writeFileSync(bodyFile, prBody(root, task, proof));
  const pkg = findPackage(loadDag(root), task.wp);
  const existing = prFor(wt, task);
  if (existing && existing.state === "OPEN") {
    gh(wt, ["pr", "edit", String(existing.number), "--body-file", bodyFile]);
    console.log(`pr: updated ${existing.url}`);
  } else {
    const url = gh(wt, ["pr", "create", "--base", cfg.baseBranch, "--head", task.branch, "--title", `${task.id}: ${pkg.title}`, "--body-file", bodyFile]);
    console.log(`pr: opened ${url}`);
  }
  postStatus(wt, cfg, sha, "pending", "Waiting for cross-model verification");
  console.log(`next: the coordinator delegates verification. The verifier runs: evf verify ${task.id} --role verifier, then evf ship ${task.id}`);
  return 0;
}

const BEHIND = /not up to date|behind|base branch|head branch was modified|update the branch/i;

export function ship(root: string, task: TaskRef, opts: { maxUpdates: number }): number {
  const cfg = loadConfig(root);
  requireRemote(root, cfg);
  const wt = requireWorktree(root, cfg, task);
  const pr = prFor(wt, task);
  if (!pr || pr.state !== "OPEN") fail(`No open PR for ${task.branch}. The author runs: evf pr open ${task.id}`);
  if (!proofsFor(root, task).some((p) => p.role === "verifier" && p.mode === "full" && shippable(p))) {
    fail(`No passing full verifier proof for ${task.id}. Run: evf verify ${task.id} --role verifier`);
  }

  for (let attempt = 0; attempt <= opts.maxUpdates; attempt++) {
    if (!isClean(wt)) fail("The worktree is not clean. A verifier does not change the code. Send failures back to the coordinator.");
    const sha = git(wt, "rev-parse", "HEAD");
    const proof = proofsFor(root, task).find((p) => p.sha === sha && p.role === "verifier" && shippable(p));
    if (!proof) fail(`No passing verifier proof for HEAD ${sha.slice(0, 10)}. Run: evf verify ${task.id} --role verifier${attempt ? " --quick" : ""}`);

    pushBranch(wt, cfg, task);
    postStatus(wt, cfg, sha, "success", `Verified ${proof.mode} by ${proof.role} at ${sha.slice(0, 10)}`);
    const merge = run("gh", ["pr", "merge", String(pr.number), "--squash", "--match-head-commit", sha], { cwd: wt });
    if (merge.code === 0) return afterMerge(root, cfg, task, wt, pr.number, proof);

    const why = (merge.stderr || merge.stdout).trim();
    if (!BEHIND.test(why)) fail(`Merge refused: ${why}`);
    if (attempt === opts.maxUpdates) fail(`Branch still behind after ${opts.maxUpdates} updates. Try again later.`);
    console.log(`ship: branch is behind ${cfg.baseBranch}. Updating and running the quick check.`);
    gh(wt, ["pr", "update-branch", String(pr.number)]);
    git(wt, "fetch", "--quiet", cfg.remote, task.branch);
    git(wt, "merge", "--quiet", "--ff-only", `${cfg.remote}/${task.branch}`);
    const quick = verify(root, task, "verifier", "quick");
    if (!quick.passed) {
      postStatus(wt, cfg, quick.sha, "failure", "Quick check failed after update from main");
      fail(`Quick check failed after the update from ${cfg.baseBranch}. Proof: ${quick.evidenceDir}. The coordinator sends the task back.`);
    }
  }
  return 1;
}

function afterMerge(root: string, cfg: Config, task: TaskRef, wt: string, prNumber: number, proof: Proof): number {
  const mergeSha = gh(wt, ["pr", "view", String(prNumber), "--json", "mergeCommit", "-q", ".mergeCommit.oid"]);
  const pkg = findPackage(loadDag(root), task.wp);
  const record = {
    task: task.id,
    package_id: task.wp,
    pr: prNumber,
    merge_commit: mergeSha,
    shipped_at: new Date().toISOString(),
    evidence: {
      path: pathsForPart(pkg, task.part)[0] ?? "",
      commit: mergeSha,
      test: `evf verify ${task.id} --role verifier (${proof.checks.map((c) => c.name).join(", ")})`,
      result: "passed",
      note: `${task.id} merged in PR #${prNumber} after cross-model verification at ${proof.sha.slice(0, 10)}; acceptance ${proof.acceptance.join(", ") || "package gates"}.`,
    },
  };
  const dir = join(evfDataDir(root), "shipped");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `${task.slug}.json`), `${JSON.stringify(record, null, 2)}\n`);
  console.log(`ship: merged PR #${prNumber} as ${mergeSha.slice(0, 10)}.`);
  console.log(`progress: record saved for the coordinator (evf shipped).`);

  stack(root, task, "down", true);
  const removed = run("git", ["worktree", "remove", wt], { cwd: root });
  if (removed.code === 0) {
    run("git", ["branch", "-D", task.branch], { cwd: root });
    console.log(`cleanup: removed ${wt}.`);
  } else console.log(`cleanup: could not remove ${wt}: ${removed.stderr.trim()}. Run evf gc later.`);
  console.log(`intent: call ws.git.unregisterRoot(${JSON.stringify(wt)}).`);
  return 0;
}

export function listShipped(root: string, clear: string[]): number {
  const dir = join(evfDataDir(root), "shipped");
  if (!existsSync(dir)) {
    console.log("[]");
    return 0;
  }
  const records = readdirSync(dir).filter((f) => f.endsWith(".json")).map((f) => JSON.parse(readFileSync(join(dir, f), "utf8")) as { task: string });
  console.log(JSON.stringify(records, null, 2));
  for (const t of clear) rmSync(join(dir, `${t.toLowerCase().replace("/", "-")}.json`), { force: true });
  return 0;
}

export function githubSetup(root: string, dryRun: boolean): number {
  const cfg = loadConfig(root);
  requireRemote(root, cfg);
  const nwo = nameWithOwner(root);
  const repoArgs = ["api", "-X", "PATCH", `repos/${nwo}`, "-F", "allow_squash_merge=true", "-F", "allow_merge_commit=false", "-F", "allow_rebase_merge=false", "-F", "delete_branch_on_merge=true", "-F", "allow_update_branch=true", "-f", "squash_merge_commit_title=PR_TITLE"];
  const protection = {
    required_status_checks: { strict: true, contexts: [cfg.statusContext] },
    enforce_admins: false,
    required_pull_request_reviews: { required_approving_review_count: 0, dismiss_stale_reviews: false, require_code_owner_reviews: false },
    restrictions: null,
    allow_force_pushes: false,
    allow_deletions: false,
    required_linear_history: true,
  };
  const protFile = join(tmpdir(), "evf-protection.json");
  writeFileSync(protFile, JSON.stringify(protection));
  const protArgs = ["api", "-X", "PUT", `repos/${nwo}/branches/${cfg.baseBranch}/protection`, "--input", protFile];
  if (dryRun) {
    console.log(`gh ${repoArgs.join(" ")}`);
    console.log(`gh ${protArgs.join(" ")}\n${JSON.stringify(protection, null, 2)}`);
    return 0;
  }
  gh(root, repoArgs);
  gh(root, protArgs);
  console.log(`github: ${nwo} uses squash merges only and deletes merged branches. ${cfg.baseBranch} requires PRs, an up-to-date branch and the ${cfg.statusContext} status. No reviews required.`);
  return 0;
}
