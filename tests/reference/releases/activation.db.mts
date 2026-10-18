import test,{before,after} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {createRequire} from 'node:module';
import {migrate} from '../../../packages/db/src/schema/migrate.ts';
import {referenceService,ReferenceRefusal} from '../../../packages/reference/src/server.ts';
import type {ReferenceAuthority,ReferenceDependencies} from '../../../packages/reference/src/server.ts';
import {promotion} from '../../../packages/contracts/src/reference/release.ts';
import type {Promotion} from '../../../packages/contracts/src/reference/release.ts';
import {hash,canonical} from '../../../packages/reference/src/hash.ts';
import {fixture} from './fixtures.mts';
const require=createRequire(new URL('../../../packages/reference/package.json',import.meta.url));
const {Pool}=require('pg');
const source=new URL(process.env.DATABASE_URL_UNPOOLED??process.env.DATABASE_URL??'about:blank');
if(source.hostname!=='ep-autumn-dew-b8ltidky.c-14.us-east-1.aws.neon.tech'||process.env.NODE_ENV==='production')throw Error('Only shared development direct endpoint permitted');
source.searchParams.set('sslmode','verify-full');
const schema='wp032_test_'+randomUUID().replaceAll('-','');
const db=new Pool({connectionString:source.href,max:6,options:`-c search_path=${schema},public,pg_catalog,pg_temp`});
const actor=randomUUID(),user=randomUUID(),session=randomUUID(),job=randomUUID(),plant=randomUUID();
const global='00000000-0000-0000-0000-000000000000';
const artifacts=new Map<string,unknown>();
const reviews=new Map<string,{actorId:string;review:ReferenceAuthority['review']}>();
let firstCommand:Promotion;
let claim:Extract<ReferenceAuthority,{mode:'worker'}>['claim']|undefined;
const authorize:ReferenceDependencies['authorize']=async (tx,command)=> {
  const saved=reviews.get(command.requestKey);if(!saved)return null;
  const live=await tx.query('SELECT id FROM auth_session WHERE id=$1 AND user_id=$2 AND expires_at>clock_timestamp() FOR SHARE',[session,user]);
  return live.rowCount===1?{...saved,...(claim?{mode:'worker',claim}:{mode:'operator'})}:null;
};
const service=referenceService(db,{authorize,loadArtifact:async locator=>artifacts.get(locator),policyFor:key=>fixture(key).policy});
function command(key:string,expected:string,kind:'activate'|'rollback'='activate'):Promotion {
  const f=fixture(key);artifacts.set(key,f.bundle);
  const cmd=promotion.parse({kind,generationKey:key,manifestHash:f.manifestHash,expectedActivation:expected,requestKey:randomUUID(),reason:'Synthetic reviewed reference proof'});
  reviews.set(cmd.requestKey,{actorId:actor,review:{commandDigest:hash(canonical(cmd)),approvalHash:hash('synthetic-reviewed:'+f.manifestHash),approvalLocator:'synthetic-review:'+cmd.requestKey}});
  return cmd;
}
async function counts() {
  return (await db.query(`SELECT (SELECT count(*)::int FROM reference_activation) AS activations,
    (SELECT count(*)::int FROM reference_release) AS releases,(SELECT count(*)::int FROM operation) AS operations,
    (SELECT count(*)::int FROM event) AS events`)).rows[0];
}
async function refused(cmd:Promotion,code:string) {
  await assert.rejects(service.promote(cmd,cmd.generationKey),e=>e instanceof ReferenceRefusal&&e.code===code);
}
before(async()=>{
  await db.query(`CREATE SCHEMA ${schema}`);await migrate(db,schema);
  await db.query(`INSERT INTO auth_user(id,email,email_verified,name) VALUES($1,$2,true,'Synthetic')`,[user,user+'@example.test']);
  await db.query(`INSERT INTO account(id,auth_user_id,registration_state,registration_kind) VALUES($1,$2,'active','discovery')`,[actor,user]);
  await db.query(`INSERT INTO auth_session(id,user_id,token,expires_at) VALUES($1,$2,$3,now()+interval '1 hour')`,[session,user,randomUUID()]);
  await db.query(`INSERT INTO platform_grant(account_id,capability) VALUES($1,'reference_publish')`,[actor]);
  await db.query(`INSERT INTO plant(id,name,timezone,warning_days,alert_days,digest_weekday,digest_hour,phase,material_revision)
    VALUES($1,'Synthetic existing plant','America/Chicago',7,14,1,8,1,1)`,[plant]);
  await db.query(`INSERT INTO task(plant_id,title,category,priority,status,created_at,due_kind)
    VALUES($1,'Keep edited title','launch_prep','medium','in_progress',now(),'undated')`,[plant]);
  await db.query(`INSERT INTO job(id,tenant_id,kind,producer_key,state,eligible_at,attempt_count,max_attempts,lease_owner,lease_until,claim_generation)
    VALUES($1,$2,'reference_generation','sweep','claimed',now(),1,3,'synthetic-worker',now()+interval '5 minutes',2)`,[job,global]);
});
after(async()=>{await db.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);await db.end();});

