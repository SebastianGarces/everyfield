import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createHash, verify as verifySignature } from 'node:crypto';
import { join } from 'node:path';
import { baseRef, contractFingerprint, evidenceDir, evfDataDir, fail, fill, findPackage, loadDag, git, gitOk, hasRemote, isClean, loadConfig, packageContext, requireWorktree, run, runtimeDir, type TaskRef } from './lib.ts';
import { stackEnv, stackInfo } from './task.ts';
import { cachedTriage } from './feedback.ts';
import { proofPlan, requiredPortions, requiredGatePortions, type ProofPlan, type Portion } from './proof-plan.ts';
import { requireImplementation, requireSpend } from './policy.ts';

export type Role='author'|'verifier';
export type Mode='full'|'quick';
export type CheckResult={name:string;command:string[];exitCode:number;durationMs:number;log:string;logSha:string;passed:boolean};
type AttestationPayload={actorId:string;modelFamily:string;task:string;role:Role;mode:Mode;sha:string;baseSha:string;fingerprint:string;casePortions:Array<{caseId:string;portion:Portion}>;gatePortions:Array<{index:number;portion:Portion}>;checkDigest:string;passed:boolean};
type Attestation={payload:AttestationPayload;signature:string};
export type Proof={schema:2;task:string;role:Role;mode:Mode;kind:'tooling'|'application';sha:string;clean:boolean;unchanged:boolean;fingerprint:string;base:{ref:string;sha:string;included:boolean};acceptance:string[];expectedCases:string[];expectedGates:string[];plan:ProofPlan|null;checks:CheckResult[];passed:boolean;qualified:boolean;attestation:Attestation|null;startedAt:string;finishedAt:string;evidenceDir:string};
type Verification={usesPaidProviders:boolean;kind:'tooling'|'application';applicationQualified:boolean;attest:string[]|null;publicKey?:string;proofPlans?:Record<string,ProofPlan>};
const digest=(value:string|Buffer)=>createHash('sha256').update(value).digest('hex');
export function validAttestation(p:Proof,publicKey:string|undefined):boolean {
 if(!p.attestation||!publicKey) return false;
 const a=p.attestation.payload;
 if(a.task!==p.task||a.role!==p.role||a.mode!==p.mode||a.sha!==p.sha||a.baseSha!==p.base.sha||a.fingerprint!==p.fingerprint||a.checkDigest!==digest(JSON.stringify(p.checks))||a.passed!==true||typeof a.actorId!=='string'||!a.actorId||typeof a.modelFamily!=='string'||!a.modelFamily||!p.plan||JSON.stringify(a.casePortions)!==JSON.stringify(requiredPortions(p.plan))||JSON.stringify(a.gatePortions)!==JSON.stringify(requiredGatePortions(p.plan)))return false;
 try{return verifySignature(null,Buffer.from(JSON.stringify(a)),publicKey,Buffer.from(p.attestation.signature,'base64'));}catch{return false;}
}
export function verify(root:string,task:TaskRef,role:Role,mode:Mode):Proof {
 const wt=requireWorktree(root,loadConfig(root),task),cfg=loadConfig(wt);
 const settings=(cfg as typeof cfg & {verification?:Verification}).verification;
 if(!settings) fail('Configure an explicit tooling/application proof kind. Scaffold checks cannot qualify application acceptance.');
 if(hasRemote(root,cfg))git(root,'fetch','--quiet',cfg.remote,cfg.baseBranch);
 const ref=baseRef(root,cfg),baseSha=git(root,'rev-parse',ref),sha=git(wt,'rev-parse','HEAD'),clean=isClean(wt),fingerprint=contractFingerprint(wt);
 const wp=task.kind==='wp'?task.wp:cachedTriage(root,task.issue!)?.wp;
 if(!wp) fail('Missing reviewed task context.');
 const context=packageContext(wt,wp);
 if(settings.kind==='application'){requireImplementation(root,wp);if(typeof settings.usesPaidProviders!=='boolean')fail('Declare actual provider usage before application proof.');if(settings.usesPaidProviders)requireSpend(root);}
 const plan=settings.kind==='application'?proofPlan(wt,task,wp,context.case_ids):null;
 const expectedGates=(findPackage(loadDag(wt),wp)).acceptance_gates;
 const included=gitOk(wt,'merge-base','--is-ancestor',baseSha,'HEAD');
 const dir=evidenceDir(root,task,sha,`${role}-${mode}`);mkdirSync(dir,{recursive:true});
 const acceptance=context.acceptance_ids,expectedCases=context.case_ids;
 const vars={task:task.id,taskSlug:task.slug,wp,part:task.part??'',sha,worktree:wt,evidenceDir:dir,runtimeDir:runtimeDir(root,task),node:process.execPath,acGrep:[...acceptance,...expectedCases].join('|'),baseUrl:stackInfo(root,task).url??'',role,mode};
 const env={...stackEnv(root,task,wt),EVF_SHA:sha,EVF_EVIDENCE_DIR:dir,EVF_ROLE:role,EVF_MODE:mode,EVF_BASE_URL:vars.baseUrl};
 const startedAt=new Date().toISOString();const checks:CheckResult[]=[];
 for(const c of cfg.checks.filter(c=>!c.modes||c.modes.includes(mode))) {
  const argv=fill(c.run,vars),t0=Date.now(),r=run(argv[0],argv.slice(1),{cwd:wt,env});
  const log=join(dir,`${c.name.replace(/[^\w.-]+/g,'_')}.log`),bytes=`$ ${argv.join(' ')}\n\n${r.stdout}\n${r.stderr}`;writeFileSync(log,bytes);
  checks.push({name:c.name,command:argv,exitCode:r.code,durationMs:Date.now()-t0,log,logSha:digest(bytes),passed:r.code===0});
 }
 let attestation:Attestation|null=null;
 if(settings.kind==='application'&&settings.applicationQualified&&settings.attest) {
  // A separately trusted runner must reproduce/attest actual provider identity and evidence. CLI flags are only requests.
  const request=join(dir,'attestation-request.json');writeFileSync(request,JSON.stringify({task:task.id,role,mode,sha,baseSha,fingerprint,casePortions:plan?requiredPortions(plan):[],plan,gatePortions:plan?requiredGatePortions(plan):[],checkDigest:digest(JSON.stringify(checks))}));
  const argv=fill(settings.attest,{...vars,request});const r=run(argv[0],argv.slice(1),{cwd:wt,env});
  if(r.code===0){try{attestation=JSON.parse(r.stdout);}catch{fail('Malformed independent runner attestation.');}}
 }
 // Checks or runner may mutate files, HEAD or main. The recorded precheck state must never survive that mutation.
 const unchanged=git(wt,'rev-parse','HEAD')===sha&&isClean(wt)&&contractFingerprint(wt)===fingerprint&&git(root,'rev-parse',ref)===baseSha;
 const proof:Proof={schema:2,task:task.id,role,mode,kind:settings.kind,sha,clean,unchanged,fingerprint,base:{ref,sha:baseSha,included},acceptance,expectedCases,expectedGates,plan,checks,passed:clean&&unchanged&&included&&checks.length>0&&checks.every(c=>c.passed),qualified:false,attestation,startedAt,finishedAt:new Date().toISOString(),evidenceDir:dir};
 proof.qualified=settings.kind==='application'&&settings.applicationQualified&&(!plan!.requiresStack||!!cfg.stack?.up&&!!cfg.stack?.status)&&validAttestation(proof,settings.publicKey);
 if(settings.kind==='application'&&!proof.qualified)proof.passed=false;
 writeFileSync(join(dir,'proof.json'),JSON.stringify(proof,null,2)+'\n');
 console.log(`${proof.passed?'PASSED':'FAILED'} ${proof.kind} proof (${proof.qualified?'application qualified':'cannot ship application'}): ${join(dir,'proof.json')}`);return proof;
}
export function proofsFor(root:string,task:TaskRef):Proof[] {
 const base=join(evfDataDir(root),'evidence',task.slug);if(!existsSync(base))return [];
 const out:Proof[]=[];
 for(const sha of readdirSync(base))for(const label of readdirSync(join(base,sha))){const p=join(base,sha,label,'proof.json');if(existsSync(p)){const value=JSON.parse(readFileSync(p,'utf8'));if(value.schema===2)out.push(value);}}
 return out.sort((a,b)=>b.finishedAt.localeCompare(a.finishedAt));
}
export function shippable(p:Proof):boolean {return p.schema===2&&p.kind==='application'&&p.qualified===true&&p.passed===true&&p.clean===true&&p.unchanged===true&&p.base.included===true&&p.mode==='full'&&p.checks.length>0&&p.checks.every(c=>c.passed===true&&c.exitCode===0);}
/** Exact final head/current main/full proof and independently attested identity, never historical full + current quick. */
export function currentProof(root:string,task:TaskRef,role:Role):Proof {
 const cfg=loadConfig(root),wt=requireWorktree(root,cfg,task),sha=git(wt,'rev-parse','HEAD'),baseSha=git(root,'rev-parse',baseRef(root,cfg)),fingerprint=contractFingerprint(wt);
 if(!isClean(wt)||contractFingerprint(root)!==fingerprint)fail('Proof contract/policy must match reviewed root and clean task checkout.');
 const key=(cfg as typeof cfg & {verification:Verification}).verification.publicKey;
 const wp=task.kind==='wp'?task.wp:cachedTriage(root,task.issue!)?.wp;if(!wp)fail('Missing task package scope.');
 const context=packageContext(root,wp),plan=proofPlan(root,task,wp,context.case_ids);
 const expectedGates=findPackage(loadDag(root),wp).acceptance_gates;
 const bound=(p:Proof)=>p.task===task.id&&JSON.stringify(p.plan)===JSON.stringify(plan)&&p.expectedCases.slice().sort().join('\0')===context.case_ids.slice().sort().join('\0')&&p.acceptance.slice().sort().join('\0')===context.acceptance_ids.slice().sort().join('\0')&&JSON.stringify(p.expectedGates)===JSON.stringify(expectedGates)&&p.checks.every(c=>existsSync(c.log)&&digest(readFileSync(c.log))===c.logSha);
 const proof=proofsFor(root,task).find(p=>bound(p)&&p.role===role&&p.sha===sha&&p.base.sha===baseSha&&p.fingerprint===fingerprint&&shippable(p)&&validAttestation(p,key));
 if(!proof)fail(`No current full independently attested ${role} application proof for ${sha.slice(0,10)}. Scaffold/quick/historical proofs cannot ship.`);
 if(role==='verifier') {
  const author=proofsFor(root,task).find(p=>bound(p)&&p.role==='author'&&p.sha===sha&&p.base.sha===baseSha&&p.fingerprint===fingerprint&&shippable(p)&&validAttestation(p,key));
  if(!author||author.attestation!.payload.actorId===proof.attestation!.payload.actorId||author.attestation!.payload.modelFamily===proof.attestation!.payload.modelFamily)fail('Author and verifier require distinct trusted provider identities and model families at the same final head.');
 }
 return proof;
}
