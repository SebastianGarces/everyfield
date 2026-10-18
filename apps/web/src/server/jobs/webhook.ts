import 'server-only';
import { createHash } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';
import { z } from 'zod';
import { boundedBytes, safeBoundary, safeResponse } from '../platform/boundary.ts';
import { transaction } from '../platform/database.ts';
import { verifyCallback } from '../platform/webhook.ts';
const kinds = ['accepted','scheduled','sent','delivered','bounced','complained','opened','clicked','cancelled'] as const;
const wire=z.object({type:z.enum(kinds.map(k=>`email.${k}` as const)),created_at:z.iso.datetime(),
  data:z.object({email_id:z.string().min(1).max(128),bounce:z.object({type:z.string()}).optional()})});
const eventSchema=z.object({id:z.uuid(),message_id:z.string(),kind:z.enum(kinds),occurred_at:z.date(),
  safe_payload:z.object({hard_bounce:z.boolean()}),processed_at:z.date().nullable()});
async function apply(tx:PoolClient,eventId:string) {
  const row=await tx.query('SELECT * FROM provider_event WHERE id=$1 FOR UPDATE',[eventId]);
  const e=eventSchema.parse(row.rows[0]);if(e.processed_at)return 'duplicate' as const;
  const matches=await tx.query('SELECT id,tenant_id,address_hash,job_id FROM mail WHERE provider_message_id=$1 FOR UPDATE',[e.message_id]);
  // Unknown and ambiguous IDs are retained as pending evidence, never routed by request IDs.
  if(matches.rowCount!==1)return 'unmatched' as const;
  const m=z.object({id:z.uuid(),tenant_id:z.uuid(),address_hash:z.string().nullable(),job_id:z.uuid().nullable()}).parse(matches.rows[0]);
  const columns={accepted:'accepted_at',scheduled:'accepted_at',sent:'sent_at',delivered:'delivered_at',
    bounced:'bounced_at',complained:'complained_at',opened:'opened_at',clicked:'clicked_at',cancelled:'cancel_confirmed_at'} as const;
  const column=columns[e.kind];
  await tx.query(`UPDATE mail SET ${column}=CASE WHEN ${column} IS NULL THEN $2 ELSE least(${column},$2) END,
    state=CASE WHEN state='cancelled' THEN state WHEN $3='cancelled' AND sent_at IS NULL AND delivered_at IS NULL THEN 'cancelled'
      WHEN sent_at IS NOT NULL OR delivered_at IS NOT NULL OR $3 IN ('sent','delivered') THEN 'sent'
      WHEN state IN ('pending','dispatched','unknown') THEN 'accepted' ELSE state END,
    provider_message_id=$4 WHERE id=$1`,[m.id,e.occurred_at,e.kind,e.message_id]);
  if(m.address_hash && (e.kind==='complained' || (e.kind==='bounced' && e.safe_payload.hard_bounce))){
    await tx.query('SELECT pg_advisory_xact_lock(hashtextextended($1,31))',[m.address_hash]);
    await tx.query(`INSERT INTO suppression(address_hash,reason,source_event_id,suppressed_at)
      VALUES($1,$2,$3,clock_timestamp()) ON CONFLICT(address_hash) DO UPDATE
      SET reason=excluded.reason,source_event_id=excluded.source_event_id,suppressed_at=excluded.suppressed_at,
      cleared_at=NULL,clear_operation_id=NULL,revision=suppression.revision+1`,[m.address_hash,e.kind==='complained'?'complaint':'hard_bounce',e.id]);
  }
  await tx.query('UPDATE provider_event SET mail_id=$2,processed_at=clock_timestamp() WHERE id=$1',[e.id,m.id]);
  await tx.query(`UPDATE job SET state='succeeded',error_code=NULL,finished_at=clock_timestamp(),revision=revision+1
    WHERE id=$1 AND state='reconcile'`,[m.job_id]);
  const action=e.kind==='delivered'?'mail.delivered':e.kind==='cancelled'?'mail.cancelled':'mail.reconciled';
  await tx.query(`INSERT INTO event(tenant_id,target_record_id,kind,occurred_at,recorded_at,system_cause,event_key,action)
    VALUES($1,$2,'outcome',$3,clock_timestamp(),'provider_callback',$4,$5) ON CONFLICT(target_record_id,event_key) DO NOTHING`,
  [m.tenant_id,m.id,e.occurred_at,`provider/${e.id}`,action]);
  return 'applied' as const;
}
export async function receiveMailCallback(db:Pool,request:Request,secret:string) {
  const raw=await boundedBytes(request,16_384);const key=verifyCallback(raw,request.headers,secret);
  const v=wire.parse(JSON.parse(new TextDecoder().decode(raw)));
  const kind=z.enum(kinds).parse(v.type.slice(6));const hash=createHash('sha256').update(raw).digest('hex');
  // Commit the safe receipt before attempting application, including unknown message IDs.
  const id=await transaction(db,async tx=>{
    const r=await tx.query(`INSERT INTO provider_event(event_key,message_id,kind,occurred_at,received_at,payload_hash,safe_payload)
      VALUES($1,$2,$3,$4,clock_timestamp(),$5,$6) ON CONFLICT(event_key) DO NOTHING RETURNING id`,
    [key,v.data.email_id,kind,v.created_at,hash,{hard_bounce:kind==='bounced'&&v.data.bounce?.type==='Permanent'}]);
    if(r.rows[0])return z.uuid().parse(r.rows[0].id);
    const old=await tx.query('SELECT id,payload_hash FROM provider_event WHERE event_key=$1',[key]);
    if(old.rows[0]?.payload_hash!==hash)throw Error('callback_identity_conflict');return z.uuid().parse(old.rows[0].id);
  });
  try{return {stored:true,result:await transaction(db,tx=>apply(tx,id))};}
  catch{return {stored:true,result:'pending' as const};}
}
export async function replayStoredCallbacks(db:Pool,limit=100) {
  z.number().int().min(1).max(100).parse(limit);
  const rows=await db.query(`SELECT e.id FROM provider_event e WHERE e.processed_at IS NULL AND
    EXISTS(SELECT 1 FROM mail m WHERE m.provider_message_id=e.message_id) ORDER BY e.received_at,e.id LIMIT $1`,[limit]);
  let applied=0;
  for(const row of rows.rows){
    try{if(await transaction(db,tx=>apply(tx,z.uuid().parse(row.id)))==='applied')applied++;}
    catch{/* The durable pending receipt stays visible; another bad row cannot block the scan tail. */}
  }
  return applied;
}
export function mailCallbackHandler(db:Pool,secret:string) {
  return (request:Request)=>safeBoundary(async()=>{
    if(request.method!=='POST')return safeResponse({code:'method_not_allowed'},405);
    const result=await receiveMailCallback(db,request,secret);return safeResponse(result,result.result==='pending'?202:200);
  });
}