test('AC:REFREL-001 initial install, exact replay and changed immutable hash refuse without rewriting originals',async()=>{
  const cmd=command('R1','0');firstCommand=cmd;const first=await service.promote(cmd,'R1');
  assert.equal(first.number,'1');assert.deepEqual(await counts(),{activations:1,releases:1,operations:1,events:1});
  assert.deepEqual(await service.promote(cmd,'R1'),{...first,replayed:true});
  const noOp=await service.promote(command('R1','1'),'R1');assert.equal(noOp.activationId,first.activationId);
  assert.deepEqual(await counts(),{activations:1,releases:1,operations:2,events:2});
  const forged={...cmd,reason:'changed'};await refused(forged,'access_denied');
  reviews.get(cmd.requestKey)!.review.commandDigest=hash(canonical(forged));await refused(forged,'idempotency_conflict');
  reviews.get(cmd.requestKey)!.review.commandDigest=hash(canonical(cmd));
  const changed=structuredClone(fixture('R1').bundle);changed.passages[0]!.embedding=[1,2,3];
  const {vectorHash}=await import('../../../packages/reference/src/hash.ts');changed.passages[0]!.embeddingChecksum=vectorHash([1,2,3]);
  const conflict=command('R1','1');conflict.manifestHash=hash(canonical(changed));artifacts.set('R1',changed);
  reviews.get(conflict.requestKey)!.review.commandDigest=hash(canonical(conflict));
  await refused(conflict,'immutable_conflict');artifacts.set('R1',fixture('R1').bundle);
  assert.deepEqual(await counts(),{activations:1,releases:1,operations:2,events:2});
  const published=await db.query(`SELECT count(*)::int AS n FROM article_revision a JOIN reference_activation r ON r.release_id=a.release_id WHERE r.activation_number=1`);
  assert.equal(published.rows[0].n,96);
  const mail=await db.query(`SELECT count(*)::int AS n FROM reference_item WHERE kind='mail_template'`);assert.equal(mail.rows[0].n,7);
  const sideEffects=await db.query(`SELECT (SELECT count(*)::int FROM message_template) AS forks,(SELECT count(*)::int FROM mail) AS mail,(SELECT count(*)::int FROM task) AS tasks`);
  assert.deepEqual(sideEffects.rows[0],{forks:0,mail:0,tasks:1});
  await db.query(`INSERT INTO message_template(plant_id,source_item_id,source_version_id,name,category,subject,body_html)
    SELECT $1,i.id,v.id,'Plant fork','meeting_invitation','My reviewed subject','<p>Plant edit survives</p>'
    FROM reference_item i JOIN reference_version v ON v.item_id=i.id WHERE i.kind='mail_template' AND i.canonical_key='Vision Meeting Invitation'`,[plant]);
});

test('AC:REFREL-004 concurrent promotions have one winner and stale claim loses',async()=>{
  const outcomes=await Promise.allSettled(['R2','R3'].map(key=>service.promote(command(key,'1'),key)));
  assert.equal(outcomes.filter(o=>o.status==='fulfilled').length,1);
  const loser=outcomes.find(o=>o.status==='rejected');assert.equal(loser?.status==='rejected'&&loser.reason.code,'revision_conflict');
  assert.equal((await service.current())?.activation_number,'2');
  await db.query('UPDATE job SET checkpoint_key=$1 WHERE id=$2',[fixture('R4').manifestHash,job]);
  claim={jobId:job,generation:'1',leaseOwner:'synthetic-worker'};await refused(command('R4','2'),'stale_claim');claim=undefined;
  assert.deepEqual(await counts(),{activations:2,releases:2,operations:3,events:3});
});

