import 'server-only';
import type { PoolClient } from 'pg';
import { z } from 'zod';
import { createMailService, type MailIntent } from './mail.ts';
import { taskReminderTimes,meetingReminderTimes } from './calendar.ts';
export const category=z.enum(['task_due','task_overdue','meeting_announcement','meeting_reminder','planter_digest',
  'oversight_digest','relationship_milestone','sharing_milestone','phase_milestone','launch_milestone','wiki_upstream_review']);
const sourceSchema=z.strictObject({kind:z.enum(['task','meeting','affiliation','phase_transition','launch_milestone','article_editor_state']),
  id:z.uuid(),revision:z.string().regex(/^[1-9]\d*$/)});
export type NoticeSource=z.infer<typeof sourceSchema>;
const noticeInput=z.strictObject({owner:z.discriminatedUnion('kind',[
  z.strictObject({kind:z.literal('plant'),id:z.uuid()}),
  z.strictObject({kind:z.literal('organization'),id:z.uuid(),organizationKind:z.enum(['sending_church','sending_network'])})]),
  source:sourceSchema,recipient:z.uuid(),category,occurrence:z.string().min(1).max(150),
  eligibleAt:z.iso.datetime(),title:z.string().min(1).max(500),text:z.string().max(10_000),operation:z.uuid().nullable()});
export type NoticeInput=z.infer<typeof noticeInput>;
const policy={task_due:{category:'task',purpose:'task_due',preference:'task',source:'task'},
  task_overdue:{category:'task',purpose:'task_due',preference:'task',source:'task'},
  meeting_announcement:{category:'meeting',purpose:'meeting_invitation',preference:'meeting',source:'meeting'},
  meeting_reminder:{category:'meeting',purpose:'meeting_reminder',preference:'meeting',source:'meeting'},
  planter_digest:{category:'digest',purpose:'planter_digest',preference:'planter_digest',source:null},
  oversight_digest:{category:'digest',purpose:'oversight_digest',preference:'oversight_digest',source:null},
  relationship_milestone:{category:'relationship',purpose:'relationship_decision',preference:'relationship',source:'affiliation'},
  sharing_milestone:{category:'relationship',purpose:'relationship_decision',preference:'relationship',source:'affiliation'},
  phase_milestone:{category:'phase',purpose:'phase_transition',preference:'phase',source:'phase_transition'},
  launch_milestone:{category:'launch',purpose:'launch_milestone',preference:'phase',source:'launch_milestone'},
  wiki_upstream_review:{category:'reference_update',purpose:'reference_update',preference:'reference_update',source:'article_editor_state'}} as const;
