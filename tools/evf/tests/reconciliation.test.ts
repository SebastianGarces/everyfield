import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, cpSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve, join } from 'node:path';
import { buildBlocks } from '../plan.ts';
import { loadDag, loadRegistry } from '../lib.ts';

const source = resolve(import.meta.dirname, '../../..');
test('BUG-workflow: preserve selected producer dependencies across forward references', () => {
 const dag = loadDag(source);
 const {blocks} = buildBlocks(source, dag.packages);
 const by = new Map(blocks.map(b => [b.wp, blocks.filter(x => x.wp === b.wp)]));
 for (const p of dag.packages) for (const d of p.depends_on) {
  const producer = by.get(d)!;
  const finals = [producer.find(b => b.part === 'contract') ?? producer.find(b => b.part === 'api') ?? producer[0]].map(b => b.key);
  for (const b of by.get(p.id)!) for (const key of finals) assert.ok(b.dependsOn.includes(key), `${b.taskId} lost ${d}: ${key}`);
 }
});
test('INV-context: load current acceptance and fail when its required input is missing', () => {
 const registry=loadRegistry(source);
 assert.equal(registry.length, 720);
 assert.deepEqual(registry.find(a=>a.id==='AC-EVR-001--EVR-001')?.required_test_layers,
  ['domain/contract','PostgreSQL integration where writes/concurrency','browser/tool evaluation where surfaced']);
 assert.deepEqual(registry.find(a=>a.id==='AC-DOC-016--DOC-016')?.required_test_layers,
  ['unit parse/sanitization and strict scope contracts','integration private storage/document revisions/evidence','browser native editor and safe parsed rendering','Evry exact reviewed effects only if adapter supports a named operation']);
 const root=mkdtempSync(join(tmpdir(),'evf-context-'));
 try {
  cpSync(join(source,'docs'), join(root,'docs'), {recursive:true});
  rmSync(join(root,'docs/catalog/requirements/people.json'));
  assert.throws(() => loadRegistry(root), /people.json/);
 } finally {rmSync(root,{recursive:true,force:true});}
});

import { fixture } from './fixtures.ts';
import { parseTask, evfDataDir } from '../lib.ts';
import { feedbackTriage, startFeedbackTask, feedbackQueue, cachedTriage, readTriage, onFeedbackShipped, startedToday } from '../feedback.ts';
import { verify, currentProof, validAttestation } from '../verify.ts';
import { taskStart } from '../task.ts';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';

