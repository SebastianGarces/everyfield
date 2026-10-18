import { createDatabase, closeDatabase } from "../../../packages/db/src/client.ts";
import { sql as querySql } from "../../../packages/db/node_modules/drizzle-orm/index.js";
import test from 'node:test';
import { spawnSync } from 'node:child_process';
import assert from 'node:assert/strict';
import { createHash, createHmac, randomUUID } from 'node:crypto';
import { devPool, owners, subjectId, requireApp } from './support.mjs';
import { office, pdf } from './fixtures.mjs';
import { claimJob, publishJob, reconcileJob } from '../../../apps/web/src/server/platform/execution.ts';

const base=process.env.PLATFORM_PROOF_ORIGIN;
if(!base || !process.env.PLATFORM_PROOF_SECRET || !process.env.PLATFORM_DATABASE_URL) throw new Error('Run explicit synthetic setup and set PLATFORM_PROOF_ORIGIN to your own preview');
const db=devPool(process.env.DATABASE_URL_UNPOOLED??process.env.DATABASE_URL,{options:new URL(process.env.PLATFORM_DATABASE_URL).searchParams.get("options")});
const runtime=devPool(process.env.PLATFORM_DATABASE_URL);
const {S3Client,DeleteObjectCommand,GetObjectCommand}=requireApp('@aws-sdk/client-s3');
const {getSignedUrl}=requireApp('@aws-sdk/s3-request-presigner');
const s3=new S3Client({endpoint:process.env.AWS_ENDPOINT_URL_S3,region:process.env.AWS_REGION,forcePathStyle:true,credentials:{accessKeyId:process.env.AWS_ACCESS_KEY_ID,secretAccessKey:process.env.AWS_SECRET_ACCESS_KEY}});
const secret=process.env.PLATFORM_PROOF_SECRET;
let cookie='';
async function req(path, body?, extra={}, method=body===undefined?'GET':'POST') {
  return fetch(base+'/api/platform-proof/'+path,{method,headers:{'x-platform-proof':secret,origin:base,...(cookie?{cookie}:{}),...(body===undefined?{}:{'Content-Type':'application/json'}),...extra},...(body===undefined?{}:{body:JSON.stringify(body)})});
}
async function login(email,password) {
  const response=await req('auth/sign-in/email',{email,password});assert.equal(response.status,200);
  const cookies=response.headers.getSetCookie();assert.equal(cookies.some(c=>c.includes('session_token=')),true);
  return cookies.map(c=>c.split(';')[0]).join('; ');
}
function bodyOf(format){return format==='pdf'?pdf():office(format);}

