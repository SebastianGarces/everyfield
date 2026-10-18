import test,{before,after} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID,randomBytes,createHmac} from 'node:crypto';
import {spawn} from 'node:child_process';
import {createServer} from 'node:http';
import {transaction} from '../../../apps/web/src/server/platform/database.ts';
import {createMailService,claimUnknownMail} from '../../../apps/web/src/server/jobs/mail.ts';
import {createResendTransport} from '../../../apps/web/src/server/jobs/resend.ts';
import {protectedTemplate} from '../../../apps/web/src/server/jobs/templates.ts';
import {claimDue,recoverLease} from '../../../apps/web/src/server/jobs/queue.ts';
import {receiveMailCallback,replayStoredCallbacks,mailCallbackHandler,callbackVisibility} from '../../../apps/web/src/server/jobs/webhook.ts';
import {db,runtime,tenant,setup,teardown,due} from './support.mts';
const account=randomUUID(),key=randomBytes(32),secret='whsec_'+randomBytes(32).toString('base64');
let handedOff=()=>{};
const effects=new Map(),requests=[];let mode='accepted',sequence=0,endpoint;
const server=createServer(async(req,res)=>{
 const chunks=[];for await(const c of req)chunks.push(c);const payload=Buffer.concat(chunks).toString();
 if(req.method==='GET'){res.setHeader('content-type','application/json');res.end(JSON.stringify({id:req.url.split('/').at(-1)}));return;}
 const requestKey=req.headers['idempotency-key'];requests.push({key:requestKey,payload});
 if(mode==='refused'){res.writeHead(429,{'retry-after':'901'});res.end('{}');return;}
 if(!effects.has(requestKey))effects.set(requestKey,'provider-'+(++sequence));
 if(mode==='lost'){req.socket.destroy();return;}
 if(mode==='hold'){handedOff();return;}
 if(mode==='malformed'){res.end('{}');return;}
 res.setHeader('content-type','application/json');res.end(JSON.stringify({id:effects.get(requestKey)}));
});
const transport=createResendTransport('synthetic',async(url,init)=>fetch(endpoint+new URL(url).pathname,init));
const authorize=async(tx,m)=>{
 const r=await tx.query('SELECT id FROM seat WHERE account_id=$1 AND plant_id=$2 AND ended_at IS NULL FOR SHARE',[m.recipient,m.tenant]);return r.rowCount===1;
};
const service=createMailService({db:runtime,encryptionKey:key,addressKey:randomBytes(32),from:'no-reply@example.test',authorize,transport});
async function enqueue(purpose='notification',content={subject:'Synthetic',text:'safe'},logicalKey=randomUUID()){
 return transaction(runtime,tx=>service.enqueue(tx,{owner:{kind:'plant',id:tenant},purpose,logicalKey,recipient:account,
  address:'synthetic@example.test',content,operation:null,notice:null,eligibleAt:'2026-01-01T00:00:00Z'}));
}
async function callback(messageId,kind,eventKey=randomUUID(),bounce){
 const raw=JSON.stringify({type:'email.'+kind,created_at:new Date().toISOString(),data:{email_id:messageId,bounce}});
 const stamp=String(Math.floor(Date.now()/1000));
 const signature=createHmac('sha256',Buffer.from(secret.slice(6),'base64')).update(eventKey+'.'+stamp+'.'+raw).digest('base64');
 return new Request('http://example.test/callback',{method:'POST',body:raw,headers:{'svix-id':eventKey,'svix-timestamp':stamp,'svix-signature':'v1,'+signature}});
}
before(async()=>{await setup();const user=randomUUID();await db.query("INSERT INTO auth_user(id,email,email_verified,name) VALUES($1,$2,true,'Synthetic')",[user,user+'@example.test']);
 await db.query("INSERT INTO account(id,auth_user_id,registration_state,registration_kind) VALUES($1,$2,'active','planter')",[account,user]);
 await db.query("INSERT INTO seat(account_id,plant_id,role,accepted_at) VALUES($1,$2,'owner',now())",[account,tenant]);
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));endpoint='http://127.0.0.1:'+server.address().port;
});
after(async()=>{server.closeAllConnections();await new Promise(resolve=>server.close(resolve));await teardown();});
test('AC:OUTBOX-RESTORE-001 INV-mail: dropped acceptance replays only the identical request/key; expiry and unknown never mint another effect',async()=>{
 mode='lost';const id=await enqueue();const [claim]=await claimDue(runtime,['mail']);const n=effects.size;
 assert.deepEqual(await service.dispatch(claim),{kind:'unknown'});assert.equal(effects.size,n+1);
 assert.equal((await db.query('SELECT state FROM job WHERE id=$1',[claim.id])).rows[0].state,'reconcile');
 mode='accepted';const [again]=await claimUnknownMail(runtime);assert.equal(again.id,claim.id);
 const out=await service.dispatch(again);assert.equal(out.kind,'accepted');assert.equal(effects.size,n+1);
 assert.deepEqual(requests.at(-1),requests.at(-2));
 assert.equal((await db.query('SELECT provider_message_id FROM mail WHERE id=$1',[id])).rows[0].provider_message_id,out.id);
 mode='lost';const expired=await enqueue();const [c]=await claimDue(runtime,['mail']);await service.dispatch(c);
 await db.query("UPDATE mail_request SET first_dispatched_at=clock_timestamp()-interval '24 hours' WHERE id=(SELECT request_id FROM mail_request_member WHERE mail_id=$1)",[expired]);
 assert.deepEqual(await claimUnknownMail(runtime),[]);const count=requests.length;
 assert.deepEqual(await service.reconcileUnknownOutcome(expired),{kind:'unknown'});assert.equal(requests.length,count);
});
test('INV-mail: killing a worker after provider acceptance recovers its original request without another effect',async()=>{
 mode='hold';const id=await enqueue();let timer;
 const observed=new Promise((resolve,reject)=>{handedOff=resolve;timer=setTimeout(()=>reject(Error('handoff_not_observed')),15000);});
 const child=spawn(process.execPath,['--conditions=react-server',new URL('./dispatch-child.mts',import.meta.url).pathname],{stdio:'ignore',env:{...process.env,
  JOBS_TEST_CONNECTION:runtime.options.connectionString,JOBS_TEST_OPTIONS:runtime.options.options,JOBS_TEST_KEY:key.toString('base64'),JOBS_TEST_ENDPOINT:endpoint}});
 const exited=new Promise(resolve=>child.once('exit',(code,signal)=>resolve({code,signal})));
 try{await observed;}finally{clearTimeout(timer);child.kill('SIGKILL');}
 assert.deepEqual(await exited,{code:null,signal:'SIGKILL'});const count=effects.size;
 assert.equal((await db.query('SELECT state FROM mail WHERE id=$1',[id])).rows[0].state,'dispatched');
 await db.query("UPDATE job SET lease_until=clock_timestamp()-interval '1 second' WHERE subject_record_id=$1",[id]);
 assert.equal(await recoverLease(runtime),1);assert.equal((await db.query('SELECT state FROM mail WHERE id=$1',[id])).rows[0].state,'unknown');
 mode='accepted';await db.query('UPDATE job SET next_attempt_at=NULL WHERE subject_record_id=$1',[id]);const [claim]=await claimUnknownMail(runtime);assert.equal(claim.subject_record_id,id);
 assert.equal((await service.dispatch(claim)).kind,'accepted');assert.equal(effects.size,count);assert.deepEqual(requests.at(-1),requests.at(-2));
});
test('INV-mail: protected token bytes stay encrypted and fixed content survives retries; identity and authority are checked',async()=>{
 mode='accepted';const token='SYNTHETIC_SECRET_'+randomUUID();const content=protectedTemplate({purpose:'password_reset',url:'https://example.test/reset-password?token='+token},'https://example.test');
 const logical=randomUUID();const id=await enqueue('password_reset',content,logical);assert.equal(await enqueue('password_reset',content,logical),id);
 await assert.rejects(enqueue('password_reset',{...content,text:'changed'},logical),/mail_identity_conflict/);
 const sql=await db.query('SELECT row_to_json(m)::text data FROM mail m WHERE id=$1',[id]);assert.equal(sql.rows[0].data.includes(token),false);assert.equal(sql.rows[0].data.includes('synthetic@example.test'),false);
 const [claim]=await claimDue(runtime,['mail']);assert.equal((await service.dispatch(claim)).kind,'accepted');assert.equal(JSON.parse(requests.at(-1).payload).text,content.text);
 assert.equal((await db.query('SELECT count(*)::int n FROM event WHERE target_record_id=$1',[id])).rows[0].n,1);
 assert.equal(JSON.stringify((await db.query('SELECT * FROM event WHERE target_record_id=$1',[id])).rows).includes(token),false);
 assert.throws(()=>protectedTemplate({purpose:'password_reset',url:'https://foreign.test/reset-password?token=x'},'https://example.test'),/invalid_purpose_link/);
 const denied=await enqueue();await db.query('UPDATE seat SET ended_at=clock_timestamp() WHERE account_id=$1',[account]);
 const before=requests.length;const [c]=await claimDue(runtime,['mail']);assert.deepEqual(await service.dispatch(c),{kind:'not_dispatched'});assert.equal(requests.length,before);
 assert.equal((await db.query('SELECT state FROM mail WHERE id=$1',[denied])).rows[0].state,'cancelled');
 await db.query('UPDATE seat SET ended_at=NULL WHERE account_id=$1',[account]);
});
test('INV-mail: known retryable refusals back off and exhaust exactly three retries',async()=>{
 mode='refused';const id=await enqueue();
 for(let attempt=1;attempt<=4;attempt++){
  const [claim]=await claimDue(runtime,['mail']);assert.equal(claim.attempt_count,attempt);
  assert.deepEqual(await service.dispatch(claim),{kind:'refused',retryable:true,retryAfterSeconds:901});
  const state=(await db.query('SELECT state FROM job WHERE id=$1',[claim.id])).rows[0].state;assert.equal(state,attempt===4?'failed':'retry_wait');
  if(attempt<4){const delay=(await db.query('SELECT extract(epoch FROM next_attempt_at-clock_timestamp())::int n FROM job WHERE id=$1',[claim.id])).rows[0].n;assert.ok(delay>=(attempt===3?1199:900));await due();}
 }
 assert.equal((await db.query('SELECT count(*)::int n FROM mail_attempt a JOIN mail_request_member m ON m.request_id=a.request_id WHERE m.mail_id=$1',[id])).rows[0].n,4);
 mode='accepted';
});
test('INV-mail: callbacks persist unknown IDs, reject wrong secrets, replay without send, and never regress delivery',async()=>{
 const id=await enqueue();const [claim]=await claimDue(runtime,['mail']);const out=await service.dispatch(claim);assert.equal(out.kind,'accepted');const count=requests.length;
 const delivered=await callback(out.id,'delivered');const clone=delivered.clone();assert.deepEqual(await receiveMailCallback(runtime,delivered,secret),{stored:true,result:'applied'});
 assert.deepEqual(await receiveMailCallback(runtime,clone,secret),{stored:true,result:'duplicate'});
 await receiveMailCallback(runtime,await callback(out.id,'sent'),secret);await receiveMailCallback(runtime,await callback(out.id,'accepted'),secret);
 assert.equal((await db.query('SELECT state,delivered_at IS NOT NULL delivered FROM mail WHERE id=$1',[id])).rows[0].state,'sent');assert.equal(requests.length,count);
 const unknown='unknown-'+randomUUID();assert.deepEqual(await receiveMailCallback(runtime,await callback(unknown,'delivered'),secret),{stored:true,result:'unmatched'});
 await db.query('UPDATE mail SET provider_message_id=$2 WHERE id=$1',[id,unknown]);assert.equal(await replayStoredCallbacks(runtime),1);
 const handler=mailCallbackHandler(runtime,'whsec_'+randomBytes(32).toString('base64'));const response=await handler(await callback(out.id,'sent'));assert.equal(response.status,404);
 const body=await response.text();assert.equal(body.includes(secret),false);assert.equal(body.includes(out.id),false);
 const genuine=mailCallbackHandler(runtime,secret);
 const prior=(await db.query('SELECT count(*)::int n FROM provider_event')).rows[0].n;
 await db.query("CREATE FUNCTION reject_callback() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'synthetic_storage_failure'; END $$; CREATE TRIGGER reject_callback BEFORE INSERT ON provider_event FOR EACH ROW EXECUTE FUNCTION reject_callback()");
 const unavailable=await genuine(await callback(unknown,'sent'));assert.equal(unavailable.status,503);assert.equal((await db.query('SELECT count(*)::int n FROM provider_event')).rows[0].n,prior);
 await db.query('DROP TRIGGER reject_callback ON provider_event; DROP FUNCTION reject_callback()');
 await db.query("CREATE FUNCTION reject_projection() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'synthetic_apply_failure'; END $$; CREATE TRIGGER reject_projection BEFORE UPDATE ON mail FOR EACH ROW EXECUTE FUNCTION reject_projection()");
 const pending=await genuine(await callback(unknown,'sent'));assert.equal(pending.status,202);assert.deepEqual(await pending.json(),{stored:true,result:'pending'});
 assert.deepEqual(await callbackVisibility(runtime,'disabled'),{endpoint:'disabled',pending:1,unmatched:0});
 await db.query('DROP TRIGGER reject_projection ON mail; DROP FUNCTION reject_projection()');
 assert.equal(await replayStoredCallbacks(runtime),1);assert.deepEqual(await callbackVisibility(runtime),{endpoint:'unverified',pending:0,unmatched:0});assert.equal(requests.length,count);

});
test('INV-recovery: only a freshly authorized operator can attach provider evidence after the replay window',async()=>{
 mode='lost';const id=await enqueue();const [claim]=await claimDue(runtime,['mail']);assert.deepEqual(await service.dispatch(claim),{kind:'unknown'});
 const providerId=effects.get(requests.at(-1).key),operation=randomUUID();
 await db.query("UPDATE mail_request SET first_dispatched_at=clock_timestamp()-interval '24 hours' WHERE id=(SELECT request_id FROM mail_request_member WHERE mail_id=$1)",[id]);
 await db.query(`INSERT INTO operation(id,tenant_id,actor_id,name,request_key,request_digest,state,started_at,tool_calls,reserved_input,reserved_output,used_input,used_output)
  VALUES($1,$2,$3,'notifications.reconcileUnknownOutcome',$4,$5,'pending',now(),0,0,0,0,0)`,[operation,tenant,account,operation,'b'.repeat(64)]);
 const recovery=createMailService({db:runtime,encryptionKey:key,addressKey:randomBytes(32),from:'no-reply@example.test',authorize,transport,
  authorizeRecovery:async(tx,m,p)=>{
   if(m.id!==id||p!==providerId||!await authorize(tx,m))return null;
   const r=await tx.query(`SELECT g.id FROM platform_grant g JOIN operation o ON o.id=$1 AND o.tenant_id=$2 AND o.actor_id=g.account_id
    WHERE g.account_id=$3 AND g.capability='recovery_operator' AND g.revoked_at IS NULL AND (g.expires_at IS NULL OR g.expires_at>clock_timestamp()) FOR SHARE OF g,o`,[operation,m.tenant,account]);
   return r.rowCount===1?{actorId:account,operationId:operation,evidenceHash:'c'.repeat(64)}:null;
  }});
 await assert.rejects(recovery.recordProviderReceipt(id,providerId),/recovery_unavailable/);
 await db.query("INSERT INTO platform_grant(account_id,capability) VALUES($1,'recovery_operator')",[account]);
 const count=requests.length;
 assert.deepEqual(await recovery.recordProviderReceipt(id,providerId),{kind:'accepted',id:providerId});assert.equal(requests.length,count);
 assert.deepEqual((await db.query("SELECT actor_id,operation_id,reason FROM event WHERE target_record_id=$1 AND kind='reconcile'",[id])).rows,[{actor_id:account,operation_id:operation,reason:'provider_receipt/'+'c'.repeat(64)}]);
 assert.equal((await db.query('SELECT state FROM job WHERE id=$1',[claim.id])).rows[0].state,'succeeded');mode='accepted';
});
test('INV-mail: hard bounce suppresses even security mail; soft bounce does not',async()=>{
 const id=await enqueue();const [c]=await claimDue(runtime,['mail']);const out=await service.dispatch(c);assert.equal(out.kind,'accepted');
 await receiveMailCallback(runtime,await callback(out.id,'bounced',randomUUID(),{type:'Transient'}),secret);
 assert.equal((await db.query('SELECT count(*)::int n FROM suppression')).rows[0].n,0);
 await receiveMailCallback(runtime,await callback(out.id,'bounced',randomUUID(),{type:'Permanent'}),secret);
 assert.equal((await db.query("SELECT reason FROM suppression")).rows[0].reason,'hard_bounce');
 const next=await enqueue('password_reset');const [claim]=await claimDue(runtime,['mail']);const count=requests.length;
 assert.deepEqual(await service.dispatch(claim),{kind:'not_dispatched'});assert.equal(requests.length,count);
 assert.equal((await db.query('SELECT state FROM mail WHERE id=$1',[next])).rows[0].state,'refused');
});