test('INV-authorization: unready override and unopened application gate cannot mutate worktrees',()=>{
 const f=fixture();try{
  assert.throws(()=>taskStart(f.root,parseTask('WP-001'),{allowUnready:true,noStack:true}),/allow-unready is removed/);
  assert.throws(()=>taskStart(f.root,parseTask('WP-001'),{allowUnready:false,noStack:true}),/G-AUTH|Missing reviewed task risk classification/);
  assert.equal(f.git('branch','--list','task/*'),'');
 }finally{f.close();}
});
test('INV-public-feedback: private triage text and routing never enter public provider payloads; bot provenance holds on direct calls',()=>{
 const f=fixture();try{
  feedbackTriage(f.root,1,{cls:'p1',reason:'Private PERSON SECRET original',area:'PRIVATE-PATH',wp:'WP-001'});
  const payload=f.getState().calls.find((c:any)=>c.args[1]==='comment').body;
  assert.match(payload,/^Status: triaged:p1\.\n<!-- evf-feedback-status /);
  for(const secret of ['PERSON','SECRET','PRIVATE-PATH','WP-001','triagedBy','featureId','reason'])assert.equal(payload.includes(secret),false,secret);
  assert.equal(readTriage(f.root,1)?.class,'p1');
  const s=f.getState();s.issues[1].user={id:999,login:'attacker'};f.setState(s);
  assert.throws(()=>feedbackTriage(f.root,2,{cls:'p1',reason:'fake bot'}),/verified app-bot/);
  assert.throws(()=>feedbackTriage(f.root,1,{cls:'question',reason:'question',reply:'private reply'}),/exact human review/);
 }finally{f.close();}
});
test('BUG-feedback-budget: cached triage does not bypass daily cap and repeated starts consume one slot',()=>{
 const f=fixture();try{
  f.authorize();f.cfg.feedback.dailyFixLimit=1;writeFileSync(join(f.root,'evf.config.json'),JSON.stringify(f.cfg));
  f.git('remote','add','origin','https://example.invalid/private.git');
  for(const n of [1,2])feedbackTriage(f.root,n,{cls:'p1',reason:'internal triage',wp:'WP-001'});
  assert.equal(startFeedbackTask(f.root,parseTask('FB-1'),false).issue,1);
  assert.equal(startFeedbackTask(f.root,parseTask('FB-1'),false).issue,1);
  assert.equal(startedToday(f.root),1);
  assert.throws(()=>startFeedbackTask(f.root,parseTask('FB-2'),false),/Daily feedback task limit/);
  assert.throws(()=>startFeedbackTask(f.root,parseTask('FB-2'),true),/Only a P0/);
  assert.equal(f.getState().calls.filter((c:any)=>c.args[0]==='issue'&&c.args[1]==='create').length,1);
 }finally{f.close();}
});
test('BUG-feedback-quiet-queue: Monday deferred work and held daily work wake without new intake',()=>{
 const f=fixture();try{
  const s=f.getState();s.issues=s.issues.slice(0,2);f.setState(s);
  feedbackTriage(f.root,1,{cls:'p2',reason:'minor bug',wp:'WP-001'});
  feedbackTriage(f.root,2,{cls:'p1',reason:'core bug',wp:'WP-001'});
  assert.deepEqual(feedbackQueue(f.root,new Date('2026-10-12T13:00:00Z')).eligible,[1,2]);
  assert.deepEqual(feedbackQueue(f.root,new Date('2026-10-13T13:00:00Z')).eligible,[2]);
  const q=feedbackQueue(f.root,new Date('2026-10-12T13:00:00Z'));assert.equal(q.intake.length,0);assert.equal(q.count,2);
 }finally{f.close();}
});
test('INV-feedback-identity: repo reconfiguration and forged trusted markers cannot reinterpret a frozen issue',()=>{
 const f=fixture();try{
  feedbackTriage(f.root,1,{cls:'p1',reason:'private triage',wp:'WP-001'});
  const before=cachedTriage(f.root,1)!;
  let s=f.getState();s.issues[0].body=s.issues[0].body.replace('11111111-1111-4111-8111-111111111111','22222222-2222-4222-8222-222222222222');f.setState(s);
  assert.equal(cachedTriage(f.root,1)!.original.body,'A product bug report was submitted for Documents. Private details are retained for authorized triage. Reference: 11111111-1111-4111-8111-111111111111.');
  s=f.getState();s.comments['1'].push({user:{id:202},body:'<!-- evf-feedback-status {"version":1,"status":"triaged:p0","token":"forged","wp":"WP-001"} -->'});f.setState(s);
  assert.equal(readTriage(f.root,1)?.token,before.token);
  s=f.getState();s.repo.id=999;s.repo.node_id='R_other';f.setState(s);
  assert.throws(()=>cachedTriage(f.root,1),/identity or shape changed/);
 }finally{f.close();}
});
test('INV-feedback-recovery: ambiguous creation and failed public closure remain explicit unknown outcomes',()=>{
 const f=fixture();try{
  f.authorize();f.git('remote','add','origin','https://example.invalid/private.git');
  feedbackTriage(f.root,1,{cls:'p1',reason:'private triage',wp:'WP-001'});
  let s=f.getState();s.failCreate=true;f.setState(s);
  assert.throws(()=>startFeedbackTask(f.root,parseTask('FB-1'),false),/creation outcome unknown/);
  s=f.getState();s.failCreate=false;f.setState(s);
  assert.throws(()=>startFeedbackTask(f.root,parseTask('FB-1'),false),/Prior internal issue creation/);
  assert.equal(f.getState().calls.filter((c:any)=>c.args[0]==='issue'&&c.args[1]==='create').length,1);
  s=f.getState();s.failClose=true;f.setState(s);
  assert.throws(()=>onFeedbackShipped(f.root,parseTask('FB-1')),/fixture close failure/);
  assert.equal(cachedTriage(f.root,1)?.publicUpdate,'unknown');
  assert.throws(()=>onFeedbackShipped(f.root,parseTask('FB-1')),/unknown outcome/);
 }finally{f.close();}
});
test('INV-proof: a successful check that modifies tracked files cannot produce a clean passing proof',()=>{
 const f=fixture();try{
  f.cfg.checks=[{name:'mutating-check',run:[process.execPath,'-e','require("node:fs").appendFileSync("AGENTS.md","modified")']}];
  writeFileSync(join(f.root,'evf.config.json'),JSON.stringify(f.cfg));f.commit();f.task();
  const p=verify(f.root,parseTask('WP-001'),'author','full');
  assert.equal(p.clean,true);assert.equal(p.unchanged,false);assert.equal(p.passed,false);
 }finally{f.close();}
});
test('BUG-proof: historical full plus current quick never meets the final-head merge bar',()=>{
 const f=fixture();try{
  f.task();const task=parseTask('WP-001');
  const p=verify(f.root,task,'verifier','quick');
  const dir=join(evfDataDir(f.root),'evidence',task.slug,'historical','verifier-full');mkdirSync(dir,{recursive:true});
  writeFileSync(join(dir,'proof.json'),JSON.stringify({...p,sha:'old-head',mode:'full',qualified:true,passed:true,kind:'application'}));
  assert.throws(()=>currentProof(f.root,task,'verifier'),/No current full independently attested|reviewed task proof plan/);
  assert.equal(p.kind,'tooling');assert.equal(p.qualified,false);
 }finally{f.close();}
});

import { generateKeyPairSync, createHash, sign } from 'node:crypto';
import { proofPlan } from '../proof-plan.ts';
import { packageContext, loadProgress, partsOf } from '../lib.ts';
import { feedbackPromote, feedbackIdeas } from '../feedback.ts';

