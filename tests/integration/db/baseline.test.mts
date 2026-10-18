import { createDatabase, closeDatabase } from "../../../packages/db/src/client.ts";
import { sql as querySql } from "../../../packages/db/node_modules/drizzle-orm/index.js";
import test, { before, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID, randomBytes } from "node:crypto";
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import { verifySchemaDrift, verifySnapshotBaseline } from "../../../packages/db/src/schema/drift.ts";
import * as declarations from "../../../packages/db/src/schema/tables.ts";
import { pgTable, integer } from "../../../packages/db/src/columns.ts";
import { assertCurrentCatalog } from "../../../packages/db/src/schema/catalog.ts";
import { migrate, adoptMigrationHistory, migrationArtifact } from "../../../packages/db/src/schema/migrate.ts";
import { pdf } from "../platform/fixtures.mjs";
import { auth_user, auth_account, auth_session, auth_verification } from "../../../packages/db/src/schema/tables.ts";
import { authStorage } from "../../../packages/db/src/schema/auth-storage.ts";
import { canonicalTimeZone } from "../../../packages/db/src/schema/time.ts";
import {
	putPrivateObject,
	readAuthorizedObject,
	createAuthorizedDownload,
	deleteUnreferencedObject,
} from "../../../packages/db/src/schema/storage.ts";
const require = createRequire(new URL("../../../packages/db/package.json", import.meta.url));

const appRequire = createRequire(new URL("../../../apps/web/package.json", import.meta.url));
const { S3Client } = require("@aws-sdk/client-s3");
const schema = "wp004_test_" + randomUUID().replaceAll("-", "");
const role = "wp004_" + randomBytes(8).toString("hex");
const authRole = role + "_auth";
const source = new URL(process.env.DATABASE_URL_UNPOOLED ?? process.env.DATABASE_URL ?? "about:blank");
const localCi =
	process.env.CI === "true" &&
	process.env.EARLY_ACCESS_TEST_DATABASE === "1" &&
	["localhost", "127.0.0.1"].includes(source.hostname) &&
	source.pathname === "/everyfield_ci";
if (
	(!localCi && source.hostname !== "ep-autumn-dew-b8ltidky.c-14.us-east-1.aws.neon.tech") ||
	process.env.NODE_ENV === "production"
)
	throw Error("Only approved shared development direct endpoint allowed");
if (!localCi) source.searchParams.set("sslmode", "verify-full");
const admin = createDatabase({
	connectionString: source.href,
	max: 3,
	options: `-c search_path=${schema},pg_catalog,pg_temp`,
});
let runtime, authDb;
const p = randomUUID(),
	q = randomUUID(),
	a = randomUUID(),
	b = randomUUID();
