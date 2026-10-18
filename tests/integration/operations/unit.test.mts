import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID, randomBytes, createHash } from 'node:crypto';
import { safeFailure } from '../../../packages/domain/src/operations/telemetry.ts';
import { liveness, readiness, dependencyNames } from '../../../packages/domain/src/operations/health.ts';
import { auditProofCoverage, trackWork } from '../../../packages/domain/src/operations/proof.ts';
import { validateCandidate, verifyCandidateBytes, encryptCopy, decryptCopy, restoreBarriers } from '../../../ops/maintenance/recovery.mts';

test('AC:CASE-OPS-002 liveness remains public and readiness distinguishes missing, lagging and failed dependencies',async()=>{
  assert.deepEqual(liveness(new Date('2026-10-18T12:00:00Z')),{status:'ok',time:'2026-10-18T12:00:00.000Z'});
  const probes=Object.fromEntries(dependencyNames.map(n=>[n,async()=>({status:'ready'})]));
  probes.database=async()=>{throw Error('DB-SECRET-CANARY');};
  probes.mail=async()=>({status:'behind'});probes.backup=async()=>({status:'unverified'});
  const result=await readiness(probes,40);
  assert.deepEqual(result,{status:'not_ready',dependencies:[{name:'database',status:'unavailable'},{name:'objects',status:'ready'},{name:'mail',status:'behind'},{name:'callbacks',status:'ready'},{name:'jobs',status:'ready'},{name:'references',status:'ready'},{name:'backup',status:'unverified'}]});
  assert.equal(JSON.stringify(result).includes('CANARY'),false);
  probes.database=async()=>new Promise(()=>{});assert.equal((await readiness(probes,10)).status,'not_ready');
  const error=safeFailure();assert.equal(error.code,'unavailable');assert.match(error.correlation,/^[a-f0-9-]{36}$/);
});

test('AC:OPS-EVAL-PROOF-001 pinned synthetic evidence inspection never confuses file presence with an executed evaluation',()=>{
  assert.deepEqual(trackWork(),{status:'skipped',reason:'board_integration_unconfigured',product_failed:false});
  const protocol={source:'a'.repeat(40),reference:'b'.repeat(64),fixtureRelease:'synthetic-v1',cases:['numeric_truth','privacy']};
  assert.deepEqual(auditProofCoverage(protocol,null),{status:'not_run',rollout_allowed:false,live_account_proven:false});
  const run={...protocol,executedAt:'2026-10-18T12:00:00Z',cases:[{name:'numeric_truth',status:'failed'},{name:'privacy',status:'passed'}]};
  assert.deepEqual(auditProofCoverage(protocol,run),{status:'failed',rollout_allowed:false,live_account_proven:false});
  assert.equal(auditProofCoverage(protocol,{...run,cases:[{name:'numeric_truth',status:'passed'}]}).status,'incomplete');
  assert.equal(auditProofCoverage(protocol,{...run,source:'c'.repeat(40)}).status,'not_run');
});

test('INV-recovery: encrypted exact DB/byte candidates reject corruption, expired subjects and recopy clock resets',()=>{
  const database=Buffer.from('synthetic database'),bytes=Buffer.from('synthetic ready object');
  const entry=b=>({id:randomUUID(),sha256:createHash('sha256').update(b).digest('hex'),bytes:b.length,version:'v1'});
  const subject=randomUUID(),object=entry(bytes);
  const candidate={version:1,source:'a'.repeat(40),schema:'b'.repeat(64),createdAt:'2026-10-17T12:00:00Z',expiresAt:'2026-10-24T12:00:00Z',database:entry(database),objects:[object],keyVersion:randomUUID(),witnessCheckpoint:'4',subjects:[{id:subject,expiresAt:'2026-10-20T12:00:00Z'}]};
  const {manifest,effectiveExpiresAt,liveRecoveryProven}=validateCandidate(candidate,new Date('2026-10-18T12:00:00Z'),new Map([[subject,'2026-10-20T12:00:00Z']]));
  assert.equal(effectiveExpiresAt,'2026-10-20T12:00:00.000Z');assert.equal(liveRecoveryProven,false);assert.deepEqual(verifyCandidateBytes(manifest,database,new Map([[object.id,bytes]])),{database:1,objects:1});
  assert.throws(()=>verifyCandidateBytes(manifest,database,new Map([[object.id,Buffer.from('corrupted')]])),/incomplete_copy/);
  assert.throws(()=>validateCandidate({...candidate,subjects:[{id:subject,expiresAt:'2026-10-21T12:00:00Z'}]},new Date('2026-10-18T12:00:00Z'),new Map([[subject,'2026-10-20T12:00:00Z']])),/subject_expired_or_reset/);
  assert.throws(()=>validateCandidate(candidate,new Date('2026-10-20T12:00:00Z')),/subject_expired_or_reset/);
  const key=randomBytes(32),clear=Buffer.concat([Buffer.from(JSON.stringify(manifest)),database,bytes]),encrypted=encryptCopy(clear,key);
  assert.deepEqual(decryptCopy(encrypted,key),clear);assert.equal(encrypted.includes(bytes),false);
  const corrupt=Buffer.from(encrypted);corrupt[corrupt.length-1]^=1;assert.throws(()=>decryptCopy(corrupt,key));assert.throws(()=>decryptCopy(encrypted,randomBytes(32)));
  assert.deepEqual(restoreBarriers({isolated:true}),{state:'blocked',serviceMayOpen:false});
  assert.deepEqual(restoreBarriers({isolated:true,usersDisabled:true,jobsDisabled:true,mailDisabled:true,issuesDisabled:true,currentWitnessesVerified:true,externalReceiptsReconciled:true,matchingBytesVerified:true,expiryVerified:true}),{state:'eligible_for_restricted_drill',serviceMayOpen:false});
});

test('INV-operator: host-bound private control files cannot grant another host, context or operation',async()=>{
  const {mkdtemp,writeFile,chmod,rm}=await import('node:fs/promises');
  const {hostname,tmpdir}=await import('node:os');
  const {loadControl}=await import('../../../ops/maintenance/control.mts');
  const dir=await mkdtemp(tmpdir()+'/wp050-control-'),path=dir+'/control.json';
  const value={version:1,host:hostname(),uid:process.getuid(),environment:'development',context:'migration-operator',expiresAt:new Date(Date.now()+60_000).toISOString(),operations:['migration-inspect']};
  try{
    await writeFile(path,JSON.stringify(value),{mode:0o600});
    assert.deepEqual(await loadControl(path,'migration-inspect'),value);
    await assert.rejects(loadControl(path,'migration-apply'),/operator_unavailable/);
    await chmod(path,0o644);await assert.rejects(loadControl(path,'migration-inspect'),/unsafe_control_file/);await chmod(path,0o600);
    await writeFile(path,JSON.stringify({...value,host:'another-host'}));await assert.rejects(loadControl(path,'migration-inspect'),/operator_unavailable/);
    await writeFile(path,JSON.stringify({...value,context:'restricted-backup'}));await assert.rejects(loadControl(path,'migration-inspect'),/operator_context_mismatch/);
  }finally{await rm(dir,{recursive:true});}
});