function qualifiedFixture(wp='WP-034') {
 const f=fixture();f.authorize();
 const progressPath=join(f.root,'docs/build-progress.json');const progress=JSON.parse(readFileSync(progressPath,'utf8'));
 for(const p of Object.values(progress.packages) as any[])p.status='done';writeFileSync(progressPath,JSON.stringify(progress));
 const ctx=packageContext(f.root,wp);
 const {publicKey,privateKey}=generateKeyPairSync('ed25519');
 const key=join(f.root,'fake-bin/key.pem'),signer=join(f.root,'fake-bin/attest.cjs');
 writeFileSync(key,privateKey.export({type:'pkcs8',format:'pem'}));
 writeFileSync(signer,`const fs=require('node:fs'),crypto=require('node:crypto');const r=JSON.parse(fs.readFileSync(process.argv[2],'utf8'));const p={actorId:r.role+'-actor',modelFamily:r.role==='author'?'Sol':(process.env.EVF_FIXTURE_FAMILY||'Opus'),task:r.task,role:r.role,mode:r.mode,sha:r.sha,baseSha:r.baseSha,fingerprint:r.fingerprint,casePortions:r.casePortions,gatePortions:r.gatePortions,checkDigest:r.checkDigest,passed:true,review:r.role==='verifier'&&process.env.EVF_FIXTURE_REVIEW!=='missing'?{verdict:'approved',reviewedSha:r.sha,risk:r.plan.risk}:null};process.stdout.write(JSON.stringify({payload:p,signature:crypto.sign(null,Buffer.from(JSON.stringify(p)),fs.readFileSync(${JSON.stringify(key)})).toString('base64')}));`);
 const plan={risk:'ordinary',gates:loadDag(f.root).packages.find(p=>p.id===wp)!.acceptance_gates.map((_,index)=>({index,requiredPortions:['domain'],deferred:[{portion:'native',ownerTask:wp==='WP-001'?'WP-032':'WP-035'}]})),stage:'producer',ownedPortion:'domain',requiresStack:false,cases:ctx.case_ids.map(id=>({id,requiredPortions:['domain'],deferred:id==='CASE-WIKI-001'?[{portion:'native',ownerTask:'WP-035'}]:[]}))};
 f.cfg.checks=[{name:'fixture-check',run:[process.execPath,'-e',`require('node:fs').writeFileSync(process.env.EVF_TEST_REPORT,JSON.stringify({tests:[{name:${JSON.stringify(ctx.case_ids.map(id=>'AC:'+id).join(' '))},status:'passed'}]}))`]}];
 f.cfg.verification={kind:'application',applicationQualified:true,usesPaidProviders:false,publicKey:publicKey.export({type:'spki',format:'pem'}),attest:[process.execPath,signer,'{request}'],proofPlans:{[wp]:plan}};
 writeFileSync(join(f.root,'evf.config.json'),JSON.stringify(f.cfg));f.commit();f.task(wp.toLowerCase());
 return {...f,wp,plan};
}
test('INV-staged-proof: reviewed native deferral preserves early producer proof and rejects own omitted portion',()=>{
 const f=qualifiedFixture();try{
  const task=parseTask(f.wp),p=verify(f.root,task,'author','full');
  assert.equal(p.passed,true);assert.equal(p.qualified,true);
  assert.deepEqual(p.plan!.cases.find(c=>c.id==='CASE-WIKI-001')!.deferred,[{portion:'native',ownerTask:'WP-035'}]);
  assert.equal(currentProof(f.root,task,'author').sha,p.sha);
  const bad=structuredClone(f.plan);bad.cases.find(c=>c.id==='CASE-WIKI-001')!.requiredPortions=[];
  f.cfg.verification.proofPlans[f.wp]=bad;writeFileSync(join(f.root,'evf.config.json'),JSON.stringify(f.cfg));
  assert.throws(()=>proofPlan(f.root,task,f.wp,p.expectedCases),/Own domain portion omitted/);
 }finally{f.close();}
});
test('INV-proof-identity: actual final full proof rejects another task, same-family verification and altered logs',()=>{
 const f=qualifiedFixture();try{
  const task=parseTask(f.wp);verify(f.root,task,'author','full');
  process.env.EVF_FIXTURE_FAMILY='Sol';verify(f.root,task,'verifier','full');
  assert.throws(()=>currentProof(f.root,task,'verifier'),/distinct trusted provider identities and model families/);
  delete process.env.EVF_FIXTURE_FAMILY;
  const verifier=verify(f.root,task,'verifier','full');assert.equal(currentProof(f.root,task,'verifier').sha,verifier.sha);
  const wrong=parseTask('WP-035');f.cfg.verification.proofPlans[wrong.id]=f.plan;
  // A foreign-task signed artifact is internally consistent, but cannot be consumed by this task.
  const path=join(verifier.evidenceDir,'proof.json'),payload={...verifier.attestation!.payload,task:'WP-035'},foreign={...verifier,task:'WP-035',attestation:{payload,signature:sign(null,Buffer.from(JSON.stringify(payload)),readFileSync(join(f.root,'fake-bin/key.pem'))).toString('base64')}};
  assert.equal(validAttestation(foreign,f.cfg.verification.publicKey),true);
  writeFileSync(path,JSON.stringify(foreign));assert.throws(()=>currentProof(f.root,task,'verifier'),/No current full/);
  writeFileSync(path,JSON.stringify(verifier));writeFileSync(verifier.checks[0].log,'altered evidence');
  assert.throws(()=>currentProof(f.root,task,'verifier'),/No current full/);
 }finally{delete process.env.EVF_FIXTURE_FAMILY;f.close();}
});
test('BUG-final-head: genuinely qualified historical full plus current quick is rejected after code changes',()=>{
 const f=qualifiedFixture();try{
  const task=parseTask(f.wp);verify(f.root,task,'author','full');verify(f.root,task,'verifier','full');
  const wt=join(f.root,'.worktrees',task.slug);writeFileSync(join(wt,'domain-output.txt'),'Changed application output');
  importGit(wt,'add','domain-output.txt');importGit(wt,'commit','-qm','New final head');
  const quick=verify(f.root,task,'verifier','quick');assert.equal(quick.qualified,true);
  assert.throws(()=>currentProof(f.root,task,'verifier'),/No current full/);
 }finally{f.close();}
});
import { execFileSync } from 'node:child_process';
const importGit=(cwd:string,...args:string[])=>execFileSync('git',['-C',cwd,...args],{encoding:'utf8'});
test('INV-feedback-reservations: old reservation charges current budget, recovery stays visible and untrusted actor cannot close',()=>{
 const f=fixture();try{
  f.authorize();f.cfg.feedback.dailyFixLimit=1;writeFileSync(join(f.root,'evf.config.json'),JSON.stringify(f.cfg));f.git('remote','add','origin','https://example.invalid/private.git');
  for(const n of [1,2])feedbackTriage(f.root,n,{cls:'p1',reason:'private triage',wp:'WP-001'});
  startFeedbackTask(f.root,parseTask('FB-1'),false);
  const log=join(evfDataDir(f.root),'feedback/started.jsonl');writeFileSync(log,readFileSync(log,'utf8')+JSON.stringify({key:'R_feedback:I_2',day:'2020-01-01',state:'reserved'})+'\n');
  assert.throws(()=>startFeedbackTask(f.root,parseTask('FB-2'),false),/Daily feedback task limit/);
  assert.deepEqual(feedbackQueue(f.root).recovery,[2]);
  const state=f.getState();state.user.id=999;f.setState(state);
  assert.throws(()=>onFeedbackShipped(f.root,parseTask('FB-1')),/explicitly trusted triage/);
  assert.equal(f.getState().issues[0].state,'open');
 }finally{f.close();}
});
test('INV-workflow-routing: Next server paths stay with implementor and presentation/browser paths route to UI',()=>{
 const pkg=loadDag(source).packages.find(p=>p.id==='WP-003')!;
 assert.deepEqual(partsOf(pkg),[null]);
 const {blocks}=buildBlocks(source,[pkg]);assert.equal(blocks[0].specialist,'implementor');
 const ui=loadDag(source).packages.find(p=>p.owning_paths.some(p=>p.startsWith('apps/web/src/features/')))!;
 assert.ok(buildBlocks(source,[ui]).blocks.some(b=>b.specialist==='ui-designer'));
 const design=loadDag(source).packages.find(p=>p.id==='WP-088')!;
 const planned=buildBlocks(source,[design]).blocks;
 assert.deepEqual(planned.map(b=>({task:b.taskId,specialist:b.specialist,paths:b.paths})),[{task:'WP-088',specialist:'ui-designer',paths:['packages/ui/','tests/ui/']}]);
 assert.equal(draftProofPlan(source,parseTask('WP-088')).ownedPortion,'native');
 assert.equal(draftProofPlan(source,parseTask('WP-088')).requiresStack,true);
});

