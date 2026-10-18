import assert from 'node:assert/strict';
import { test, before, after } from 'node:test';
import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { request as httpRequest } from 'node:http';
import { trustedIdentityIp } from '../../../packages/domain/src/identity/index.ts';
import { fixture, register, signIn, cookie, password } from './support.mts';
let f: Awaited<ReturnType<typeof fixture>>;
before(async()=>{ f=await fixture(); }); after(async()=>{if(f)await f.close();});

async function resetProof(email:string) {
  assert.equal((await f.req('request-password-reset',{email})).status,200);await f.dispatch();
  const effect=f.effects.filter(v=>v.to===email&&v.text.startsWith('Reset your password')).at(-1);assert.ok(effect);
  const token=new URL(effect.text.split('\n')[2]!).searchParams.get('token');assert.ok(token);return token;
}

test('AC:WP005-API-STAGED pending credentials reveal no account or tenant authority, duplicate registration converges, authenticated self resumes',async()=>{
  f.setIp('127.0.0.11');
  const first=await register(f,'staged@example.test');assert.equal(first.status,200);assert.deepEqual(await first.json(),{status:'continue_identity_proof'});assert.equal(cookie(first),'');
  const duplicate=await register(f,'staged@example.test');assert.equal(duplicate.status,200);assert.deepEqual(await duplicate.json(),{status:'continue_identity_proof'});assert.equal(cookie(duplicate),'');
  assert.deepEqual((await f.db.query("SELECT registration_state,registration_kind FROM account a JOIN auth_user u ON u.id=a.auth_user_id WHERE u.email='staged@example.test'")).rows,[{registration_state:'pending_domain',registration_kind:'discovery'}]);
  assert.equal((await f.db.query('SELECT count(*)::int n FROM seat')).rows[0].n,0);
  assert.equal((await f.req('registration-status')).status,401);
  assert.equal((await f.req('resume-registration',{requestKey:randomUUID()})).status,401);
  const login=await signIn(f,' STAGED@EXAMPLE.TEST ');assert.equal(login.status,200);const c=cookie(login);assert.ok(c);
  const status=await (await f.req('registration-status',undefined,c)).json();assert.equal(status.status,'pending_domain');
  assert.deepEqual(await (await f.req('resume-registration',{requestKey:randomUUID()},c)).json(),status);
  assert.equal((await f.req('resume-registration',{requestKey:randomUUID(),invitationProof:'stolen'},c)).status,503);
});

test('INV-identity: atomic registration admission counts malformed submissions, requires trustworthy IP and does not trust client IP headers',async()=>{
  f.setIp('127.0.0.12');
  assert.deepEqual(await Promise.all(Array.from({length:5},()=>f.req('register',{}).then(r=>r.status))).then(a=>a.sort()),[422,422,422,429,429]);
  f.setIp(null);assert.equal((await register(f,'noip@example.test')).status,503);
  assert.equal((await f.req('register',{},undefined,{'x-forwarded-for':'127.0.0.99'})).status,503);
  assert.equal((await f.db.query("SELECT count(*)::int n FROM auth_user WHERE email='noip@example.test'")).rows[0].n,0);
  await f.db.query('ALTER TABLE admission_attempt RENAME TO admission_unavailable');
  try { const refused=await signIn(f,'staged@example.test'); assert.equal(refused.status,503);assert.equal(cookie(refused),''); }
  finally { await f.db.query('ALTER TABLE admission_unavailable RENAME TO admission_attempt'); }
});

test('INV-identity: normalized login and reset budgets reserve concurrently, success clears only own login failures',async()=>{
  f.setIp('127.0.0.13');await register(f,'limits@example.test');
  const statuses=await Promise.all(Array.from({length:8},()=>signIn(f,' LIMITS@EXAMPLE.TEST ','Wrong-password-1').then(r=>r.status)));
  assert.deepEqual(statuses.sort(),[401,401,401,401,401,429,429,429]);
  f.setIp(null);assert.equal((await signIn(f,'limits@example.test')).status,429);
  await f.db.query("UPDATE admission_attempt SET reserved_at=clock_timestamp()-interval '16 minutes' WHERE kind='login'");
  await signIn(f,'foreign@example.test','Wrong-password-1');
  const login=await signIn(f,'limits@example.test');assert.equal(login.status,200);
  assert.equal((await f.db.query("SELECT count(*)::int n FROM admission_attempt WHERE kind='login' AND state='failed' AND reserved_at>clock_timestamp()-interval '15 minutes'")).rows[0].n,1);
  assert.deepEqual(await Promise.all(Array.from({length:5},()=>f.req('request-password-reset',{email:'missing@example.test'}).then(r=>r.status))).then(a=>a.sort()),[200,200,200,429,429]);
});