const hash = "a".repeat(64);
async function rejected(sql, params = [], code = "23514", db = admin) {
	await assert.rejects(db.execute(statement(sql, params)), (e) => e.cause?.code === code);
}
async function account(id) {
	const user = randomUUID();
	await admin.execute(
		querySql`INSERT INTO auth_user(id,email,email_verified,name) VALUES(${querySql.param(user)},${querySql.param(user + "@example.test")},true,'Synthetic')`,
	);
	await admin.execute(
		querySql`INSERT INTO account(id,auth_user_id,registration_state,registration_kind) VALUES(${querySql.param(id)},${querySql.param(user)},'active','planter')`,
	);
}
async function plant(id) {
	await admin.execute(
		querySql`INSERT INTO plant(id,name,timezone,warning_days,alert_days,digest_weekday,digest_hour,phase,material_revision) VALUES(${querySql.param(id)},'Synthetic Plant','America/Chicago',7,14,1,8,1,1)`,
	);
}
async function person(owner, id = randomUUID()) {
	await admin.execute(
		querySql`INSERT INTO person(id,tenant_id,plant_id,display_name,created_at,stage,adult_classification,state,commitment_state,pipeline_position,source) VALUES(${querySql.param(id)},${querySql.param(owner)},${querySql.param(owner)},'Synthetic Person',now(),'prospect','adult','live','unknown',0,'other')`,
	);
	return id;
}
async function doc(owner, id = randomUUID()) {
	await admin.execute(
		querySql`INSERT INTO document(id,tenant_id,kind,title) VALUES(${querySql.param(id)},${querySql.param(owner)},'native','Synthetic')`,
	);
	return id;
}
const authorizer = async (tx, file) => {
	const r = await tx.execute(
		querySql`SELECT 1 FROM seat WHERE account_id=${querySql.param(a)} AND plant_id=${querySql.param(file.tenant_id)} AND ended_at IS NULL AND role IN ('owner','admin') FOR SHARE`,
	);
	return r.rowCount === 1 ? { kind: "account", actorId: a } : null;
};
before(async () => {
	await admin.execute(querySql.raw(`CREATE SCHEMA ${schema}`));
	assert.deepEqual(
		await migrate(admin, schema),
		(await migrationArtifact()).map((m) => m.name),
	);
	assert.deepEqual(await migrate(admin, schema), []);
	await account(a);
	await account(b);
	await plant(p);
	await plant(q);
	await admin.execute(
		querySql`INSERT INTO seat(account_id,plant_id,role,accepted_at) VALUES(${querySql.param(a)},${querySql.param(p)},'owner',now())`,
	);
	const password = randomBytes(32).toString("hex");
	for (const [name, capability] of [
		[role, "everyfield_runtime"],
		[authRole, "everyfield_auth"],
	]) {
		await admin.execute(
			querySql.raw(
				`CREATE ROLE ${name} LOGIN INHERIT PASSWORD '${password}' NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS`,
			),
		);
		await admin.execute(querySql.raw(`GRANT ${capability} TO ${name}`));
	}
	const url = new URL(source);
	url.username = role;
	url.password = password;
	runtime = createDatabase({
		connectionString: url.href,
		max: 3,
		options: `-c search_path=${schema},pg_catalog,pg_temp`,
	});
	url.username = authRole;
	authDb = createDatabase({
		connectionString: url.href,
		max: 2,
		options: `-c search_path=${schema},pg_catalog,pg_temp`,
	});
});
after(async () => {
	if (runtime) await closeDatabase(runtime);
	if (authDb) await closeDatabase(authDb);
	await admin.execute(querySql.raw(`DROP SCHEMA IF EXISTS ${schema} CASCADE`));
	for (const name of [role, authRole]) await admin.execute(querySql.raw(`DROP ROLE IF EXISTS ${name}`));
	await closeDatabase(admin);
});

