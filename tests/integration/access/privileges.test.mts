import { sql as querySql } from "../../../packages/db/node_modules/drizzle-orm/index.js";
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, mkdtemp, cp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { pathToFileURL } from 'node:url';
import { database, transaction, id, account, plant } from './support.mts';
import { migrate, migrationArtifact } from '../../../packages/db/src/schema/migrate.ts';
import { currentActor } from '../../../packages/domain/src/access/index.ts';

async function permissions(db, schema) {
  return (await db.execute(querySql`SELECT role,tab,priv,has_table_privilege(role,quote_ident(${schema})||'.'||quote_ident(tab),priv) AS allowed
    FROM unnest(ARRAY['everyfield_runtime','everyfield_cleanup']) role
    CROSS JOIN unnest(ARRAY['lifecycle_witness','document_revision','tenant','record']) tab
    CROSS JOIN unnest(ARRAY['SELECT','INSERT','UPDATE','DELETE']) priv ORDER BY role,tab,priv`)).rows;
}

test('INV-privileges: fresh and upgraded grants converge without rewriting applied bytes; restricted LOGIN refusals and exact lifecycle body cleanup', async () => {
  const db = await database();
  const other = db.schema + '_old', dir = await mkdtemp(tmpdir() + '/wp006-upgrade-');
  try {
    for (const name of ['0001_early_access.sql', '0002_baseline.sql']) await cp(new URL('../../../packages/db/migrations/' + name, import.meta.url), dir + '/' + name);
    await db.admin.execute(querySql.raw(`CREATE SCHEMA ${other}`));
    await migrate(db.admin, other, pathToFileURL(dir + '/'));
    const oldACL = await permissions(db.admin, other);
    assert.equal(oldACL.find(p => p.role === 'everyfield_runtime' && p.tab === 'lifecycle_witness' && p.priv === 'DELETE').allowed, true);
    assert.equal(oldACL.find(p => p.role === 'everyfield_cleanup' && p.tab === 'record' && p.priv === 'DELETE').allowed, true);
    const before = (await db.admin.execute(querySql.raw(`SELECT name,sha256,applied_at FROM ${other}.schema_migration ORDER BY name`))).rows;
    assert.deepEqual(await migrate(db.admin, other), ['0003_access_privileges.sql']);
    assert.deepEqual((await db.admin.execute(querySql.raw(`SELECT name,sha256,applied_at FROM ${other}.schema_migration WHERE name<>'0003_access_privileges.sql' ORDER BY name`))).rows, before);
    assert.deepEqual(await permissions(db.admin, other), await permissions(db.admin, db.schema));
    assert.deepEqual(await migrate(db.admin, other), []);
    const baseline = await readFile(new URL('../../../packages/db/migrations/0002_baseline.sql', import.meta.url));
    assert.equal((await migrationArtifact())[1].sha256, (await import('node:crypto')).createHash('sha256').update(baseline).digest('hex'));
    assert.deepEqual((await db.runtime.execute(querySql`SELECT rolsuper,rolbypassrls FROM pg_roles WHERE rolname=current_user`)).rows, [{ rolsuper: false, rolbypassrls: false }]);
    for (const [pool, sql] of [[db.runtime, 'DELETE FROM lifecycle_witness'], [db.runtime, 'DELETE FROM document_revision'], [db.runtime, 'SELECT * FROM auth_session'], [db.cleanup, 'DELETE FROM lifecycle_witness'], [db.cleanup, 'DELETE FROM document_revision'], [db.cleanup, 'UPDATE tenant SET kind=kind'], [db.cleanup, 'DELETE FROM tenant'], [db.cleanup, 'UPDATE record SET kind=kind'], [db.cleanup, 'DELETE FROM record']]) await assert.rejects(pool.execute(querySql.raw(sql)), e => e.cause?.code === '42501');
    const a = await account(db.admin), p = await plant(db.admin), q = await plant(db.admin), doc = id(), revision = id(), witness = id(), request = id();
    await db.admin.execute(querySql`INSERT INTO document(id,tenant_id,kind,title) VALUES(${doc},${p.id},'native','Synthetic')`);
    await db.admin.execute(querySql`INSERT INTO document_revision(id,tenant_id,document_id,version_number,body,content_hash,recorded_at) VALUES(${revision},${p.id},${doc},1,'IMMUTABLE-BODY',${'a'.repeat(64)},clock_timestamp())`);
    await db.admin.execute(querySql`UPDATE document SET current_revision_id=${revision} WHERE id=${doc}`);
    await db.admin.execute(querySql`INSERT INTO lifecycle_witness(id,kind,opaque_subject_id,plant_id,request_id,requester_id,request_revision,state,requested_at,cancel_until,witness_checkpoint,cleanup_state)
      VALUES(${witness},'plant',${p.id},${p.id},${request},${a.id},1,'pending_deletion',now()-interval '31 days',now()-interval '1 day',1,'not_started')`);
    const futureRequest = id(), futureDoc = id();
    await db.admin.execute(querySql`INSERT INTO document(id,tenant_id,kind,title) VALUES(${futureDoc},${q.id},'native','Future purge')`);
    await db.admin.execute(querySql`INSERT INTO lifecycle_witness(kind,opaque_subject_id,plant_id,request_id,request_revision,state,requested_at,cancel_until,witness_checkpoint,cleanup_state)
      VALUES('plant',${q.id},${q.id},${futureRequest},1,'purging',now(),now()+interval '30 days',1,'not_started')`);
    await assert.rejects(db.cleanup.execute(querySql`SELECT purge_document_revisions(${q.id},${futureRequest},${'1'},${futureDoc})`), e => e.cause?.code === '42501');
    const args = [p.id, request, '1', doc];
    await assert.rejects(db.runtime.execute(statement('SELECT purge_document_revisions($1,$2,$3,$4)', args)), e => e.cause?.code === '42501');
    await assert.rejects(db.cleanup.execute(statement('SELECT purge_document_revisions($1,$2,$3,$4)', args)), e => e.cause?.code === '42501');
    assert.deepEqual((await db.admin.execute(querySql`SELECT body FROM document_revision WHERE id=${revision}`)).rows, [{ body: 'IMMUTABLE-BODY' }]);
    await db.admin.execute(querySql`UPDATE lifecycle_witness SET state='purging' WHERE id=${witness}`);
    for (const invalid of [[q.id, request, '1', doc], [p.id, id(), '1', doc], [p.id, request, '2', doc]]) await assert.rejects(db.cleanup.execute(statement('SELECT purge_document_revisions($1,$2,$3,$4)', invalid)), e => e.cause?.code === '42501');
    assert.deepEqual((await db.cleanup.execute(statement('SELECT purge_document_revisions($1,$2,$3,$4) AS n', args))).rows, [{ n: '1' }]);
    assert.deepEqual((await db.cleanup.execute(statement('SELECT purge_document_revisions($1,$2,$3,$4) AS n', args))).rows, [{ n: '0' }]);
    assert.deepEqual((await db.admin.execute(querySql`SELECT current_revision_id FROM document WHERE id=${doc}`)).rows, [{ current_revision_id: null }]);
    assert.deepEqual((await db.admin.execute(querySql`SELECT kind,opaque_subject_id,state,request_id,request_revision FROM lifecycle_witness WHERE id=${witness}`)).rows, [{ kind: 'plant', opaque_subject_id: p.id, state: 'purging', request_id: request, request_revision: '1' }]);
    assert.deepEqual((await db.admin.execute(querySql`SELECT kind FROM tenant WHERE id=${p.id}`)).rows, [{ kind: 'plant' }]);
  } finally {
    await db.admin.execute(querySql.raw(`DROP SCHEMA IF EXISTS ${other} CASCADE`));
    await rm(dir, { recursive: true }); await db.close();
  }
});

