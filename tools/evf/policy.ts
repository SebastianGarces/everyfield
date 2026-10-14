import { join } from 'node:path';
import { baseRef, contractFingerprint, git, fail, findPackage, loadDag, loadConfig, readJson, type TaskRef } from './lib.ts';
import { producerReady } from './progress.ts';

/** Local reviewed source policy is an operator boundary, never inferred from a role flag or severity. */
export function requireImplementation(root:string,wp:string):void {
 const gates=readJson<{gates:Array<{id:string;status:string;scope?:string;work_packages:string[]}>}>(join(root,'docs/plan/release-gates.json')).gates;
 for(const id of ['G-AUTH','G-WORKFLOW']) {
  const g=gates.find(g=>g.id===id),expected=id==='G-AUTH'?'authorized':'reconciled-independent-review';
  if(!g||(g.scope!=='global' && g.work_packages?.length!==0)||g.status!==expected) fail(`${id} is not closed for application implementation. Global action gates apply to every application package; read-only work does not open them.`);
 }
 const p=findPackage(loadDag(root),wp);
 const blocked=p.depends_on.filter(id=>!producerReady(root,id));
 if(blocked.length) fail(`Prerequisites need reviewed producer/interface milestones: ${blocked.join(', ')}. --allow-unready cannot grant implementation authority.`);
 }
/** Check actual paid commitments separately from local implementation and synthetic proof. */
export function requireSpend(root:string):void {
 const gates=readJson<{gates:Array<{id:string;status:string}>}>(join(root,'docs/plan/release-gates.json')).gates;
 if(!['approved','closed','passed'].includes(gates.find(g=>g.id==='G-SPEND')?.status??''))fail('G-SPEND must approve the concrete paid provider envelope before usage or subscription commitment.');
}

export function requireTaskScope(root:string,task:TaskRef,wp?:string):void {
 if(task.kind==='ops') {
  const scope=loadConfig(root).maintenanceTasks?.[task.id];
  if(!scope?.title||!scope.owningPaths.length||!scope.checks?.length)fail('Maintenance requires a reviewed title, owning paths and local tooling checks in maintenanceTasks.');
  if(scope.configChanges?.some(key=>!['stack','checks'].includes(key))||scope.configChanges?.length&&!scope.owningPaths.includes('evf.config.json'))fail('Maintenance config changes require owning evf.config.json and reviewed stack/checks fields only.');
  const files=['README.md','AGENTS.md','evf.config.json','skills-lock.json','.gitignore','bin/evf'];
  const directories=['.agents/','.claude/','docs/','tools/evf/','.github/'];
  if(scope.owningPaths.some(path=>path.split('/').includes('..')||!files.includes(path)&&!directories.some(dir=>path.startsWith(dir))))fail('Maintenance owning paths must stay in documentation and workflow tooling; OPS cannot authorize application code.');
 } else {
  if(!wp)fail('Missing reviewed task scope.');
  requireImplementation(root,wp);
 }
 requireTaskRisk(root,task);
}

/** Intent's reviewed task scope supplies risk. Ordinary auto-merge never approves sensitive work. */
export function requireTaskRisk(root:string,task:TaskRef):void {
 const cfg=loadConfig(root) as ReturnType<typeof loadConfig>&{verification:{proofPlans:Record<string,{risk?:string}>}};
 const risk=cfg.verification.proofPlans[task.id]?.risk;
 if(risk==='ordinary')return;
 if(['sensitive','security','privacy','irreversible'].includes(risk??''))fail(`${task.id} is ${risk}; escalate through Intent's existing owner channel before implementation or merge. The scoped owner-approval adapter is not configured; ordinary automatic merge is no exception.`);
 fail('Missing reviewed task risk classification. Resolve it in the root Intent task/proof plan before implementation.');
}

/** OPS may change reviewed subjects, but never its own runner, key, scope or proof authority. */
export function requireReviewedContract(root:string,wt:string,task:TaskRef):void {
 if(task.kind!=='ops') {
  if(contractFingerprint(root)!==contractFingerprint(wt))fail('Verification contract/policy must match the reviewed root before any check or runner executes; worktree flags cannot downgrade application/risk gates.');
  return;
 }
 requireTaskScope(root,task);
 const cfg=loadConfig(root),candidate=loadConfig(wt),scope=cfg.maintenanceTasks![task.id];
 const owns=(path:string)=>scope.owningPaths.some(p=>p.endsWith('/')?path.startsWith(p):path===p);
 // Check the whole candidate diff, including subjects outside the policy fingerprint.
 const changed=git(wt,'diff','--name-only','--no-renames',baseRef(root,cfg),'HEAD').split('\n').filter(Boolean);
 if(changed.some(p=>!owns(p)))fail('Maintenance candidate changes paths outside its reviewed owning paths.');
 const authority=structuredClone(candidate);
 for(const key of scope.configChanges??[])authority[key]=cfg[key];
 if(JSON.stringify(authority)!==JSON.stringify(cfg))fail('Maintenance cannot change runner, keys, proof plans or unreviewed config fields.');
 if(contractFingerprint(root,p=>p!=='evf.config.json'&&owns(p),cfg)!==contractFingerprint(wt,p=>p!=='evf.config.json'&&owns(p),authority))fail('Maintenance contract outside reviewed owning paths must match the reviewed root.');
}
