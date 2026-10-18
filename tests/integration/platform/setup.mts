// Explicit, protected synthetic setup. Never run at app startup.
import { randomBytes, randomUUID } from "node:crypto";
import { readFileSync, writeFileSync, chmodSync } from "node:fs";
import { devPool, owners, subjectId } from "./support.mjs";
import { createPlatformAuth } from "../../../apps/web/src/server/platform/auth.ts";
import { getMigrations } from "../../../apps/web/node_modules/better-auth/dist/db/get-migration.mjs";

if (process.env.NODE_ENV === "production" || process.env.PLATFORM_SETUP !== "synthetic-wp003") throw new Error("Explicit synthetic development setup required");
const admin = devPool(process.env.DATABASE_URL_UNPOOLED ?? process.env.DATABASE_URL);
const password = randomBytes(32).toString("hex");
try {
  await admin.query('CREATE SCHEMA IF NOT EXISTS wp003_proof');
  // Only this proof schema is reset. Shared marketing fixtures are untouched.
  await admin.query('DROP SCHEMA wp003_proof CASCADE');
  await admin.query('CREATE SCHEMA wp003_proof');
  const auth = createPlatformAuth(admin, "http://localhost", process.env.BETTER_AUTH_SECRET!, async () => {});
  const migrations = await getMigrations(auth.options);
  await migrations.runMigrations();
  await admin.query(`
    CREATE TABLE proof_grant(account_id text NOT NULL,owner_id uuid NOT NULL,role text NOT NULL CHECK(role IN ('owner','admin')),active boolean NOT NULL DEFAULT true,PRIMARY KEY(account_id,owner_id));
    CREATE TABLE proof_subject(id uuid PRIMARY KEY,owner_id uuid NOT NULL,value text NOT NULL DEFAULT 'original',revision bigint NOT NULL DEFAULT 1,active boolean NOT NULL DEFAULT true);
    CREATE TABLE proof_audit(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),subject uuid NOT NULL REFERENCES proof_subject(id),revision bigint NOT NULL);
    CREATE TABLE proof_receipt(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),subject uuid NOT NULL REFERENCES proof_subject(id),revision bigint NOT NULL);
    CREATE TABLE proof_intent(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),subject uuid NOT NULL REFERENCES proof_subject(id),revision bigint NOT NULL);
    CREATE TABLE proof_rate(key text NOT NULL,at timestamptz NOT NULL DEFAULT clock_timestamp());
    CREATE INDEX ON proof_rate(key,at);
    CREATE TABLE proof_object(id uuid PRIMARY KEY,owner_id uuid NOT NULL,object_key text NOT NULL UNIQUE,format text NOT NULL CHECK(format IN ('docx','xlsx','pdf')),checksum text NOT NULL,bytes int NOT NULL,state text NOT NULL DEFAULT 'pending' CHECK(state IN ('pending','ready','deleted')),preview text);
    CREATE TABLE proof_stream(id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,owner_id uuid NOT NULL,status text NOT NULL CHECK(status IN ('ready','succeeded','reconcile')));
    CREATE TABLE proof_job(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),kind text NOT NULL CHECK(kind='document_render'),subject uuid NOT NULL REFERENCES proof_subject(id),producer_key text NOT NULL,revision bigint NOT NULL,generation bigint NOT NULL DEFAULT 0,worker uuid,lease_until timestamptz,state text NOT NULL DEFAULT 'ready' CHECK(state IN ('ready','claimed','retry_wait','reconcile','succeeded','failed','cancelled','superseded')),attempts int NOT NULL DEFAULT 0,checkpoint text,UNIQUE(kind,subject,producer_key));
    CREATE TABLE proof_mail(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),provider_id text NOT NULL UNIQUE,rank int NOT NULL DEFAULT 0);
    CREATE TABLE proof_provider_event(id text PRIMARY KEY);
    CREATE TABLE proof_job_receipt(job_id uuid PRIMARY KEY REFERENCES proof_job(id));
  `);
  await admin.query('INSERT INTO proof_subject(id,owner_id) VALUES($1,$2)', [subjectId, owners.p]);
  const existing = await admin.query("SELECT 1 FROM pg_roles WHERE rolname='wp003_runtime'");
  if (existing.rowCount === 0) await admin.query(`CREATE ROLE wp003_runtime LOGIN PASSWORD '${password}' NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOBYPASSRLS`);
  else await admin.query(`ALTER ROLE wp003_runtime PASSWORD '${password}'`);
  await admin.query('GRANT USAGE ON SCHEMA wp003_proof TO wp003_runtime');
  await admin.query('GRANT SELECT,INSERT,UPDATE,DELETE ON ALL TABLES IN SCHEMA wp003_proof TO wp003_runtime');
  await admin.query('REVOKE UPDATE,DELETE ON proof_audit,proof_receipt,proof_intent,proof_job_receipt FROM wp003_runtime');
  await admin.query('GRANT USAGE,SELECT ON ALL SEQUENCES IN SCHEMA wp003_proof TO wp003_runtime');
  const runtimeURL = new URL(process.env.DATABASE_URL_UNPOOLED ?? process.env.DATABASE_URL!); runtimeURL.username='wp003_runtime';runtimeURL.password=password;
  const file = new URL('../../../apps/web/.env.local', import.meta.url);
  let env = readFileSync(file,'utf8').split('\n').filter(line=>!/^PLATFORM_(DATABASE_URL|EXECUTOR_SECRET|STORAGE_PREFIX)=/.test(line)).join('\n');
  env += `\nPLATFORM_DATABASE_URL=${JSON.stringify(runtimeURL.href)}\nPLATFORM_EXECUTOR_SECRET=${randomBytes(32).toString('hex')}\nPLATFORM_STORAGE_PREFIX=wp003/${randomUUID()}/\n`;
  writeFileSync(file,env);chmodSync(file,0o600);
  const runtime = devPool(runtimeURL.href);
  try { const r = await runtime.query("SELECT current_user,has_table_privilege(current_user,'proof_audit','UPDATE') audit_update,has_table_privilege(current_user,'proof_audit','DELETE') audit_delete");console.log(JSON.stringify({setup:'synthetic-only',runtime:r.rows[0]})); } finally { await runtime.end(); }
} finally { await admin.end(); }
