import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
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
import { requireTaskScope } from "./policy.ts";
import { recordProgress, type ShippedRecord } from './progress.ts';
import { stack } from "./task.ts";
import { cachedTriage, fbOwningPaths, feedbackTitle, internalIssueOf, isPrototype, onFeedbackShipped } from "./feedback.ts";
import { currentProof, type Proof } from "./verify.ts";

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

function taskTitle(root: string, task: TaskRef): string {
  if(task.kind==='ops')return loadConfig(root).maintenanceTasks![task.id].title;
  if (task.kind === "fb") return feedbackTitle(root, task.issue!);
  const pkg = findPackage(loadDag(root), task.wp);
  return `${pkg.title}${task.part ? ` (${task.part})` : ""}`;
}

function taskPaths(root: string, task: TaskRef): string[] {
  if(task.kind==='ops')return loadConfig(root).maintenanceTasks![task.id].owningPaths;
  return task.kind === "fb" ? fbOwningPaths(root, task) : pathsForPart(findPackage(loadDag(root), task.wp), task.part);
}

function prBody(root: string, task: TaskRef, proof: Proof): string {
  const rows = proof.checks.map((c) => `| ${c.name} | ${c.passed ? "pass" : "FAIL"} | ${Math.round(c.durationMs / 1000)}s |`);
  const internal = internalIssueOf(root, task);
  const proto = isPrototype(root, task);
  const paths = taskPaths(root, task);
  return [
    `Task \`${task.id}\`: ${taskTitle(root, task)}.`,
    ...(internal ? ["", `Closes #${internal}.`] : []),
    ...(proto ? ["", "**Prototype for product review.** Sebastian merges or closes this PR. `evf ship` refuses prototypes.", "", "Preview steps and screenshots:", "- (author: add them here)"] : []),
    "",
    `Owning paths: ${paths.length ? paths.map((p) => `\`${p}\``).join(", ") : "see the diff"}.`,
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
    "Merge policy: `.agents/skills/ship/SKILL.md`.",
    "",
    "Rulings and shared changes made in this task:",
    "- (author: list them here, or write \"none\")",
  ].join("\n");
}

export function prOpen(root: string, task: TaskRef): number {
  const cfg = loadConfig(root);
  const wp=task.kind==='wp'?task.wp:task.kind==='fb'?cachedTriage(root,task.issue!)?.wp:undefined;requireTaskScope(root,task,wp);
  requireRemote(root, cfg);
  const wt = requireWorktree(root, cfg, task);
  if (!isClean(wt)) fail("Commit your work first. The worktree is not clean.");
  const sha = git(wt, "rev-parse", "HEAD");
  git(root,"fetch","--quiet",cfg.remote,cfg.baseBranch);
  const proof = currentProof(root,task,"author");

  pushBranch(wt, cfg, task);
  const bodyFile = join(tmpdir(), `evf-pr-${task.slug}.md`);
  writeFileSync(bodyFile, prBody(root, task, proof));
  const proto = isPrototype(root, task);
  const existing = prFor(wt, task);
  if (existing && existing.state === "OPEN") {
    gh(wt, ["pr", "edit", String(existing.number), "--body-file", bodyFile]);
    console.log(`pr: updated ${existing.url}`);
  } else {
    const extra = proto ? ["--draft", "--label", "prototype"] : [];
    if (proto) gh(wt, ["label", "create", "prototype", "--force", "--description", "Prototype from feedback; waits for product review"]);
    const url = gh(wt, ["pr", "create", "--base", cfg.baseBranch, "--head", task.branch, "--title", `${task.id}: ${taskTitle(root, task)}`, "--body-file", bodyFile, ...extra]);
    console.log(`pr: opened ${url}`);
  }
  if (proto) {
    postStatus(wt, cfg, sha, "pending", "Prototype: waits for Sebastian's product review");
    console.log("next: this is a prototype. Report the PR to the coordinator; Sebastian reviews it. Do not run evf ship.");
    return 0;
  }
  postStatus(wt, cfg, sha, "pending", "Waiting for cross-model verification");
  console.log(`next: the coordinator delegates verification. The verifier runs: evf verify ${task.id} --role verifier, then evf ship ${task.id}`);
  return 0;
}

const BEHIND = /not up to date|behind|base branch|head branch was modified|update the branch/i;

export function ship(root: string, task: TaskRef, opts: { maxUpdates: number }): number {
  const cfg = loadConfig(root);
  const wp=task.kind==='wp'?task.wp:task.kind==='fb'?cachedTriage(root,task.issue!)?.wp:undefined;requireTaskScope(root,task,wp);
  requireRemote(root, cfg);
  const wt = requireWorktree(root, cfg, task);
  if (isPrototype(root, task)) fail(`${task.id} is a prototype. Sebastian reviews and merges it; evf ship never does.`);
  const pr = prFor(wt, task);
  if (!pr || pr.state !== "OPEN") fail(`No open PR for ${task.branch}. The author runs: evf pr open ${task.id}`);
  const policy=(cfg as Config & {mergePolicy:{ordinary:string;feedbackVerifierMerge:string[]}}).mergePolicy;
  if(policy.ordinary!=='automatic-after-independent-review')fail('Ordinary automatic merge is not approved in the reviewed root policy.');
  // Owner ruling 2026-10-15: listed feedback bug classes merge through the verifier like ordinary builds.
  // Other classes need Sebastian's approval through `evf approve`; prototypes never ship here.
  if(task.kind==='fb') {
    const cls=cachedTriage(root,task.issue!)?.class;
    if(!cls||!(policy.feedbackVerifierMerge??[]).includes(cls))fail(`${task.id} is ${cls??'untriaged'}; only ${(policy.feedbackVerifierMerge??[]).join(', ')||'no'} feedback classes merge through the verifier. Sebastian approves the rest with: bin/evf approve <PR>`);
  }


  for (let attempt = 0; attempt <= opts.maxUpdates; attempt++) {
    if (!isClean(wt)) fail("The worktree is not clean. A verifier does not change the code. Send failures back to the coordinator.");
    const sha = git(wt, "rev-parse", "HEAD");
    git(root,"fetch","--quiet",cfg.remote,cfg.baseBranch);
    const proof = currentProof(root,task,"verifier");
    const authorProof = currentProof(root,task,"author");
    const repo=nameWithOwner(wt);
    const protection=JSON.parse(gh(wt,["api",`repos/${repo}/branches/${cfg.baseBranch}/protection`]));
    if(protection.required_status_checks?.strict!==true || !Array.isArray(protection.required_status_checks?.contexts) || !protection.required_status_checks.contexts.includes(cfg.statusContext) || protection.enforce_admins?.enabled!==true)fail('Verified strict branch protection and enforced final-head checks are required before automatic merge. Restore it with: evf github setup');



    pushBranch(wt, cfg, task);
    postStatus(wt, cfg, sha, "success", `Verified ${proof.mode} by ${proof.role} at ${sha.slice(0, 10)}`);
    const merge = run("gh", ["pr", "merge", String(pr.number), "--squash", "--match-head-commit", sha], { cwd: wt });
    if (merge.code === 0) return afterMerge(root, cfg, task, wt, pr.number, proof,authorProof);

    const why = (merge.stderr || merge.stdout).trim();
    if (!BEHIND.test(why)) fail(`Merge refused: ${why}`);
    if (attempt === opts.maxUpdates) fail(`Branch still behind after ${opts.maxUpdates} updates. Try again later.`);
    console.log(`ship: branch is behind ${cfg.baseBranch}. Updating and requiring full independent author/verifier proof.`);
    gh(wt, ["pr", "update-branch", String(pr.number)]);
    git(wt, "fetch", "--quiet", cfg.remote, task.branch);
    git(wt, "merge", "--quiet", "--ff-only", `${cfg.remote}/${task.branch}`);
    fail(`Branch updated. Stop for full author and verifier proofs at the new final head; prior evidence is stale.`);
  }
  return 1;
}

function afterMerge(root: string, cfg: Config, task: TaskRef, wt: string, prNumber: number, proof: Proof,authorProof:Proof): number {
  const mergeSha = gh(wt, ["pr", "view", String(prNumber), "--json", "mergeCommit", "-q", ".mergeCommit.oid"]);
  const record = {
    task: task.id,
    package_id: task.kind === "wp" ? task.wp : null,
    pr: prNumber,
    merge_commit: mergeSha,
    shipped_at: new Date().toISOString(),
    part: task.part,
    package_completion: false,
    passed_case_portions: proof.attestation?.payload.casePortions ?? [],
    passed_gate_portions: proof.attestation?.payload.gatePortions ?? [],
    deferred_gate_portions: proof.plan?.gates.flatMap(g=>g.deferred.map(d=>({gateIndex:g.index,...d}))) ?? [],
    deferred_case_portions: proof.plan?.cases.flatMap(c=>c.deferred.map(d=>({caseId:c.id,...d}))) ?? [],
    verified_head: proof.sha,
    contract_fingerprint: proof.fingerprint,
    proof,
    author_proof: authorProof,
    evidence: {
      path: taskPaths(root, task)[0] ?? "",
      commit: mergeSha,
      test: `evf verify ${task.id} --role verifier (${proof.checks.map((c) => c.name).join(", ")})`,
      result: "passed",
      note: `${task.id} merged in PR #${prNumber} after cross-model verification at ${proof.sha.slice(0, 10)}; acceptance ${proof.acceptance.join(", ") || "package gates"}.`,
    },
  };
  const dir = join(evfDataDir(root), "shipped");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `${task.slug}.json`), `${JSON.stringify(record, null, 2)}\n`);
  git(root,'fetch','--quiet',cfg.remote,cfg.baseBranch);
  recordProgress(root,record,false);
  console.log(`ship: merged PR #${prNumber} as ${mergeSha.slice(0, 10)}.`);
  if (task.kind === "fb") onFeedbackShipped(root, task);
  else console.log(`progress: recorded automatically; the coordinator reviews and acknowledges with evf shipped --clear ${task.id}.`);

  if(task.kind!=='ops')stack(root, task, "down", true);
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
  const records = readdirSync(dir).filter(f=>f.endsWith(".json")).map(f=>({path:join(dir,f),value:JSON.parse(readFileSync(join(dir,f),"utf8")) as ShippedRecord}));
  console.log(JSON.stringify(records.filter(r=>!r.value.acknowledged).map(r=>r.value),null,2));
  for(const id of clear) {
    const record=records.find(r=>r.value.task===id);if(!record)fail(`No retained shipped record for ${id}.`);
    recordProgress(root,record.value,true);
    record.value.acknowledged=true;writeFileSync(record.path,JSON.stringify(record.value,null,2)+"\n");
  } // Acknowledgement clears the inbox, never removes proof/part provenance.

  return 0;
}