import { ship, listShipped, prOpen } from '../ship.ts';
import { requireImplementation, requireSpend } from '../policy.ts';
test('INV-gate-phases: local evidence producers can start before runtime completion; paid commitment remains gated',()=>{
 const f=fixture();try{
  f.authorize();const path=join(f.root,'docs/plan/release-gates.json'),gates=JSON.parse(readFileSync(path,'utf8'));
  for(const g of gates.gates)if(['G-RUNTIME','G-RECOVERY','G-SPEND'].includes(g.id))g.status='not-passed';writeFileSync(path,JSON.stringify(gates));
  const pp=join(f.root,'docs/build-progress.json'),p=JSON.parse(readFileSync(pp,'utf8'));p.packages['WP-002'].status='done';writeFileSync(pp,JSON.stringify(p));
  requireImplementation(f.root,'WP-003');assert.throws(()=>requireSpend(f.root),/G-SPEND/);
  gates.gates.find((g:any)=>g.id==='G-AUTH').status='not-authorized';writeFileSync(path,JSON.stringify(gates));
  assert.throws(()=>requireImplementation(f.root,'WP-003'),/G-AUTH/);
 }finally{f.close();}
});
test('INV-feedback-review: missing, stale, dismissed and changes-requested human reviews block before push or merge',()=>{
 const f=qualifiedFixture();try{
  f.cfg.verification.proofPlans['FB-1']=f.plan;f.cfg.mergePolicy.humanActorIds=[303,304];writeFileSync(join(f.root,'evf.config.json'),JSON.stringify(f.cfg));f.commit();
  feedbackTriage(f.root,1,{cls:'p1',reason:'scoped feedback',wp:f.wp});
  const bare=join(f.root,'fake-bin/origin.git');execFileSync('git',['init','--bare',bare],{stdio:'ignore'});f.git('remote','add','origin',bare);f.git('push','-q','origin','main');f.task('fb-1');
  const task=parseTask('FB-1');verify(f.root,task,'author','full');const proof=verify(f.root,task,'verifier','full');
  for(const reviews of [[],[{user:{id:303},state:'APPROVED',commit_id:'old-head'}],[{user:{id:303},state:'DISMISSED',commit_id:proof.sha}],[{user:{id:303},state:'APPROVED',commit_id:proof.sha},{user:{id:304},state:'CHANGES_REQUESTED',commit_id:proof.sha}], [{user:{id:303},state:'CHANGES_REQUESTED',commit_id:proof.sha},{user:{id:303},state:'COMMENTED',commit_id:proof.sha},{user:{id:304},state:'APPROVED',commit_id:proof.sha}]]){
   const s=f.getState();s.reviews=reviews;f.setState(s);
   assert.throws(()=>ship(f.root,task,{maxUpdates:0}),/configured human approval/);
   assert.equal(f.getState().calls.filter((c:any)=>c.args[0]==='pr'&&c.args[1]==='merge').length,0);
   assert.equal(execFileSync('git',['--git-dir',bare,'branch','--list','task/fb-1'],{encoding:'utf8'}).trim(),'');
  }
  const s=f.getState();s.reviews=[{user:{id:303},state:'APPROVED',commit_id:proof.sha}];s.protection={};f.setState(s);
  assert.throws(()=>ship(f.root,task,{maxUpdates:0}),/Verified strict branch protection/);
  delete s.protection;f.setState(s);
  assert.throws(()=>ship(f.root,task,{maxUpdates:0}),/fixture merge barrier/);
  const merge=f.getState().calls.find((c:any)=>c.args[0]==='pr'&&c.args[1]==='merge');assert.ok(merge.args.includes('--match-head-commit'));assert.equal(merge.args.at(-1),proof.sha);
 }finally{f.close();}
});
test('INV-feedback-preservation: approved owner promotion, demand ranking and exact reviewed question reply survive',()=>{
 const f=fixture();const oldLog=console.log;const out:string[]=[];try{
  f.git('remote','add','origin','https://example.invalid/private.git');
  feedbackTriage(f.root,1,{cls:'feature-large',reason:'new product idea',wp:'WP-001'});
  feedbackTriage(f.root,2,{cls:'duplicate',reason:'same idea',duplicateOf:'1'});
  console.log=(...xs)=>out.push(xs.join(' '));feedbackIdeas(f.root);console.log=oldLog;
  assert.equal(JSON.parse(out[0])[0].demand,2);
  assert.throws(()=>feedbackPromote(f.root,1),/explicit owner authorization/);
  f.cfg.feedback.ownerActorIds=[202];f.cfg.feedback.promotionApprovals=['R_feedback:I_1'];writeFileSync(join(f.root,'evf.config.json'),JSON.stringify(f.cfg));
  assert.equal(feedbackPromote(f.root,1),0);assert.equal(cachedTriage(f.root,1)?.internalIssue,801);
  const reply='A human-reviewed public answer.';f.cfg.feedback.replyApprovals={'R_feedback:I_3':createHash('sha256').update(reply).digest('hex')};writeFileSync(join(f.root,'evf.config.json'),JSON.stringify(f.cfg));
  assert.equal(feedbackTriage(f.root,3,{cls:'question',reason:'question received',reply}),0);
  const state=f.getState();assert.equal(state.issues[2].state,'closed');assert.equal(state.calls.find((c:any)=>c.body===reply).body,reply);
 }finally{console.log=oldLog;f.close();}
});
test('INV-model-feedback: verified bot identity never authorizes arbitrary raw public text',()=>{
 const f=fixture();try{
  const s=f.getState();s.issues[0].title='Private PERSON name';s.issues[0].body='Private original or pastoral narrative';f.setState(s);
  assert.throws(()=>feedbackTriage(f.root,1,{cls:'p1',reason:'internal reason',wp:'WP-001'}),/safe opaque publication marker|outside the reviewed closed/);
  assert.equal(f.getState().calls.filter((c:any)=>c.args[0]==='issue'&&c.args[1]==='comment').length,0);
 }finally{f.close();}
});

