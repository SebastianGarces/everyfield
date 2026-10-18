import { createDatabase, closeDatabase } from "../../../packages/db/src/client.ts";
import { sql as querySql } from "../../../packages/db/node_modules/drizzle-orm/index.js";
import test, { before, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID, randomBytes, createHmac } from "node:crypto";
import { createRequire } from "node:module";
import { mkdtemp, readFile, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { pathToFileURL } from "node:url";
import {
	migrate as applyVersionedMigration,
	migrationArtifact,
	adoptMigrationHistory,
	inspectMigrationProvenance,
} from "../../../packages/db/src/schema/migrate.ts";
import { executeAtomicConsequences } from "../../../packages/domain/src/operations/atomic.ts";
import { createFixtureSwitcher } from "../../../packages/domain/src/operations/fixtures.ts";
import { authStorage } from "../../../packages/db/src/schema/auth-storage.ts";
import { operatorOperations } from "../../../packages/domain/src/operations/operator.ts";
import { createTelemetry, telemetryConfig, traceOperation } from "../../../packages/domain/src/operations/telemetry.ts";
import { createServer } from "node:http";
import { once } from "node:events";
import { mountExecutor, mountCallback } from "../../../ops/maintenance/mount.mts";
import { enqueueJob } from "../../../apps/web/src/server/jobs/queue.ts";
const require = createRequire(new URL("../../../packages/domain/package.json", import.meta.url));

const source = new URL(process.env.DATABASE_URL_UNPOOLED ?? process.env.DATABASE_URL ?? "about:blank");
if (source.hostname !== "ep-autumn-dew-b8ltidky.c-14.us-east-1.aws.neon.tech" || process.env.NODE_ENV === "production")
	throw Error("Only approved shared development direct endpoint allowed");
source.searchParams.set("sslmode", "verify-full");
const schema = "wp050_" + randomUUID().replaceAll("-", ""),
	role = "wp050_" + randomBytes(8).toString("hex");
const admin = createDatabase({
	connectionString: source.href,
	max: 4,
	options: `-c search_path=${schema},pg_catalog,pg_temp`,
});
let runtime;
const actor = randomUUID(),
	tenant = randomUUID(),
	foreign = randomUUID(),
	doc = randomUUID();
const password = randomBytes(32).toString("hex");
before(async () => {
	await admin.execute(querySql.raw(`CREATE SCHEMA ${schema}`));
	assert.deepEqual(await applyVersionedMigration(admin, schema), [
		"0001_early_access.sql",
		"0002_baseline.sql",
		"0003_access_privileges.sql",
	]);
	await admin.execute(
		querySql.raw(
			`CREATE ROLE ${role} LOGIN INHERIT PASSWORD '${password}' NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS`,
		),
	);
	await admin.execute(querySql.raw(`GRANT everyfield_runtime TO ${role}`));
	const url = new URL(source);
	url.username = role;
	url.password = password;
	runtime = createDatabase({
		connectionString: url.href,
		max: 4,
		options: `-c search_path=${schema},pg_catalog,pg_temp`,
	});
	const user = randomUUID();
	await admin.execute(
		querySql`INSERT INTO auth_user(id,email,email_verified,name) VALUES(${user},${user + "@example.test"},true,'Synthetic')`,
	);
	await admin.execute(
		querySql`INSERT INTO account(id,auth_user_id,registration_state,registration_kind) VALUES(${actor},${user},'active','planter')`,
	);
	for (const id of [tenant, foreign])
		await admin.execute(
			querySql`INSERT INTO plant(id,name,timezone,warning_days,alert_days,digest_weekday,digest_hour,phase,material_revision) VALUES(${id},'Synthetic','UTC',7,14,1,8,1,1)`,
		);
	await admin.execute(
		querySql`INSERT INTO document(id,tenant_id,kind,title) VALUES(${doc},${tenant},'native','before')`,
	);
});
after(async () => {
	await runtime?.end();
	try {
		await admin.execute(querySql.raw(`DROP SCHEMA IF EXISTS ${schema} CASCADE`));
		await admin.execute(querySql.raw(`DROP ROLE IF EXISTS ${role}`));
	} finally {
		await closeDatabase(admin);
	}
});

test("AC:CASE-OPS-005 versioned migration checksums are observed at application, replay locks and unverified history is untouched", async () => {
	assert.deepEqual(
		await Promise.all([applyVersionedMigration(admin, schema), applyVersionedMigration(admin, schema)]),
		[[], []],
	);
	const provenance = await inspectMigrationProvenance(admin, schema);
	assert.equal(provenance.state, "current");
	assert.deepEqual(
		provenance.applied.map((r) => r.provenance),
		["original", "original", "original"],
	);
	const ledger = (
		await admin.execute(querySql`SELECT name,applied_at,sha256,provenance FROM schema_migration ORDER BY name`)
	).rows;
	const dir = await mkdtemp(tmpdir() + "/wp050-migrations-");
	try {
		for (const row of ledger) {
			const bytes = await readFile(new URL("../../../packages/db/migrations/" + row.name, import.meta.url));
			await writeFile(dir + "/" + row.name, bytes);
		}
		await writeFile(dir + "/0002_baseline.sql", "SELECT 1;");
		await assert.rejects(
			applyVersionedMigration(admin, schema, pathToFileURL(dir + "/")),
			/migration_checksum_conflict/,
		);
		assert.deepEqual(
			(await admin.execute(querySql`SELECT name,applied_at,sha256,provenance FROM schema_migration ORDER BY name`))
				.rows,
			ledger,
		);
		const other = "wp050_" + randomUUID().replaceAll("-", "");
		await admin.execute(querySql.raw(`CREATE SCHEMA ${other}`));
		try {
			await admin.execute(
				querySql.raw(
					`CREATE TABLE ${other}.schema_migration(name text PRIMARY KEY,applied_at timestamptz NOT NULL);INSERT INTO ${other}.schema_migration VALUES('0001_early_access.sql','2026-01-01Z')`,
				),
			);
			assert.equal((await inspectMigrationProvenance(admin, other)).state, "unverified");
			await assert.rejects(applyVersionedMigration(admin, other), /migration_provenance_unverified/);
			assert.equal(
				(
					await admin.execute(querySql.raw(`SELECT applied_at FROM ${other}.schema_migration`))
				).rows[0].applied_at.toISOString(),
				"2026-01-01T00:00:00.000Z",
			);
			const approved = Object.fromEntries(
				(await migrationArtifact()).filter((r) => r.name === "0001_early_access.sql").map((r) => [r.name, r.sha256]),
			);
			await assert.rejects(
				adoptMigrationHistory(admin, other, { "0001_early_access.sql": "0".repeat(64) }),
				/adoption_review_mismatch/,
			);
			assert.equal((await inspectMigrationProvenance(admin, other)).state, "unverified");
			assert.deepEqual(await adoptMigrationHistory(admin, other, approved), [
				{ name: "0001_early_access.sql", provenance: "adopted" },
			]);
			assert.deepEqual(
				(await admin.execute(querySql.raw(`SELECT provenance,applied_at FROM ${other}.schema_migration`))).rows,
				[{ provenance: "adopted", applied_at: new Date("2026-01-01T00:00:00Z") }],
			);
		} finally {
			await admin.execute(querySql.raw(`DROP SCHEMA ${other} CASCADE`));
		}
	} finally {
		await rm(dir, { recursive: true });
	}
});

test("AC:OPS-ATOMIC-001 AC:OPS-PLATFORM-001 required SQL consequences roll back together; replay retains one committed intent", async () => {
	const properties = (
		await runtime.execute(querySql`SELECT rolname,rolsuper,rolbypassrls FROM pg_roles WHERE rolname=current_user`)
	).rows[0];
	assert.deepEqual(properties, { rolname: role, rolsuper: false, rolbypassrls: false });
	await assert.rejects(runtime.execute(querySql`CREATE TABLE forbidden(id int)`), (e) => e.code === "42501");
	await assert.rejects(runtime.execute(querySql`SELECT * FROM auth_user`), (e) => e.code === "42501");
	const key = randomUUID(),
		receiptId = randomUUID();
	const writes = {
		facts: async (tx) => {
			await tx.execute(querySql`UPDATE document SET title='after' WHERE id=${doc} AND tenant_id=${tenant}`);
			return doc;
		},
		history: async (tx, id) => {
			await tx.execute(
				querySql`INSERT INTO event(tenant_id,target_record_id,actor_id,kind,occurred_at,recorded_at,event_key,action) VALUES(${tenant},${id},${actor},'edit',clock_timestamp(),clock_timestamp(),${key},'documents.saved') ON CONFLICT(target_record_id,event_key) DO NOTHING`,
			);
		},
		receipt: async (tx) => {
			await tx.execute(
				querySql`INSERT INTO operation(id,tenant_id,actor_id,name,request_key,request_digest,state,outcome,started_at,completed_at,tool_calls,reserved_input,reserved_output,used_input,used_output) VALUES(${receiptId},${tenant},${actor},'domain.executeAtomicConsequences',${key},${"a".repeat(64)},'complete','committed',clock_timestamp(),clock_timestamp(),0,0,0,0,0) ON CONFLICT(tenant_id,request_key) DO NOTHING`,
			);
		},
		intents: async (tx, id) => {
			await enqueueJob(tx, {
				tenant,
				kind: "document_render",
				subject: id,
				key,
				revision: "1",
				eligibleAt: new Date().toISOString(),
			});
		},
	};
	for (const slot of ["history", "receipt", "intents"]) {
		await assert.rejects(
			executeAtomicConsequences(runtime, async () => {}, {
				...writes,
				[slot]: async () => {
					throw Error("required_writer_fault");
				},
			}),
			/required_writer_fault/,
		);
		assert.equal((await admin.execute(querySql`SELECT title FROM document WHERE id=${doc}`)).rows[0].title, "before");
		assert.equal(
			(await admin.execute(querySql`SELECT count(*)::int n FROM event WHERE target_record_id=${doc}`)).rows[0].n,
			0,
		);
		assert.equal(
			(await admin.execute(querySql`SELECT count(*)::int n FROM job WHERE subject_record_id=${doc}`)).rows[0].n,
			0,
		);
		assert.equal(
			(await admin.execute(querySql`SELECT count(*)::int n FROM operation WHERE id=${receiptId}`)).rows[0].n,
			0,
		);
	}
	const authorize = async (tx) => {
		const r = await tx.execute(querySql`SELECT id FROM document WHERE id=${doc} AND tenant_id=${tenant} FOR UPDATE`);
		assert.equal(r.rowCount, 1);
	};
	const telemetry = createTelemetry(
		telemetryConfig({ endpoint: "http://127.0.0.1:1/unreachable", token: "a".repeat(32), timeoutMs: 10 }),
	);
	assert.equal(
		await traceOperation(
			telemetry,
			{ operation: "documents.generate", correlation: randomUUID(), build: "a".repeat(40) },
			() => executeAtomicConsequences(runtime, authorize, writes),
		),
		doc,
	);
	assert.equal(await executeAtomicConsequences(runtime, authorize, writes), doc);
	assert.deepEqual((await admin.execute(querySql`SELECT title FROM document WHERE id=${doc}`)).rows, [
		{ title: "after" },
	]);
	assert.equal(
		(await admin.execute(querySql`SELECT count(*)::int n FROM event WHERE target_record_id=${doc}`)).rows[0].n,
		1,
	);
	assert.deepEqual(
		(await admin.execute(querySql`SELECT kind,state,producer_key FROM job WHERE subject_record_id=${doc}`)).rows,
		[{ kind: "document_render", state: "ready", producer_key: key }],
	);
	assert.deepEqual((await admin.execute(querySql`SELECT id,state,outcome FROM operation WHERE id=${receiptId}`)).rows, [
		{ id: receiptId, state: "complete", outcome: "committed" },
	]);
});

test("INV-operator: exact fresh scope denies tenant roles, expired grants and foreign records; inspection is safe and audited atomically", async () => {
	const operations = ["ops.readiness", "jobs.inspectLag", "security.inspectAudit", "ops.errorCorrelation"];
	let allowed = true,
		scopeTenant = tenant;
	const authenticate = async (tx) => {
		await tx.execute(querySql`SELECT id FROM account WHERE id=${actor} FOR SHARE`);
		return allowed
			? {
					principal: actor,
					tenant: scopeTenant,
					purpose: "incident",
					operations,
					expiresAt: new Date(Date.now() + 60_000),
				}
			: null;
	};
	const ops = operatorOperations(runtime, authenticate);
	await admin.execute(querySql`UPDATE event SET reason='PRIVATE-CANARY',diff='{}' WHERE false`);
	const audit = await ops.inspectAudit({ target: doc });
	assert.equal(audit.length, 1);
	assert.deepEqual(Object.keys(audit[0]).sort(), [
		"action",
		"after_revision",
		"before_revision",
		"effect_id",
		"id",
		"occurred_at",
		"operation_id",
	]);
	assert.equal(audit[0].action, "documents.saved");
	assert.equal((await ops.inspectLag())[0].kind, "document_render");
	assert.deepEqual(
		(
			await admin.execute(
				querySql`SELECT action,count(*)::int n FROM event WHERE target_record_id=${tenant} GROUP BY action ORDER BY action`,
			)
		).rows,
		[
			{ action: "security.audit_inspected", n: 1 },
			{ action: "security.operator_accessed", n: 1 },
		],
	);
	scopeTenant = foreign;
	assert.deepEqual(await ops.inspectAudit({ target: doc }), []);
	assert.deepEqual(await ops.inspectLag(), []);
	allowed = false;
	await assert.rejects(ops.inspectAudit({ target: doc }), /unavailable/);
	const expired = operatorOperations(runtime, async () => ({
		principal: actor,
		tenant,
		purpose: "incident",
		operations,
		expiresAt: new Date(0),
	}));
	await assert.rejects(expired.inspectLag(), /unavailable/);
	const denied = operatorOperations(runtime, async () => ({
		principal: actor,
		tenant,
		purpose: "incident",
		operations: ["ops.readiness"],
		expiresAt: new Date(Date.now() + 60_000),
	}));
	await assert.rejects(denied.inspectLag(), /unavailable/);
});

test("AC:EXEC-001 INV-mount: authenticated bounded HTTP executor and raw signed callback remain separate from business authority", async () => {
	const secret = randomBytes(32).toString("hex"),
		callbackKey = randomBytes(32),
		callbackSecret = "whsec_" + callbackKey.toString("base64");
	const tick = mountExecutor({
		db: runtime,
		secret,
		limit: 1,
		handlers: { document_render: async () => ({ state: "succeeded" }) },
		publish: async (tx, claim) => {
			const current = await tx.execute(
				querySql`SELECT id FROM document WHERE tenant_id=${claim.tenant_id} AND id=${claim.subject_record_id} AND revision=${claim.source_revision} FOR SHARE`,
			);
			return current.rowCount === 1;
		},
	});
	const callback = mountCallback({ db: runtime, secret: callbackSecret });
	const server = createServer(async (req, res) => {
		try {
			const chunks = [];
			for await (const chunk of req) chunks.push(chunk);
			const raw = Buffer.concat(chunks);
			const request = new Request("http://127.0.0.1" + req.url, {
				method: req.method,
				headers: req.headers,
				...(raw.length ? { body: raw } : {}),
			});
			const result = await (req.url === "/tick" ? tick : callback)(request);
			res.writeHead(result.status, Object.fromEntries(result.headers));
			res.end(Buffer.from(await result.arrayBuffer()));
		} catch {
			res.writeHead(500);
			closeDatabase(res);
		}
	});
	server.listen(0, "127.0.0.1");
	await once(server, "listening");
	const url = "http://127.0.0.1:" + server.address().port;
	try {
		const states = (await admin.execute(querySql`SELECT id,state FROM job ORDER BY id`)).rows;
		for (const key of [null, "wrong"]) {
			const r = await fetch(url + "/tick", { method: "POST", headers: key ? { authorization: "Bearer " + key } : {} });
			assert.equal(r.status, 404);
		}
		assert.deepEqual((await admin.execute(querySql`SELECT id,state FROM job ORDER BY id`)).rows, states);
		const arbitrary = await fetch(url + "/tick", {
			method: "POST",
			headers: { authorization: "Bearer " + secret },
			body: JSON.stringify({ kind: "lifecycle_purge", tenant: foreign }),
		});
		assert.equal(arbitrary.status, 413);
		const r = await fetch(url + "/tick", { method: "POST", headers: { authorization: "Bearer " + secret } });
		assert.equal(r.status, 200);
		assert.deepEqual(await r.json(), { processed: 1 });
		assert.equal(
			(await admin.execute(querySql`SELECT state FROM job WHERE subject_record_id=${doc}`)).rows[0].state,
			"succeeded",
		);
		const signed = (type) => {
			const body = JSON.stringify({
					type,
					created_at: new Date().toISOString(),
					data: { email_id: randomUUID(), email: "PRIVATE-CANARY", body: "PRIVATE-CANARY" },
				}),
				id = randomUUID(),
				stamp = String(Math.floor(Date.now() / 1000));
			const signature = createHmac("sha256", callbackKey)
				.update(id + "." + stamp + "." + body)
				.digest("base64");
			return {
				method: "POST",
				body,
				headers: { "svix-id": id, "svix-timestamp": stamp, "svix-signature": "v1," + signature },
			};
		};
		const known = await fetch(url + "/callback", signed("email.delivered"));
		assert.equal(known.status, 200);
		assert.deepEqual(await known.json(), { stored: true, result: "unmatched" });
		const rows = (await admin.execute(querySql`SELECT kind,safe_payload FROM provider_event`)).rows;
		assert.deepEqual(rows, [{ kind: "delivered", safe_payload: { hard_bounce: false } }]);
		const unsupported = await fetch(url + "/callback", signed("email.failed"));
		assert.equal(unsupported.status, 503);
		const forged = signed("email.delivered");
		forged.headers["svix-signature"] = "v1,forged";
		assert.equal((await fetch(url + "/callback", forged)).status, 404);
		assert.equal((await admin.execute(querySql`SELECT count(*)::int n FROM provider_event`)).rows[0].n, 1);
		assert.equal(JSON.stringify(rows).includes("PRIVATE-CANARY"), false);
		assert.equal((await mountExecutor(null)(new Request(url + "/tick", { method: "POST" }))).status, 404);
		assert.equal((await mountCallback(null)(new Request(url + "/callback", { method: "POST" }))).status, 404);
	} finally {
		server.closeAllConnections();
		await new Promise((resolve) => server.close(resolve));
	}
});

test("AC:TARGET-IDN-004 fixture switching issues a real allowlisted synthetic session and refuses wrong environments and client authority", async () => {
	const appRequire = createRequire(new URL("../../../apps/web/package.json", import.meta.url));
	const { betterAuth } = await import(appRequire.resolve("better-auth"));
	const auth = betterAuth({
		database: admin,
		baseURL: "http://localhost",
		secret: randomBytes(32).toString("hex"),
		...authStorage,
		emailAndPassword: { enabled: true },
		advanced: { database: { generateId: () => randomUUID() } },
		logger: { disabled: true },
	});
	const email = randomUUID() + "@example.test",
		password = randomBytes(20).toString("hex"),
		account = randomUUID();
	const created = await auth.api.signUpEmail({ body: { email, name: "Fresh Synthetic Fixture", password } });
	await admin.execute(
		querySql`INSERT INTO account(id,auth_user_id,registration_state,registration_kind) VALUES(${account},${created.user.id},'active','planter')`,
	);
	const target = (
		await admin.execute(querySql`SELECT current_database() AS database,current_user AS role,current_schema() AS schema`)
	).rows[0];
	const c = {
		enabled: true,
		environment: "development",
		target,
		fixtures: { planter: { account, user: created.user.id, email, password } },
	};
	const switcher = createFixtureSwitcher(admin, c, (credentials) =>
		auth.api.signInEmail({ body: credentials, asResponse: true }),
	);
	const saved = Object.fromEntries(
		["EVERYFIELD_FIXTURES_ENABLED", "EVERYFIELD_ENVIRONMENT", "NODE_ENV", "VERCEL_ENV"].map((name) => [
			name,
			process.env[name],
		]),
	);
	const sessions = async () =>
		(await admin.execute(querySql`SELECT count(*)::int n FROM auth_session WHERE user_id=${created.user.id}`)).rows[0]
			.n;
	try {
		delete process.env.VERCEL_ENV;
		process.env.NODE_ENV = "development";
		process.env.EVERYFIELD_ENVIRONMENT = "development";
		delete process.env.EVERYFIELD_FIXTURES_ENABLED;
		const before = await sessions();
		assert.equal((await switcher({ fixture: "planter" })).status, 404);
		process.env.EVERYFIELD_FIXTURES_ENABLED = "1";
		for (const command of [
			{ fixture: "unknown" },
			{ fixture: "planter", role: "owner" },
			{ fixture: "planter", environment: "production" },
		])
			assert.equal((await switcher(command)).status, 404);
		process.env.EVERYFIELD_ENVIRONMENT = "preview";
		assert.equal((await switcher({ fixture: "planter" })).status, 404);
		process.env.EVERYFIELD_ENVIRONMENT = "development";
		process.env.NODE_ENV = "production";
		assert.equal((await switcher({ fixture: "planter" })).status, 404);
		process.env.NODE_ENV = "development";
		const wrong = createFixtureSwitcher(admin, { ...c, target: { ...target, database: "foreign" } }, (credentials) =>
			auth.api.signInEmail({ body: credentials, asResponse: true }),
		);
		assert.equal((await wrong({ fixture: "planter" })).status, 404);
		assert.equal(await sessions(), before);
		const response = await switcher({ fixture: "planter" });
		assert.equal(response.status, 200);
		assert.deepEqual(await response.json(), { switched: true });
		const cookie = response.headers
			.getSetCookie()
			.map((v) => v.split(";")[0])
			.join("; ");
		assert.ok(cookie.length > 0);
		const session = await auth.api.getSession({ headers: new Headers({ cookie }) });
		assert.equal(session.user.id, created.user.id);
		assert.equal(await sessions(), before + 1);
	} finally {
		for (const [name, value] of Object.entries(saved)) {
			if (value === undefined) delete process.env[name];
			else process.env[name] = value;
		}
	}
});