export function githubSetup(root: string, dryRun: boolean): number {
  // Owner-approved 2026-10-15: squash-only merges and strict protection that binds admin tokens,
  // because agents act through the owner's account. Zero approvals; evf/verify is the merge bar.
  const cfg = loadConfig(root);
  requireRemote(root, cfg);
  const repo = nameWithOwner(root);
  const settings = ["api", "-X", "PATCH", `repos/${repo}`, "-F", "allow_squash_merge=true", "-F", "allow_merge_commit=false", "-F", "allow_rebase_merge=false", "-F", "delete_branch_on_merge=true", "-F", "allow_update_branch=true", "-f", "squash_merge_commit_title=PR_TITLE", "-f", "squash_merge_commit_message=PR_BODY"];
  const protection = {
    required_status_checks: { strict: true, contexts: [cfg.statusContext] },
    enforce_admins: true,
    required_pull_request_reviews: { required_approving_review_count: 0, dismiss_stale_reviews: true, require_code_owner_reviews: false },
    restrictions: null,
    required_linear_history: true,
    allow_force_pushes: false,
    allow_deletions: false,
  };
  const file = join(tmpdir(), "evf-protection.json");
  writeFileSync(file, JSON.stringify(protection));
  const protect = ["api", "-X", "PUT", `repos/${repo}/branches/${cfg.baseBranch}/protection`, "--input", file];
  if (dryRun) {
    console.log(`gh ${settings.join(" ")}\ngh ${protect.join(" ")}\n${JSON.stringify(protection, null, 2)}`);
    return 0;
  }
  gh(root, settings);
  gh(root, protect);
  console.log(`github: ${repo} merges by squash only. ${cfg.baseBranch} needs a PR, an up-to-date branch and a passing ${cfg.statusContext} status, for admins too. No approvals required.`);
  return 0;
}
