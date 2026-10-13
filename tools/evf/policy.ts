import { join } from 'node:path';
import { fail, findPackage, loadDag, loadProgress, loadConfig, readJson, type TaskRef } from './lib.ts';

/** Local reviewed source policy is an operator boundary, never inferred from a role flag or severity. */
export function requireImplementation(root:string,wp:string):void {
 const gates=readJson<{gates:Array<{id:string;status:string;work_packages:string[]}>}>(join(root,'docs/plan/release-gates.json')).gates;
 for(const id of ['G-AUTH','G-WORKFLOW']) {
  const g=gates.find(g=>g.id===id),expected=id==='G-AUTH'?'authorized':'reconciled-independent-review';
  if(g?.status!==expected) fail(`${id} is not closed for application implementation. Read-only briefs and this separately authorized local tooling task do not open the application gate.`);
 }
 const p=findPackage(loadDag(root),wp),progress=loadProgress(root);
 const blocked=p.depends_on.filter(id=>progress[id]?.status!=='done');
 if(blocked.length) fail(`Prerequisites not canonically done: ${blocked.join(', ')}. --allow-unready cannot grant implementation authority.`);
 }
/** Check actual paid commitments separately from local implementation and synthetic proof. */
export function requireSpend(root:string):void {
 const gates=readJson<{gates:Array<{id:string;status:string}>}>(join(root,'docs/plan/release-gates.json')).gates;
 if(!['approved','closed','passed'].includes(gates.find(g=>g.id==='G-SPEND')?.status??''))fail('G-SPEND must approve the concrete paid provider envelope before usage or subscription commitment.');
}

/** Intent's reviewed task scope supplies risk. Ordinary auto-merge never approves sensitive work. */
export function requireTaskRisk(root:string,task:TaskRef):void {
 const cfg=loadConfig(root) as ReturnType<typeof loadConfig>&{verification:{proofPlans:Record<string,{risk?:string}>}};
 const risk=cfg.verification.proofPlans[task.id]?.risk;
 if(risk==='ordinary')return;
 if(['sensitive','security','privacy','irreversible'].includes(risk??''))fail(`${task.id} is ${risk}; escalate through Intent's existing owner channel before implementation or merge. The scoped owner-approval adapter is not configured; ordinary automatic merge is no exception.`);
 fail('Missing reviewed task risk classification. Resolve it in the root Intent task/proof plan before implementation.');
}