test('INV-revocation: a session revoke waits for an in-flight authority transaction and the next access is unavailable', async () => {
  const db = await database();
  const a = await account(db.admin), selected = { kind: 'account', id: a.id };
  let release; const hold = new Promise(resolve => { release=resolve; });
  let loaded; const ready = new Promise(resolve => { loaded=resolve; });
  let announced; const revokeReady = new Promise(resolve => { announced=resolve; });
  let pid;
  const active = db.runtime.transaction(async tx => {
    assert.deepEqual(await currentActor(tx,a.session,selected),{status:'active',accountId:a.id,context:{kind:'account',owner:selected}});
    loaded(); await hold;
  });
  let deleting;
  try {
    await Promise.race([ready,active]);
    deleting=db.admin.transaction(async tx=>{
      pid=(await tx.execute(querySql`SELECT pg_backend_pid() AS pid`)).rows[0].pid;
      announced(); await tx.execute(querySql`DELETE FROM auth_session WHERE id=${a.session}`);
    });
    await Promise.race([revokeReady,deleting]);
    let observed=false;
    for(let i=0;i<40;i++){
      const status=(await db.admin.execute(querySql`SELECT wait_event_type FROM pg_stat_activity WHERE pid=${pid}`)).rows[0];
      if(status?.wait_event_type==='Lock'){observed=true;break;}
    }
    assert.equal(observed,true);release();await active;await deleting;
    assert.deepEqual(await db.runtime.transaction(tx=>currentActor(tx,a.session,selected)),{status:'unavailable'});
  } finally { release();await Promise.allSettled([active,deleting]);await db.close(); }
});