export async function channelEnabled(tx:PoolClient,recipient:string,preference:string,channel:'email'|'in_app') {
  const row=await tx.query('SELECT enabled FROM notification_preference WHERE account_id=$1 AND category=$2 AND channel=$3',[recipient,preference,channel]);
  return row.rows[0]?z.boolean().parse(row.rows[0].enabled):!(preference==='planter_digest'&&channel==='in_app');
}
export async function lockSource(tx:PoolClient,tenant:string,source:NoticeSource) {
  const s=sourceSchema.parse(source);
  const tables={task:['task','plant_id'],meeting:['meeting','plant_id'],affiliation:['affiliation','plant_id'],
    phase_transition:['phase_transition','plant_id'],launch_milestone:['launch_milestone','plant_id'],article_editor_state:['article_editor_state','organization_id']} as const;
  const [table,column]=tables[s.kind];
  if(s.kind==='phase_transition'){
    const phase=await tx.query("SELECT id FROM phase_transition WHERE id=$1 AND plant_id=$2 AND kind='movement' AND to_phase>from_phase AND $3='1' FOR SHARE",[s.id,tenant,s.revision]);
    return phase.rowCount===1;
  }
  if(s.kind==='affiliation'){
    const relationship=await tx.query('SELECT id FROM affiliation WHERE id=$1 AND (plant_id=$2 OR organization_id=$2) AND revision=$3 FOR SHARE',[s.id,tenant,s.revision]);
    return relationship.rowCount===1;
  }
  const r=await tx.query(`SELECT id FROM ${table} WHERE id=$1 AND ${column}=$2 AND revision=$3 FOR SHARE`,[s.id,tenant,s.revision]);
  return r.rowCount===1;
}
export function createNotificationService(config:{mail:ReturnType<typeof createMailService>;
  eligible:(tx:PoolClient,input:NoticeInput)=>Promise<{address:string|null}|null>}) {
  async function enqueue(tx:PoolClient,input:NoticeInput) {
    const v=noticeInput.parse(input),p=policy[v.category];
    if(!p.source || p.source!==v.source.kind)throw Error('notification_source_mismatch');
    const tenant=await tx.query('SELECT kind FROM tenant WHERE id=$1',[v.owner.id]);
    if(tenant.rows[0]?.kind!==v.owner.kind)throw Error('notification_owner_mismatch');
    if(v.owner.kind==='organization'){
      const org=await tx.query('SELECT kind FROM organization WHERE id=$1 FOR SHARE',[v.owner.id]);
      if(org.rows[0]?.kind!==v.owner.organizationKind)throw Error('notification_owner_mismatch');
    }
    if(!await lockSource(tx,v.owner.id,v.source))throw Error('notification_source_stale');
    if(v.source.kind==='task'){
      const task=await tx.query("SELECT id FROM task WHERE id=$1 AND assignee_id=$2 AND deleted_at IS NULL AND status NOT IN ('complete','no_longer_needed') FOR SHARE",[v.source.id,v.recipient]);
      if(task.rowCount!==1)return {notice:null,mail:null};
    }
    if(v.source.kind==='meeting'){
      const meeting=await tx.query("SELECT id FROM meeting WHERE id=$1 AND status NOT IN ('cancelled','completed') AND starts_at>clock_timestamp() FOR SHARE",[v.source.id]);
      if(meeting.rowCount!==1)return {notice:null,mail:null};
    }
    if(v.source.kind==='launch_milestone'){
      const launch=await tx.query('SELECT id FROM launch_milestone WHERE id=$1 AND completed_at IS NOT NULL AND removed_at IS NULL FOR SHARE',[v.source.id]);
      if(launch.rowCount!==1)return {notice:null,mail:null};
    }
    if(v.category==='wiki_upstream_review'){
      if(v.owner.kind!=='organization')throw Error('notification_owner_mismatch');
      const seat=await tx.query("SELECT id FROM seat WHERE account_id=$1 AND organization_id=$2 AND ended_at IS NULL AND role IN ('owner','admin') FOR SHARE",[v.recipient,v.owner.id]);
      if(seat.rowCount!==1)return {notice:null,mail:null};
    }
    const recipient=await config.eligible(tx,v);if(!recipient)return {notice:null,mail:null};
    const key=`${v.owner.id}/${v.category}/${v.source.id}/${v.source.revision}/${v.occurrence}`;
    const old=await tx.query('SELECT id,title,safe_body,eligible_at FROM notice WHERE recipient_id=$1 AND logical_key=$2',[v.recipient,key]);
    if(old.rows[0]){
      if(old.rows[0].title!==v.title||old.rows[0].safe_body!==v.text||old.rows[0].eligible_at.toISOString()!==new Date(v.eligibleAt).toISOString())throw Error('notification_identity_conflict');
      const mail=await tx.query('SELECT id FROM mail WHERE notice_id=$1',[old.rows[0].id]);return {notice:z.uuid().parse(old.rows[0].id),mail:mail.rows[0]?z.uuid().parse(mail.rows[0].id):null};
    }
    // Wiki editor notices remain in-app even when an email preference is supplied elsewhere.
    const inApp=await channelEnabled(tx,v.recipient,p.preference,'in_app');
    const email=v.category!=='wiki_upstream_review'&&await channelEnabled(tx,v.recipient,p.preference,'email');
    if(!inApp&&!email)return {notice:null,mail:null};
    const inserted=await tx.query(`INSERT INTO notice(tenant_id,recipient_id,category,purpose,logical_key,source_record_id,
      source_revision,title,safe_body,eligible_at,created_at,archived_at)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,clock_timestamp(),CASE WHEN $11 THEN NULL ELSE clock_timestamp() END)
      ON CONFLICT(recipient_id,logical_key) DO UPDATE SET logical_key=excluded.logical_key RETURNING id`,
    [v.owner.id,v.recipient,p.category,p.purpose,key,v.source.id,v.source.revision,v.title,v.text,v.eligibleAt,inApp]);
    const id=z.uuid().parse(inserted.rows[0].id);
    const mail=email&&recipient.address?await config.mail.enqueue(tx,{owner:v.owner,recipient:v.recipient,address:recipient.address,
      purpose:'notification',logicalKey:`notice/${id}`,notice:id,operation:v.operation,eligibleAt:v.eligibleAt,
      content:{subject:v.title,text:v.text}}):null;
    return {notice:id,mail};
  }
  async function cancelForEntity(tx:PoolClient,tenant:string,source:NoticeSource,preserveCurrent=false) {
    if(!await lockSource(tx,tenant,source))throw Error('notification_source_stale');
    await tx.query('UPDATE notice SET cancelled_at=coalesce(cancelled_at,clock_timestamp()) WHERE tenant_id=$1 AND source_record_id=$2 AND (NOT $3 OR source_revision<>$4)',[tenant,source.id,preserveCurrent,source.revision]);
    // Pending/known-refused work is safe to cancel. Unknown external effects stay unknown.
    await tx.query(`UPDATE mail m SET state='cancelled' FROM notice n WHERE n.id=m.notice_id AND n.tenant_id=$1
      AND n.source_record_id=$2 AND n.cancelled_at IS NOT NULL AND m.state IN ('pending','refused')`,[tenant,source.id]);
    await tx.query(`UPDATE job j SET state='cancelled',claim_generation=claim_generation+1,lease_owner=NULL,lease_until=NULL,
      revision=j.revision+1,finished_at=clock_timestamp() FROM mail m JOIN notice n ON n.id=m.notice_id WHERE m.job_id=j.id AND n.tenant_id=$1
      AND n.source_record_id=$2 AND n.cancelled_at IS NOT NULL AND m.state='cancelled' AND j.state IN ('ready','retry_wait','claimed')`,[tenant,source.id]);
  }
  // Actual task/meeting producers run these in the mutation transaction, after their new revision.
  async function syncTaskReminders(tx:PoolClient,input:{base:Omit<NoticeInput,'category'|'occurrence'|'eligibleAt'>;
    due:Parameters<typeof taskReminderTimes>[0];open:boolean;asOf:string}) {
    await cancelForEntity(tx,input.base.owner.id,input.base.source,input.open);
    if(!input.open)return [];
    const result=[];
    for(const t of taskReminderTimes(input.due))if(t.at>=input.asOf)result.push(await enqueue(tx,{...input.base,
      category:t.slot==='due'?'task_due':'task_overdue',occurrence:t.slot,eligibleAt:t.at}));
    return result;
  }
  async function syncMeetingReminders(tx:PoolClient,input:{base:Omit<NoticeInput,'category'|'occurrence'|'eligibleAt'>;
    date:string;time:string;zone:string;scheduled:boolean;startsAt:string;asOf:string}) {
    await cancelForEntity(tx,input.base.owner.id,input.base.source,input.scheduled&&input.startsAt>input.asOf);
    if(!input.scheduled||input.startsAt<=input.asOf)return [];
    const result=[];
    for(const t of meetingReminderTimes(input.date,input.time,input.zone))if(t.at>=input.asOf)result.push(await enqueue(tx,{...input.base,
      category:'meeting_reminder',occurrence:t.slot,eligibleAt:t.at}));
    return result;
  }
  return {enqueue,cancelForEntity,syncTaskReminders,syncMeetingReminders};
}
// A Discovery receipt deliberately has no plant or inbox anchor.
export async function sendDiscoveryAssociationReceipt(tx:PoolClient,mail:ReturnType<typeof createMailService>,input:{
  organization:string;account:string;occurrence:string;operation:string;content:MailIntent['content'];
  address:(tx:PoolClient,account:string)=>Promise<string|null>;now:string;
  verifyOccurrence:(tx:PoolClient)=>Promise<boolean>}) {
  if(!await input.verifyOccurrence(tx))throw Error('association_occurrence_unavailable');
  z.uuid().parse(input.operation);
  const rows=await tx.query("SELECT account_id FROM seat WHERE organization_id=$1 AND role='owner' AND ended_at IS NULL FOR SHARE",[input.organization]);
  const recipients=[...new Set([input.account,...rows.rows.map(r=>z.uuid().parse(r.account_id))])];
  const ids=[];
  for(const recipient of recipients){const address=await input.address(tx,recipient);if(!address)continue;
    ids.push(await mail.enqueue(tx,{owner:{kind:'account',id:recipient},recipient,address,purpose:'discovery_receipt',
      logicalKey:`association/${input.operation}/${input.occurrence}/${recipient}`,content:input.content,operation:null,notice:null,eligibleAt:input.now}));
  }
  return ids;
}
