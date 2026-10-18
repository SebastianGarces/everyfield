import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  evfDataDir,
  fail,
  baseRef,
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


function gh(cwd: string, args: string[]): string {
  const r = run("gh", args, { cwd });
  if (r.code !== 0) fail(`gh ${args.join(" ")} failed: ${(r.stderr || r.stdout).trim()}`);
  return r.stdout.trim();
}

function requireRemote(root: string, cfg: Config): void {
  if (!hasRemote(root, cfg)) fail(`No "${cfg.remote}" git remote yet. Create the GitHub repository, add the remote, then retry.`);
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

export function prOpen(root: string, task: TaskRef, bodyFile?: string): number {
  const cfg = loadConfig(root);
  const wp=task.kind==='wp'?task.wp:task.kind==='fb'?cachedTriage(root,task.issue!)?.wp:undefined;requireTaskScope(root,task,wp);
  requireRemote(root, cfg);
  const wt = requireWorktree(root, cfg, task);
  if (!isClean(wt)) fail("Commit your work first. The worktree is not clean.");
  const sha = git(wt, "rev-parse", "HEAD");
  git(root,"fetch","--quiet",cfg.remote,cfg.baseBranch);

  if(!bodyFile||!existsSync(bodyFile))fail('Write the PR body following the PR standard, then pass --body-file <file>.');
  pushBranch(wt,cfg,task);
  const proto = isPrototype(root, task);
  const existing = prFor(wt, task);
  if (existing && existing.state === "OPEN") {
    gh(wt,["pr","edit",String(existing.number),"--body-file",bodyFile]);
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
  console.log(`next: the coordinator delegates verification. The verifier runs: evf verify ${task.id} --role verifier, then evf ship ${task.id}`);
  return 0;
}

const FAMILIES=['openai','anthropic'];
export type Approval={head:string;verifierFamily:string;verdict:'approved'|'changes_requested';packageClosures?:string[]};
export type RequiredCheck={name:string;bucket:string;state:string;link:string};
export type MergeEvidence={head:string;authorFamily:string;approval:Approval;approvalUrl:string;checks:RequiredCheck[];checkedAt:string};
type PullRequest={number:number;body:string;headRefOid:string;baseRefName:string;state:string;isDraft:boolean};

function readApproval(input:unknown):Approval|null {
 if(!input||typeof input!=='object'||!('head' in input)||typeof input.head!=='string'||!/^([a-f0-9]{40})$/.test(input.head))return null;
 if(!('verifierFamily' in input)||typeof input.verifierFamily!=='string'||!FAMILIES.includes(input.verifierFamily))return null;
 if(!('verdict' in input)||(input.verdict!=='approved'&&input.verdict!=='changes_requested'))return null;
 let packageClosures:string[]|undefined;
 if('packageClosures' in input) {
  const values=input.packageClosures;
  if(!Array.isArray(values)||!values.every((id):id is string=>typeof id==='string'&&/^WP-\d{3}$/.test(id)))return null;
  packageClosures=values;
 }
 return {head:input.head,verifierFamily:input.verifierFamily,verdict:input.verdict,...(packageClosures?{packageClosures}: {})};
}

/** One unsigned review convention, shared by the verifier and GitHub merge workflow. */
export function checkPr(root:string,number:number,expectedHead?:string):MergeEvidence {
 const cfg=loadConfig(root);
 const pr:PullRequest=JSON.parse(gh(root,['pr','view',String(number),'--json','number,body,headRefOid,baseRefName,state,isDraft']));
 if(pr.state!=='OPEN'||pr.isDraft||pr.baseRefName!==cfg.baseBranch)fail('Shipping requires an open, ready PR targeting main.');
 if(expectedHead&&pr.headRefOid!==expectedHead)fail('PR head changed. Verify the new exact head before shipping.');
 const families=[...pr.body.matchAll(/^EVF-Author: (openai|anthropic)\s*$/gm)];
 if(families.length!==1)fail('PR body must record one EVF-Author model family.');
 const authorFamily=families[0][1];
 // gh discovers required checks from the PR's actual branch rules; absent and unreadable checks refuse.
 const result=run('gh',['pr','checks',String(number),'--required','--json','name,state,bucket,link'],{cwd:root});
 let checks:RequiredCheck[]=[];
 try{checks=JSON.parse(result.stdout);}catch{fail('Required GitHub CI is missing or unreadable.');}
 if(!Array.isArray(checks)||!checks.length)fail('Required GitHub CI is missing.');
 if(result.code!==0||checks.some(c=>!c||c.bucket!=='pass'||typeof c.name!=='string'||typeof c.link!=='string'))fail('Required GitHub CI must be green on the exact PR head.');
 const repo=nameWithOwner(root);
 const pages=JSON.parse(gh(root,['api',`repos/${repo}/issues/${number}/comments`,'--paginate','--slurp']));
 if(!Array.isArray(pages)||pages.some(page=>!Array.isArray(page)))fail('GitHub verifier comments are unreadable.');
 const comments=pages.flat();
 let selected:{approval:Approval;url:string}|undefined;
 for(const comment of comments)for(const match of String(comment?.body??'').matchAll(/^EVF-Review: (.+)$/gm)) {
  let value:unknown;try{value=JSON.parse(match[1]);}catch{continue;}
  const approval=readApproval(value);
  if(!approval||approval.head!==pr.headRefOid)continue;
  selected={approval,url:typeof comment.html_url==='string'?comment.html_url:''};
 }
 if(!selected?.url||selected.approval.verdict!=='approved')fail('Missing verifier approval for the exact PR head.');
 if(selected.approval.verifierFamily===authorFamily)fail('Verifier approval must come from a different model family.');
 // PR body section validation is added after the W4 template merges.
 const current:PullRequest=JSON.parse(gh(root,['pr','view',String(number),'--json','number,body,headRefOid,baseRefName,state,isDraft']));
 if(current.headRefOid!==pr.headRefOid||current.body!==pr.body||current.state!=='OPEN'||current.isDraft)fail('PR changed during merge checks. Run verification again.');
 return {head:pr.headRefOid,authorFamily,approval:selected.approval,approvalUrl:selected.url,checks,checkedAt:new Date().toISOString()};
}

export function ship(root:string,task:TaskRef):number {
 const cfg=loadConfig(root),wp=task.kind==='wp'?task.wp:task.kind==='fb'?cachedTriage(root,task.issue!)?.wp:undefined;
 requireTaskScope(root,task,wp);requireRemote(root,cfg);
 const wt=requireWorktree(root,cfg,task);
 if(isPrototype(root,task))fail(`${task.id} is a prototype. Sebastian approves it in chat before evf approve.`);
 if(!isClean(wt))fail('The task worktree must be clean before shipping.');
 const pr=prFor(wt,task);
 if(!pr||pr.state!=='OPEN')fail(`No open PR for ${task.branch}.`);
 if(cfg.mergePolicy.ordinary!=='automatic-after-independent-review')fail('Ordinary automatic merge is not approved.');
 const sha=git(wt,'rev-parse','HEAD'),baseSha=git(root,'merge-base',sha,baseRef(root,cfg));
 const verification=checkPr(wt,pr.number,sha);
 if(task.kind==='fb') {
  const cls=cachedTriage(root,task.issue!)?.class;
  if(!cls)fail('Feedback must be triaged before shipping.');
  if((cfg.mergePolicy.feedbackOwnerAfterVerifier as string[]).includes(cls)) {
   postStatus(wt,cfg,sha,'success',`Verified by ${verification.approval.verifierFamily} at ${sha.slice(0,10)}`);
   console.log(`PR #${pr.number} is verified and waits for Sebastian's chat approval, then evf approve.`);return 0;
  }
  if(!(cfg.mergePolicy.feedbackVerifierMerge as string[]).includes(cls))fail('This feedback class requires the owner approval route.');
 }
 const merge=run('gh',['pr','merge',String(pr.number),'--squash','--match-head-commit',sha],{cwd:wt});
 if(merge.code!==0)fail(`Merge refused: ${(merge.stderr||merge.stdout).trim()}. A changed head needs fresh CI and verifier approval.`);
 return afterMerge(root,cfg,task,wt,pr.number,verification,baseSha);
}

function afterMerge(root: string, cfg: Config, task: TaskRef, wt: string, prNumber: number, verification: MergeEvidence, baseSha: string): number {
  const mergeSha = gh(wt, ["pr", "view", String(prNumber), "--json", "mergeCommit", "-q", ".mergeCommit.oid"]);
  const record = {
    task: task.id,
    package_id: task.kind === "wp" ? task.wp : null,
    pr: prNumber,
    merge_commit: mergeSha,
    shipped_at: new Date().toISOString(),
    part: task.part,
    package_completion: false,
    verified_head: verification.head,
    base_sha: baseSha,
    verification,
    evidence: {
      path: taskPaths(root, task)[0] ?? "",
      commit: mergeSha,
      test: `GitHub required CI and ${verification.approval.verifierFamily} approval`,
      result: "passed",
      note: `${task.id} merged in PR #${prNumber} after cross-model verification at ${verification.head.slice(0,10)}. ${verification.approvalUrl}`,
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
  } // Acknowledgement clears the inbox and preserves milestone history.

  return 0;
}
