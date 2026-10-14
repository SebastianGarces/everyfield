import { currentCatalog, isUiPath, fail, findPackage, loadConfig, loadDag, loadProgress, packageContext, pathsForPart, prerequisitesForPart, worktreePath, run, type Case, type TaskRef } from "./lib.ts";
import { proofPlan } from "./proof-plan.ts";
import { producerReady } from "./progress.ts";
import { renderFeedbackBrief } from "./feedback.ts";

export function renderBrief(root: string, task: TaskRef, opts: { uiTier?: string; full?: boolean }): string {
 if (task.kind === "fb") return renderFeedbackBrief(root,task);
 if(task.kind==='ops'){
  const cfg=loadConfig(root),scope=cfg.maintenanceTasks?.[task.id];
  if(!scope)fail('Configure the reviewed maintenance task title and owning paths first.');
  let installed=false;try{proofPlan(root,task,'',[]);installed=true;}catch{}
  return [`# ${task.id}: ${scope.title}`,`Worktree: ${worktreePath(root,cfg,task)}`,`Owning paths: ${scope.owningPaths.join(', ')}`,'Proof kind: tooling only. No application cases, package gates or runtime.',installed?'The reviewed maintenance proof plan is installed.':'Review and install the draft maintenance proof plan before starting.'].join('\n\n');
 }
 const context=packageContext(root,task.wp), pkg=findPackage(loadDag(root),task.wp);
 const progress=loadProgress(root);
 const L=[`# ${task.id}: ${pkg.title}`,`Goal: ${pkg.goal}`,`Outputs: ${pkg.outputs.join('\n')}`,`Owned requirements: ${context.own_requirement_ids.join(', ') || 'package output gates'}`,`Worktree: ${worktreePath(root,loadConfig(root),task)}`,`Owning paths: ${pathsForPart(pkg,task.part).join(", ")}`,
 `Acceptance gates:\n${pkg.acceptance_gates.map((gate,index)=>`${index+1}. ${gate}`).join('\n')}`,
 `Proof stage: ${pkg.context_scope.proof_stage}`,
 `Integration and bounded ownership: ${pkg.integration_rule}`,
 `Fast track: ${pkg.fast_track?JSON.stringify(pkg.fast_track):'none'}`,
 `Owned operations: ${(context.own_operation_ids as string[]).join(', ') || 'none'}`,
 `Context-only cases, excluded from proof plans: ${(context.context_case_ids as string[]).join(', ') || 'none'}. Read any case with evf ac <case-id>.`,
 ...(pkg.ui_specialist?[`Public page work: ${pkg.ui_specialist} on ${pkg.ui_model}; reuse approved E3 pages and route remaining UI work to that specialist.`]:[]),
 ...(pkg.ui_composition_rule?[`UI guidance: ${pkg.ui_composition_rule}`]:[]),
 "Current product clauses are authoritative. Do not reconstruct old PD rulings or invent permission/methodology policy.",
 "Package completion requires the selected obligations and applicable adapter cases, satisfied prerequisites and gates; merging one split part does not complete its package.",
 `Prerequisites: ${prerequisitesForPart(pkg,task.part).map(d=>`${d}=${producerReady(root,d)?progress[d]?.status==='done'?'done':'reviewed producer/interface milestone':progress[d]?.status ?? "unknown"}`).join(", ") || "none"}`,
 `Selected acceptance bundles: ${context.acceptance_ids.join(", ")}`,
 `Selected acceptance count: ${context.acceptance_ids.length}`,
 `Write owned cases at package start for: ${(context.case_requirements_at_start as string[]).join(', ') || 'none'}`,
 `Owned cases: ${context.own_case_ids.join(", ") || "package output gates"}`,
 "For the bounded overview: python3 docs/package-context.py "+task.wp,
 "Start with the short package brief. Read linked chapters, schema and detailed clauses/cases on demand to resolve the task obligations.",
 pkg.fast_track?"Fast-track completion uses evf shipped --fast-track WP-097 --evidence <file>; see the ship skill for the bounded exception.":"evf records shipped progress automatically; the coordinator acknowledges producer/interface milestones. Full closure stays at integration.",
 `UI tier: ${opts.uiTier ?? "not assigned"}. Implementation authorization and external operations remain separately gated.`];
 const ui=task.part==='ui'||task.part===null&&(pkg.ui_specialist||pkg.owning_paths.some(isUiPath));
 if(ui){
  const result=run('python3',[root+'/docs/package-context.py',task.wp,'--root',root],{cwd:root});
  if(result.code!==0)fail(result.stderr||result.stdout);
  const design=JSON.parse(result.stdout).design_links;
  if(design)L.push(`Design prototype: ${design.prototype}`,`Screen map: ${design.screen_map}`, ...design.rows.map((row:{line:number;screen:string;source:string})=>`${row.source}: ${row.screen}`),design.reading);
 }
 if(opts.full) for(const id of context.acceptance_ids) L.push(renderAc(root,id));
 return L.join("\n\n");
}
export function renderAc(root: string,id: string): string {
 const {registry,requirements,cases}=currentCatalog(root);
 if(cases.has(id))return renderCase(cases.get(id)!);
 const entries=registry.filter(e=>e.id===id || e.shared_gate_id===id);
 if (!entries.length) fail(`Unknown current acceptance ${id}.`);
 return entries.map(e=>[`## ${e.id} (${e.feature_id})`,...e.requirement_ids.map(id=>`${id}: ${requirements.get(id)!.text} (${requirements.get(id)!.spec})`),...e.case_ids.map(id=>renderCase(cases.get(id)!)),`Operations: ${e.operations.join(", ")}. Packages: ${e.work_packages.join(", ")}.`].join("\n")).join("\n\n");
}

function renderCase(c:Case):string {
 const fields=['given','actor','clock','action','expected','group','subcases'] as const;
 return [`### ${c.id}: ${c.description}`,...fields.filter(key=>key in c).map(key=>`${key}:\n\`\`\`json\n${JSON.stringify(c[key],null,2)}\n\`\`\``)].join('\n\n');
}
