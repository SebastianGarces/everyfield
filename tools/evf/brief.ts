import { currentCatalog, fail, findPackage, loadConfig, loadDag, loadProgress, packageContext, pathsForPart, worktreePath, type TaskRef } from "./lib.ts";
import { renderFeedbackBrief } from "./feedback.ts";

export function renderBrief(root: string, task: TaskRef, opts: { uiTier?: string; full?: boolean }): string {
 if (task.kind === "fb") return renderFeedbackBrief(root,task);
 const context=packageContext(root,task.wp), pkg=findPackage(loadDag(root),task.wp);
 const progress=loadProgress(root);
 const L=[`# ${task.id}: ${pkg.title}`,`Worktree: ${worktreePath(root,loadConfig(root),task)}`,`Owning paths: ${pathsForPart(pkg,task.part).join(", ")}`,
 "Current product clauses are authoritative. Do not reconstruct old PD rulings or invent permission/methodology policy.",
 "Package completion requires all selected pages and applicable adapter cases, satisfied prerequisites and gates; merging one split part does not complete its package.",
 `Prerequisites: ${pkg.depends_on.map(d=>`${d}=${progress[d]?.status ?? "unknown"}`).join(", ") || "none"}`,
 `Selected acceptance bundles: ${context.acceptance_ids.join(", ")}`,
 `Selected cases: ${context.case_ids.join(", ")}`,
 "For the bounded overview: python3 docs/package-context.py "+task.wp,
 "Read every selected detail page: --part requirements|operations|aliases|cases|schema --page N. totalPages is mandatory scope, not optional reading.",
 "Maintain owned progress patches at start, blocker changes, reviewed milestones and handoff; only the integration owner updates canonical progress/explorer.",
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
