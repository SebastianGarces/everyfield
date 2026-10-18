import { closeDatabase } from "../../../packages/db/src/client.ts";
import { sql as querySql } from "../../../packages/db/node_modules/drizzle-orm/index.js";
// Explicit, protected synthetic setup. Never run at app startup.
import { randomBytes, randomUUID } from "node:crypto";
import { readFileSync, writeFileSync, chmodSync } from "node:fs";
import { devPool, owners, subjectId } from "./support.mjs";
import {generateDrizzleJson,generateMigration} from "../../../packages/db/node_modules/drizzle-kit/api.mjs";
import * as proofSchema from "../../../apps/web/src/server/platform/tables.ts";

if (process.env.NODE_ENV === "production" || process.env.PLATFORM_SETUP !== "synthetic-wp003") throw new Error("Explicit synthetic development setup required");
const schema="db1_platform_"+randomUUID().replaceAll("-","");
const role="db1_platform_"+randomBytes(8).toString("hex");
const options=`-c search_path=${schema},pg_catalog,pg_temp`;
const admin = devPool(process.env.DATABASE_URL_UNPOOLED ?? process.env.DATABASE_URL,{options});
const password = randomBytes(32).toString("hex");
try {
  const snapshot=generateDrizzleJson(proofSchema);
  const scoped={...snapshot,schemas:{[schema]:schema},tables:Object.fromEntries(Object.values(snapshot.tables).map(table=>[`${schema}.${table.name}`,{
    ...table,schema,foreignKeys:Object.fromEntries(Object.entries(table.foreignKeys).map(([name,key])=>[name,{...key,schemaTo:schema}]))
  }]))};
  const ddl=await generateMigration(generateDrizzleJson({}),scoped);
  await admin.transaction(async tx=>{for(const statement of ddl)await tx.execute(querySql.raw(statement));});
  await admin.execute(querySql`INSERT INTO proof_subject(id,owner_id) VALUES(${querySql.param(subjectId)},${querySql.param(owners.p)})`);
  await admin.execute(querySql.raw(`CREATE ROLE "${role}" LOGIN PASSWORD '${password}' NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOBYPASSRLS`));
  await admin.execute(querySql`GRANT USAGE ON SCHEMA ${querySql.identifier(schema)} TO ${querySql.identifier(role)}`);
  await admin.execute(querySql`GRANT SELECT,INSERT,UPDATE,DELETE ON ALL TABLES IN SCHEMA ${querySql.identifier(schema)} TO ${querySql.identifier(role)}`);
  await admin.execute(querySql`REVOKE UPDATE,DELETE ON proof_audit,proof_receipt,proof_intent,proof_job_receipt FROM ${querySql.identifier(role)}`);
  await admin.execute(querySql`GRANT USAGE,SELECT ON ALL SEQUENCES IN SCHEMA ${querySql.identifier(schema)} TO ${querySql.identifier(role)}`);
  const runtimeURL = new URL(process.env.DATABASE_URL_UNPOOLED ?? process.env.DATABASE_URL!); runtimeURL.username=role;runtimeURL.password=password;
  runtimeURL.searchParams.set('options',options);
  const file = new URL('../../../apps/web/.env.local', import.meta.url);
  let env = readFileSync(file,'utf8').split('\n').filter(line=>!/^PLATFORM_(DATABASE_URL|EXECUTOR_SECRET|STORAGE_PREFIX)=/.test(line)).join('\n');
  env += `\nPLATFORM_DATABASE_URL=${JSON.stringify(runtimeURL.href)}\nPLATFORM_EXECUTOR_SECRET=${randomBytes(32).toString('hex')}\nPLATFORM_STORAGE_PREFIX=wp003/${randomUUID()}/\n`;
  writeFileSync(file,env);chmodSync(file,0o600);
  const runtime = devPool(runtimeURL.href);
  try { const r = await runtime.execute(querySql`SELECT current_user,has_table_privilege(current_user,'proof_audit','UPDATE') audit_update,has_table_privilege(current_user,'proof_audit','DELETE') audit_delete`);console.log(JSON.stringify({setup:'synthetic-only',runtime:r.rows[0]})); } finally { await closeDatabase(runtime); }
} finally { await closeDatabase(admin); }