test('AC:WP005-API-RESET real single-use reset consumes one proof, rejects unchanged/expired/consumed proof, revokes every prior session and reports failure truthfully',async()=>{
  f.setIp('127.0.0.14');await register(f,'reset@example.test');
  const c1=cookie(await signIn(f,'reset@example.test')),c2=cookie(await signIn(f,'reset@example.test'));
  const proof=await resetProof('reset@example.test');
  const lifetime=await f.db.query("SELECT extract(epoch FROM(expires_at-created_at))::int seconds FROM auth_verification WHERE identifier=$1",['reset-password:'+proof]);assert.equal(lifetime.rows[0].seconds,3600);
  assert.equal((await f.req('reset-password',{proof,newPassword:password,confirmPassword:password})).status,422);
  await f.db.query(`CREATE FUNCTION fail_security_event() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.action='identity.credential_changed' THEN RAISE EXCEPTION 'synthetic_event_failure'; END IF; RETURN NEW; END $$`);
  await f.db.query('CREATE TRIGGER fail_security_event BEFORE INSERT ON event FOR EACH ROW EXECUTE FUNCTION fail_security_event()');
  const results=await Promise.all(Array.from({length:2},()=>f.req('reset-password',{proof,newPassword:'Fixture-new-pass-2',confirmPassword:'Fixture-new-pass-2'})));
  await f.db.query('DROP TRIGGER fail_security_event ON event');
  assert.deepEqual(results.map(r=>r.status).sort(),[200,400]);
  assert.deepEqual(await results.find(r=>r.status===200)!.json(),{status:'password_reset',next:'sign_in'});
  assert.equal(cookie(results.find(r=>r.status===200)!), '');
  for(const c of [c1,c2])assert.deepEqual(await (await f.req('get-session',undefined,c)).json(),{status:'unauthenticated'});
  assert.equal((await signIn(f,'reset@example.test',password)).status,401);assert.equal((await signIn(f,'reset@example.test','Fixture-new-pass-2')).status,200);
  assert.ok(f.diagnostics.some((v:unknown)=>typeof v==='object'&&v!==null&&'outcome' in v&&v.outcome==='reporting_pending'));
  const events=await f.db.query("SELECT action FROM event WHERE action LIKE 'identity.credential%' ORDER BY recorded_at");assert.equal(events.rows.some((v:{action:string})=>v.action==='identity.credential_observed'),true);assert.equal(events.rows.some((v:{action:string})=>v.action==='identity.credential_changed'),false);
  f.setMailFault(false);
  const expired=await resetProof('reset@example.test');await f.db.query("UPDATE auth_verification SET expires_at=clock_timestamp()-interval '1 second' WHERE identifier=$1",['reset-password:'+expired]);
  assert.equal((await f.req('reset-password',{proof:expired,newPassword:'Fixture-third-pass-3',confirmPassword:'Fixture-third-pass-3'})).status,400);
  const stale=proof;
  assert.equal((await f.req('reset-password',{proof:stale,newPassword:'Fixture-third-pass-3',confirmPassword:'Fixture-third-pass-3'})).status,400);
});

test('INV-identity: recovery is nonenumerating through outbox failure and unknown provider acceptance; tokens never reach security diagnostics',async()=>{
  f.setIp('127.0.0.15');await register(f,'notice@example.test');
  const missing=await f.req('request-password-reset',{email:'missing-notice@example.test'});assert.equal(missing.status,200);assert.deepEqual(await missing.json(),{status:'accepted'});
  f.setMailFault(true);const failed=await f.req('request-password-reset',{email:'notice@example.test'});assert.equal(failed.status,200);assert.deepEqual(await failed.json(),{status:'accepted'});await f.runDeliveryRequests();f.setMailFault(false);
  const accepted=await f.req('request-password-reset',{email:'notice@example.test'});assert.deepEqual(await accepted.json(),{status:'accepted'});
  f.setProviderFault(true);await f.dispatch();f.setProviderFault(false);
  assert.equal((await f.db.query("SELECT count(*)::int n FROM mail WHERE state='unknown'")).rows[0].n,1);
  const serialized=JSON.stringify(f.diagnostics);assert.equal(serialized.includes('@example.test'),false);assert.equal(serialized.includes(password),false);
  assert.equal((await f.db.query("SELECT count(*)::int n FROM job WHERE state='reconcile'")).rows[0].n,1);
});

