import { randomBytes, timingSafeEqual } from 'node:crypto';
import type { PoolClient } from 'pg';
import { z } from 'zod';
import { recordId, accountId, tenantId, revision, type Owner, type sessionId } from '@everyfield/contracts/common';
import * as Q from '@everyfield/contracts/organizations';
import type { OrganizationAdapter, RelationshipPair } from '@everyfield/contracts/organizations';
import { administrator, appendEvent, beginCommand, checkRevision, currentActor, endpointValues, finishCommand, hash, invalidate, loadAffiliation, liveOwner, lock,
  pairOf, projection, refuse, sameOwner, subjectAuthority, subjectOwner, validPair, type Actor, type OrganizationEffects } from './core.ts';

const invitationRow=z.object({id:recordId,tenant_id:tenantId,recipient_email:z.string(),inviter_id:accountId.nullable(),token_hash:z.string(),state:z.string(),created_at:z.date(),resent_at:z.date().nullable(),revision,
  plant_id:tenantId.nullable(),account_id:accountId.nullable(),sending_church_id:tenantId.nullable(),organization_id:tenantId,organization_kind:z.enum(['sending_church','sending_network']),subject_kind:z.enum(['sending_church','sending_network']).nullable(),inviter_description:z.string(),subject_revision:revision});
