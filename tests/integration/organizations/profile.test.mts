import {before,after,test} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import * as S from './support.mts';
import * as Q from '../../../packages/contracts/src/organizations/index.ts';
before(S.setup);after(S.teardown);
test('AC:ORG55-001 AC:TARGET-IDN-026 exact organization Owner/Admin profile changes are bounded and audited without narrative values',async()=>{
 for(const kind of ['sending_church','sending_network'] as const){
 const o=await S.tenant(kind),a=await S.identity(o,'admin'),member=await S.identity(o,'member'),foreign=await S.identity(await S.tenant('sending_church')),plant=await S.identity(await S.tenant('plant'));
 const q=S.command({organization:o,patch:{name:'  Changed name  ',city:null,contactEmail:'OFFICE@EXAMPLE.TEST',description:'Private profile narrative'}});
 for(const actor of [member,foreign,plant])await assert.rejects(S.call('organizations.updateProfile',actor,q),/unavailable/);
 const changed=await S.call('organizations.updateProfile',a,q);assert.deepEqual(await S.call('organizations.updateProfile',a,q),changed);
 const profile=Q.organizationProfileResult.parse(await S.call('organizations.getProfile',member,{organization:o}));assert.equal(profile.status,'available');if(profile.status!=='available')throw Error();assert.equal(profile.profile.name,'Changed name');assert.equal(profile.profile.contactEmail,'office@example.test');assert.equal(profile.profile.city,null);assert.equal(profile.revision,'2');
 assert.deepEqual(await S.call('organizations.getProfile',plant,{organization:o}),{status:'unavailable'});
 await assert.rejects(S.call('organizations.updateProfile',a,S.command({organization:o,patch:{name:'stale'}},'1')),/stale_revision/);
 await assert.rejects(S.call('organizations.updateProfile',a,S.command({organization:o,patch:{organizationKind:'sending_church'}})));
 const events=await S.db.query('SELECT action,diff,reason FROM event WHERE target_record_id=$1',[o.id]);assert.deepEqual(events.rows,[{action:'organization.profile_changed',diff:null,reason:null}]);
 }
});
test('INV-location: correction is plant settings with immutable effective history, no street or phase editing',async()=>{
 const p=await S.tenant('plant'),pa=await S.identity(p),org=await S.identity(await S.tenant('sending_church')),release=randomUUID(),item=randomUUID(),version=randomUUID();
 await S.db.query("INSERT INTO reference_release(id,release_key,artifact_locator,chunker_version,embedding_profile,embedding_dimensions,tenant_id,manifest_hash,state,expected_passages,complete_at,validated_at,approval_hash,approval_locator) VALUES($1,$1::text,'synthetic-fixture','fixture','fixture',3,'00000000-0000-0000-0000-000000000000',$2,'validated',0,clock_timestamp(),clock_timestamp(),$2,'synthetic-approved-fixture')",[release,'a'.repeat(64)]);
 await S.db.query("INSERT INTO reference_item(id,kind,canonical_key,tenant_id) VALUES($1,'geography_dataset',$2,'00000000-0000-0000-0000-000000000000')",[item,'synthetic/'+item]);
 await S.db.query("INSERT INTO reference_version(id,item_id,release_id,version_number,artifact_path,content_hash,source_credit) VALUES($1,$2,$3,1,'synthetic-official-fixture',$4,'Synthetic reference fixture')",[version,item,release,'a'.repeat(64)]);
 const q=S.command({plant:p,locality:{city:'City',stateProvince:'State',country:'US'},referenceVersionId:version,regionItemId:null});
 await assert.rejects(S.call('organizations.correctReportingLocation',org,q),/unavailable/);
 await S.call('organizations.correctReportingLocation',pa,q);
 await S.call('organizations.correctReportingLocation',pa,S.command({...q.input,locality:{city:null,stateProvince:null,country:null}},'2'));
 const history=await S.db.query('SELECT id,city,state_province,country,region_item_id,supersedes_id,committed_at,effective_at FROM plant_geography WHERE plant_id=$1 ORDER BY effective_at',[p.id]);
 assert.equal(history.rows.length,2);assert.equal(history.rows[0].city,'City');assert.equal(history.rows[1].city,null);assert.equal(history.rows[1].supersedes_id,history.rows[0].id);assert.equal(history.rows[0].region_item_id,null);
 const root=await S.db.query('SELECT phase,street,revision FROM plant WHERE id=$1',[p.id]);assert.deepEqual(root.rows,[{phase:1,street:'private street',revision:'3'}]);
 await assert.rejects(S.call('organizations.correctReportingLocation',pa,S.command({...q.input,regionItemId:randomUUID()},'3')),/region_unavailable/);
});
test('INV-authority: revoked session and lifecycle suspension block fresh reads and receipt replay',async()=>{
 const o=await S.tenant('sending_church'),a=await S.identity(o),q=S.command({organization:o,patch:{name:'Changed'}});await S.call('organizations.updateProfile',a,q);
 await S.db.query('DELETE FROM auth_session WHERE id=$1',[a.session]);assert.deepEqual(await S.call('organizations.getProfile',a,{organization:o}),{status:'unavailable'});await assert.rejects(S.call('organizations.updateProfile',a,q),/unavailable/);
 const p=await S.tenant('plant'),pa=await S.identity(p),n=await S.tenant('sending_network');await S.affiliation(p,n,true);
 await S.db.query("INSERT INTO lifecycle_witness(kind,opaque_subject_id,plant_id,request_revision,state,witness_checkpoint,cleanup_state,request_id,requested_at,cancel_until) VALUES('plant',$1,$1,1,'pending_deletion',1,'not_started',$2,clock_timestamp(),clock_timestamp()+interval '30 days')",[p.id,randomUUID()]);
 assert.deepEqual(await S.call('privacy.getSharing',pa,{plant:p,organization:n}),{status:'unavailable'});
});
