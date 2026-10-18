import { createRequire } from 'node:module';
import { parseArgs } from 'node:util';
import { loadControl,readPrivateJson,developmentConnection } from './control.mts';
import { migrate as applyVersionedMigration,adoptMigrationHistory,inspectMigrationProvenance } from '../../packages/db/src/schema/migrate.ts';
import { validateCandidate } from './recovery.mts';
const require=createRequire(new URL('../../packages/domain/package.json',import.meta.url));
const {Pool}=require('pg');
const commands=['migration-inspect','migration-apply','migration-adopt','backup-check'];
async function main() {
  const {values,positionals}=parseArgs({allowPositionals:true,options:{control:{type:'string'},review:{type:'string'},manifest:{type:'string'},help:{type:'boolean'}}});
  if(values.help){console.log('Restricted development operations. Commands: migration-inspect, migration-apply, migration-adopt, backup-check. Requires --control <private host-bound authorization file>. Adoption additionally requires --review <private reviewed per-file SHA-256 map>. No production action or provider setup.');return;}
  const command=positionals[0];
  if(positionals.length!==1||!commands.includes(command)||!values.control)throw Error('invalid_command');
  const c=await loadControl(values.control,command);
  if(command==='backup-check'){
    if(!values.manifest)throw Error('manifest_required');
    const result=validateCandidate(await readPrivateJson(values.manifest),new Date());
    console.log(JSON.stringify({candidate_manifest_valid:true,bytes_verified:false,live_recovery_proven:result.liveRecoveryProven,key_custody_proven:false,restore_executed:false}));return;
  }
  const connectionString=developmentConnection(c,process.env.DATABASE_URL_UNPOOLED??'');
  const db=new Pool({connectionString,max:1});
  try{
    const actual=await db.query('SELECT current_user AS role,current_database() AS name');
    if(actual.rows[0].role!==c.database.role||actual.rows[0].name!==c.database.name)throw Error('target_mismatch');
    if(command==='migration-inspect'){
      console.log(JSON.stringify(await inspectMigrationProvenance(db,c.database.schema)));
    }else if(command==='migration-apply'){
      console.log(JSON.stringify({applied:await applyVersionedMigration(db,c.database.schema)}));
    }else{
      if(!values.review)throw Error('adoption_review_required');
      const adopted=await adoptMigrationHistory(db,c.database.schema,await readPrivateJson(values.review));
      console.log(JSON.stringify({adopted,original_application_proven:false}));
    }
  }finally{await db.end();}
}
main().catch(()=>{console.error('Operations command refused or failed. No credentials or raw errors were logged.');process.exitCode=1;});
