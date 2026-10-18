import { randomBytes, randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import { migrate } from '../../../packages/db/src/schema/migrate.ts';
import { createOrganizationAdapter } from '../../../packages/domain/src/organizations/index.ts';
import { createMailService } from '../../../apps/web/src/server/jobs/mail.ts';
import { enqueueJob } from '../../../apps/web/src/server/jobs/queue.ts';
import { owner, sessionId } from '../../../packages/contracts/src/common/index.ts';
const require=createRequire(new URL('../../../packages/domain/package.json',import.meta.url));
const {Pool}=require('pg');
const source=new URL(process.env.DATABASE_URL_UNPOOLED??process.env.DATABASE_URL??'about:blank');
if(source.hostname!=='ep-autumn-dew-b8ltidky.c-14.us-east-1.aws.neon.tech'||process.env.NODE_ENV==='production')throw Error('Only shared development direct endpoint allowed');
source.searchParams.set('sslmode','verify-full');
export const schema='wp007_'+randomUUID().replaceAll('-','');
export const db=new Pool({connectionString:source.href,max:8,options:`-c search_path=${schema},pg_catalog,pg_temp`});
const role='wp007_'+randomBytes(8).toString('hex'),password=randomBytes(32).toString('hex'),runtimeUrl=new URL(source);
runtimeUrl.username=role;runtimeUrl.password=password;
export const runtime=new Pool({connectionString:runtimeUrl.href,max:8,options:`-c search_path=${schema},pg_catalog,pg_temp`});
export async function setup(){await db.query(`CREATE SCHEMA ${schema}`);await migrate(db,schema);await db.query(`CREATE ROLE ${role} LOGIN INHERIT PASSWORD '${password}' NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS`);await db.query(`GRANT everyfield_runtime TO ${role}`);}
export async function teardown(){await runtime.end();await db.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);await db.query(`DROP ROLE IF EXISTS ${role}`);await db.end();}
export async function tx<T>(body:(c:import('pg').PoolClient)=>Promise<T>):Promise<T>{const c=await runtime.connect();try{await c.query('BEGIN');await c.query("SET LOCAL statement_timeout='10s'");const r=await body(c);await c.query('COMMIT');return r;}catch(e){await c.query('ROLLBACK');throw e;}finally{c.release();}}
export async function tenant(kind:'plant'|'sending_church'|'sending_network',name='Synthetic'){
 const id=randomUUID();if(kind==='plant')await db.query("INSERT INTO plant(id,name,street,timezone,warning_days,alert_days,digest_weekday,digest_hour,phase,material_revision) VALUES($1,$2,'private street','America/Chicago',7,14,0,16,1,1)",[id,name]);
 else await db.query("INSERT INTO organization(id,kind,name,timezone,material_revision) VALUES($1,$2,$3,'UTC',1)",[id,kind,name]);
 return owner.parse(kind==='plant'?{kind:'plant',id}:{kind:'organization',id,organizationKind:kind});
}
export async function identity(selected?:ReturnType<typeof owner.parse>,role='owner'){
 const user=randomUUID(),account=randomUUID(),handle=randomUUID(),email=randomUUID()+'@example.test';
 await db.query("INSERT INTO auth_user(id,email,email_verified,name) VALUES($1,$2,true,'Synthetic')",[user,email]);
 await db.query("INSERT INTO account(id,auth_user_id,registration_state,registration_kind) VALUES($1,$2,'active',$3)",[account,user,selected?.kind==='plant'?'planter':selected?.kind==='organization'?(selected.organizationKind==='sending_church'?'sending_church':'network'):'discovery']);
 await db.query("INSERT INTO auth_session(id,user_id,token,expires_at) VALUES($1,$2,$3,clock_timestamp()+interval '1 day')",[handle,user,randomUUID()]);
 if(selected)await db.query('INSERT INTO seat(account_id,plant_id,organization_id,role,accepted_at) VALUES($1,$2,$3,$4,clock_timestamp())',[account,selected.kind==='plant'?selected.id:null,selected.kind==='organization'?selected.id:null,role]);
 return {account,session:sessionId.parse(handle),email,selected:selected??owner.parse({kind:'account',id:account})};
}
export const proofs=new Map<string,string>();
export const mail=createMailService({db:runtime,encryptionKey:randomBytes(32),addressKey:randomBytes(32),from:'test@example.test',authorize:async()=>true,
 transport:{send:async()=>{throw Error('No provider call allowed');},lookup:async()=>{throw Error('No provider call allowed');}}});
export const effects={
 async invitation(c:import('pg').PoolClient,v:Parameters<import('../../../packages/domain/src/organizations/index.ts').OrganizationEffects['invitation']>[1]){
   proofs.set(v.invitationId,v.proof);
   await mail.enqueue(c,{owner:v.owner.kind==='global'?(()=>{throw Error('global');})():v.owner,purpose:'relationship_invitation',logicalKey:'relationship/'+v.invitationId+'/'+v.operationId,recipient:null,address:v.recipientEmail,
     content:{subject:v.inviterDescription,text:'https://example.test/accept-relationship?token='+v.proof},operation:v.operationId,notice:null,eligibleAt:new Date().toISOString()});
 },
 async notice(c:import('pg').PoolClient,v:Parameters<import('../../../packages/domain/src/organizations/index.ts').OrganizationEffects['notice']>[1]){
   const target=v.pair.kind==='plant'?v.pair.subject.id:v.pair.organization.id;
   await enqueueJob(c,{tenant:target,kind:'notification',subject:v.relationshipId,key:v.kind+'/'+v.eventId,revision:v.revision,eligibleAt:new Date().toISOString()});
 },
 async invalidate(c:import('pg').PoolClient,v:Parameters<import('../../../packages/domain/src/organizations/index.ts').OrganizationEffects['invalidate']>[1]){
   await c.query("UPDATE job SET state='superseded',claim_generation=claim_generation+1,lease_owner=NULL,lease_until=NULL,revision=revision+1,finished_at=clock_timestamp() WHERE subject_record_id=$1 AND kind IN ('assessment','digest') AND state IN ('ready','retry_wait','claimed')",[v.sourceId]);
 }
};
export const api=createOrganizationAdapter(effects,{candidates:async()=>[]});
export const command=(input:unknown,expectedRevision='1',requestKey=randomUUID())=>({requestKey,expectedRevision,input});
export async function call(name:keyof typeof api,actor:Awaited<ReturnType<typeof identity>>,input:unknown){return tx(c=>api[name](c,actor.session,actor.selected,input as never));}
export async function affiliation(plant:ReturnType<typeof owner.parse>,org:ReturnType<typeof owner.parse>,share=false){
 const r=await db.query(`INSERT INTO affiliation(plant_id,account_id,sending_church_id,organization_id,accepted_at,share_people,share_meetings,share_tasks,share_ministry_teams,share_wiki,share_activity,shared_findings)
 VALUES($1,$2,$3,$4,clock_timestamp(),$5,$5,$5,$5,$5,$5,$5) RETURNING id`,[plant.kind==='plant'?plant.id:null,plant.kind==='account'?plant.id:null,plant.kind==='organization'?plant.id:null,org.id,share]);return r.rows[0].id;
}
