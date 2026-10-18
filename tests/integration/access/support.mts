import { randomUUID, randomBytes } from 'node:crypto';
import { createRequire } from 'node:module';
import { migrate } from '../../../packages/db/src/schema/migrate.ts';
const require = createRequire(new URL('../../../packages/domain/package.json', import.meta.url));
const { Pool } = require('pg');
export const id = randomUUID;
export async function database() {
  const source = new URL(process.env.DATABASE_URL_UNPOOLED ?? process.env.DATABASE_URL ?? 'about:blank');
  if (source.hostname !== 'ep-autumn-dew-b8ltidky.c-14.us-east-1.aws.neon.tech' || process.env.NODE_ENV === 'production') throw Error('Only approved shared development endpoint allowed');
  source.searchParams.set('sslmode', 'verify-full');
  const schema = 'wp006_' + id().replaceAll('-', '');
  const roles = ['runtime', 'cleanup'].map(kind => ({ name: 'wp006_' + randomBytes(8).toString('hex'), kind }));
  const options = `-c search_path=${schema},pg_catalog,pg_temp`;
  const admin = new Pool({ connectionString: source.href, options, max: 4 });
  const pools = {};
  try {
    await admin.query(`CREATE SCHEMA ${schema}`);
    await migrate(admin, schema);
    for (const { name, kind } of roles) {
      const password = randomBytes(32).toString('hex');
      await admin.query(`CREATE ROLE ${name} LOGIN INHERIT PASSWORD '${password}' NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS`);
      await admin.query(`GRANT everyfield_${kind} TO ${name}`);
      const url = new URL(source); url.username = name; url.password = password;
      pools[kind] = new Pool({ connectionString: url.href, options, max: 4 });
    }
    return { admin, ...pools, schema, async close() {
      await Promise.all(Object.values(pools).map(pool => pool.end()));
      await admin.query(`DROP SCHEMA ${schema} CASCADE`);
      for (const { name } of roles) await admin.query(`DROP ROLE ${name}`);
      await admin.end();
    } };
  } catch (error) {
    await Promise.all(Object.values(pools).map(pool => pool.end()));
    await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
    for (const { name } of roles) await admin.query(`DROP ROLE IF EXISTS ${name}`);
    await admin.end(); throw error;
  }
}
export async function transaction(pool, run) {
  const tx = await pool.connect();
  try { await tx.query('BEGIN'); const result = await run(tx); await tx.query('COMMIT'); return result; }
  catch (error) { await tx.query('ROLLBACK'); throw error; }
  finally { tx.release(); }
}
export async function account(db, registration = 'active') {
  const a = id(), user = id(), session = id();
  await db.query("INSERT INTO auth_user(id,name,email,email_verified) VALUES($1,'Synthetic',$2,true)", [user, user + '@example.test']);
  await db.query("INSERT INTO account(id,auth_user_id,registration_state,registration_kind) VALUES($1,$2,$3,'planter')", [a, user, registration]);
  await db.query("INSERT INTO auth_session(id,user_id,token,expires_at) VALUES($1,$2,$3,clock_timestamp()+interval '1 day')", [session, user, randomBytes(32).toString('hex')]);
  return { id: a, user, session };
}
export async function plant(db) {
  const p = id();
  await db.query("INSERT INTO plant(id,name,timezone,warning_days,alert_days,digest_weekday,digest_hour,phase,material_revision) VALUES($1,'Synthetic','UTC',7,14,1,8,1,1)", [p]);
  return { kind: 'plant', id: p };
}
export async function organization(db, kind = 'sending_church') {
  const o = id();
  await db.query("INSERT INTO organization(id,kind,name,timezone,material_revision) VALUES($1,$2,'Synthetic','UTC',1)", [o, kind]);
  return { kind: 'organization', id: o, organizationKind: kind };
}
export async function seat(db, actor, tenant, role = 'admin') {
  const s = id();
  await db.query(`INSERT INTO seat(id,account_id,${tenant.kind === 'plant' ? 'plant_id' : 'organization_id'},role,accepted_at) VALUES($1,$2,$3,$4,clock_timestamp())`, [s, actor.id, tenant.id, role]);
  return s;
}
export async function person(db, tenant, linked = null) {
  const p = id();
  await db.query(`INSERT INTO person(id,tenant_id,${tenant.kind === 'plant' ? 'plant_id' : 'organization_id'},display_name,source,created_at,state,linked_account_id,stage,commitment_state,adult_classification,pipeline_position) VALUES($1,$2,$2,'Synthetic','other',clock_timestamp(),'live',$3,$4,$5,$6,$7)`, [p, tenant.id, linked, ...(tenant.kind === 'plant' ? ['prospect','unknown','adult',1] : [null,null,null,null])]);
  return p;
}
