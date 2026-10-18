import type { PoolClient } from 'pg';
import type { OrganizationAdapter } from '@everyfield/contracts/organizations';
import * as Q from '@everyfield/contracts/organizations';
import { choices, active, administrator, appendEvent, beginCommand, checkRevision, currentActor, finishCommand, invalidate, loadAffiliation, pairOf, refuse, sameOwner, unavailable, type OrganizationEffects } from './core.ts';
const columns={people:'share_people',meetings:'share_meetings',tasks:'share_tasks',ministry_teams:'share_ministry',wiki:'share_wiki',activity:'share_activity',shared_findings:'shared_findings'} as const;
export function sharingOperations(effects:OrganizationEffects):Pick<OrganizationAdapter<PoolClient>,'privacy.getSharing'|'privacy.setSharing'> {
  return {
    async 'privacy.getSharing'(tx,session,selected,raw) {
      const q=Q.readSharingRequest.parse(raw),actor=await currentActor(tx,session,selected);
      if(actor.status!=='active'||(!sameOwner(selected,q.plant)&&!sameOwner(selected,q.organization)))return unavailable();
      const r=await tx.query<{id:string;name:string}>('SELECT a.id,o.name FROM affiliation a JOIN organization o ON o.id=a.organization_id WHERE a.plant_id=$1 AND a.organization_id=$2',[q.plant.id,q.organization.id]);
      if(!r.rows[0])return unavailable();
      const a=await loadAffiliation(tx,r.rows[0].id);if(!a||!await active(tx,a)||!sameOwner(pairOf(a).organization,q.organization))return unavailable();
      const base={plant:q.plant,organization:q.organization,organizationDisplayName:r.rows[0].name,activeAffiliation:true};
      return Q.sharingResult.parse(sameOwner(selected,q.organization)?{view:'organization',...base,availability:choices(a)}:
        administrator(actor)?{view:'plant_administration',...base,consentRevision:a.consent_revision,choices:choices(a)}:{view:'plant_member',...base});
    },
    async 'privacy.setSharing'(tx,session,selected,raw) {
      const q=Q.setSharingRequest.parse(raw),a=await loadAffiliation(tx,q.input.relationshipId,true),actor=await currentActor(tx,session,selected);
      if(!a||actor.status!=='active'||!administrator(actor)||!sameOwner(selected,q.input.plant)||a.plant_id!==q.input.plant.id||!sameOwner(pairOf(a).organization,q.input.organization)||!await active(tx,a))refuse();
      const c=await beginCommand(tx,actor,selected,'privacy.setSharing',q);if(c.kind==='replay')return Q.mutationResult.parse(c.result);
      checkRevision(q.expectedRevision,a.revision);checkRevision(q.input.expectedConsentRevision,a.consent_revision);
      if(choices(a)[q.input.category]===q.input.enabled)return finishCommand(tx,c,r=>Q.mutationResult.parse({status:'committed',receipt:r}),[],false);
      await tx.query(`UPDATE affiliation SET ${columns[q.input.category]}=$2,consent_revision=consent_revision+1,revision=revision+1 WHERE id=$1`,[a.id,q.input.enabled]);
      const next=String(BigInt(a.revision)+1n),event=await appendEvent(tx,c,a.id,'preference','sharing.changed',a.revision,next);
      await invalidate(tx,effects,pairOf(a),a.id,next);
      // Coarse event only. Never copy the changed category or private body to notices.
      await effects.notice(tx,{eventId:event,relationshipId:a.id,pair:pairOf(a),kind:'sharing_changed',revision:next,operationId:c.id});
      return finishCommand(tx,c,r=>Q.mutationResult.parse({status:'committed',receipt:r}),[event]);
    }
  };
}