test('AC:REFREL-005 rollback appends attributable activation and preserves old generations',async()=>{
  const rollback=await service.promote(command('R1','2','rollback'),'R1');
  assert.equal(rollback.number,'3');assert.equal((await service.current())?.release_key,'R1');
  const history=await db.query(`SELECT activation_number::text,expected_prior_number::text,previous_id,actor_id,reason FROM reference_activation ORDER BY activation_number`);
  assert.deepEqual(history.rows.map((r:{activation_number:string;expected_prior_number:string})=>[r.activation_number,r.expected_prior_number]),[['1','0'],['2','1'],['3','2']]);
  assert.equal(history.rows[2].actor_id,actor);assert.equal(history.rows[2].reason,'Synthetic reviewed reference proof');
  const invalid=command('never-active','3','rollback');await refused(invalid,'rollback_unavailable');
  assert.deepEqual(await counts(),{activations:3,releases:2,operations:4,events:4});
  assert.deepEqual((await db.query('SELECT title,status,due_kind FROM task')).rows,[{title:'Keep edited title',status:'in_progress',due_kind:'undated'}]);
  assert.deepEqual((await db.query('SELECT subject,body_html FROM message_template')).rows,[{subject:'My reviewed subject',body_html:'<p>Plant edit survives</p>'}]);
});

test('INV-reference-authority: live session, current grant and exact trusted review are required even on replay',async()=>{
  const cmd=firstCommand;
  await db.query(`UPDATE platform_grant SET revoked_at=now() WHERE account_id=$1`,[actor]);await refused(cmd,'access_denied');
  await db.query(`UPDATE platform_grant SET revoked_at=null,expires_at=now()-interval '1 minute' WHERE account_id=$1`,[actor]);await refused(cmd,'access_denied');
  await db.query(`UPDATE platform_grant SET expires_at=null WHERE account_id=$1`,[actor]);
  await db.query(`UPDATE auth_session SET expires_at=now()-interval '1 minute' WHERE id=$1`,[session]);await refused(cmd,'access_denied');
  await db.query(`UPDATE auth_session SET expires_at=now()+interval '1 hour' WHERE id=$1`,[session]);
  reviews.delete(cmd.requestKey);await refused(cmd,'access_denied');
  assert.deepEqual(await counts(),{activations:3,releases:2,operations:4,events:4});
});

test('INV-reference-atomicity: required audit fault rolls back candidate, mapping, activation and receipt',async()=>{
  await db.query(`CREATE FUNCTION fail_reference_audit() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'synthetic audit fault' USING ERRCODE='P0001'; END $$`);
  await db.query(`CREATE TRIGGER fail_reference_audit BEFORE INSERT ON event FOR EACH ROW EXECUTE FUNCTION fail_reference_audit()`);
  try {await assert.rejects(service.promote(command('R5','3'),'R5'),(e:unknown)=>typeof e==='object'&&e!==null&&'code' in e&&e.code==='P0001');}
  finally {await db.query('DROP TRIGGER fail_reference_audit ON event');}
  assert.deepEqual(await counts(),{activations:3,releases:2,operations:4,events:4});
  assert.equal((await service.current())?.release_key,'R1');
  const orphans=await db.query(`SELECT count(*)::int AS n FROM record WHERE kind='reference_release' AND id NOT IN(SELECT id FROM reference_release)`);assert.equal(orphans.rows[0].n,0);
});

test('INV-reference-revalidation: changed persisted derivatives refuse while current claim can replay clean data',async()=>{
  const saved=(await db.query(`SELECT id,content,embedding::text FROM passage WHERE release_id=(SELECT release_id FROM reference_activation ORDER BY activation_number DESC LIMIT 1) LIMIT 1`)).rows[0];
  await db.query('UPDATE passage SET embedding=$2::vector WHERE id=$1',[saved.id,'[9,9,9]']);
  try{await refused(command('R1','3'),'immutable_conflict');}
  finally{await db.query('UPDATE passage SET embedding=$2::vector WHERE id=$1',[saved.id,saved.embedding]);}
  assert.deepEqual(await counts(),{activations:3,releases:2,operations:4,events:4});
  await db.query('UPDATE job SET checkpoint_key=$1 WHERE id=$2',[fixture('R1').manifestHash,job]);
  claim={jobId:job,generation:'2',leaseOwner:'another-worker'};await refused(command('R1','3'),'stale_claim');
  claim={jobId:job,generation:'2',leaseOwner:'synthetic-worker'};
  await db.query('UPDATE job SET checkpoint_key=$1 WHERE id=$2',['wrong-manifest',job]);await refused(command('R1','3'),'stale_claim');
  await db.query('UPDATE job SET checkpoint_key=$1 WHERE id=$2',[fixture('R1').manifestHash,job]);
  try{assert.equal((await service.promote(command('R1','3'),'R1')).number,'3');}finally{claim=undefined;}
  assert.deepEqual(await counts(),{activations:3,releases:2,operations:5,events:5});
});