test('AC:PLATFORM-001 AC:PLATFORM-002 AC:SEC-10 AC:TEN-009 real Next sessions, rollback, private files, streams, callbacks and lease recovery',async(t)=>{
  const email=`wp003-${randomUUID()}@example.test`;const password='Fixture-first-password-123';
  try {
    await t.test('AC:PLATFORM-003 AC:PLATFORM-004 proof gate and safe output',async()=>{
      assert.equal((await fetch(base+'/api/platform-proof/readiness')).status,404);
      assert.equal((await fetch(base+'/api/platform-proof/readiness',{headers:{'x-platform-proof':'wrong'}})).status,404);
      const r=await req('readiness');assert.equal(r.status,200);assert.equal(r.headers.get('cache-control'),'private, no-store');
      const value=await r.json();assert.equal(value.customer_data_allowed,false);assert.equal(value.new_paid_commitment_allowed,false);assert.equal(value.AI_processing_allowed,false);
    });
    await t.test('login, exact Origin and fresh live session authority',async()=>{
      for(const headers of [{origin:''},{origin:'https://foreign.test'},{origin:'http://fake.test','x-forwarded-host':new URL(base).host}])assert.equal((await req('auth/sign-up/email',{email,password,name:'Synthetic'},headers)).status,403);
      assert.equal((await req('auth/sign-up/email',{email,password,name:'Synthetic'})).status,200);
      cookie=await login(email,password);
      const user=(await db.execute(querySql`SELECT id FROM auth_user WHERE email=${querySql.param(email)}`)).rows[0];
      await db.execute(querySql`INSERT INTO proof_grant(account_id,owner_id,role) VALUES(${querySql.param(user.id)},${querySql.param(owners.p)},'admin')`);
      assert.deepEqual((await req('auth/get-session')).status,200);
      const before=(await db.execute(querySql`SELECT value,revision::text FROM proof_subject WHERE id=${querySql.param(subjectId)}`)).rows;
      assert.equal((await req('update',{ownerId:owners.p,id:subjectId,expectedRevision:'1',value:'foreign-origin'},{origin:'https://foreign.test'})).status,403);
      assert.deepEqual((await db.execute(querySql`SELECT value,revision::text FROM proof_subject WHERE id=${querySql.param(subjectId)}`)).rows,before);
      const forged=await req('update',{ownerId:owners.q,id:subjectId,expectedRevision:'1',value:'bad'});assert.equal(forged.status,404);assert.equal((await forged.json()).code,'unavailable');
      assert.equal((await req('update',{ownerId:owners.p,id:subjectId,expectedRevision:'1',value:'bad',actorId:user.id,role:'owner'})).status,422);
      await db.execute(querySql`UPDATE auth_session SET expires_at=now()-interval '1 second' WHERE user_id=${querySql.param(user.id)}`);
      assert.equal((await req('update',{ownerId:owners.p,id:subjectId,expectedRevision:'1',value:'bad'})).status,404);
      cookie=await login(email,password);
    });
    await t.test('credential-account SQL fault rolls back the supported auth transaction',async()=>{
      await db.execute(querySql`CREATE OR REPLACE FUNCTION reject_fixture_account() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'synthetic_account_insert_fault'; END $$;CREATE TRIGGER reject_fixture_account BEFORE INSERT ON auth_account FOR EACH ROW EXECUTE FUNCTION reject_fixture_account()`);
      try {
        const email='rollback-'+randomUUID()+'@example.test';
        const result=await req('auth/sign-up/email',{email,password,name:'Synthetic'});assert.equal(result.status,503);
        assert.equal((await db.execute(querySql`SELECT count(*)::int n FROM auth_user WHERE email=${querySql.param(email)}`)).rows[0].n,0);
      }finally{await db.execute(querySql`DROP TRIGGER IF EXISTS reject_fixture_account ON auth_account`);await db.execute(querySql`DROP FUNCTION IF EXISTS reject_fixture_account()`);}
    });
    await t.test('required history failure rolls back facts, receipt and intent; runtime cannot rewrite audit',async()=>{
      const input={ownerId:owners.p,id:subjectId,expectedRevision:'1',value:'changed'};
      const fail=await req('update',{...input,failHistory:true});assert.equal(fail.status,503);
      const text=await fail.text();assert.equal(/proof_audit|SQL|constraint|stack/i.test(text),false);
      assert.deepEqual((await db.execute(querySql`SELECT value,revision::text FROM proof_subject WHERE id=${querySql.param(subjectId)}`)).rows[0],{value:'original',revision:'1'});
      for(const table of ['proof_audit','proof_receipt','proof_intent'])assert.equal((await db.execute(querySql.raw('SELECT count(*)::int n FROM '+table))).rows[0].n,0);
      const ok=await req('update',input);assert.equal(ok.status,200);assert.deepEqual(await ok.json(),{revision:'2'});
      for(const table of ['proof_audit','proof_receipt','proof_intent'])assert.equal((await db.execute(querySql.raw('SELECT count(*)::int n FROM '+table))).rows[0].n,1);
      await assert.rejects(()=>runtime.execute(querySql`DELETE FROM proof_audit`),{code:'42501'});
      await assert.rejects(()=>runtime.execute(querySql`UPDATE proof_audit SET revision=0`),{code:'42501'});
      await assert.rejects(()=>runtime.execute(querySql`CREATE TABLE should_not_exist(id int)`),{code:'42501'});
      assert.equal((await req('update',input)).status,409);
      const concurrent=await Promise.all(Array.from({length:5},()=>req('update',input)));assert.deepEqual(concurrent.map(r=>r.status),[409,409,409,409,409]);
    });
    await t.test('real Tigris private upload, inert previews, fresh file grant, TTL and deletion',async()=>{
      for(const format of ['docx','xlsx','pdf']){
        const bytes=bodyOf(format);const checksum=createHash('sha256').update(bytes).digest('hex');
        const intent=await req('upload-intent',{ownerId:owners.p,format,checksum,bytes:bytes.length});assert.equal(intent.status,200);const {id}=await intent.json();
        const finalize=await fetch(base+`/api/platform-proof/finalize?ownerId=${owners.p}&id=${id}`,{method:'POST',headers:{'x-platform-proof':secret,origin:base,cookie},body:bytes});assert.equal(finalize.status,200);assert.equal((await finalize.json()).preview,format==='pdf'?'Synthetic PDF':'Synthetic document');
        assert.equal((await req('download',{ownerId:owners.p,id,ttl:61})).status,422);
        const download=await req('download',{ownerId:owners.p,id,ttl:60});assert.equal(download.status,200);const {url}=await download.json();
        const anonymous=new URL(url);anonymous.search='';assert.equal((await fetch(anonymous)).status,403);
        const delivered=await fetch(url);assert.equal(delivered.status,200);assert.equal(delivered.headers.get('cache-control'),'private, no-store');assert.equal(createHash('sha256').update(Buffer.from(await delivered.arrayBuffer())).digest('hex'),checksum);
        assert.equal((await req('download',{ownerId:owners.p,id,key:'arbitrary'})).status,422);
        assert.equal((await req('download',{ownerId:owners.q,id})).status,404);
        await db.execute(querySql`UPDATE proof_grant SET active=false`);assert.equal((await req('download',{ownerId:owners.p,id})).status,404);
        assert.equal((await fetch(url)).status,200); // Issued bearers cannot promise instant recall.
        await db.execute(querySql`UPDATE proof_grant SET active=true`);
        const short=await (await req('download',{ownerId:owners.p,id,ttl:1})).json();await new Promise(r=>setTimeout(r,2100));assert.equal((await fetch(short.url)).status,403);
        // A second independently signed link survives until actual object deletion.
        const key=(await db.execute(querySql`SELECT object_key FROM proof_object WHERE id=${querySql.param(id)}`)).rows[0].object_key;
        const valid=await getSignedUrl(s3,new GetObjectCommand({Bucket:process.env.PLATFORM_STORAGE_BUCKET,Key:process.env.PLATFORM_STORAGE_PREFIX+key}),{expiresIn:60});
        await s3.send(new DeleteObjectCommand({Bucket:process.env.PLATFORM_STORAGE_BUCKET,Key:process.env.PLATFORM_STORAGE_PREFIX+key}));assert.equal((await fetch(valid)).status,404);
        await db.execute(querySql`UPDATE proof_object SET state='deleted' WHERE id=${querySql.param(id)}`);assert.equal((await req('download',{ownerId:owners.p,id})).status,404);
      }
      const bytes=bodyOf('pdf');const intent=await (await req('upload-intent',{ownerId:owners.p,format:'pdf',checksum:'0'.repeat(64),bytes:bytes.length})).json();
      const bad=await fetch(base+`/api/platform-proof/finalize?ownerId=${owners.p}&id=${intent.id}`,{method:'POST',headers:{'x-platform-proof':secret,origin:base,cookie},body:bytes});assert.equal(bad.status,422);
      assert.equal((await db.execute(querySql`SELECT state FROM proof_object WHERE id=${querySql.param(intent.id)}`)).rows[0].state,'pending');
    });
    await t.test('SSE reconnect reads progress only and fresh revocation closes the stream',async()=>{
      await db.execute(querySql`INSERT INTO proof_stream(owner_id,status) VALUES(${querySql.param(owners.p)},'ready'),(${querySql.param(owners.p)},'succeeded')`);
      const response=await req('stream?ownerId='+owners.p);assert.equal(response.status,200);const reader=response.body.getReader();
      const chunk=new TextDecoder().decode((await reader.read()).value);assert.match(chunk,/event: progress/);assert.match(chunk,/ready/);assert.match(chunk,/succeeded/);
      const revokedAt=performance.now();
      await db.execute(querySql`BEGIN;UPDATE proof_grant SET active=false;INSERT INTO proof_stream(owner_id,status) VALUES('11111111-1111-4111-8111-111111111111','reconcile');COMMIT`);
      const end=await reader.read();assert.equal(end.done,true,'revoked stream must emit no later event');
      assert.ok(performance.now()-revokedAt<1200,'revocation must close before the normal two-second stream deadline');
      assert.equal((await req('stream?ownerId='+owners.p)).status,404);await db.execute(querySql`UPDATE proof_grant SET active=true`);
      const reconnect=await req('stream?ownerId='+owners.p,undefined,{'last-event-id':'1'});const text=await reconnect.text();assert.match(text,/succeeded/);assert.equal(text.includes('"status":"ready"'),false);
      assert.equal((await req('stream?ownerId='+owners.q)).status,404);
      assert.equal((await db.execute(querySql`SELECT count(*)::int n FROM proof_job`)).rows[0].n,0);
    });
    await t.test('signed raw callback is idempotent, monotonic and exact-message bound',async()=>{
      await db.execute(querySql`INSERT INTO proof_mail(provider_id) VALUES('synthetic-mail')`);
      async function callback(type,id,provider='synthetic-mail',alter=false,stamp=String(Math.floor(Date.now()/1000))){
        const raw=JSON.stringify({type,data:{email_id:provider}});const signature=createHmac('sha256',Buffer.from(process.env.PLATFORM_WEBHOOK_SECRET.slice(6),'base64')).update(id+'.'+stamp+'.'+raw).digest('base64');
        return fetch(base+'/api/platform-proof/webhook',{method:'POST',headers:{'x-platform-proof':secret,'svix-id':id,'svix-timestamp':stamp,'svix-signature':'v1,'+signature},body:alter?raw+' ':raw});
      }
      assert.equal((await callback('email.delivered','e1')).status,200);assert.equal((await callback('email.delivered','e1')).status,200);assert.equal((await callback('email.sent','e2')).status,200);
      assert.equal((await callback('email.bounced','e3','foreign')).status,200);assert.equal((await callback('email.bounced','e4','synthetic-mail',true)).status,404);
      assert.equal((await callback('email.bounced','e5','synthetic-mail',false,'1000000000')).status,404);
      assert.deepEqual((await db.execute(querySql`SELECT rank FROM proof_mail`)).rows,[{rank:2}]);assert.equal((await db.execute(querySql`SELECT count(*)::int n FROM proof_provider_event`)).rows[0].n,2);
    });
    await t.test('invocation loss, concurrent claims, late worker fence and unknown acceptance',async()=>{
      await db.execute(querySql`INSERT INTO proof_job(kind,subject,producer_key,revision) VALUES('document_render',${querySql.param(subjectId)},'render-1',2)`);
      const script=`const {claimJob}=await import(${JSON.stringify(new URL('../../../apps/web/src/server/platform/execution.ts',import.meta.url).href)});const {devPool}=await import(${JSON.stringify(new URL('./support.mjs',import.meta.url).href)});const db=devPool(process.env.PLATFORM_DATABASE_URL);const claim=await claimJob(db);process.stdout.write(JSON.stringify(claim),()=>process.exit(17));`;
      const lost=spawnSync(process.execPath,['--conditions=react-server','--input-type=module','-e',script],{encoding:'utf8',env:process.env,timeout:10000});assert.equal(lost.status,17);const old=JSON.parse(lost.stdout);assert.equal(await claimJob(runtime),null);
      // Abandon a committed claim by exiting its process without releasing the pool.
      await db.execute(querySql`UPDATE proof_job SET lease_until=clock_timestamp()-interval '1 second'`);
      const claims=await Promise.all([claimJob(runtime),claimJob(runtime)]);assert.equal(claims.filter(Boolean).length,1);const fresh=claims.find(Boolean);assert.ok(fresh);assert.equal(fresh.generation,'2');assert.equal(await publishJob(runtime,old),false);assert.equal(await publishJob(runtime,fresh),true);assert.equal(await publishJob(runtime,fresh),false);
      assert.deepEqual((await db.execute(querySql`SELECT state,checkpoint FROM proof_job`)).rows,[{state:'succeeded',checkpoint:'rendered'}]);assert.equal((await db.execute(querySql`SELECT count(*)::int n FROM proof_job_receipt`)).rows[0].n,1);
      await db.execute(querySql`INSERT INTO proof_job(kind,subject,producer_key,revision) VALUES('document_render',${querySql.param(subjectId)},'unknown',2)`);const unknown=await claimJob(runtime);assert.ok(unknown);assert.equal(await reconcileJob(runtime,unknown),true);assert.equal(await claimJob(runtime),null);
      await db.execute(querySql`INSERT INTO proof_job(kind,subject,producer_key,revision) VALUES('document_render',${querySql.param(subjectId)},'stale',1)`);const stale=await claimJob(runtime);assert.ok(stale);assert.equal(await publishJob(runtime,stale),false);
      const denied=await req('execute',{});assert.equal(denied.status,404);
    });
    await t.test('password change preserves initiating session, reset revokes all; logout and concurrency limits',async()=>{
      const first=cookie;const other=await login(email,password);
      cookie=first;assert.equal((await req('auth/change-password',{currentPassword:password,newPassword:password,revokeOtherSessions:true})).status,422);
      const next='Fixture-next-password-123';const changed=await req('auth/change-password',{currentPassword:password,newPassword:next,revokeOtherSessions:true});assert.equal(changed.status,200);cookie=changed.headers.getSetCookie().map(c=>c.split(';')[0]).join('; ');
      assert.notEqual(await (await req('auth/get-session')).json(),null);cookie=other;assert.equal(await (await req('auth/get-session')).json(),null);
      cookie=await login(email,next);const knownReset=await req('auth/request-password-reset',{email});const unknownReset=await req('auth/request-password-reset',{email:'nobody@example.test'});assert.equal(knownReset.status,200);assert.deepEqual(await knownReset.json(),await unknownReset.json());
      const verification=(await db.execute(querySql`SELECT identifier FROM auth_verification WHERE identifier LIKE 'reset-password:%' ORDER BY created_at DESC LIMIT 1`)).rows[0];assert.ok(verification);
      const token=verification.identifier.slice('reset-password:'.length);const third='Fixture-third-password-123';assert.equal((await req('auth/reset-password',{token,newPassword:third})).status,200);
      assert.equal(await (await req('auth/get-session')).json(),null);assert.equal((await db.execute(querySql`SELECT count(*)::int n FROM auth_session`)).rows[0].n,0);
      cookie=await login(email,third);assert.equal((await req('auth/sign-out',{})).status,200);assert.equal(await (await req('auth/get-session')).json(),null);
      const responses=await Promise.all(Array.from({length:8},()=>req('auth/sign-in/email',{email,password:'wrong-password'})));assert.equal(responses.filter(r=>r.status===429).length,3);assert.equal(responses.filter(r=>r.status!==429).length,5);
    });
  } finally {await closeDatabase(db);await closeDatabase(runtime);s3.destroy();}
});
