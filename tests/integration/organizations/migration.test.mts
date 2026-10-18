import {test} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {mkdtemp,copyFile,readdir,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {pathToFileURL} from 'node:url';
import {createRequire} from 'node:module';
import {migrate} from '../../../packages/db/src/schema/migrate.ts';
const {Pool}=createRequire(new URL('../../../packages/domain/package.json',import.meta.url))('pg');
test('INV-schema: fresh and upgraded affiliation schemas use canonical ministry_teams and preserve existing consent',async()=>{
 const source=new URL(process.env.DATABASE_URL_UNPOOLED??process.env.DATABASE_URL??'about:blank');
 if(source.hostname!=='ep-autumn-dew-b8ltidky.c-14.us-east-1.aws.neon.tech'||process.env.NODE_ENV==='production')throw Error('Only shared development direct endpoint allowed');
 source.searchParams.set('sslmode','verify-full');
 const schema='wp007upgrade_'+randomUUID().replaceAll('-',''),fresh='wp007fresh_'+randomUUID().replaceAll('-',''),db=new Pool({connectionString:source.href,max:2});
 const old=await mkdtemp(tmpdir()+'/wp007-migrations-'),migrations=new URL('../../../packages/db/migrations/',import.meta.url);
 try{
  for(const name of await readdir(migrations))if(/^\d{4}_.*\.sql$/.test(name)&&Number(name.slice(0,4))<5)await copyFile(new URL(name,migrations),old+'/'+name);
  await db.query(`CREATE SCHEMA ${schema}`);await db.query(`CREATE SCHEMA ${fresh}`);
  await migrate(db,schema,pathToFileURL(old+'/'));
  const p=randomUUID(),o=randomUUID();
  await db.query(`SET search_path=${schema},pg_catalog,pg_temp`);
  await db.query("INSERT INTO plant(id,name,timezone,warning_days,alert_days,digest_weekday,digest_hour,phase,material_revision) VALUES($1,'Synthetic','UTC',7,14,0,16,1,1)",[p]);
  await db.query("INSERT INTO organization(id,kind,name,timezone,material_revision) VALUES($1,'sending_church','Synthetic','UTC',1)",[o]);
  // This is deliberately the pre-0005 historical input, never a current caller.
  await db.query(`INSERT INTO affiliation(plant_id,organization_id,accepted_at,share_people,share_meetings,share_tasks,share_ministry,share_wiki,share_activity,shared_findings) VALUES($1,$2,clock_timestamp(),false,false,false,true,false,false,false)`,[p,o]);
  const ledger=await db.query(`SELECT name,sha256,applied_at FROM ${schema}.schema_migration ORDER BY name`);
  assert.deepEqual(await migrate(db,schema),['0005_organization_relationships.sql']);await migrate(db,fresh);
  const columns=async(s:string)=>(await db.query("SELECT column_name,data_type,is_nullable,column_default,is_generated FROM information_schema.columns WHERE table_schema=$1 AND table_name='affiliation' ORDER BY ordinal_position",[s])).rows;
  assert.deepEqual(await columns(schema),await columns(fresh));assert.equal((await columns(schema)).some(r=>r.column_name==='share_ministry'),false);
  assert.deepEqual((await db.query(`SELECT share_ministry_teams,consent_revision FROM ${schema}.affiliation WHERE plant_id=$1`,[p])).rows,[{share_ministry_teams:true,consent_revision:'1'}]);
  await db.query(`UPDATE ${schema}.affiliation SET share_ministry_teams=false WHERE plant_id=$1`,[p]);assert.equal((await db.query(`SELECT share_ministry_teams FROM ${schema}.affiliation WHERE plant_id=$1`,[p])).rows[0].share_ministry_teams,false);
  assert.deepEqual((await db.query(`SELECT name,sha256,applied_at FROM ${schema}.schema_migration WHERE name<>'0005_organization_relationships.sql' ORDER BY name`)).rows,ledger.rows);
  assert.deepEqual(await migrate(db,schema),[]);
 }finally{await db.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);await db.query(`DROP SCHEMA IF EXISTS ${fresh} CASCADE`);await db.end();await rm(old,{recursive:true,force:true});}
});
