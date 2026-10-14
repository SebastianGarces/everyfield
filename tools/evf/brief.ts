import { currentCatalog, fail, findPackage, loadConfig, loadDag, loadProgress, packageContext, pathsForPart, worktreePath, type TaskRef } from "./lib.ts";
import { producerReady } from "./progress.ts";
import { renderFeedbackBrief } from "./feedback.ts";

export function renderBrief(root: string, task: TaskRef, opts: { uiTier?: string; full?: boolean }): string {
 if (task.kind === "fb") return renderFeedbackBrief(root,task);
 if(task.kind==='ops'){
  const cfg=loadConfig(root),scope=cfg.maintenanceTasks?.[task.id];
  if(!scope)fail('Configure the reviewed maintenance task title and owning paths first.');
  return [`# ${task.id}: ${scope.title}`,`Worktree: ${worktreePath(root,cfg,task)}`,`Owning paths: ${scope.owningPaths.join(', ')}`,'Proof kind: tooling only. No application cases, package gates or runtime.','Review and install the draft maintenance proof plan before starting.'].join('\n\n');
 }
 const context=packageContext(root,task.wp), pkg=findPackage(loadDag(root),task.wp);
 const progress=loadProgress(root);
 const L=[`# ${task.id}: ${pkg.title}`,`Goal: ${pkg.goal}`,`Outputs: ${pkg.outputs.join('\n')}`,`Owned requirements: ${context.own_requirement_ids.join(', ') || 'package output gates'}`,`Worktree: ${worktreePath(root,loadConfig(root),task)}`,`Owning paths: ${pathsForPart(pkg,task.part).join(", ")}`,
 "Current product clauses are authoritative. Do not reconstruct old PD rulings or invent permission/methodology policy.",
 "Package completion requires the selected obligations and applicable adapter cases, satisfied prerequisites and gates; merging one split part does not complete its package.",
 `Prerequisites: ${pkg.depends_on.map(d=>`${d}=${producerReady(root,d)?progress[d]?.status==='done'?'done':'reviewed producer/interface milestone':progress[d]?.status ?? "unknown"}`).join(", ") || "none"}`,
 `Selected acceptance bundles: ${context.acceptance_ids.join(", ")}`,
 `Selected acceptance count: ${context.acceptance_ids.length}`,
 `Owned cases: ${context.own_case_ids.join(", ") || "package output gates"}`,
 "For the bounded overview: python3 docs/package-context.py "+task.wp,
 "Start with the short package brief. Read linked chapters, schema and detailed clauses/cases on demand to resolve the task obligations.",
 "evf records shipped progress automatically; the coordinator acknowledges producer/interface milestones. Full closure stays at integration.",
 `UI tier: ${opts.uiTier ?? "not assigned"}. Implementation authorization and external operations remain separately gated.`];
 if(opts.full) for(const id of context.acceptance_ids) L.push(renderAc(root,id));
 return L.join("\n\n");
}
export function renderAc(root: string,id: string): string {
 const {registry,requirements,cases}=currentCatalog(root);
 const entries=registry.filter(e=>e.id===id || e.shared_gate_id===id);
 if (!entries.length) fail(`Unknown current acceptance ${id}.`);
 return entries.map(e=>[`## ${e.id} (${e.feature_id})`,...e.requirement_ids.map(id=>`${id}: ${requirements.get(id)!.text} (${requirements.get(id)!.spec})`),...e.case_ids.map(id=>`${id}: fixture ${cases.get(id)!.fixture}; expected ${cases.get(id)!.expected}`),`Operations: ${e.operations.join(", ")}. Packages: ${e.work_packages.join(", ")}.`].join("\n")).join("\n\n");
}
