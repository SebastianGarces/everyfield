import { before,after,test } from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import * as S from './support.mts';
import * as Q from '../../../packages/contracts/src/organizations/index.ts';
import { canReadSharedSources,canDispatchActivity,canReadResidentProgress,readSharingDisclosure,createOrganizationAdapter } from '../../../packages/domain/src/organizations/index.ts';
before(S.setup);after(S.teardown);
const view=(v:unknown)=>Q.sharingResult.parse(v);
test('AC:AF-030 AC:AF-032 AC:AF-033 AC:TARGET-IDN-022 AC:WP007-API-KNOW-112 source gates recheck exact consent, saved witnesses and activity independently',async()=>{
 const p=await S.tenant('plant'),pa=await S.identity(p),o=await S.tenant('sending_church'),oa=await S.identity(o),n=await S.tenant('sending_network'),na=await S.identity(n),a=await S.affiliation(p,o,true),b=await S.affiliation(p,n,true),m=await S.identity(p,'member');
 const initial=view(await S.call('privacy.getSharing',pa,{plant:p,organization:o}));assert.equal(initial.view,'plant_administration');
 const member=view(await S.call('privacy.getSharing',m,{plant:p,organization:o}));assert.equal(member.view,'plant_member');assert.equal('choices' in member,false);assert.equal('consentRevision' in member,false);
 const org=view(await S.call('privacy.getSharing',oa,{plant:p,organization:o}));assert.equal(org.view,'organization');assert.equal('consentRevision' in org,false);
 const witness={relationshipId:a,relationshipRevision:'1',consentRevision:'1',categories:['people'],publishedResult:true};
 assert.equal(await S.tx(c=>canReadSharedSources(c,oa.session,o,witness)),true);
 assert.equal(await S.tx(c=>canReadSharedSources(c,na.session,n,witness)),false);
 const q=S.command({plant:p,organization:o,relationshipId:a,expectedConsentRevision:'1',category:'shared_findings',enabled:false});
 await assert.rejects(S.call('privacy.setSharing',oa,q),/unavailable/);await assert.rejects(S.call('privacy.setSharing',m,q),/unavailable/);
 const r=await S.call('privacy.setSharing',pa,q);assert.deepEqual(await S.call('privacy.setSharing',pa,q),r);
 assert.equal(await S.tx(c=>canReadSharedSources(c,oa.session,o,witness)),false);
 assert.equal(await S.tx(c=>canReadSharedSources(c,oa.session,o,{...witness,relationshipRevision:'2',consentRevision:'2'})),false);
 assert.equal(await S.tx(c=>canReadSharedSources(c,oa.session,o,{...witness,relationshipRevision:'2',consentRevision:'2',publishedResult:false})),true);
 assert.equal(await S.tx(c=>canDispatchActivity(c,oa.session,o,{relationshipId:a,relationshipRevision:'2',consentRevision:'2'})),true);
 const off=S.command({plant:p,organization:o,relationshipId:a,expectedConsentRevision:'2',category:'activity',enabled:false},'2');await S.call('privacy.setSharing',pa,off);
 assert.equal(await S.tx(c=>canDispatchActivity(c,oa.session,o,{relationshipId:a,relationshipRevision:'3',consentRevision:'3'})),false);
 assert.equal(await S.tx(c=>canDispatchActivity(c,na.session,n,{relationshipId:b,relationshipRevision:'1',consentRevision:'1'})),true);
 await assert.rejects(S.call('privacy.setSharing',pa,S.command({...off.input,enabled:true},'2')),/stale_revision/);
 const data=(await S.db.query("SELECT e.action,e.diff,e.reason FROM event e JOIN affiliation a ON a.id=e.target_record_id WHERE a.id=$1",[a])).rows;assert.deepEqual(data.map(r=>({action:r.action,diff:r.diff,reason:r.reason})),[{action:'sharing.changed',diff:null,reason:null},{action:'sharing.changed',diff:null,reason:null}]);
});
test('INV-consent: first approval defaults on while rejoin preserves independent saved choices',async()=>{
 const p=await S.tenant('plant'),pa=await S.identity(p),o=await S.tenant('sending_church'),oa=await S.identity(o),pair={kind:'plant',subject:p,organization:o};
 const disclosed=await S.tx(c=>readSharingDisclosure(c,pa.session,p,pair));assert.equal(disclosed.kind,'first_invitation');assert.deepEqual(disclosed.choices,{people:true,meetings:true,tasks:true,ministry_teams:true,wiki:true,activity:true,shared_findings:true});
 const i=Q.invitationResult.parse(await S.call('associations.invite',pa,S.command({pair,recipientEmail:oa.email})));
 const accepted=Q.acceptedInvitationResult.parse(await S.call('associations.acceptInvitation',oa,S.command({invitationId:i.invitationId,proof:S.proofs.get(i.invitationId),decision:'accept'})));if(accepted.status!=='accepted')throw Error();
 await S.call('privacy.setSharing',pa,S.command({plant:p,organization:o,relationshipId:accepted.relationship.id,category:'wiki',enabled:false,expectedConsentRevision:'1'}));
 await S.call('associations.end',pa,S.command({relationshipId:accepted.relationship.id,pair,confirmed:true,reason:null},'2'));
 const retained=await S.tx(c=>readSharingDisclosure(c,pa.session,p,pair));assert.equal(retained.kind,'existing_consent');assert.equal(retained.choices.wiki,false);
 const j=Q.invitationResult.parse(await S.call('associations.invite',pa,S.command({pair,recipientEmail:oa.email})));
 await S.call('associations.acceptInvitation',oa,S.command({invitationId:j.invitationId,proof:S.proofs.get(j.invitationId),decision:'accept'}));
 const v=view(await S.call('privacy.getSharing',pa,{plant:p,organization:o}));if(v.view!=='plant_administration')throw Error();assert.equal(v.choices.wiki,false);assert.equal(v.choices.people,true);assert.equal(v.consentRevision,'2');
});
test('AC:ADR1-016 AC:WP007-API-MUL-016 pipeline consent defaults off and requires two distinct currently eligible churches',async()=>{
 const n=await S.tenant('sending_network'),na=await S.identity(n),churches=[await S.tenant('sending_church'),await S.tenant('sending_church')],actors=await Promise.all(churches.map(c=>S.identity(c))),ids=[];
 for(const c of churches)ids.push(await S.affiliation(c,n,false));
 const initial=Q.pipelineConsentResult.parse(await S.call('pipelineSharing.readConsent',actors[0],{relationshipId:ids[0]}));assert.equal(initial.status,'available');if(initial.status==='available')assert.equal(initial.sharePipelineTotals,false);
 const check=()=>S.call('pipelineSharing.checkAggregateAccess',na,{network:n});assert.deepEqual(await check(),{allowed:false,minimumContributors:2});
 await S.call('pipelineSharing.setConsent',actors[0],S.command({relationshipId:ids[0],sharePipelineTotals:true}));assert.deepEqual(await check(),{allowed:false,minimumContributors:2});
 await S.call('pipelineSharing.setConsent',actors[1],S.command({relationshipId:ids[1],sharePipelineTotals:true}));assert.deepEqual(await check(),{allowed:true,minimumContributors:2});
 const other=await S.tenant('sending_network'),otherLink=await S.affiliation(churches[0],other,false);await S.call('pipelineSharing.setConsent',actors[0],S.command({relationshipId:otherLink,sharePipelineTotals:true}));
 await S.call('pipelineSharing.setConsent',actors[0],S.command({relationshipId:ids[0],sharePipelineTotals:false},'2'));assert.deepEqual(await check(),{allowed:false,minimumContributors:2});
 const retained=Q.pipelineConsentResult.parse(await S.call('pipelineSharing.readConsent',actors[0],{relationshipId:otherLink}));if(retained.status!=='available')throw Error();assert.equal(retained.sharePipelineTotals,true);
 await assert.rejects(S.call('pipelineSharing.setConsent',na,S.command({relationshipId:ids[0],sharePipelineTotals:true},'3')),/unavailable/);
});
async function resident(){
 const o=await S.tenant('sending_church'),staff=await S.identity(o),r=await S.identity(),a=await S.affiliation(r.selected,o,false),person=randomUUID(),invitation=randomUUID(),link=randomUUID();
 await S.db.query("INSERT INTO person(id,tenant_id,organization_id,display_name,source,state,linked_account_id,created_at,revision) VALUES($1,$2,$2,'Resident','other','live',$3,clock_timestamp(),1)",[person,o.id,r.account]);
 await S.db.query("INSERT INTO invitation(id,tenant_id,purpose,recipient_email,token_hash,state,created_at,accepted_account_id,resident_person_id) VALUES($1,$2,'residency_link',$3,$4,'accepted',clock_timestamp(),$5,$6)",[invitation,o.id,r.email,randomUUID(),r.account,person]);
 await S.db.query('INSERT INTO residency_link(id,organization_id,person_id,account_id,affiliation_id,invitation_id,accepted_at,consent_revision,revision,share_foundations,share_milestones) VALUES($1,$2,$3,$4,$5,$6,clock_timestamp(),1,1,true,true)',[link,o.id,person,r.account,a,invitation]);
 return {o,staff,r,link,person};
}
test('AC:ADR1-003 AC:WP007-API-MUL-003 resident category withdrawal and leave immediately fence original progress witnesses',async()=>{
 const {o,staff,r,link,person}=await resident(),read=(category:string,consentRevision:string)=>S.tx(c=>canReadResidentProgress(c,staff.session,o,{linkId:link,category,consentRevision}));
 assert.equal(await read('foundations','1'),true);assert.equal(await read('milestones','1'),true);
 const initial=Q.residencySharingResult.parse(await S.call('residency.readSharing',r,{linkId:link}));assert.equal(initial.status,'active');
 await S.call('residency.setSharing',r,S.command({linkId:link,expectedConsentRevision:'1',choices:{shareFoundations:false,shareMilestones:true}}));
 assert.equal(await read('foundations','1'),false);assert.equal(await read('milestones','1'),false);assert.equal(await read('foundations','2'),false);assert.equal(await read('milestones','2'),true);
 await assert.rejects(S.call('residency.setSharing',r,S.command({linkId:link,expectedConsentRevision:'1',choices:{shareFoundations:true,shareMilestones:true}})),/stale_revision/);
 const q=S.command({linkId:link,expectedConsentRevision:'2'},'2'),left=await S.call('residency.leave',r,q);assert.deepEqual(await S.call('residency.leave',r,q),left);
 assert.equal(await read('milestones','3'),false);assert.deepEqual(await S.call('residency.readSharing',r,{linkId:link}),{status:'ended',linkId:link});
 await assert.rejects(S.call('residency.setSharing',r,S.command({linkId:link,expectedConsentRevision:'3',choices:{shareFoundations:true,shareMilestones:true}},'3')),/unavailable/);
 assert.equal((await S.db.query('SELECT display_name FROM person WHERE id=$1',[person])).rows[0].display_name,'Resident');assert.equal((await S.db.query('SELECT count(*)::int AS n FROM seat WHERE account_id=$1',[r.account])).rows[0].n,0);
});
test('INV-atomicity: required outbox failure rolls back sharing, revision, audit, receipt and invalidation',async()=>{
 const p=await S.tenant('plant'),pa=await S.identity(p),o=await S.tenant('sending_church'),id=await S.affiliation(p,o,true),key=randomUUID();
 const bad=createOrganizationAdapter({...S.effects,notice:async()=>{throw Error('synthetic_outbox_failure');}},{candidates:async()=>[]});
 await assert.rejects(S.tx(c=>bad['privacy.setSharing'](c,pa.session,p,Q.setSharingRequest.parse(S.command({plant:p,organization:o,relationshipId:id,expectedConsentRevision:'1',category:'people',enabled:false},'1',key)))),/synthetic_outbox_failure/);
 const v=view(await S.call('privacy.getSharing',pa,{plant:p,organization:o}));if(v.view!=='plant_administration')throw Error();assert.equal(v.choices.people,true);assert.equal(v.consentRevision,'1');
 assert.equal((await S.db.query('SELECT count(*)::int AS n FROM operation WHERE request_key=$1',[key])).rows[0].n,0);assert.equal((await S.db.query('SELECT count(*)::int AS n FROM event WHERE target_record_id=$1',[id])).rows[0].n,0);assert.equal((await S.db.query('SELECT material_revision FROM organization WHERE id=$1',[o.id])).rows[0].material_revision,'1');
});