test('INV-membership: legacy inconsistent seats and current lifecycle witnesses fail closed', async () => {
  const db = await database();
  try {
    const a = await account(db.admin), p = await plant(db.admin), q = await plant(db.admin);
    const { seat } = await import('./support.mts');
    const first = await seat(db.admin, a, p), second = id();
    // Simulate pre-constraint corruption only inside this disposable schema.
    await db.admin.execute(querySql.raw(`DROP INDEX ${db.schema}.seat_uq_0`));
    await db.admin.execute(querySql`INSERT INTO seat(id,account_id,plant_id,role,accepted_at) VALUES(${second},${a.id},${q.id},${'member'},clock_timestamp())`);
    await transaction(db.runtime, async tx => {
      assert.deepEqual(await currentActor(tx, a.session, p), { status: 'unavailable' });
      assert.deepEqual(await currentActor(tx, a.session, { kind: 'account', id: a.id }), { status: 'unavailable' });
    });
    await db.admin.execute(querySql`DELETE FROM seat WHERE id=${second}`);
    await db.admin.execute(querySql.raw(`CREATE UNIQUE INDEX seat_uq_0 ON ${db.schema}.seat(account_id) WHERE ended_at IS NULL`));
    const request = id(), witness = id();
    await db.admin.execute(querySql`INSERT INTO lifecycle_witness(id,kind,opaque_subject_id,plant_id,request_id,request_revision,state,requested_at,cancel_until,witness_checkpoint,cleanup_state)
      VALUES(${witness},'plant',${p.id},${p.id},${request},1,'pending_deletion',now(),now()+interval '30 days',1,'not_started')`);
    await transaction(db.runtime, async tx => { assert.deepEqual(await currentActor(tx, a.session, p), { status: 'unavailable' }); });
    await db.admin.execute(querySql`UPDATE lifecycle_witness SET state='cancelled',cancelled_at=clock_timestamp() WHERE id=${witness}`);
    await transaction(db.runtime, async tx => { assert.deepEqual(await currentActor(tx, a.session, p), { status: 'active', accountId: a.id, context: { kind: 'seat', owner: p, seatId: first, role: 'admin', revision: '1' } }); });
    await db.admin.execute(querySql`INSERT INTO lifecycle_witness(kind,opaque_subject_id,seat_id,request_revision,state,witness_checkpoint,cleanup_state) VALUES('seat',${first},${first},1,'revoked',2,'not_started')`);
    await transaction(db.runtime, async tx => { assert.deepEqual(await currentActor(tx, a.session, p), { status: 'unavailable' }); });
  } finally { await db.close(); }
});

function statement(text: string, values: readonly unknown[]) { return querySql.join(text.split(/(\$\d+)/).filter(Boolean).map(part => /^\$\d+$/.test(part) ? querySql`${values[Number(part.slice(1))-1]}` : querySql.raw(part)), querySql``); }
