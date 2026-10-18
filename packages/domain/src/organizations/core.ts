import { createHash, randomUUID } from 'node:crypto';
import type { PoolClient } from 'pg';
import { z } from 'zod';
import { owner, recordId, accountId, tenantId, revision, receipt, requestIdentity, sameOwner, type Owner, type Receipt } from '@everyfield/contracts/common';
import { relationshipPair, relationshipProjection, sharingChoices, type RelationshipPair } from '@everyfield/contracts/organizations';
import { currentActor } from '../access/session.ts';
import { liveOwner } from '../access/session.ts';

export { currentActor, liveOwner, sameOwner };
export type Actor = Extract<Awaited<ReturnType<typeof currentActor>>, {status:'active'}>;
export const administrator = (a: Actor) => a.context.kind==='seat' && a.context.role!=='member';
export const unavailable = () => ({status:'unavailable'} as const);
export function refuse(code='unavailable'): never { throw new Error(code); }
export function checkRevision(expected:string, actual:string) { if(expected!==actual)refuse('stale_revision'); }
export const hash = (value:string) => createHash('sha256').update(value).digest('hex');
export function canonical(value:unknown):string {
  if(Array.isArray(value))return '['+value.map(canonical).join(',')+']';
  if(value!==null&&typeof value==='object')return '{'+Object.entries(value).sort(([a],[b])=>a.localeCompare(b)).map(([k,v])=>JSON.stringify(k)+':'+canonical(v)).join(',')+'}';
  return JSON.stringify(value);
}
export async function lock(tx:PoolClient,key:string) { await tx.query('SELECT pg_advisory_xact_lock(hashtextextended($1,7007))',[key]); }
export const subjectOwner = (pair:RelationshipPair):Owner => pair.kind==='discovery'?owner.parse({kind:'account',id:pair.accountId}):pair.subject;
export const endpointValues = (pair:RelationshipPair) => [pair.kind==='plant'?pair.subject.id:null,pair.kind==='discovery'?pair.accountId:null,pair.kind==='sending_church'?pair.subject.id:null,pair.organization.id];
export async function subjectAuthority(tx:PoolClient,actor:Actor,pair:RelationshipPair):Promise<boolean> {
  if(!sameOwner(actor.context.owner,subjectOwner(pair)))return false;
  if(pair.kind!=='discovery')return administrator(actor);
  const d=await tx.query('SELECT id FROM discovery WHERE account_id=$1 AND converted_at IS NULL FOR SHARE',[pair.accountId]);
  const s=await tx.query('SELECT id FROM seat WHERE account_id=$1 AND ended_at IS NULL FOR SHARE',[pair.accountId]);
  return d.rowCount===1&&s.rowCount===0;
}
export async function validPair(tx:PoolClient,pair:RelationshipPair) {
  if(!await liveOwner(tx,subjectOwner(pair))||!await liveOwner(tx,pair.organization))return false;
  if(pair.kind==='discovery')return (await tx.query('SELECT id FROM discovery WHERE account_id=$1 AND converted_at IS NULL FOR SHARE',[pair.accountId])).rowCount===1;
  return true;
}
const affiliationSchema=z.object({id:recordId,plant_id:tenantId.nullable(),account_id:accountId.nullable(),sending_church_id:tenantId.nullable(),organization_id:tenantId,
  organization_kind:z.enum(['sending_church','sending_network']),subject_kind:z.enum(['sending_church','sending_network']).nullable(),
  accepted_at:z.date(),ended_at:z.date().nullable(),invitation_id:recordId.nullable(),revision,consent_revision:revision,
  share_people:z.boolean(),share_meetings:z.boolean(),share_tasks:z.boolean(),share_ministry_teams:z.boolean(),share_wiki:z.boolean(),share_activity:z.boolean(),shared_findings:z.boolean()});