export async function callbackVisibility(db:Pool,endpoint:'disabled'|'unverified'|'verified'='unverified') {
  const r=await db.query(`SELECT count(*) FILTER(WHERE processed_at IS NULL)::int AS pending,
    count(*) FILTER(WHERE processed_at IS NULL AND NOT EXISTS(SELECT 1 FROM mail m WHERE m.provider_message_id=e.message_id))::int AS unmatched FROM provider_event e`);
  return {endpoint,...z.object({pending:z.number().int(),unmatched:z.number().int()}).parse(r.rows[0])};
}
// The operator adapter must establish fresh restricted authority for this exact mail owner.
export async function recoverCallback(db:Pool,eventId:string,authorize:(tx:PoolClient,tenant:string)=>Promise<{actorId:string;operationId:string}|null>) {
  z.uuid().parse(eventId);
  return transaction(db,async tx=>{
    const found=await tx.query(`SELECT m.tenant_id,m.id FROM provider_event e JOIN mail m ON m.provider_message_id=e.message_id WHERE e.id=$1`,[eventId]);
    if(found.rowCount!==1)return 'unmatched' as const;
    const m=z.object({tenant_id:z.uuid(),id:z.uuid()}).parse(found.rows[0]);
    const actor=await authorize(tx,m.tenant_id);if(!actor)throw Error('recovery_unavailable');
    const result=await apply(tx,eventId);
    await tx.query(`INSERT INTO event(tenant_id,target_record_id,actor_id,operation_id,kind,occurred_at,recorded_at,event_key,action)
      VALUES($1,$2,$3,$4,'reconcile',clock_timestamp(),clock_timestamp(),$5,'mail.reconciled')
      ON CONFLICT(target_record_id,event_key) DO NOTHING`,[m.tenant_id,m.id,actor.actorId,actor.operationId,`callback-recovery/${eventId}/${actor.operationId}`]);
    return result;
  });
}