test('INV-identity: real database session renews, expired/revoked/deleted identities deny; logout converges and revocation preserves only its own session',async()=>{
  f.setIp('127.0.0.16');await register(f,'session@example.test');
  const c1=cookie(await signIn(f,'session@example.test')),c2=cookie(await signIn(f,'session@example.test'));
  const s=await (await f.req('get-session',undefined,c1)).json();assert.equal(s.status,'pending_domain');
  await f.db.query("UPDATE auth_session SET expires_at=clock_timestamp()+interval '14 days',updated_at=clock_timestamp()-interval '16 days' WHERE id=$1",[s.sessionId]);
  const renewed=await f.req('get-session',undefined,c1);assert.equal(renewed.status,200);assert.ok(cookie(renewed));
  const row=await f.db.query('SELECT extract(epoch FROM(expires_at-clock_timestamp()))::int seconds FROM auth_session WHERE id=$1',[s.sessionId]);assert.ok(row.rows[0].seconds>=2591990&&row.rows[0].seconds<=2592000);
  assert.equal((await f.req('revoke-other-sessions',{},c1)).status,200);assert.deepEqual(await (await f.req('get-session',undefined,c2)).json(),{status:'unauthenticated'});
  assert.equal((await(await f.req('get-session',undefined,c1)).json()).status,'pending_domain');
  for(let i=0;i<2;i++)assert.deepEqual(await(await f.req('sign-out',{},c1)).json(),{status:'signed_out'});
  assert.deepEqual(await(await f.req('get-session',undefined,c1)).json(),{status:'unauthenticated'});
  const c3=cookie(await signIn(f,'session@example.test'));
  await f.db.query("UPDATE auth_session SET expires_at=clock_timestamp()-interval '1 second'");assert.deepEqual(await(await f.req('get-session',undefined,c3)).json(),{status:'unauthenticated'});
  const c4=cookie(await signIn(f,'session@example.test'));
  await f.db.query(`INSERT INTO lifecycle_witness(kind,opaque_subject_id,request_revision,state,witness_checkpoint,cleanup_state,request_id,requested_at,cancel_until)
    VALUES('account',$1,1,'pending_deletion',1,'not_started',$2,statement_timestamp(),statement_timestamp()+interval '720 hours')`,[s.accountId,randomUUID()]);
  assert.deepEqual(await(await f.req('get-session',undefined,c4)).json(),{status:'unauthenticated'});assert.equal((await f.req('resume-registration',{requestKey:randomUUID()},c4)).status,401);
});

test('INV-identity: real routes reject wrong/missing origins, method and raw handler bypasses, unknown keys and unsafe returns',async()=>{
  f.setIp('127.0.0.17');await register(f,'boundary@example.test');
  for(const origin of ['', 'https://evil.example',f.origin.replace('http:','https:')])assert.equal((await f.req('sign-in/email',{email:'boundary@example.test',password},undefined,{origin})).status,403);
  const hostStatus=await new Promise<number>((resolve,reject)=>{const r=httpRequest(f.origin+'/api/auth/get-session',{headers:{host:'evil.example'}},response=>{response.resume();resolve(response.statusCode??0);});r.on('error',reject);r.end();});
  assert.equal(hostStatus,403);
  assert.equal((await f.req('get-session',undefined,undefined,{'x-forwarded-host':'evil.example','x-forwarded-proto':'https'})).status,200);
  for(const path of ['sign-up/email','change-password','reset-password/anything','verify-email?token=forged'])assert.equal((await f.req(path)).status,404);
  assert.equal((await f.req('sign-in/email',{email:'boundary@example.test',password,actor:'forged'})).status,422);
  const safe=await f.req('sign-in/email',{email:'boundary@example.test',password,returnTo:'/people?q=Alex'});assert.equal((await safe.json()).returnTo,'/people?q=Alex');
  const unsafe=await f.req('sign-in/email',{email:'boundary@example.test',password,returnTo:'//evil.example'});assert.equal((await unsafe.json()).returnTo,null);
  assert.deepEqual(await(await f.req('get-session',undefined,'forged=canary',{'user-agent':'Googlebot','x-wiki-preview':'1'})).json(),{status:'unauthenticated'});
});