test("INV-schema: full ordered migrations match the current catalog and reject actual schema drift", async () => {
	const catalog = JSON.parse(readFileSync(new URL("../../../docs/schema/target.json", import.meta.url), "utf8"));
	await assertCurrentCatalog(admin, schema, catalog);
	await verifySnapshotBaseline();
	await verifySchemaDrift(admin, schema);
	const drift_probe = pgTable("drift_probe", { id: integer("id").notNull() });
	await assert.rejects(verifySchemaDrift(admin, schema, { ...declarations, drift_probe }), /Schema drift in columns/);
	await admin.execute(querySql`ALTER TABLE schema_migration ADD CONSTRAINT drift_check CHECK(length(name)>0)`);
	try {
		await assert.rejects(verifySchemaDrift(admin, schema), /Schema drift in constraints/);
	} finally {
		await admin.execute(querySql`ALTER TABLE schema_migration DROP CONSTRAINT drift_check`);
	}

	await admin.execute(querySql`ALTER TABLE affiliation RENAME COLUMN consent_revision TO consent_revision_drift`);
	await assert.rejects(assertCurrentCatalog(admin, schema, catalog), /Migrated columns\/types\/nullability differ/);
	await admin.execute(querySql`ALTER TABLE affiliation RENAME COLUMN consent_revision_drift TO consent_revision`);
	await admin.execute(querySql`ALTER TABLE affiliation ALTER COLUMN consent_revision DROP NOT NULL`);
	await assert.rejects(assertCurrentCatalog(admin, schema, catalog), /Migrated columns\/types\/nullability differ/);
	await admin.execute(querySql`ALTER TABLE affiliation ALTER COLUMN consent_revision SET NOT NULL`);
	await assertCurrentCatalog(admin, schema, catalog);

	const ledger = await admin.execute(querySql`SELECT name FROM schema_migration ORDER BY name`);
	assert.deepEqual(
		ledger.rows,
		(await migrationArtifact()).map((m) => ({ name: m.name })),
	);
	assert.equal((await admin.execute(querySql`SELECT count(*)::int AS n FROM early_access_request`)).rows[0].n, 0);
});
test("INV-migration: preserves applied 0001 bytes and ledger; retries and failed batches roll back", async () => {
	const other = "wp004_test_" + randomUUID().replaceAll("-", "");
	await admin.execute(querySql.raw(`CREATE SCHEMA ${other}`));
	const pool = createDatabase({
		connectionString: source.href,
		max: 2,
		options: `-c search_path=${other},pg_catalog,pg_temp`,
	});
	try {
		await pool.execute(
			querySql.raw(
				readFileSync(new URL("../../../packages/db/migrations/0001_early_access.sql", import.meta.url), "utf8"),
			),
		);
		await pool.execute(
			querySql`CREATE TABLE schema_migration(name text PRIMARY KEY,applied_at timestamptz NOT NULL DEFAULT now());INSERT INTO schema_migration VALUES('0001_early_access.sql','2026-10-01Z')`,
		);
		await pool.execute(
			querySql`INSERT INTO early_access_request(kind,email,data,mail_payload) VALUES('planter','preserved@example.test','{}','{}')`,
		);
		await assert.rejects(migrate(pool, other), /migration_provenance_unverified/);
		const approved = Object.fromEntries(
			(await migrationArtifact()).filter((r) => r.name === "0001_early_access.sql").map((r) => [r.name, r.sha256]),
		);
		assert.deepEqual(await adoptMigrationHistory(pool, other, approved), [
			{ name: "0001_early_access.sql", provenance: "adopted" },
		]);
		await pool.execute(querySql`CREATE TABLE file_object(id uuid)`);
		await assert.rejects(migrate(pool, other), (e) => e.cause?.code === "42P07");
		assert.deepEqual((await pool.execute(querySql`SELECT name FROM schema_migration`)).rows, [
			{ name: "0001_early_access.sql" },
		]);
		assert.equal((await pool.execute(querySql`SELECT to_regclass('tenant') AS t`)).rows[0].t, null);
		await pool.execute(querySql`DROP TABLE file_object`);
		assert.deepEqual(
			await migrate(pool, other),
			(await migrationArtifact()).filter((m) => m.name !== "0001_early_access.sql").map((m) => m.name),
		);
		assert.equal(
			(await pool.execute(querySql`SELECT email FROM early_access_request`)).rows[0].email,
			"preserved@example.test",
		);
		assert.equal(
			new Date(
				(
					await pool.execute(
						querySql`SELECT applied_at FROM schema_migration WHERE name=${querySql.param("0001_early_access.sql")}`,
					)
				).rows[0].applied_at,
			).toISOString(),
			"2026-10-01T00:00:00.000Z",
		);
		assert.deepEqual(await Promise.all([migrate(pool, other), migrate(pool, other)]), [[], []]);
	} finally {
		await closeDatabase(pool);
		await admin.execute(querySql.raw(`DROP SCHEMA ${other} CASCADE`));
	}
});
test("AC:TEN-001 INV-subtype: real same-owner FKs, root kinds and record bindings reject forged identities", async () => {
	const x = await person(p);
	assert.deepEqual(
		(await admin.execute(querySql`SELECT kind,tenant_id FROM record WHERE id=${querySql.param(x)}`)).rows,
		[{ kind: "person", tenant_id: p }],
	);
	await rejected(
		"INSERT INTO person_note(tenant_id,plant_id,person_id,author_id,body,occurred_at,recorded_at) VALUES($1,$1,$2,$3,'foreign',now(),now())",
		[q, x, a],
		"23503",
	);
	await admin.execute(
		querySql`INSERT INTO person_note(tenant_id,plant_id,person_id,author_id,body,occurred_at,recorded_at) VALUES(${querySql.param(p)},${querySql.param(p)},${querySql.param(x)},${querySql.param(a)},'same',now(),now())`,
	);
	await rejected("UPDATE person SET tenant_id=$1,plant_id=$1 WHERE id=$2", [q, x], "23503");
	await rejected("INSERT INTO document(id,tenant_id,kind,title) VALUES($1,$2,'native','forged subtype')", [x, p]);
	const before = (await admin.execute(querySql`SELECT count(*)::int n FROM tenant`)).rows[0].n;
	const credential = (await admin.execute(querySql`SELECT auth_user_id FROM account WHERE id=${querySql.param(a)}`))
		.rows[0].auth_user_id;
	const duplicate = randomUUID();
	await admin.execute(
		querySql`INSERT INTO account(id,auth_user_id,registration_state,registration_kind) VALUES(${querySql.param(duplicate)},${querySql.param(credential)},'active','planter') ON CONFLICT(auth_user_id) DO NOTHING`,
	);
	assert.equal((await admin.execute(querySql`SELECT count(*)::int n FROM tenant`)).rows[0].n, before);
	assert.equal(
		(await admin.execute(querySql`SELECT count(*)::int n FROM record WHERE id=${querySql.param(duplicate)}`)).rows[0].n,
		0,
	);
	const wrong = randomUUID();
	await admin.execute(querySql`INSERT INTO tenant(id,kind) VALUES(${querySql.param(wrong)},'organization')`);
	await rejected(
		"INSERT INTO plant(id,name,timezone,warning_days,alert_days,digest_weekday,digest_hour,phase,material_revision) VALUES($1,'Wrong','UTC',7,14,1,8,1,1)",
		[wrong],
	);
	await rejected("INSERT INTO tenant(id,kind) VALUES($1,'global')", [randomUUID()]);
	await admin.execute(querySql`DELETE FROM person_note WHERE person_id=${querySql.param(x)}`);
	await admin.execute(querySql`DELETE FROM person WHERE id=${querySql.param(x)}`);
	assert.deepEqual(
		(await admin.execute(querySql`SELECT kind,tenant_id FROM record WHERE id=${querySql.param(x)}`)).rows,
		[{ kind: "person", tenant_id: p }],
	);
});
test("INV-seat: simultaneous acceptance permits only one active tenant seat", async () => {
	const c = randomUUID();
	await account(c);
	const results = await Promise.allSettled(
		[p, q].map((owner) =>
			admin.execute(
				querySql`INSERT INTO seat(account_id,plant_id,role,accepted_at) VALUES(${querySql.param(c)},${querySql.param(owner)},'member',now())`,
			),
		),
	);
	assert.equal(results.filter((r) => r.status === "fulfilled").length, 1);
	assert.equal(results.filter((r) => r.status === "rejected" && r.reason.cause?.code === "23505").length, 1);
	assert.equal(
		(
			await admin.execute(
				querySql`SELECT count(*)::int n FROM seat WHERE account_id=${querySql.param(c)} AND ended_at IS NULL`,
			)
		).rows[0].n,
		1,
	);
});
test("INV-document: private and plant bodies preserve exact immutable owner and selected revision", async () => {
	const d = await doc(a),
		d2 = await doc(a),
		rev = randomUUID();
	await admin.execute(
		querySql`INSERT INTO document_revision(id,tenant_id,document_id,version_number,body,content_hash,recorded_at) VALUES(${querySql.param(rev)},${querySql.param(a)},${querySql.param(d)},1,'private body',${querySql.param(hash)},now())`,
	);
	await admin.execute(
		querySql`UPDATE document SET current_revision_id=${querySql.param(rev)} WHERE id=${querySql.param(d)}`,
	);
	await rejected("UPDATE document SET current_revision_id=$1 WHERE id=$2", [rev, d2]);
	await rejected("UPDATE document SET tenant_id=$1 WHERE id=$2", [p, d], "23503");
	await rejected(
		"INSERT INTO document_revision(tenant_id,document_id,version_number,body,content_hash,recorded_at) VALUES($1,$2,2,'foreign',$3,now())",
		[p, d, hash],
		"23503",
	);
	assert.equal(
		(await admin.execute(querySql`SELECT body FROM document_revision WHERE id=${querySql.param(rev)}`)).rows[0].body,
		"private body",
	);
});
test("AC:TEN-009 INV-runtime: real login cannot own schema, change audit history or run migrations", async () => {
	const identity = (await runtime.execute(querySql`SELECT current_user`)).rows[0];
	assert.equal(identity.current_user, role);
	assert.deepEqual(
		(
			await runtime.execute(
				querySql`SELECT rolsuper,rolcreaterole,rolcreatedb,rolbypassrls FROM pg_roles WHERE rolname=current_user`,
			)
		).rows[0],
		{ rolsuper: false, rolcreaterole: false, rolcreatedb: false, rolbypassrls: false },
	);
	for (const statement of [
		"CREATE TABLE forbidden(id int)",
		"UPDATE event SET kind='edit'",
		"DELETE FROM event",
		"SELECT * FROM schema_migration",
		"SELECT * FROM auth_user",
		"INSERT INTO record(id,kind,tenant_id) VALUES(gen_random_uuid(),'person','" + p + "')",
	])
		await rejected(statement, [], "42501", runtime);
	const x = await doc(p);
	await runtime.execute(
		querySql`INSERT INTO event(tenant_id,target_record_id,kind,occurred_at,recorded_at,system_cause,event_key,action) VALUES(${querySql.param(p)},${querySql.param(x)},'create',now(),now(),'synthetic','first','documents.saved')`,
	);
	assert.equal(
		(await runtime.execute(querySql`SELECT count(*)::int n FROM event WHERE target_record_id=${querySql.param(x)}`))
			.rows[0].n,
		1,
	);
});
test("INV-transaction: audit failure rolls back domain mutation and receipt, replay adds no duplicate event", async () => {
	const x = await doc(p);
	await assert.rejects(
		runtime.transaction(async (tx) => {
			await tx.execute(querySql`UPDATE document SET title='changed',revision=revision+1 WHERE id=${querySql.param(x)}`);
			await tx.execute(
				querySql`INSERT INTO operation(id,tenant_id,actor_id,name,request_key,request_digest,state,started_at,tool_calls,reserved_input,reserved_output,used_input,used_output) VALUES(gen_random_uuid(),${querySql.param(p)},${querySql.param(a)},'documents.saveNative','rollback-receipt',${querySql.param(hash)},'pending',now(),0,0,0,0,0)`,
			);
			await tx.execute(
				querySql`INSERT INTO event(tenant_id,target_record_id,kind,occurred_at,recorded_at,system_cause,event_key,action) VALUES(${querySql.param(p)},${querySql.param(x)},'edit',now(),now(),'synthetic','bad','not_allowed')`,
			);
		}),
		(e) => e.cause?.code === "23514",
	);
	assert.equal(
		(await admin.execute(querySql`SELECT title FROM document WHERE id=${querySql.param(x)}`)).rows[0].title,
		"Synthetic",
	);
	assert.equal(
		(await admin.execute(querySql`SELECT count(*)::int n FROM operation WHERE request_key='rollback-receipt'`)).rows[0]
			.n,
		0,
	);
	const sql =
		"INSERT INTO event(tenant_id,target_record_id,kind,occurred_at,recorded_at,system_cause,event_key) VALUES($1,$2,'create',now(),now(),'synthetic','replay') ON CONFLICT(target_record_id,event_key) DO NOTHING";
	await runtime.execute(statement(sql, [p, x]));
	await runtime.execute(statement(sql, [p, x]));
	assert.equal(
		(await admin.execute(querySql`SELECT count(*)::int n FROM event WHERE target_record_id=${querySql.param(x)}`))
			.rows[0].n,
		1,
	);
});
test("INV-audit: exact UTF-8 limit and dedicated private care identity", async () => {
	const x = await doc(p);
	const sql =
		"INSERT INTO event(tenant_id,target_record_id,kind,occurred_at,recorded_at,system_cause,event_key,action,diff) VALUES($1,$2,'edit',now(),now(),'synthetic',$3,'documents.saved',$4)";
	// JSONB text adds 9 bytes for this key/value shape.
	const size = (n) => JSON.stringify({ x: "a".repeat(n - 9) });
	await runtime.execute(statement(sql, [p, x, "boundary", size(2048)]));
	assert.equal(
		(
			await admin.execute(
				querySql`SELECT octet_length(convert_to(diff::text,'UTF8')) n FROM event WHERE target_record_id=${querySql.param(x)}`,
			)
		).rows[0].n,
		2048,
	);
	await rejected(sql, [p, x, "oversized", size(2049)]);
	const week = randomUUID();
	await runtime.execute(
		querySql`INSERT INTO private_week(id,plant_id,author_id,ordinal,monday,timezone,starts_at,ends_at,revision,note) VALUES(${querySql.param(week)},${querySql.param(p)},${querySql.param(a)},1,'2026-10-12','America/Chicago','2026-10-12T05:00Z','2026-10-19T05:00Z',1,'CARE-CANARY')`,
	);
	assert.equal(
		(await admin.execute(querySql`SELECT count(*)::int n FROM record WHERE id=${querySql.param(week)}`)).rows[0].n,
		0,
	);
	await rejected("UPDATE private_week SET author_id=$1 WHERE id=$2", [b, week]);
	assert.equal(
		(await admin.execute(querySql`SELECT count(*)::int n FROM event WHERE target_record_id=${querySql.param(week)}`))
			.rows[0].n,
		0,
	);
});
test("INV-calendar-revision: canonical named zones and full int64 precision in real PostgreSQL", async () => {
	await admin.execute(
		querySql`UPDATE plant SET timezone=${querySql.param(canonicalTimeZone("US/Eastern"))},revision=${querySql.param("9223372036854775807")} WHERE id=${querySql.param(p)}`,
	);
	assert.deepEqual(
		(await admin.execute(querySql`SELECT timezone,revision FROM plant WHERE id=${querySql.param(p)}`)).rows[0],
		{
			timezone: "America/New_York",
			revision: "9223372036854775807",
		},
	);
	await rejected("UPDATE plant SET timezone='US/Eastern' WHERE id=$1", [p]);
	await rejected("UPDATE plant SET revision=revision+1 WHERE id=$1", [p], "22003");
	await admin.execute(querySql`UPDATE plant SET revision=1 WHERE id=${querySql.param(p)}`);
});
test("INV-storage: server-owned key, current authorization, five-minute signing and fenced cleanup", async () => {
	const bytes = Buffer.from(pdf());
	const saved = new Map();
	const fake = {
		client: {
			send: async (command) => {
				const i = command.input;
				if (command.constructor.name === "GetBucketAclCommand")
					return {
						Grants: [{ Permission: "FULL_CONTROL", Grantee: { Type: "CanonicalUser", ID: "synthetic-owner" } }],
					};
				if (command.constructor.name === "PutObjectCommand") {
					if (saved.has(i.Key)) {
						const error = new Error("already present");
						error.name = "PreconditionFailed";
						throw error;
					}
					saved.set(i.Key, Buffer.from(i.Body));
					return {};
				}
				if (command.constructor.name === "GetObjectCommand") {
					const body = saved.get(i.Key);
					return { ContentLength: body.length, Body: { transformToByteArray: async () => body } };
				}
				if (command.constructor.name === "DeleteObjectCommand") {
					saved.delete(i.Key);
					return {};
				}
				throw Error("unexpected");
			},
		},
		bucket: "synthetic-only",
	};
	const publicBucket = {
		bucket: "public-fixture",
		client: {
			send: async () => ({
				Grants: [{ Grantee: { URI: "http://acs.amazonaws.com/groups/global/AllUsers" }, Permission: "READ" }],
			}),
		},
	};
	await assert.rejects(
		putPrivateObject(runtime, publicBucket, authorizer, {
			tenantId: p,
			purpose: "commitment",
			mediaType: "application/pdf",
			bytes,
			uploadKey: randomUUID(),
		}),
		/private_bucket_required/,
	);
	const uploaded = await putPrivateObject(runtime, fake, authorizer, {
		tenantId: p,
		purpose: "commitment",
		mediaType: "application/pdf",
		bytes,
		uploadKey: randomUUID(),
	});
	const recordCount = (await admin.execute(querySql`SELECT count(*)::int n FROM record WHERE kind='file_object'`))
		.rows[0].n;
	const uploadKey = (
		await admin.execute(querySql`SELECT upload_key FROM file_object WHERE id=${querySql.param(uploaded.id)}`)
	).rows[0].upload_key;
	assert.deepEqual(
		await putPrivateObject(runtime, fake, authorizer, {
			tenantId: p,
			purpose: "commitment",
			mediaType: "application/pdf",
			bytes,
			uploadKey,
		}),
		uploaded,
	);
	assert.equal(
		(await admin.execute(querySql`SELECT count(*)::int n FROM record WHERE kind='file_object'`)).rows[0].n,
		recordCount,
	);
	assert.equal(
		(
			await admin.execute(
				querySql`SELECT count(*)::int n FROM event WHERE target_record_id=${querySql.param(uploaded.id)} AND action='files.finalized'`,
			)
		).rows[0].n,
		1,
	);
	assert.deepEqual(Buffer.from(await readAuthorizedObject(runtime, fake, authorizer, uploaded.id)), bytes);
	const stored = (
		await admin.execute(querySql`SELECT opaque_key,state FROM file_object WHERE id=${querySql.param(uploaded.id)}`)
	).rows[0];
	assert.equal(stored.state, "ready");
	assert.match(stored.opaque_key, new RegExp("^private/" + p + "/[a-f0-9-]{36}$"));
	await assert.rejects(
		readAuthorizedObject(runtime, fake, async () => null, uploaded.id),
		/unavailable/,
	);
	const signing = {
		bucket: "private-fixture",
		client: new S3Client({
			region: "auto",
			endpoint: "https://storage.example.test",
			forcePathStyle: true,
			credentials: { accessKeyId: "synthetic", secretAccessKey: "synthetic-only" },
		}),
	};
	const link = await createAuthorizedDownload(runtime, signing, authorizer, uploaded.id);
	assert.equal(new URL(link.url).searchParams.get("X-Amz-Expires"), "300");
	assert.equal(link.expiresInSeconds, 300);
	const revision = randomUUID(),
		d = await doc(p);
	await admin.execute(
		querySql`INSERT INTO document_revision(id,tenant_id,document_id,version_number,body,content_hash,import_object_id,recorded_at) VALUES(${querySql.param(revision)},${querySql.param(p)},${querySql.param(d)},1,'imported',${querySql.param(hash)},${querySql.param(uploaded.id)},now())`,
	);
	await assert.rejects(deleteUnreferencedObject(runtime, fake, authorizer, uploaded.id), /unavailable/);
	assert.equal(saved.size, 1);
	await admin.execute(querySql`DELETE FROM document_revision WHERE id=${querySql.param(revision)}`);
	assert.deepEqual(await deleteUnreferencedObject(runtime, fake, authorizer, uploaded.id), { status: "inaccessible" });
	assert.equal(saved.size, 0);
	await rejected(
		"INSERT INTO document_revision(tenant_id,document_id,version_number,body,content_hash,import_object_id,recorded_at) VALUES($1,$2,2,'late bind',$3,$4,now())",
		[p, d, hash, uploaded.id],
	);
	// Provider failure remains truthful and retryable with the same key.
	const retryInput = {
		tenantId: p,
		purpose: "commitment",
		mediaType: "application/pdf",
		bytes,
		uploadKey: randomUUID(),
	};
	let lost = true;
	const lostResponse = {
		bucket: "synthetic-only",
		client: {
			send: async (command) => {
				const result = await fake.client.send(command);
				if (command.constructor.name === "PutObjectCommand" && lost) {
					lost = false;
					throw Error("response lost after accepted PUT");
				}
				return result;
			},
		},
	};
	await assert.rejects(putPrivateObject(runtime, lostResponse, authorizer, retryInput), /unavailable/);
	const pending = (
		await admin.execute(
			querySql`SELECT id,opaque_key,expires_at FROM file_object WHERE upload_key=${querySql.param(retryInput.uploadKey)}`,
		)
	).rows[0];
	const recovered = await putPrivateObject(runtime, fake, authorizer, retryInput);
	assert.deepEqual(recovered, { id: pending.id });
	assert.deepEqual(
		(
			await admin.execute(
				querySql`SELECT id,opaque_key,expires_at FROM file_object WHERE upload_key=${querySql.param(retryInput.uploadKey)}`,
			)
		).rows[0],
		pending,
	);
	assert.equal(
		(
			await admin.execute(
				querySql`SELECT count(*)::int n FROM event WHERE target_record_id=${querySql.param(recovered.id)} AND action='files.finalized'`,
			)
		).rows[0].n,
		1,
	);
	await deleteUnreferencedObject(runtime, fake, authorizer, recovered.id);
	const second = await putPrivateObject(runtime, fake, authorizer, {
		tenantId: p,
		purpose: "commitment",
		mediaType: "application/pdf",
		bytes,
		uploadKey: randomUUID(),
	});
	const failing = {
		bucket: "synthetic-only",
		client: {
			send: async () => {
				throw Error("lost response");
			},
		},
	};
	assert.deepEqual(await deleteUnreferencedObject(runtime, failing, authorizer, second.id), { status: "unknown" });
	assert.equal(
		(await admin.execute(querySql`SELECT state FROM file_object WHERE id=${querySql.param(second.id)}`)).rows[0].state,
		"cleanup",
	);
	assert.deepEqual(await deleteUnreferencedObject(runtime, fake, authorizer, second.id), { status: "inaccessible" });
});
test("INV-auth-adapter: pinned Better Auth uses app-owned physical UUID and snake-case fields", async () => {
	const { betterAuth } = await import(appRequire.resolve("better-auth"));
	const { drizzleAdapter } = await import(appRequire.resolve("better-auth/adapters/drizzle"));
	const auth = betterAuth({
		database: drizzleAdapter(authDb, {
			provider: "pg",
			schema: { auth_user, auth_account, auth_session, auth_verification },
			transaction: true,
		}),
		baseURL: "http://localhost",
		secret: randomBytes(32).toString("hex"),
		...authStorage,
		emailAndPassword: { enabled: true },
		advanced: { database: { generateId: () => randomUUID() } },
		logger: { disabled: true },
	});
	const email = randomUUID() + "@example.test";
	const result = await auth.api.signUpEmail({
		body: { email, name: "Synthetic Auth", password: "Synthetic-Baseline-123!" },
	});
	assert.equal(result.user.email, email);
	assert.match(result.user.id, /^[a-f0-9-]{36}$/);
	const signed = await auth.api.signInEmail({ body: { email, password: "Synthetic-Baseline-123!" } });
	assert.equal(signed.user.id, result.user.id);
	assert.equal(
		(
			await admin.execute(
				querySql`SELECT count(*)::int n FROM auth_account WHERE user_id=${querySql.param(result.user.id)}`,
			)
		).rows[0].n,
		1,
	);
	assert.equal(
		(
			await admin.execute(
				querySql`SELECT count(*)::int n FROM account WHERE auth_user_id=${querySql.param(result.user.id)}`,
			)
		).rows[0].n,
		0,
	);
});
test("INV-baseline: Launch links, creation journal and retained purge clocks use typed immutable facts", async () => {
	const personP = await person(p),
		personQ = await person(q);
	await admin.execute(querySql`INSERT INTO launch(plant_id,status) VALUES(${querySql.param(p)},'planning')`);
	await admin.execute(
		querySql`INSERT INTO launch_guest(plant_id,person_id,kind,recorded_at) VALUES(${querySql.param(p)},${querySql.param(personP)},'first_time',now())`,
	);
	await rejected(
		"INSERT INTO launch_guest(plant_id,person_id,kind,recorded_at) VALUES($1,$2,'returning',now())",
		[p, personP],
		"23505",
	);
	await rejected(
		"INSERT INTO launch_guest(plant_id,person_id,kind,recorded_at) VALUES($1,$2,'first_time',now())",
		[p, personQ],
		"23503",
	);
	const operation = async () => {
		const id = randomUUID();
		await admin.execute(
			querySql`INSERT INTO operation(id,tenant_id,actor_id,name,request_key,request_digest,state,started_at,tool_calls,reserved_input,reserved_output,used_input,used_output) VALUES(${querySql.param(id)},${querySql.param(p)},${querySql.param(a)},'onboarding.createPlant',${querySql.param(id)},${querySql.param(hash)},'pending',now(),0,0,0,0,0)`,
		);
		return id;
	};
	const first = await operation(),
		second = await operation();
	await admin.execute(
		querySql`INSERT INTO phase_transition(plant_id,kind,to_phase,reason,occurred_at,recorded_at,operation_id) VALUES(${querySql.param(p)},'creation',1,'created',now(),now(),${querySql.param(first)})`,
	);
	await rejected(
		"INSERT INTO phase_transition(plant_id,kind,to_phase,reason,occurred_at,recorded_at,operation_id) VALUES($1,'creation',1,'duplicate',now(),now(),$2)",
		[p, second],
		"23505",
	);
	await rejected(
		"INSERT INTO phase_transition(plant_id,kind,to_phase,reason,occurred_at,recorded_at,operation_id) VALUES($1,'creation',2,'wrong phase',now(),now(),$2)",
		[q, second],
	);
	const witness = randomUUID();
	await admin.execute(
		querySql`INSERT INTO lifecycle_witness(id,kind,opaque_subject_id,plant_id,request_id,request_revision,state,requested_at,cancel_until,live_purged_at,copy_expires_at,witness_checkpoint,cleanup_state) VALUES(${querySql.param(witness)},'plant',${querySql.param(p)},${querySql.param(p)},${querySql.param(randomUUID())},1,'purged','2026-10-01Z','2026-10-31Z','2026-11-01Z','2026-11-08Z',1,'inaccessible')`,
	);
	await rejected("UPDATE lifecycle_witness SET copy_expires_at='2026-11-09Z' WHERE id=$1", [witness]);
	await rejected(
		"UPDATE lifecycle_witness SET live_purged_at='2026-11-02Z',copy_expires_at='2026-11-09Z' WHERE id=$1",
		[witness],
	);
	await admin.execute(querySql`UPDATE lifecycle_witness SET plant_id=NULL WHERE id=${querySql.param(witness)}`);
	assert.deepEqual(
		(await admin.execute(querySql`SELECT tenant_id,kind FROM record WHERE id=${querySql.param(witness)}`)).rows,
		[{ tenant_id: p, kind: "lifecycle_witness" }],
	);
});

function statement(text: string, values: readonly unknown[]) {
	return querySql.join(
		text
			.split(/(\$\d+)/)
			.filter(Boolean)
			.map((part) =>
				/^\$\d+$/.test(part) ? querySql`${querySql.param(values[Number(part.slice(1)) - 1])}` : querySql.raw(part),
			),
		querySql``,
	);
}
