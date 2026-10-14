import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync, unlinkSync } from 'node:fs';
import { createHash, verify as verifySignature } from 'node:crypto';
import { join } from 'node:path';
import { baseRef, contractFingerprint, evidenceDir, evfDataDir, fail, fill, findPackage, loadDag, git, gitOk, hasRemote, isClean, loadConfig, packageContext, parseTask, requireWorktree, run, runtimeDir, type TaskRef } from './lib.ts';
import { stackEnv, stackInfo } from './task.ts';
import { cachedTriage } from './feedback.ts';
import { proofPlan, requiredPortions, requiredGatePortions, type ProofPlan, type Portion } from './proof-plan.ts';
import { requireImplementation, requireSpend, requireTaskRisk, requireTaskScope, requireReviewedContract } from './policy.ts';
import { caseCoverage, caseGrep } from './coverage.ts';

export type Role='author'|'verifier';
export type Mode='full'|'quick';
export type CheckResult={name:string;command:string[];exitCode:number;durationMs:number;log:string;logSha:string;passed:boolean};
type AttestationPayload={actorId:string;modelFamily:string;task:string;role:Role;mode:Mode;sha:string;baseSha:string;fingerprint:string;casePortions:Array<{caseId:string;portion:Portion}>;gatePortions:Array<{index:number;portion:Portion}>;checkDigest:string;passed:boolean;review?:{verdict:'approved';reviewedSha:string;risk:ProofPlan['risk']}|null};
type Attestation={payload:AttestationPayload;signature:string};
export type Proof={schema:2;task:string;role:Role;mode:Mode;kind:'tooling'|'application';sha:string;clean:boolean;unchanged:boolean;fingerprint:string;base:{ref:string;sha:string;included:boolean};acceptance:string[];expectedCases:string[];expectedGates:string[];plan:ProofPlan|null;checks:CheckResult[];passed:boolean;qualified:boolean;attestation:Attestation|null;startedAt:string;finishedAt:string;evidenceDir:string};
type Verification={usesPaidProviders:boolean;kind:'tooling'|'application';applicationQualified:boolean;attest:string[]|null;publicKey?:string;proofPlans?:Record<string,ProofPlan>;testReport?:string};
const digest=(value:string|Buffer)=>createHash('sha256').update(value).digest('hex');
export function validAttestation(p:Proof,publicKey:string|undefined):boolean {
 if(!p.attestation||!publicKey) return false;
 const a=p.attestation.payload;
 if(p.role==='verifier'&&(a.review?.verdict!=='approved'||a.review.reviewedSha!==p.sha||a.review.risk!==p.plan?.risk))return false;
 if(a.task!==p.task||a.role!==p.role||a.mode!==p.mode||a.sha!==p.sha||a.baseSha!==p.base.sha||a.fingerprint!==p.fingerprint||a.checkDigest!==digest(JSON.stringify(p.checks))||a.passed!==true||typeof a.actorId!=='string'||!a.actorId||typeof a.modelFamily!=='string'||!a.modelFamily||!p.plan||JSON.stringify(a.casePortions)!==JSON.stringify(requiredPortions(p.plan))||JSON.stringify(a.gatePortions)!==JSON.stringify(requiredGatePortions(p.plan)))return false;
 try{return verifySignature(null,Buffer.from(JSON.stringify(a)),publicKey,Buffer.from(p.attestation.signature,'base64'));}catch{return false;}
}
export function verify(root:string,task:TaskRef,role:Role,mode:Mode):Proof {
 const wt=requireWorktree(root,loadConfig(root),task);
 requireReviewedContract(root,wt,task);
 const reviewedFingerprint=contractFingerprint(root),cfg=loadConfig(task.kind==='ops'?root:wt);
 const configured=(cfg as typeof cfg & {verification?:Verification}).verification;
 const settings=configured && (task.kind==='ops'?{...configured,kind:'tooling' as const}:configured);
 if(!settings) fail('Configure an explicit tooling/application proof kind. Scaffold checks cannot qualify application acceptance.');
 if(hasRemote(root,cfg))git(root,'fetch','--quiet',cfg.remote,cfg.baseBranch);
 const ref=baseRef(root,cfg),baseSha=git(root,'rev-parse',ref),sha=git(wt,'rev-parse','HEAD'),clean=isClean(wt),fingerprint=contractFingerprint(wt);
 const wp=task.kind==='wp'?task.wp:task.kind==='fb'?cachedTriage(root,task.issue!)?.wp:undefined;
 if(!wp&&task.kind!=='ops') fail('Missing reviewed task context.');
 const context=task.kind==='ops'?{acceptance_ids:[],case_ids:[]}:packageContext(wt,wp!);
 if(task.kind==='ops')requireTaskScope(root,task);
 if(settings.kind==='application'){requireImplementation(root,wp!);requireTaskRisk(root,task);if(typeof settings.usesPaidProviders!=='boolean')fail('Declare actual provider usage before application proof.');if(settings.usesPaidProviders)requireSpend(root);}
 const plan=settings.kind==='application'||task.kind==='ops'?proofPlan(task.kind==='ops'?root:wt,task,wp??'',context.case_ids):null;
 const expectedGates=task.kind==='ops'?[]:(findPackage(loadDag(wt),wp!)).acceptance_gates;
 const included=gitOk(wt,'merge-base','--is-ancestor',baseSha,'HEAD');
 const dir=evidenceDir(root,task,sha,`${role}-${mode}`);mkdirSync(dir,{recursive:true});
 const acceptance=context.acceptance_ids,expectedCases=context.case_ids;
 const vars={task:task.id,taskSlug:task.slug,wp:wp??'',part:task.part??'',sha,worktree:wt,evidenceDir:dir,runtimeDir:runtimeDir(root,task),node:process.execPath,acGrep:caseGrep(expectedCases),baseUrl:stackInfo(root,task).url??'',role,mode,testReport:join(dir,'tests.json')};
 const reportPath=fill([settings.testReport??'{testReport}'],vars)[0];
 if(settings.kind==='application'&&existsSync(reportPath))unlinkSync(reportPath);
 const env={...stackEnv(root,task,wt),EVF_SHA:sha,EVF_EVIDENCE_DIR:dir,EVF_ROLE:role,EVF_MODE:mode,EVF_BASE_URL:vars.baseUrl,EVF_TEST_REPORT:reportPath};
 const startedAt=new Date().toISOString();const checks:CheckResult[]=[];
 const checkDefs=task.kind==='ops'?cfg.maintenanceTasks![task.id].checks:cfg.checks;
 for(const c of checkDefs.filter(c=>!c.modes||c.modes.includes(mode))) {
  const argv=fill(c.run,vars),t0=Date.now(),r=run(argv[0],argv.slice(1),{cwd:wt,env});
  const log=join(dir,`${c.name.replace(/[^\w.-]+/g,'_')}.log`),bytes=`$ ${argv.join(' ')}\n\n${r.stdout}\n${r.stderr}`;writeFileSync(log,bytes);
  checks.push({name:c.name,command:argv,exitCode:r.code,durationMs:Date.now()-t0,log,logSha:digest(bytes),passed:r.code===0});
 }
 if(settings.kind==='application') {
  let coverage:{missing:string[];duplicates:unknown[]}={missing:expectedCases,duplicates:[]};let report:unknown=null;
  if(existsSync(reportPath)){report=JSON.parse(readFileSync(reportPath,'utf8'));coverage=caseCoverage(expectedCases,report);}
  const log=join(dir,'case-coverage.log'),bytes=JSON.stringify({report,coverage},null,2);writeFileSync(log,bytes);
  const passed=coverage.missing.length===0 && report!==null;
  checks.push({name:'case-coverage',command:['evf','coverage',reportPath],exitCode:passed?0:1,durationMs:0,log,logSha:digest(bytes),passed});
  if(coverage.duplicates.length)console.log('Review duplicate case coverage in '+log);
 }
 let attestation:Attestation|null=null;
 if((settings.kind==='application'&&settings.applicationQualified||task.kind==='ops')&&settings.attest) {
  // A separately trusted runner must reproduce/attest actual provider identity and evidence. CLI flags are only requests.
  const request=join(dir,'attestation-request.json');writeFileSync(request,JSON.stringify({task:task.id,role,mode,sha,baseSha,fingerprint,reviewRequired:role==='verifier',casePortions:plan?requiredPortions(plan):[],plan,gatePortions:plan?requiredGatePortions(plan):[],checkDigest:digest(JSON.stringify(checks))}));
  const argv=fill(settings.attest,{...vars,request});const r=run(argv[0],argv.slice(1),{cwd:wt,env});
  if(r.code===0){try{attestation=JSON.parse(r.stdout);}catch{fail('Malformed independent runner attestation.');}}
 }
 // Checks or runner may mutate files, HEAD or main. The recorded precheck state must never survive that mutation.
 const unchanged=contractFingerprint(root)===reviewedFingerprint&&git(wt,'rev-parse','HEAD')===sha&&isClean(wt)&&contractFingerprint(wt)===fingerprint&&git(root,'rev-parse',ref)===baseSha;
 const proof:Proof={schema:2,task:task.id,role,mode,kind:settings.kind,sha,clean,unchanged,fingerprint,base:{ref,sha:baseSha,included},acceptance,expectedCases,expectedGates,plan,checks,passed:clean&&unchanged&&included&&checks.length>0&&checks.every(c=>c.passed),qualified:false,attestation,startedAt,finishedAt:new Date().toISOString(),evidenceDir:dir};
 proof.qualified=(settings.kind==='application'&&settings.applicationQualified||task.kind==='ops')&&(!plan!.requiresStack||!!cfg.stack?.up&&!!cfg.stack?.status)&&validAttestation(proof,settings.publicKey);
 if((settings.kind==='application'||task.kind==='ops')&&!proof.qualified)proof.passed=false;
 writeFileSync(join(dir,'proof.json'),JSON.stringify(proof,null,2)+'\n');
 console.log(`${proof.passed?'PASSED':'FAILED'} ${proof.kind} proof (${proof.qualified?task.kind==='ops'?'maintenance qualified':'application qualified':'not qualified for shipping'}): ${join(dir,'proof.json')}`);return proof;
}
export function proofsFor(root:string,task:TaskRef):Proof[] {
 const base=join(evfDataDir(root),'evidence',task.slug);if(!existsSync(base))return [];
 const out:Proof[]=[];
 for(const sha of readdirSync(base))for(const label of readdirSync(join(base,sha))){const p=join(base,sha,label,'proof.json');if(existsSync(p)){const value=JSON.parse(readFileSync(p,'utf8'));if(value.schema===2)out.push(value);}}
 return out.sort((a,b)=>b.finishedAt.localeCompare(a.finishedAt));
}
export function shippable(p:Proof):boolean {return p.schema===2&&(p.kind==='application'||p.kind==='tooling'&&parseTask(p.task).kind==='ops')&&p.qualified===true&&p.passed===true&&p.clean===true&&p.unchanged===true&&p.base.included===true&&p.mode==='full'&&p.checks.length>0&&p.checks.every(c=>c.passed===true&&c.exitCode===0);}
/** Exact final head/current main/full proof and independently attested identity, never historical full + current quick. */
export function currentProof(root:string,task:TaskRef,role:Role):Proof {
 const cfg=loadConfig(root),wt=requireWorktree(root,cfg,task),sha=git(wt,'rev-parse','HEAD'),baseSha=git(root,'rev-parse',baseRef(root,cfg)),fingerprint=contractFingerprint(wt);
 if(!isClean(wt))fail('Proof requires a clean task checkout.');
 requireReviewedContract(root,wt,task);
 const key=(cfg as typeof cfg & {verification:Verification}).verification.publicKey;
 const wp=task.kind==='wp'?task.wp:task.kind==='fb'?cachedTriage(root,task.issue!)?.wp:undefined;if(!wp&&task.kind!=='ops')fail('Missing task package scope.');
 const context=task.kind==='ops'?{case_ids:[],acceptance_ids:[]}:packageContext(root,wp!),plan=proofPlan(root,task,wp??'',context.case_ids);
 const expectedGates=task.kind==='ops'?[]:findPackage(loadDag(root),wp!).acceptance_gates;
 const bound=(p:Proof)=>p.task===task.id&&JSON.stringify(p.plan)===JSON.stringify(plan)&&p.expectedCases.slice().sort().join('\0')===context.case_ids.slice().sort().join('\0')&&p.acceptance.slice().sort().join('\0')===context.acceptance_ids.slice().sort().join('\0')&&JSON.stringify(p.expectedGates)===JSON.stringify(expectedGates)&&p.checks.every(c=>existsSync(c.log)&&digest(readFileSync(c.log))===c.logSha);
 const proof=proofsFor(root,task).find(p=>bound(p)&&p.role===role&&p.sha===sha&&p.base.sha===baseSha&&p.fingerprint===fingerprint&&shippable(p)&&validAttestation(p,key));
 if(!proof)fail(`No current full independently attested ${role} ${task.kind==='ops'?'maintenance tooling':'application'} proof for ${sha.slice(0,10)}. Scaffold/quick/historical proofs cannot ship.`);
 if(role==='verifier') {
  const author=proofsFor(root,task).find(p=>bound(p)&&p.role==='author'&&p.sha===sha&&p.base.sha===baseSha&&p.fingerprint===fingerprint&&shippable(p)&&validAttestation(p,key));
  if(!author||author.attestation!.payload.actorId===proof.attestation!.payload.actorId||author.attestation!.payload.modelFamily===proof.attestation!.payload.modelFamily)fail('Author and verifier require distinct trusted provider identities and model families at the same final head.');
 }
 return proof;
}