test('INV-identity: interruption after credentials preserves authenticated resumption, email verification and successful reset append event and outbox together',async()=>{
  f.setIp('127.0.0.18');
  await f.db.query(`CREATE FUNCTION fail_pending() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'synthetic_pending_failure'; END $$`);
  await f.db.query('CREATE TRIGGER fail_pending BEFORE INSERT ON account FOR EACH ROW EXECUTE FUNCTION fail_pending()');
  try { assert.deepEqual(await(await register(f,'interrupted@example.test')).json(),{status:'continue_identity_proof'}); }
  finally {await f.db.query('DROP TRIGGER fail_pending ON account');}
  assert.equal((await f.db.query("SELECT count(*)::int n FROM auth_user WHERE email='interrupted@example.test'")).rows[0].n,1);
  await f.db.query("UPDATE admission_attempt SET reserved_at=clock_timestamp()-interval '25 hours',expires_at=clock_timestamp()-interval '1 second' WHERE kind='registration'");
  const login=await signIn(f,'interrupted@example.test');assert.equal(login.status,200);const c=cookie(login);
  assert.equal((await f.req('registration-status',undefined,c)).status,401);
  assert.deepEqual(await(await f.req('register',{kind:'discovery',name:'Synthetic',email:'interrupted@example.test',password,requestKey:randomUUID()},c)).json(),{status:'continue_identity_proof'});
  const status=await(await f.req('registration-status',undefined,c)).json();assert.equal(status.status,'pending_domain');
  assert.equal((await f.db.query('SELECT registration_kind FROM account WHERE id=$1',[status.accountId])).rows[0].registration_kind,'discovery');
  assert.equal((await f.req('send-verification-email',{email:'interrupted@example.test'},c)).status,200);await f.dispatch();
  const verification=f.effects.find(v=>v.to==='interrupted@example.test'&&v.text.startsWith('Verify your email'));assert.ok(verification);
  const proof=new URL(verification.text.split('\n')[2]!).searchParams.get('token');assert.ok(proof);
  assert.deepEqual(await(await f.req('verify-email',{proof})).json(),{status:'email_verified'});
  assert.equal((await f.db.query("SELECT email_verified FROM auth_user WHERE email='interrupted@example.test'")).rows[0].email_verified,true);
  const reset=await resetProof('interrupted@example.test');
  assert.equal((await f.req('reset-password',{proof:reset,newPassword:'Fixture-final-pass-4',confirmPassword:'Fixture-final-pass-4'})).status,200);
  assert.equal((await f.db.query("SELECT count(*)::int n FROM event WHERE target_record_id=$1 AND action='identity.credential_changed'",[status.accountId])).rows[0].n,1);
  const outbox=await f.db.query("SELECT state FROM mail WHERE tenant_id=$1 AND logical_key LIKE 'password_reset/outcome/%'",[status.accountId]);assert.deepEqual(outbox.rows,[{state:'pending'}]);
  await f.dispatch();assert.ok(f.effects.find(v=>v.to==='interrupted@example.test'&&v.text.startsWith('Your EveryField password was reset')), JSON.stringify((await f.db.query('SELECT m.state,j.state AS job_state,j.error_code FROM mail m JOIN job j ON j.id=m.job_id WHERE m.tenant_id=$1',[status.accountId])).rows));
});

test('INV-identity: a successful login never clears other identifiers or the trusted-IP failure budget',async()=>{
  f.setIp('127.0.0.19');await register(f,'ip-limit@example.test');
  for(let i=0;i<4;i++)assert.equal((await signIn(f,'ip-limit@example.test','Wrong-password-1')).status,401);
  assert.equal((await signIn(f,'ip-limit@example.test')).status,200);
  const attempts=await Promise.all(Array.from({length:20},(_,i)=>signIn(f,`ip-other-${i}@example.test`,'Wrong-password-1').then(r=>r.status)));
  assert.equal(attempts.filter(s=>s===401).length,16);assert.equal(attempts.filter(s=>s===429).length,4);
  const fake=new Request(f.origin,{headers:{'x-forwarded-for':'192.0.2.1','x-vercel-forwarded-for':'192.0.2.2'}});
  assert.equal(trustedIdentityIp(fake,false),null);assert.equal(trustedIdentityIp(fake,true),'192.0.2.2');
  assert.equal(trustedIdentityIp(new Request(f.origin,{headers:{'x-vercel-forwarded-for':'192.0.2.1, 192.0.2.2'}}),true),null);
});