export type Affiliation=z.infer<typeof affiliationSchema>;
export const affiliationSelect=`SELECT a.*,o.kind AS organization_kind,s.kind AS subject_kind FROM affiliation a JOIN organization o ON o.id=a.organization_id LEFT JOIN organization s ON s.id=a.sending_church_id`;
export async function loadAffiliation(tx:PoolClient,id:string,write=false):Promise<Affiliation|null> {
  const r=await tx.query(affiliationSelect+' WHERE a.id=$1 '+(write?'FOR UPDATE OF a':'FOR SHARE OF a'),[id]);
  return r.rows[0]?affiliationSchema.parse(r.rows[0]):null;
}
export function pairOf(a:Affiliation):RelationshipPair {
  const organization={kind:'organization',id:a.organization_id,organizationKind:a.organization_kind};
  return relationshipPair.parse(a.plant_id?{kind:'plant',subject:{kind:'plant',id:a.plant_id},organization}:a.account_id?{kind:'discovery',accountId:a.account_id,organization}:{kind:'sending_church',subject:{kind:'organization',id:a.sending_church_id,organizationKind:a.subject_kind},organization});
}
export const projection=(a:Affiliation) => relationshipProjection.parse({id:a.id,pair:pairOf(a),revision:a.revision,acceptedAt:a.accepted_at.toISOString(),endedAt:a.ended_at?.toISOString()??null});
export const choices=(a:Affiliation) => sharingChoices.parse({people:a.share_people,meetings:a.share_meetings,tasks:a.share_tasks,ministry_teams:a.share_ministry_teams,wiki:a.share_wiki,activity:a.share_activity,shared_findings:a.shared_findings});
export async function active(tx:PoolClient,a:Affiliation) {
  return a.ended_at===null && (await tx.query("SELECT id FROM affiliation WHERE id=$1 AND accepted_at<=clock_timestamp()",[a.id])).rowCount===1 && await validPair(tx,pairOf(a)) &&
    !(await tx.query("SELECT id FROM lifecycle_witness WHERE affiliation_id=$1 AND state<>'active' FOR SHARE",[a.id])).rowCount;
}
export interface OrganizationEffects {
  invitation(tx:PoolClient,input:{invitationId:string;owner:Owner;recipientEmail:string;proof:string;inviterDescription:string;expiresAt:string;operationId:string}):Promise<void>;
  notice(tx:PoolClient,input:{eventId:string;relationshipId:string;pair:RelationshipPair;kind:'relationship_approved'|'relationship_ended'|'sharing_changed';revision:string;operationId:string}):Promise<void>;
  invalidate(tx:PoolClient,input:{owner:Owner;sourceId:string;revision:string}):Promise<void>;
}
type Command={requestKey:string;expectedRevision:string;input:unknown};
export async function beginCommand(tx:PoolClient,actor:Actor,selected:Owner,name:string,command:Command) {
  const identity=requestIdentity.parse({owner:selected,actorId:actor.accountId,operation:name,requestKey:command.requestKey,
    digest:hash(canonical(command)),origin:{kind:'native'}});
  await lock(tx,'request/'+selected.id+'/'+command.requestKey);
  const prior=await tx.query('SELECT r.receipt,r.result FROM operation o JOIN organization_operation_result r ON r.operation_id=o.id WHERE o.tenant_id=$1 AND o.request_key=$2',[selected.id,command.requestKey]);
  if(prior.rows[0]) {
    const saved=receipt.parse(prior.rows[0].receipt);
    if(canonical(saved.request)!==canonical(identity))refuse('request_conflict');
    return {kind:'replay' as const,result:prior.rows[0].result,receipt:saved};
  }
  const id=randomUUID();
  await tx.query(`INSERT INTO operation(id,tenant_id,actor_id,name,request_key,request_digest,state,started_at,tool_calls,reserved_input,reserved_output,used_input,used_output)
    VALUES($1,$2,$3,$4,$5,$6,'running',clock_timestamp(),0,0,0,0,0)`,[id,selected.id,actor.accountId,name,command.requestKey,identity.digest]);
  return {kind:'new' as const,id,identity};
}
export type NewCommand=Extract<Awaited<ReturnType<typeof beginCommand>>,{kind:'new'}>;
export async function finishCommand<T>(tx:PoolClient,c:NewCommand,result:(r:Receipt)=>T,eventIds:string[],changed=true):Promise<T> {
  const now=(await tx.query<{now:Date}>('SELECT clock_timestamp() AS now')).rows[0]!.now.toISOString();
  const r=receipt.parse({id:c.id,request:c.identity,completedAt:now,outcome:changed?'changed':'noop',subjects:[],eventIds,effectIds:[]});
  const output=result(r);
  await tx.query("UPDATE operation SET state='complete',outcome=$2,completed_at=$3 WHERE id=$1",[c.id,changed?'committed':'no_effect',now]);
  await tx.query('INSERT INTO organization_operation_result(operation_id,receipt,result) VALUES($1,$2,$3)',[c.id,JSON.stringify(r),JSON.stringify(output)]);
  return output;
}
export async function appendEvent(tx:PoolClient,c:NewCommand,target:string,kind:string,action:string|null,before:string,after:string) {
  const id=randomUUID();
  await tx.query(`INSERT INTO event(id,tenant_id,target_record_id,operation_id,actor_id,kind,action,occurred_at,recorded_at,before_revision,after_revision,event_key)
    VALUES($1,$2,$3,$4,$5,$6,$7,clock_timestamp(),clock_timestamp(),$8,$9,$4)`,[id,c.identity.owner.id,target,c.id,c.identity.actorId,kind,action,before,after]);
  return id;
}
export async function invalidate(tx:PoolClient,effects:OrganizationEffects,pair:RelationshipPair,id:string,rev:string) {
  await tx.query('UPDATE organization SET material_revision=material_revision+1 WHERE id=$1',[pair.organization.id]);
  await effects.invalidate(tx,{owner:pair.organization,sourceId:id,revision:rev});
}