type Invite=z.infer<typeof invitationRow>;
const pairFor=(i:Invite) => Q.relationshipPair.parse({kind:i.plant_id?'plant':i.account_id?'discovery':'sending_church',...(i.account_id?{accountId:i.account_id}:{subject:i.plant_id?{kind:'plant',id:i.plant_id}:{kind:'organization',id:i.sending_church_id,organizationKind:i.subject_kind}}),organization:{kind:'organization',id:i.organization_id,organizationKind:i.organization_kind}});
async function loadInvitation(tx:PoolClient,id:string) {
  const r=await tx.query(`SELECT i.*,r.*,i.revision,o.kind AS organization_kind,s.kind AS subject_kind FROM invitation i
    JOIN relationship_invitation r ON r.invitation_id=i.id JOIN organization o ON o.id=r.organization_id LEFT JOIN organization s ON s.id=r.sending_church_id WHERE i.id=$1 FOR UPDATE OF i`,[id]);
  return r.rows[0]?invitationRow.parse(r.rows[0]):null;
}
async function assertInviter(tx:PoolClient,i:Invite,pair:RelationshipPair) {
  if(!i.inviter_id||!await liveOwner(tx,{kind:'account',id:i.inviter_id}))return false;
  if(pair.kind==='discovery')return i.inviter_id===pair.accountId&&(await tx.query('SELECT id FROM discovery WHERE account_id=$1 AND converted_at IS NULL FOR SHARE',[pair.accountId])).rowCount===1&&!(await tx.query('SELECT id FROM seat WHERE account_id=$1 AND ended_at IS NULL FOR SHARE',[pair.accountId])).rowCount;
  return (await tx.query(`SELECT id FROM seat WHERE account_id=$1 AND coalesce(plant_id,organization_id)=$2 AND role IN ('owner','admin') AND ended_at IS NULL
    AND NOT EXISTS(SELECT FROM lifecycle_witness w WHERE w.seat_id=seat.id AND w.state<>'active') FOR SHARE`,[i.inviter_id,pair.subject.id])).rowCount===1;
}
async function time(tx:PoolClient) { return (await tx.query<{now:Date}>('SELECT clock_timestamp() AS now')).rows[0]!.now; }
function proofMatches(proof:string,digest:string) { const a=Buffer.from(hash(proof)),b=Buffer.from(digest); return a.length===b.length&&timingSafeEqual(a,b); }
async function addressed(tx:PoolClient,session:z.infer<typeof sessionId>,i:Invite) {
  return (await tx.query<{email:string|null}>('SELECT relationship_recipient($1) AS email',[session])).rows[0]?.email===i.recipient_email;
}
async function authorizedReceiver(tx:PoolClient,actor:Actor,i:Invite,pair:RelationshipPair,session:z.infer<typeof sessionId>) {
  return sameOwner(actor.context.owner,pair.organization)&&administrator(actor)&&await addressed(tx,session,i);
}
async function findPair(tx:PoolClient,pair:RelationshipPair) {
  const r=await tx.query('SELECT id FROM affiliation WHERE plant_id IS NOT DISTINCT FROM $1::uuid AND account_id IS NOT DISTINCT FROM $2::uuid AND sending_church_id IS NOT DISTINCT FROM $3::uuid AND organization_id=$4 FOR UPDATE',endpointValues(pair));
  return r.rows[0]?loadAffiliation(tx,recordId.parse(r.rows[0].id),true):null;
}
export function relationshipCommands(effects:OrganizationEffects):Pick<OrganizationAdapter<PoolClient>,'associations.invite'|'associations.acceptInvitation'|'associations.respondInvitation'|'associations.declineInvitation'|'associations.resendInvitation'|'associations.revokeInvitation'|'associations.end'> {
  async function invite(tx:PoolClient,session:z.infer<typeof sessionId>,selected:Owner,raw:unknown) {
    const q=Q.inviteRelationshipRequest.parse(raw),pair=q.input.pair;
    await lock(tx,'pair/'+JSON.stringify(endpointValues(pair)));
    const actor=await currentActor(tx,session,selected);
    if(actor.status!=='active'||!await subjectAuthority(tx,actor,pair)||!await validPair(tx,pair))refuse();
    const c=await beginCommand(tx,actor,selected,'associations.invite',q);
    if(c.kind==='replay')return Q.invitationResult.parse(c.result);
    const subject=subjectOwner(pair);
    const table=subject.kind==='plant'?'plant':subject.kind==='account'?'account':'organization';
    const root=await tx.query<{revision:string;name?:string}>(`SELECT revision${subject.kind==='account'?'':',name'} FROM ${table} WHERE id=$1 FOR SHARE`,[subject.id]);
    checkRevision(q.expectedRevision,revision.parse(root.rows[0]?.revision));
    if((await findPair(tx,pair))?.ended_at===null)refuse('already_active');
    await lock(tx,'invite-address/'+q.input.recipientEmail);
    const limit=await tx.query<{count:number}>("SELECT count(*)::int AS count FROM invitation WHERE recipient_email=$1 AND created_at>clock_timestamp()-interval '30 days'",[q.input.recipientEmail]);
    if(limit.rows[0]!.count>=3)refuse('invitation_limit');
    const pending=await tx.query(`SELECT i.id FROM invitation i JOIN relationship_invitation r ON r.invitation_id=i.id WHERE r.plant_id IS NOT DISTINCT FROM $1::uuid AND r.account_id IS NOT DISTINCT FROM $2::uuid
      AND r.sending_church_id IS NOT DISTINCT FROM $3::uuid AND r.organization_id=$4 AND i.state='pending' AND i.created_at>clock_timestamp()-interval '30 days'`,endpointValues(pair));
    if(pending.rowCount)refuse('pending_invitation');
    const now=await time(tx),expiry=new Date(now.getTime()+30*86400000).toISOString(),proof=randomBytes(32).toString('base64url');
    const purposes={plant:pair.organization.organizationKind==='sending_church'?'plant_church':'plant_network',sending_church:'church_network',discovery:pair.organization.organizationKind==='sending_church'?'discovery_church':'discovery_network'};
    const description=subject.kind==='account'?z.string().trim().min(1).max(500).parse((await tx.query('SELECT relationship_inviter_name($1) AS name',[session])).rows[0]?.name):root.rows[0]!.name!;
    const inserted=await tx.query<{id:string}>(`INSERT INTO invitation(tenant_id,purpose,recipient_email,inviter_id,token_hash,state,created_at) VALUES($1,$2,$3,$4,$5,'pending',$6) RETURNING id`,[subject.id,purposes[pair.kind],q.input.recipientEmail,actor.accountId,hash(proof),now]);
    const id=inserted.rows[0]!.id;
    await tx.query(`INSERT INTO relationship_invitation(invitation_id,plant_id,account_id,sending_church_id,organization_id,inviter_description,subject_revision) VALUES($1,$2,$3,$4,$5,$6,$7)`,[id,...endpointValues(pair),description,q.expectedRevision]);
    const event=await appendEvent(tx,c,id,'create',null,'0','1');
    await effects.invitation(tx,{invitationId:id,owner:subject,recipientEmail:q.input.recipientEmail,proof,inviterDescription:description,expiresAt:expiry,operationId:c.id});
    return finishCommand(tx,c,r=>Q.invitationResult.parse({status:'pending',invitationId:id,pair,revision:'1',expiresAt:expiry,inviterDescription:description,receipt:r}),[event]);
  }
  async function decide(tx:PoolClient,session:z.infer<typeof sessionId>,selected:Owner,raw:unknown,name:'associations.acceptInvitation'|'associations.respondInvitation'|'associations.declineInvitation') {
    const q=name==='associations.declineInvitation'?Q.declineInvitationRequest.parse(raw):name==='associations.acceptInvitation'?Q.acceptInvitationRequest.parse(raw):Q.respondInvitationRequest.parse(raw);
    // Address rows stay locked through decision, proof rotation and receipt commit.
    const i=await loadInvitation(tx,q.input.invitationId);
    if(!i)refuse();
    const pair=pairFor(i);await lock(tx,'pair/'+JSON.stringify(endpointValues(pair)));
    const actor=await currentActor(tx,session,selected);
    if(actor.status!=='active'||!await validPair(tx,pair)||!await authorizedReceiver(tx,actor,i,pair,session))refuse();
    const c=await beginCommand(tx,actor,selected,name,q);
    if(c.kind==='replay') {
      if(i.state==='accepted') { const a=await findPair(tx,pair);if(!a||a.ended_at!==null)refuse(); }
      return Q.invitationDecisionResult.parse(c.result);
    }
    checkRevision(q.expectedRevision,i.revision);
    if(i.state!=='pending'||(await time(tx)).getTime()>=i.created_at.getTime()+30*86400000||!await assertInviter(tx,i,pair))refuse();
    if('proof' in q.input&&!proofMatches(q.input.proof,i.token_hash))refuse();
    const accept=q.input.decision==='accept';
    await tx.query("UPDATE invitation SET state=$2,acted_at=clock_timestamp(),accepted_account_id=$3,revision=revision+1 WHERE id=$1",[i.id,accept?'accepted':'declined',actor.accountId]);
    if(!accept){const event=await appendEvent(tx,c,i.id,'remove',null,i.revision,String(BigInt(i.revision)+1n));return finishCommand(tx,c,r=>Q.invitationDecisionResult.parse({status:'declined',invitationId:i.id,receipt:r}),[event]);}
    let a=await findPair(tx,pair);
    if(a?.ended_at===null)refuse('already_active');
    const previous=a?.revision??'0';
    if(a)await tx.query('UPDATE affiliation SET accepted_at=clock_timestamp(),ended_at=NULL,invitation_id=$2,revision=revision+1 WHERE id=$1',[a.id,i.id]);
    else {
      const r=await tx.query<{id:string}>(`INSERT INTO affiliation(plant_id,account_id,sending_church_id,organization_id,accepted_at,invitation_id,share_people,share_meetings,share_tasks,share_ministry,share_wiki,share_activity,shared_findings)
        VALUES($1,$2,$3,$4,clock_timestamp(),$5,$6,$6,$6,$6,$6,$6,$6) RETURNING id`,[...endpointValues(pair),i.id,pair.kind==='plant']);
      a=await loadAffiliation(tx,r.rows[0]!.id,true);
    }
    if(!a)refuse();a=(await loadAffiliation(tx,a.id,true))!;
    const event=await appendEvent(tx,c,a.id,'accept','affiliation.approved',previous,a.revision);
    await tx.query('INSERT INTO relationship_history(id,relationship_id,pair,reason,source_invitation_id) VALUES($1,$2,$3,NULL,$4)',[event,a.id,JSON.stringify(pair),i.id]);
    await invalidate(tx,effects,pair,a.id,a.revision);
    await effects.notice(tx,{eventId:event,relationshipId:a.id,pair,kind:'relationship_approved',revision:a.revision,operationId:c.id});
    return finishCommand(tx,c,r=>Q.invitationDecisionResult.parse({status:'accepted',relationship:projection(a),receipt:r}),[event]);
  }
  async function manage(tx:PoolClient,session:z.infer<typeof sessionId>,selected:Owner,raw:unknown,resend:boolean) {
    const q=Q.invitationCommandRequest.parse(raw),i=await loadInvitation(tx,q.input.invitationId);if(!i)refuse();
    const pair=pairFor(i),actor=await currentActor(tx,session,selected);
    if(actor.status!=='active'||!await subjectAuthority(tx,actor,pair)||!await validPair(tx,pair))refuse();
    const c=await beginCommand(tx,actor,selected,resend?'associations.resendInvitation':'associations.revokeInvitation',q);
    if(c.kind==='replay')return resend?Q.invitationResult.parse(c.result):Q.mutationResult.parse(c.result);
    checkRevision(q.expectedRevision,i.revision);
    const now=await time(tx);if(i.state!=='pending'||now.getTime()>=i.created_at.getTime()+30*86400000)refuse();
    const next=String(BigInt(i.revision)+1n);
    if(!resend) {
      await tx.query("UPDATE invitation SET state='revoked',acted_at=clock_timestamp(),revision=revision+1 WHERE id=$1",[i.id]);
      const event=await appendEvent(tx,c,i.id,'revoke','invitation.revoked',i.revision,next);
      return finishCommand(tx,c,r=>Q.mutationResult.parse({status:'committed',receipt:r}),[event]);
    }
    if(now.getTime()-(i.resent_at??i.created_at).getTime()<60000)refuse('resend_cooldown');
    const proof=randomBytes(32).toString('base64url'),expiresAt=new Date(i.created_at.getTime()+30*86400000).toISOString();
    await tx.query('UPDATE invitation SET token_hash=$2,resent_at=clock_timestamp(),revision=revision+1 WHERE id=$1',[i.id,hash(proof)]);
    const event=await appendEvent(tx,c,i.id,'resend',null,i.revision,next);
    await effects.invitation(tx,{invitationId:i.id,owner:subjectOwner(pair),recipientEmail:i.recipient_email,proof,inviterDescription:i.inviter_description,expiresAt,operationId:c.id});
    return finishCommand(tx,c,r=>Q.invitationResult.parse({status:'pending',invitationId:i.id,pair,revision:next,expiresAt,inviterDescription:i.inviter_description,receipt:r}),[event]);
  }
  async function end(tx:PoolClient,session:z.infer<typeof sessionId>,selected:Owner,raw:unknown) {
    const q=Q.endRelationshipRequest.parse(raw);await lock(tx,'pair/'+JSON.stringify(endpointValues(q.input.pair)));
    const a=await loadAffiliation(tx,q.input.relationshipId,true),actor=await currentActor(tx,session,selected);
    if(!a||actor.status!=='active'||JSON.stringify(pairOf(a))!==JSON.stringify(q.input.pair)||!await validPair(tx,q.input.pair)||
      !(await subjectAuthority(tx,actor,q.input.pair)||sameOwner(selected,q.input.pair.organization)&&administrator(actor)))refuse();
    const c=await beginCommand(tx,actor,selected,'associations.end',q);if(c.kind==='replay')return Q.mutationResult.parse(c.result);
    if(a.ended_at!==null)return finishCommand(tx,c,r=>Q.mutationResult.parse({status:'committed',receipt:r}),[],false);
    checkRevision(q.expectedRevision,a.revision);
    await tx.query('UPDATE affiliation SET ended_at=clock_timestamp(),revision=revision+1 WHERE id=$1',[a.id]);
    const next=String(BigInt(a.revision)+1n),event=await appendEvent(tx,c,a.id,'remove','affiliation.ended',a.revision,next);
    await tx.query('INSERT INTO relationship_history(id,relationship_id,pair,reason,source_invitation_id) VALUES($1,$2,$3,$4,$5)',[event,a.id,JSON.stringify(q.input.pair),q.input.reason,a.invitation_id]);
    await invalidate(tx,effects,q.input.pair,a.id,next);
    await effects.notice(tx,{eventId:event,relationshipId:a.id,pair:q.input.pair,kind:'relationship_ended',revision:next,operationId:c.id});
    return finishCommand(tx,c,r=>Q.mutationResult.parse({status:'committed',receipt:r}),[event]);
  }
  return {'associations.invite':invite,'associations.acceptInvitation':async(tx,s,o,q)=>Q.acceptedInvitationResult.parse(await decide(tx,s,o,q,'associations.acceptInvitation')),
    'associations.respondInvitation':(tx,s,o,q)=>decide(tx,s,o,q,'associations.respondInvitation'),
    'associations.declineInvitation':async(tx,s,o,q)=>Q.declinedInvitationResult.parse(await decide(tx,s,o,q,'associations.declineInvitation')),
    'associations.resendInvitation':async(tx,s,o,q)=>Q.invitationResult.parse(await manage(tx,s,o,q,true)),
    'associations.revokeInvitation':async(tx,s,o,q)=>Q.mutationResult.parse(await manage(tx,s,o,q,false)),'associations.end':end};
}