test('INV-identity: outcome mail INSERT failure rolls back the success event without restoring credentials or sessions',async()=>{
  f.setIp('127.0.0.20');await register(f,'mail-rollback@example.test');
  const c=cookie(await signIn(f,'mail-rollback@example.test'));
  const state=await(await f.req('get-session',undefined,c)).json();
  const proof=await resetProof('mail-rollback@example.test');
  await f.db.query(`CREATE FUNCTION fail_outcome_mail() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.logical_key LIKE 'password_reset/outcome/%' THEN RAISE EXCEPTION 'synthetic_mail_insert_failure'; END IF;RETURN NEW;END $$`);
  await f.db.query('CREATE TRIGGER fail_outcome_mail BEFORE INSERT ON mail FOR EACH ROW EXECUTE FUNCTION fail_outcome_mail()');
  const diagnosticsBefore=f.diagnostics.length;
  try { assert.deepEqual(await(await f.req('reset-password',{proof,newPassword:'Fixture-mail-pass-5',confirmPassword:'Fixture-mail-pass-5'})).json(),{status:'password_reset',next:'sign_in'}); }
  finally {await f.db.query('DROP TRIGGER fail_outcome_mail ON mail');}
  assert.deepEqual((await f.db.query('SELECT action FROM event WHERE target_record_id=$1 ORDER BY recorded_at',[state.accountId])).rows,[{action:'identity.credential_observed'}]);
  assert.equal((await f.db.query("SELECT count(*)::int n FROM mail WHERE tenant_id=$1 AND logical_key LIKE 'password_reset/outcome/%'",[state.accountId])).rows[0].n,0);
  assert.deepEqual(await(await f.req('get-session',undefined,c)).json(),{status:'unauthenticated'});
  assert.equal((await signIn(f,'mail-rollback@example.test',password)).status,401);
  assert.equal((await signIn(f,'mail-rollback@example.test','Fixture-mail-pass-5')).status,200);
  assert.ok(f.diagnostics.slice(diagnosticsBefore).some((v:unknown)=>typeof v==='object'&&v!==null&&'outcome' in v&&v.outcome==='reporting_pending'));
});

test('INV-identity: existing and missing recovery/verification requests perform no identity lookup or outbox write before their response',async()=>{
  f.setIp('127.0.0.21');await register(f,'deferred@example.test');await f.runDeliveryRequests();
  const proofs=(await f.db.query('SELECT count(*)::int n FROM auth_verification')).rows[0].n;
  const mails=(await f.db.query('SELECT count(*)::int n FROM mail')).rows[0].n;
  for(const path of ['request-password-reset','send-verification-email'])for(const email of ['deferred@example.test','absent-deferred@example.test']){
    assert.deepEqual(await(await f.req(path,{email})).json(),{status:'accepted'});
    assert.equal((await f.db.query('SELECT count(*)::int n FROM auth_verification')).rows[0].n,proofs);
    assert.equal((await f.db.query('SELECT count(*)::int n FROM mail')).rows[0].n,mails);
  }
  assert.equal(f.pendingDeliveryCount(),4);
  await f.dispatch();
  assert.equal(f.effects.filter(e=>e.to==='deferred@example.test').length,2);
});


