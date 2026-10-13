import { fail, findPackage, loadConfig, loadDag, currentCatalog, partsOf, parseTask, type TaskRef } from './lib.ts';

export type Portion='reference'|'platform'|'contract'|'domain'|'native'|'assistant'|'integration';
export type CasePlan={id:string;requiredPortions:Portion[];deferred:Array<{portion:Portion;ownerTask:string}>};
export type GatePlan={index:number;requiredPortions:Portion[];deferred:Array<{portion:Portion;ownerTask:string}>};
export type ProofPlan={gates:GatePlan[];stage:'producer'|'contract'|'api'|'ui'|'full-target';ownedPortion:Portion;requiresStack:boolean;cases:CasePlan[]};
const portions=['reference','platform','contract','domain','native','assistant','integration'];
export function proofPlan(root:string,task:TaskRef,wp:string,expectedCases:string[]):ProofPlan {
 const cfg=loadConfig(root) as ReturnType<typeof loadConfig>&{verification:{proofPlans?:Record<string,ProofPlan>}};
 const plan=cfg.verification.proofPlans?.[task.id];
 if(!plan) fail('A reviewed task proof plan must select current-stage portions and explicitly account for later adapters before application qualification.');
 const stage=task.part??(['WP-056','WP-057'].includes(wp)?'full-target':'producer');
 if(plan.stage!==stage||!portions.includes(plan.ownedPortion)||typeof plan.requiresStack!=='boolean'||!Array.isArray(plan.cases))fail('Invalid reviewed proof stage.');
 const dag=loadDag(root),catalog=currentCatalog(root);
 const reaches=(owner:string,start:string,seen=new Set<string>()):boolean=>{
  if(owner===start)return true;if(seen.has(owner))return false;seen.add(owner);
  return findPackage(dag,owner).depends_on.some(id=>reaches(id,start,seen));
 };
 const expectedGates=findPackage(dag,wp).acceptance_gates;
 if(!Array.isArray(plan.gates)||plan.gates.length!==expectedGates.length||plan.gates.map(g=>g.index).sort((a,b)=>a-b).some((x,i)=>x!==i))fail('Proof plan must account for every package gate as staged portions, never claim whole later-runtime gates passed.');
 for(const g of plan.gates){
  const names=[...g.requiredPortions,...g.deferred.map(d=>d.portion)];
  if(!g.requiredPortions.includes(plan.ownedPortion)||new Set(names).size!==names.length||names.some(n=>!portions.includes(n)))fail('Every gate needs its own reviewed producer portion and nonduplicated future portions.');
  if(stage==='full-target'&&g.deferred.length)fail('Whole-target gate proof cannot defer portions.');
  for(const d of g.deferred){
   const owner=parseTask(d.ownerTask),sibling=owner.kind==='wp'&&owner.wp===wp&&(task.part==='contract'&&(owner.part==='api'||owner.part==='ui')||task.part==='api'&&owner.part==='ui'&&d.portion==='native');
   if(owner.kind!=='wp'||!sibling&&(owner.wp===wp||!reaches(owner.wp,wp)))fail('Deferred gate portion must name a downstream producer or valid later/peer adapter, never a prerequisite.');
  }
 }
 const selected=plan.cases.map(c=>c.id);
 if(new Set(selected).size!==selected.length||selected.slice().sort().join('\0')!==expectedCases.slice().sort().join('\0'))fail('Reviewed proof plan must account for every selected case exactly once.');
 for(const c of plan.cases){
  if(!Array.isArray(c.requiredPortions)||!Array.isArray(c.deferred))fail('Invalid case portion plan.');
  const names=[...c.requiredPortions,...c.deferred.map(d=>d.portion)];
  if(!names.length||new Set(names).size!==names.length||names.some(n=>!portions.includes(n)))fail(`Invalid/duplicated case portions for ${c.id}.`);
  const original=catalog.cases.get(c.id) as {work_packages?:string[]}|undefined;
  if((original?.work_packages?.includes(wp)||stage==='full-target')&&!c.requiredPortions.includes(plan.ownedPortion))fail(`Own ${plan.ownedPortion} portion omitted for ${c.id}.`);
  if(stage==='full-target'&&c.deferred.length)fail('Whole-target proof cannot defer any selected portion.');
  for(const d of c.deferred){
   const owner=parseTask(d.ownerTask);if(owner.kind!=='wp')fail('Deferred portions need a named producer/adapter task.');
   const sibling=owner.wp===wp&&partsOf(findPackage(dag,wp)).includes(owner.part) && (
    task.part==='contract' && (owner.part==='api'||owner.part==='ui') ||
    task.part==='api' && owner.part==='ui' && d.portion==='native'
   ); // API/UI can share a frozen contract in parallel; a peer UI deferral cannot omit this task's own domain portion.
   if(!sibling && (owner.wp===wp||!reaches(owner.wp,wp)||!original?.work_packages?.includes(owner.wp)))fail(`Deferred ${c.id}/${d.portion} must name its actual downstream owner, not an unrelated/current/prerequisite package.`);
  }
 }
 return plan;
}
export function requiredPortions(plan:ProofPlan):Array<{caseId:string;portion:Portion}> {
 return plan.cases.flatMap(c=>c.requiredPortions.map(portion=>({caseId:c.id,portion}))).sort((a,b)=>a.caseId.localeCompare(b.caseId)||a.portion.localeCompare(b.portion));
}

export function requiredGatePortions(plan:ProofPlan):Array<{index:number;portion:Portion}> {
 return plan.gates.flatMap(g=>g.requiredPortions.map(portion=>({index:g.index,portion}))).sort((a,b)=>a.index-b.index||a.portion.localeCompare(b.portion));
}
