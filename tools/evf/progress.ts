import { existsSync, mkdirSync, writeFileSync, openSync, closeSync, unlinkSync, renameSync } from 'node:fs';
import { join } from 'node:path';
import { baseRef, evfDataDir, fail, findPackage, git, gitOk, loadConfig, loadDag, loadProgress, packageContext, parseTask, partsOf, pathsForPart, readJson } from './lib.ts';
import { shippable, validAttestation, type Proof } from './verify.ts';

export type ShippedRecord = {
 task:string; package_id:string|null; part:string|null; merge_commit:string; shipped_at:string;
 proof:Proof; author_proof:Proof; acknowledged?:boolean;
 evidence:{path:string;commit:string;test:string;result:string;note:string};
};
type Milestone = {task:string;merge_commit:string;acknowledged:boolean;stage:string;passed_case_portions:unknown[];passed_gate_portions:unknown[];deferred_case_portions:unknown[];deferred_gate_portions:unknown[]};
type ProgressPackage = {status:string;revision:number;updated_at:string|null;evidence:ShippedRecord['evidence'][];notes:string;milestones?:Record<string,Milestone>};
type Progress = {revision:number;updated_at:string;packages:Record<string,ProgressPackage>};

function retained(root:string,task:string):ShippedRecord|null {
 const path=join(evfDataDir(root),'shipped',`${parseTask(task).slug}.json`);
 return existsSync(path)?readJson<ShippedRecord>(path):null;
}
/** Re-check the signed producer and its actual merged bytes, not a caller-created status flag. */
export function reviewedMilestone(root:string,record:ShippedRecord):boolean {
 const task=parseTask(record.task),cfg=loadConfig(root);
 if(task.kind!=='wp'||record.package_id!==task.wp||record.part!==task.part)return false;
 const key=(cfg as typeof cfg & {verification:{publicKey?:string}}).verification.publicKey;
 const p=record.proof,a=record.author_proof;
 if(!p||!a||p.task!==task.id||a.task!==task.id||p.role!=='verifier'||a.role!=='author'||p.sha!==a.sha||p.base.sha!==a.base.sha||p.fingerprint!==a.fingerprint||!shippable(p)||!shippable(a)||!validAttestation(p,key)||!validAttestation(a,key)||p.attestation!.payload.actorId===a.attestation!.payload.actorId||p.attestation!.payload.modelFamily===a.attestation!.payload.modelFamily)return false;
 const installed=JSON.parse(git(root,'show',`${p.sha}:evf.config.json`)).verification.proofPlans?.[task.id];
 if(JSON.stringify(p.plan)!==JSON.stringify(installed)||JSON.stringify(a.plan)!==JSON.stringify(installed))return false;
 if(!gitOk(root,'merge-base','--is-ancestor',record.merge_commit,baseRef(root,cfg)))return false;
 const paths=pathsForPart(findPackage(loadDag(root),task.wp),task.part);
 const tested=git(root,'diff','--binary',p.base.sha,p.sha,'--',...paths);
 return !!tested&&tested===git(root,'diff','--binary',`${record.merge_commit}^`,record.merge_commit,'--',...paths);
}
export function producerReady(root:string,wp:string):boolean {
 const p=loadProgress(root)[wp];
 if(p?.status==='done')return true;
 const pkg=findPackage(loadDag(root),wp),parts=partsOf(pkg);
 const anchor=parts.includes('contract')?'contract':parts.includes('api')?'api':null;
 const task=anchor?`${wp}/${anchor}`:wp,record=retained(root,task);
 const progress=readJson<Progress>(join(root,'docs/build-progress.json'));
 const milestone=progress.packages[wp]?.milestones?.[task];
 return !!record?.acknowledged&&milestone?.acknowledged===true&&milestone.merge_commit===record.merge_commit&&reviewedMilestone(root,record);
}
/** Only evf writes canonical progress. Lock and atomic rename protect concurrent ships/acks. */
export function recordProgress(root:string,record:ShippedRecord,acknowledged:boolean):void {
 if(record.package_id===null)return; // Feedback and upkeep do not complete build packages.
 if(!reviewedMilestone(root,record))fail('Progress requires independently reviewed, integrated shipped proof.');
 const dir=evfDataDir(root);mkdirSync(dir,{recursive:true});
 const lock=join(dir,'progress.lock');let fd:number;
 try{fd=openSync(lock,'wx');}catch{fail('Progress writer is busy. Retry after the other evf operation completes; reconcile a stale lock before retrying.');}
 const path=join(root,'docs/build-progress.json'),temp=join(root,`docs/.build-progress-${process.pid}.tmp`);
 try{
  const progress=readJson<Progress>(path),p=progress.packages[record.package_id];
  if(!p)fail(`Unknown progress package ${record.package_id}.`);
  const plan=record.proof.plan!;
  const milestone:Milestone={task:record.task,merge_commit:record.merge_commit,acknowledged,stage:plan.stage,
   passed_case_portions:record.proof.attestation!.payload.casePortions,passed_gate_portions:record.proof.attestation!.payload.gatePortions,
   deferred_case_portions:plan.cases.flatMap(c=>c.deferred.map(d=>({caseId:c.id,...d}))),deferred_gate_portions:plan.gates.flatMap(g=>g.deferred.map(d=>({gateIndex:g.index,...d})))};
  if(p.milestones?.[record.task]?.acknowledged)milestone.acknowledged=true;
  if(JSON.stringify(p.milestones?.[record.task])===JSON.stringify(milestone))return;
  p.milestones={...p.milestones,[record.task]:milestone};
  if(!p.evidence.some(e=>e.commit===record.merge_commit&&e.test===record.evidence.test))p.evidence.push(record.evidence);
  if(p.status!=='done')p.status='in_progress';
  p.notes='Reviewed task milestones retained; full package closure remains at integration.';
  p.revision++;p.updated_at=new Date().toISOString();progress.revision++;progress.updated_at=p.updated_at;
  if(acknowledged&&plan.packageClosures?.length){
   const pending=new Set(plan.packageClosures.map(c=>c.packageId)),dag=loadDag(root);
   while(pending.size){
    let advanced=false;
    for(const wp of pending){
     const pkg=findPackage(dag,wp),target=progress.packages[wp];
     if(pkg.depends_on.some(id=>progress.packages[id].status!=='done'))continue;
     const parts=partsOf(pkg).map(part=>part?`${wp}/${part}`:wp);
     if(parts.some(id=>!target.milestones?.[id]?.acknowledged||!retained(root,id)||!reviewedMilestone(root,retained(root,id)!)))fail(`Closure requires every reviewed merged part of ${wp}.`);
     const passed=new Set(record.proof.attestation!.payload.casePortions.filter(c=>c.portion==='integration').map(c=>c.caseId));
     if(packageContext(root,wp).case_ids.some(id=>!passed.has(id)))fail(`Closure needs full integration evidence for every ${wp} case.`);
     if(target.status!=='done'){target.status='done';target.evidence.push(record.evidence);target.notes=`Full package gates and cases reviewed at integration by ${record.task}.`;target.revision++;target.updated_at=p.updated_at;}
     pending.delete(wp);advanced=true;
    }
    if(!advanced)fail(`Closure requires canonically done direct prerequisites: ${[...pending].join(', ')}.`);
   }
  }
  writeFileSync(temp,JSON.stringify(progress,null,2)+'\n');renameSync(temp,path);
 }finally{if(existsSync(temp))unlinkSync(temp);closeSync(fd);unlinkSync(lock);}
}