test('INV-contract-freeze: a caller-created merged-part record cannot unlock implementation',()=>{
 const f=fixture();try{
  f.authorize();const path=join(f.root,'docs/build-progress.json'),p=JSON.parse(readFileSync(path,'utf8'));
  for(const x of Object.values(p.packages) as any[])x.status='done';writeFileSync(path,JSON.stringify(p));
  f.cfg.verification.proofPlans['WP-005/api']={risk:'ordinary'};writeFileSync(join(f.root,'evf.config.json'),JSON.stringify(f.cfg));
  const dir=join(evfDataDir(f.root),'shipped');mkdirSync(dir,{recursive:true});
  writeFileSync(join(dir,'wp-005-contract.json'),JSON.stringify({task:'WP-005/contract',package_id:'WP-005',part:'contract',merge_commit:f.git('rev-parse','HEAD')}));
  assert.throws(()=>taskStart(f.root,parseTask('WP-005/api'),{allowUnready:false,noStack:true}),/retained independently attested proof/);
  assert.equal(f.git('branch','--list','task/*'),'');
 }finally{f.close();}
});

test('INV-ordinary-auto-merge: independently reviewed final head reaches automatic merge without human approval',()=>{
 const f=qualifiedFixture();try{
  const wt=join(f.root,'.worktrees',f.wp.toLowerCase());importGit(wt,'merge','--ff-only','main');
  const bare=join(f.root,'fake-bin/origin.git');execFileSync('git',['init','--bare',bare],{stdio:'ignore'});f.git('remote','add','origin',bare);f.git('push','-q','origin','main');
  const s=f.getState();s.reviews=[];s.protection={required_status_checks:{strict:true,contexts:['evf/verify']},enforce_admins:{enabled:true},required_pull_request_reviews:{required_approving_review_count:0,dismiss_stale_reviews:false}};f.setState(s);
  const task=parseTask(f.wp);verify(f.root,task,'author','full');const proof=verify(f.root,task,'verifier','full');
  assert.throws(()=>ship(f.root,task,{maxUpdates:0}),/fixture merge barrier/);
  const merge=f.getState().calls.find((c:any)=>c.args[0]==='pr'&&c.args[1]==='merge');assert.equal(merge.args.at(-1),proof.sha);
 }finally{f.close();}
});