test('BUG-PR94: killing post-response recovery work leaves no stuck state and permits the next budgeted request',async()=>{
  f.setIp('127.0.0.22');
  const serviceUrl=new URL('../../../packages/domain/src/identity/index.ts',import.meta.url).href;
  const mailUrl=new URL('../../../apps/web/src/server/jobs/mail.ts',import.meta.url).href;
  const packageUrl=new URL('../../../apps/web/package.json',import.meta.url).href;
  const worker=`
    import {createServer} from 'node:http';import {once} from 'node:events';import {createRequire} from 'node:module';
    import {createIdentityService} from ${JSON.stringify(serviceUrl)};import {createMailService} from ${JSON.stringify(mailUrl)};
    const chunks=[];for await(const c of process.stdin)chunks.push(c);const v=JSON.parse(Buffer.concat(chunks));
    const {Pool}=createRequire(${JSON.stringify(packageUrl)})('pg');
    const db=new Pool({connectionString:v.IDENTITY_DATABASE_URL}),authDb=new Pool({connectionString:v.IDENTITY_AUTH_DATABASE_URL}),admissionDb=new Pool({connectionString:v.IDENTITY_DATABASE_URL});
    const mail=createMailService({db,encryptionKey:Buffer.from(v.IDENTITY_MAIL_KEY,'hex'),addressKey:Buffer.from(v.IDENTITY_ADDRESS_KEY,'hex'),from:v.IDENTITY_MAIL_FROM,
      authorize:async()=>false,transport:{async send(){throw Error('producer_only')},async lookup(){throw Error('producer_only')}}});
    const server=createServer();server.listen(0,'127.0.0.1');await once(server,'listening');const origin='http://127.0.0.1:'+server.address().port;
    const service=createIdentityService({db,authDb,admissionDb,origin,secret:v.IDENTITY_SECRET,trustedIp:()=> '127.0.0.22',
      scheduleDelivery:work=>setTimeout(work,5000),diagnostic:()=>{},
      enqueueMail:(tx,m)=>mail.enqueue(tx,{owner:{kind:'account',id:m.accountId},purpose:m.purpose,logicalKey:m.logicalKey,recipient:m.accountId,address:m.address,
        content:{subject:m.subject,text:m.text},operation:null,notice:null,eligibleAt:new Date().toISOString()})});
    server.on('request',async(req,res)=>{const chunks=[];for await(const c of req)chunks.push(c);
      const response=await service.handle(new Request(origin+req.url,{method:req.method,headers:req.headers,body:Buffer.concat(chunks)}));
      res.statusCode=response.status;res.end(Buffer.from(await response.arrayBuffer()));});
    console.log(origin);
  `;
  for(const [i,path] of ['request-password-reset','send-verification-email'].entries()){
    const email=`lost-worker-${i}@example.test`;await register(f,email);
    const c=cookie(await signIn(f,email));
    const proofs=(await f.db.query('SELECT count(*)::int n FROM auth_verification')).rows[0].n;
    const mails=(await f.db.query('SELECT count(*)::int n FROM mail')).rows[0].n;
    const child=spawn(process.execPath,['--import','tsx','--conditions=react-server','--input-type=module','--eval',worker],{stdio:['pipe','pipe','ignore']});
    child.stdin.end(JSON.stringify(f.previewSettings));
    const exited=once(child,'exit');
    try {
      const [line]=await Promise.race([once(child.stdout,'data'),exited.then(()=>{throw Error('recovery_worker_exited_before_ready')})]);const origin=String(line).trim();assert.match(origin,/^http:\/\/127\.0\.0\.1:\d+$/);
      const response=await fetch(origin+'/api/auth/'+path,{method:'POST',headers:{origin,'content-type':'application/json'},body:JSON.stringify({email})});
      assert.equal(response.status,200);assert.deepEqual(await response.json(),{status:'accepted'});
      child.kill('SIGKILL');const [code,signal]=await exited;assert.equal(code,null);assert.equal(signal,'SIGKILL');
    } finally { if(child.exitCode===null&&child.signalCode===null){child.kill('SIGKILL');await exited;} }
    assert.equal((await f.db.query('SELECT count(*)::int n FROM auth_verification')).rows[0].n,proofs);
    assert.equal((await f.db.query('SELECT count(*)::int n FROM mail')).rows[0].n,mails);
    assert.equal((await(await f.req('get-session',undefined,c)).json()).status,'pending_domain');
    assert.equal((await signIn(f,email)).status,200);
    assert.deepEqual(await(await f.req(path,{email})).json(),{status:'accepted'});await f.dispatch();
    assert.equal(f.effects.filter(e=>e.to===email).length,1);
    assert.equal((await f.db.query("SELECT count(*)::int n FROM admission_attempt WHERE kind='reset' AND state='reserved'")).rows[0].n,0);
  }
});