test('INV-independent-review: passing tests and a signed verifier identity cannot replace final-head approved review',()=>{
 const f=qualifiedFixture();try{
  const task=parseTask(f.wp);verify(f.root,task,'author','full');
  process.env.EVF_FIXTURE_REVIEW='missing';const p=verify(f.root,task,'verifier','full');delete process.env.EVF_FIXTURE_REVIEW;
  assert.equal(p.checks[0].passed,true);assert.equal(p.qualified,false);assert.equal(p.passed,false);
  assert.throws(()=>currentProof(f.root,task,'verifier'),/No current full independently attested/);
 }finally{delete process.env.EVF_FIXTURE_REVIEW;f.close();}
});
test('INV-sensitive-escalation: ordinary automatic merge does not authorize sensitive/security/privacy/irreversible work',()=>{
 const f=qualifiedFixture();try{
  const task=parseTask(f.wp);
  for(const risk of ['sensitive','security','privacy','irreversible']) {
   f.cfg.verification.proofPlans[f.wp].risk=risk;writeFileSync(join(f.root,'evf.config.json'),JSON.stringify(f.cfg));
   assert.throws(()=>taskStart(f.root,task,{allowUnready:false,noStack:true}),/escalate through Intent's existing owner channel/);
   assert.throws(()=>ship(f.root,task,{maxUpdates:0}),/escalate through Intent's existing owner channel/);
  }
  assert.equal(f.getState().calls.filter((c:any)=>c.args[0]==='pr'&&c.args[1]==='merge').length,0);
 }finally{f.close();}
});

import { existsSync } from 'node:fs';
import { stack } from '../task.ts';
import { draftProofPlan } from '../proof-plan.ts';
import { caseCoverage, caseGrep } from '../coverage.ts';
import { producerReady, recordProgress } from '../progress.ts';
import { contractFingerprint } from '../lib.ts';
import { renderAc, renderBrief } from '../brief.ts';

test('BUG-plan-context: plan and brief use the same manifest acceptance scope, including consumed bundles',()=>{
 const pkg=loadDag(source).packages.find(p=>p.id==='WP-001')!;
 const context=packageContext(source,pkg.id),block=buildBlocks(source,[pkg]).blocks[0];
 assert.equal(block.acceptanceCount,context.acceptance_ids.length);
 assert.match(renderBrief(source,parseTask(pkg.id),{}),new RegExp(`Selected acceptance count: ${block.acceptanceCount}`));
 assert.equal(block.acceptanceCount,8);
 const brief=renderBrief(source,parseTask('WP-002'),{});
 assert.match(brief,/Goal: Provide shared trusted scope, time, revision, replay, receipt and audit contracts/);
 assert.match(brief,/Owned requirements: REQ-IDN-029, REQ-OPS-004, REQ-PI-037, REQ-PPL-024, REQ-TSK-018/);
 assert.match(brief,/Owned cases: AUDIT-001, AUDIT-002, AUDIT-003/);
});

test('INV-proof-draft: drafts account for each selected case and gate without installing authority',()=>{
 const before=readFileSync(join(source,'evf.config.json'),'utf8');
 for(const id of ['WP-001','WP-005/contract','WP-005/api','WP-005/ui','WP-057']){
  const task=parseTask(id),context=packageContext(source,task.wp),draft=draftProofPlan(source,task);
  assert.deepEqual(draft.cases.map(c=>c.id),context.case_ids);
  assert.deepEqual(draft.gates.map(g=>g.index),loadDag(source).packages.find(p=>p.id===task.wp)!.acceptance_gates.map((_,i)=>i));
 }
 assert.deepEqual(draftProofPlan(source,parseTask('OPS-1')),{risk:'ordinary',stage:'maintenance',ownedPortion:'platform',requiresStack:false,cases:[],gates:[]});
 assert.equal(readFileSync(join(source,'evf.config.json'),'utf8'),before);
});

test('INV-case-coverage: one passing test covers several cases by exact name or annotation, never a failed/skipped result',()=>{
 const ids=['REF-CASE-001','CA017','ASMT-011'];
 const report={tests:[{name:'AC:REF-CASE-001 AC:CA017 reference install',status:'passed',annotations:['AC:ASMT-011']}]};
 assert.deepEqual(caseCoverage(ids,report),{missing:[],duplicates:[]});
 assert.deepEqual(caseCoverage(ids,{tests:[...report.tests,{name:'AC:CA017 alternate projection',status:'passed'}]}).duplicates,[{caseId:'CA017',tests:[report.tests[0].name,'AC:CA017 alternate projection']}]);
 for(const status of ['failed','skipped'])assert.deepEqual(caseCoverage(ids,{tests:[{...report.tests[0],status}]}).missing,ids);
 const re=new RegExp(caseGrep(['CA017']));assert.equal(re.test('AC:CA017 install'),true);assert.equal(re.test('AC:CA017-extra'),false);assert.equal(re.test('CA017'),false);
 assert.deepEqual(caseCoverage(['CA017'],{tests:[{name:'AC:CA017-extra',status:'passed'}]}).missing,['CA017']);
});

test('INV-proof-coverage: current application verification rejects missing reports and uncovered cases despite signed passing claims',()=>{
 const f=qualifiedFixture();try{
  const task=parseTask(f.wp),wt=join(f.root,'.worktrees',task.slug);
  for(const report of [null,{tests:[{name:'AC:CASE-WIKI-001',status:'passed'}]},{tests:[{name:packageContext(f.root,f.wp).case_ids.map(id=>'AC:'+id).join(' '),status:'failed'}]}]){
   f.cfg.checks=[{name:'fixture-check',run:[process.execPath,'-e',report?`require('node:fs').writeFileSync(process.env.EVF_TEST_REPORT,${JSON.stringify(JSON.stringify(report))})`:'process.exit(0)']}];
   writeFileSync(join(f.root,'evf.config.json'),JSON.stringify(f.cfg));f.commit();importGit(wt,'merge','--ff-only','main');
   const stale=join(evfDataDir(f.root),'evidence',task.slug,importGit(wt,'rev-parse','HEAD').trim(),'author-full');mkdirSync(stale,{recursive:true});
   writeFileSync(join(stale,'tests.json'),JSON.stringify({tests:[{name:packageContext(f.root,f.wp).case_ids.map(id=>'AC:'+id).join(' '),status:'passed'}]}));
   const p=verify(f.root,task,'author','full');assert.equal(p.checks.find(c=>c.name==='case-coverage')!.passed,false);assert.equal(p.passed,false);
  }
 }finally{f.close();}
});

test('INV-progress-milestones: ship and acknowledgement write once, preserve proof, unlock a dependent before package closure, reject forged records',()=>{
 const f=qualifiedFixture('WP-001');const oldLog=console.log;try{
  const task=parseTask(f.wp),wt=join(f.root,'.worktrees',task.slug);
  const progressPath=join(f.root,'docs/build-progress.json'),progress=JSON.parse(readFileSync(progressPath,'utf8'));
  delete progress.packages['WP-001'];writeFileSync(progressPath,JSON.stringify(progress));f.commit();importGit(wt,'merge','--ff-only','main');
  const output=join(wt,'packages/reference/fixture.txt');mkdirSync(join(wt,'packages/reference'),{recursive:true});writeFileSync(output,'Reviewed reference bundle');importGit(wt,'add','packages/reference/fixture.txt');importGit(wt,'commit','-qm','Substantive reference output');
  const bare=join(f.root,'fake-bin/origin.git');execFileSync('git',['init','--bare',bare],{stdio:'ignore'});f.git('remote','add','origin',bare);f.git('push','-q','origin','main');
  const state=f.getState();state.allowMerge=true;state.mergeBranch=task.branch;f.setState(state);
  const author=verify(f.root,task,'author','full'),verifier=verify(f.root,task,'verifier','full');
  console.log=()=>{};assert.equal(ship(f.root,task,{maxUpdates:0}),0);
  const recordPath=join(evfDataDir(f.root),'shipped',task.slug+'.json'),record=JSON.parse(readFileSync(recordPath,'utf8'));
  const shipped=JSON.parse(readFileSync(progressPath,'utf8'));assert.equal(shipped.packages[f.wp].status,'in_progress');assert.equal(shipped.packages[f.wp].milestones[task.id].acknowledged,false);
  assert.equal(producerReady(f.root,f.wp),false);
  const fingerprint=contractFingerprint(f.root);listShipped(f.root,[task.id]);const acknowledged=readFileSync(progressPath,'utf8');
  assert.equal(contractFingerprint(f.root),fingerprint);assert.equal(producerReady(f.root,f.wp),true);requireImplementation(f.root,'WP-032');
  writeFileSync(progressPath,JSON.stringify(shipped));assert.equal(producerReady(f.root,f.wp),true);requireImplementation(f.root,'WP-032');
  writeFileSync(progressPath,acknowledged);
  assert.equal(loadProgress(f.root)[f.wp].status,'in_progress');listShipped(f.root,[task.id]);assert.equal(readFileSync(progressPath,'utf8'),acknowledged);
  const retained=JSON.parse(readFileSync(recordPath,'utf8'));assert.equal(retained.proof.sha,verifier.sha);assert.equal(retained.author_proof.sha,author.sha);
  assert.throws(()=>recordProgress(f.root,{...record,proof:{...record.proof,task:'WP-002'}},true),/independently reviewed/);
  // Only reviewed full-target integration may acknowledge package closure.
  const integration=parseTask('WP-057'),draft=draftProofPlan(f.root,integration);
  const closure={packageId:'WP-001',gateIndexes:loadDag(f.root).packages.find(p=>p.id==='WP-001')!.acceptance_gates.map((_,i)=>i)};
  f.cfg.verification.proofPlans[integration.id]={...draft,requiresStack:false,packageClosures:[{...closure,gateIndexes:[]}]};
  writeFileSync(join(f.root,'evf.config.json'),JSON.stringify(f.cfg));
  assert.throws(()=>proofPlan(f.root,integration,integration.wp,draft.cases.map(c=>c.id)),/every target package gate/);
  f.cfg.verification.proofPlans[integration.id]={...draft,requiresStack:false,packageClosures:[closure]};
  f.cfg.checks=[{name:'fixture-check',run:[process.execPath,'-e',`require('node:fs').writeFileSync(process.env.EVF_TEST_REPORT,JSON.stringify({tests:[{name:${JSON.stringify(draft.cases.map(c=>'AC:'+c.id).join(' '))},status:'passed'}]}))`]}];
  writeFileSync(join(f.root,'evf.config.json'),JSON.stringify(f.cfg));f.commit();f.git('push','-q','origin','main');const integratedWt=f.task(integration.slug);
  const integratedOutput=join(integratedWt,'tests/e2e/fixture.txt');mkdirSync(join(integratedWt,'tests/e2e'),{recursive:true});writeFileSync(integratedOutput,'Reviewed complete integration');importGit(integratedWt,'add','tests/e2e/fixture.txt');importGit(integratedWt,'commit','-qm','Integration output');
  const integrationState=f.getState();integrationState.mergeBranch=integration.branch;f.setState(integrationState);
  verify(f.root,integration,'author','full');verify(f.root,integration,'verifier','full');assert.equal(ship(f.root,integration,{maxUpdates:0}),0);
  assert.equal(loadProgress(f.root)['WP-001'].status,'in_progress');listShipped(f.root,[integration.id]);assert.equal(loadProgress(f.root)['WP-001'].status,'done');
  const closed=readFileSync(progressPath,'utf8');listShipped(f.root,[integration.id]);assert.equal(readFileSync(progressPath,'utf8'),closed);
 }finally{console.log=oldLog;f.close();}
});

test('INV-maintenance: OPS uses tooling-only proof without global app gates or stack, and retains signed cross-model review',()=>{
 const f=qualifiedFixture();try{
  const task=parseTask('OPS-1');f.cfg.maintenanceTasks={[task.id]:{title:'Workflow upkeep',owningPaths:['tools/evf/','evf.config.json'],configChanges:['stack','checks'],checks:[{name:'tooling-upkeep',run:[process.execPath,'-e',`require('node:assert/strict').equal(require('node:fs').readFileSync('tools/evf/upkeep.txt','utf8'),'Reviewed tooling change')`]}]}};
  f.cfg.verification.proofPlans[task.id]=draftProofPlan(f.root,task);
  f.cfg.maintenanceTasks[task.id].owningPaths=['packages/domain/','evf.config.json'];writeFileSync(join(f.root,'evf.config.json'),JSON.stringify(f.cfg));
  assert.throws(()=>taskStart(f.root,task,{allowUnready:false,noStack:true}),/OPS cannot authorize application code/);assert.equal(f.git('branch','--list',task.branch),'');
  f.cfg.maintenanceTasks[task.id].owningPaths=['tools/evf/','evf.config.json'];
  const gatePath=join(f.root,'docs/plan/release-gates.json'),gates=JSON.parse(readFileSync(gatePath,'utf8'));gates.gates.find((g:any)=>g.id==='G-AUTH').status='not-authorized';writeFileSync(gatePath,JSON.stringify(gates));
  writeFileSync(join(f.root,'evf.config.json'),JSON.stringify(f.cfg));f.commit();
  taskStart(f.root,task,{allowUnready:false,noStack:false});
  const wt=join(f.root,'.worktrees',task.slug),marker=join(f.root,'fake-bin/unreviewed-check');
  mkdirSync(join(wt,'tools/evf'),{recursive:true});writeFileSync(join(wt,'tools/evf/upkeep.txt'),'Reviewed tooling change');
  const candidate=structuredClone(f.cfg);
  candidate.stack={usesPaidProviders:false,up:['scripts/stack','up'],status:['scripts/stack','status']};
  candidate.checks=[{name:'future-check',run:[process.execPath,'-e',`require('node:fs').writeFileSync(${JSON.stringify(marker)},'ran')`]}];
  writeFileSync(join(wt,'evf.config.json'),JSON.stringify(candidate));importGit(wt,'add','tools/evf/upkeep.txt','evf.config.json');importGit(wt,'commit','-qm','Wire candidate stack and checks with tooling change');
  for(const field of ['publicKey','attest','proofPlans']){
   const changed=structuredClone(candidate);changed.verification[field]=null;writeFileSync(join(wt,'evf.config.json'),JSON.stringify(changed));
   assert.throws(()=>verify(f.root,task,'author','full'),/cannot change runner, keys/);
  }
  writeFileSync(join(wt,'evf.config.json'),JSON.stringify(candidate));
  const bare=join(f.root,'fake-bin/origin.git');execFileSync('git',['init','--bare',bare],{stdio:'ignore'});f.git('remote','add','origin',bare);f.git('push','-q','origin','main');
  const a=verify(f.root,task,'author','full'),v=verify(f.root,task,'verifier','full');assert.equal(a.kind,'tooling');assert.equal(v.passed,true);assert.deepEqual(v.checks.map(c=>c.name),['tooling-upkeep']);assert.deepEqual(v.expectedCases,[]);assert.deepEqual(v.expectedGates,[]);
  assert.equal(currentProof(f.root,task,'verifier').sha,v.sha);assert.equal(prOpen(f.root,task),0);assert.equal(existsSync(marker),false);assert.throws(()=>stack(f.root,task,'up'),/no application stack/);
  process.env.EVF_FIXTURE_FAMILY='Sol';verify(f.root,task,'verifier','full');assert.throws(()=>currentProof(f.root,task,'verifier'),/distinct trusted/);
 }finally{delete process.env.EVF_FIXTURE_FAMILY;f.close();}
});

test('INV-execution-policy: worktree tooling/risk edits cannot run checks or stack before reviewed-root gates',()=>{
 const f=qualifiedFixture();try{
  const task=parseTask(f.wp),wt=join(f.root,'.worktrees',task.slug),marker=join(f.root,'fake-bin/executed.txt');
  f.cfg.stack={usesPaidProviders:false,up:[process.execPath,'-e',`require('node:fs').writeFileSync(${JSON.stringify(marker)},'ran')`],status:[process.execPath,'-e','process.exit(0)']};
  writeFileSync(join(f.root,'evf.config.json'),JSON.stringify(f.cfg));f.commit();importGit(wt,'merge','--ff-only','main');
  const changed=JSON.parse(readFileSync(join(wt,'evf.config.json'),'utf8'));changed.verification.kind='tooling';changed.verification.proofPlans[f.wp].risk='security';changed.checks=[{name:'unreviewed-check',run:f.cfg.stack.up}];writeFileSync(join(wt,'evf.config.json'),JSON.stringify(changed));
  assert.throws(()=>verify(f.root,task,'verifier','full'),/match the reviewed root before any check/);
  assert.throws(()=>stack(f.root,task,'up'),/match the reviewed root before runtime/);
  assert.equal(existsSync(marker),false);
 }finally{f.close();}
});

import { bootstrapReadiness } from '../doctor.ts';
test('BUG-bootstrap-reader: case and full brief preserve structured fixtures, actors, clock, actions, expected and groups',()=>{
 const c=renderAc(source,'REF-CASE-001');
 assert.match(c,/"timezone": "America\/Chicago"/);assert.match(c,/"accepted_original_sha256": "d365dd4992156e674f8e67601239fbf97c173074a3ca7e0bc8010aa725205e7a"/);
 for(const field of ['given','actor','clock','action','expected'])assert.ok(c.includes(field+':\n```json\n'));
 assert.doesNotMatch(c,/undefined|\[object Object\]/);
 assert.match(renderAc(source,'CASE-DOC-004'),/group:\n```json\n"frozen-template-generation"/);
 const subcases=renderAc(source,'SCHEMA-004');assert.match(subcases,/subcases:\n```json\n/);assert.match(subcases,/"name": "completion-without-assignment"/);assert.match(subcases,/"earned_credit": true/);
 const full=renderBrief(source,parseTask('WP-001'),{full:true});
 assert.ok(full.includes(c));assert.doesNotMatch(full,/fixture undefined|\[object Object\]/);
 const catalog=loadRegistry(source);assert.ok(renderAc(source,catalog.find(e=>e.case_ids.includes('REF-CASE-001'))!.id).includes(c));
});
test('INV-bootstrap-readiness: missing owner setup lists each prerequisite without starting a runner',()=>{
 const f=fixture();try{
  const missing=bootstrapReadiness(f.root).filter(([ready])=>!ready).map(([,item])=>item);
  assert.deepEqual(missing,[
   'owner kickoff approval in G-AUTH','owner workflow approval in G-WORKFLOW','repository remote origin',
   'trusted signed runner command with {request}; owner reviews its identity and review adapter',
   'reviewed Ed25519 public key; private key stays outside agent worktrees',
   'reviewed WP-087 producer proof plan','reviewed WP-001 proof plan',
   'reviewed OPS task and maintenance proof plan for stack/checks configuration wiring',
   'acknowledged WP-087 stack and test scripts milestone','stack up/status commands wired after WP-087',
   'owner-reviewed bootstrap application qualification and assertion/report driver']);
  f.authorize();assert.equal(bootstrapReadiness(f.root)[0][0],true);assert.equal(bootstrapReadiness(f.root)[1][0],true);
 }finally{f.close();}
});
