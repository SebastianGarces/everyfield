import "../../platform/setup.mts";
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import test, { after } from "node:test";
import { nativeFromText } from "../../../../packages/contracts/src/documents/native.ts";
import { sql, type SQL } from "../../../../packages/db/src/query.ts";
import { RequestActor } from "../../../../packages/domain/src/access/session.ts";
import { documentsWriter } from "../../../../packages/domain/src/documents/index.ts";
import { registry } from "../../../../packages/domain/src/people/person-reference-registry/index.ts";
import { readiness } from "../../../../ops/maintenance/readiness.mts";
import { readCurrentManifest, restoreWithCurrentManifest } from "../../../../ops/maintenance/restore.mts";
import { fixture, ok, seeds, type Actor } from "../../../support/fixture.mts";
import { testDatabase } from "../../../support/test-database.mts";
import { failingWrite, touched } from "../../../support/recorded.mts";
import { dropTarget, objectStore, operator, snapshot } from "../sql/knowledge/support.mts";
import { accepts, schemaCase, type SchemaCase } from "./schema-probe.mts";

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const NOW = new Date(schemaCase("WP004-IDN-029").clock!.now);
const database = await fixture({ prefix: "baselinecases", plant: { name: "Harvest Point" }, clock: NOW });
const { admin } = database;
const db = database.pools.runtime;
const P = database.tenant;
const Q = await database.plant({ name: "Grace Hill", timezone: "America/New_York" });
after(() => database.close());

const one = async (query: SQL, pool = admin) => (await pool.execute(query)).rows[0] ?? assert.fail("no row");
const code = (error: unknown) => (error as { cause?: { code?: string } }).cause?.code;
const failure = (query: SQL, pool = admin) =>
	pool.execute(query).then(
		() => null,
		(error: unknown) => {
			const cause = (error as { cause?: { code?: string; constraint?: string; message?: string } }).cause;
			return { code: cause?.code, why: cause?.constraint ?? cause?.message };
		},
	);
const actorOf = async (who: Actor) => {
	const actor = await RequestActor.resolve(db, who.session);
	assert.ok(actor instanceof RequestActor, JSON.stringify(actor));
	return actor;
};
const sha = (text: string) => createHash("sha256").update(text).digest("hex");

const scoped = {
	authority: "explicit_scoped_operator",
	verified: true,
	operation_ids: ["ops.readiness"],
	environment: "isolated-test",
} as const;
const documented = (at: string) => ({
	cost_approval: { approved: true, approved_at: at, monthly_usd: { low: 0, expected: 0, high: 0 } },
	host_schedule: { host: "documented", schedule: "daily", verified_at: at },
	key_exclusion: { denied: { app: true, build: true, preview: true }, verified_at: at },
	coherent_restore: { live_recovery_proven: true, verified_at: at },
});
function gate(c: SchemaCase) {
	const { baseline } = c.given as { baseline: { customer_data: boolean; shared_development: boolean } };
	assert.deepEqual([baseline.customer_data, baseline.shared_development], [false, true]);
	const now = new Date(c.clock!.now);
	const report = readiness({ capability: scoped, evidence: {}, now });
	assert.equal(report.refusal, null);
	if (report.refusal !== null) assert.fail();
	const full = readiness({ capability: scoped, evidence: documented(c.clock!.now), now });
	if (full.refusal !== null) assert.fail();
	assert.deepEqual([full.missing, full.customer_data_gate, full.live_evidence_verified], [[], "blocked", false]);
	assert.equal(full.second_provider_gate, false);
	return {
		customer_data_gate: report.customer_data_gate === "blocked" ? "closed" : "open",
		provider_setup_performed: !report.missing.includes("cost_approval") || !report.missing.includes("host_schedule"),
		recovery_guarantee_claimed: report.live_evidence_verified || !report.missing.includes("coherent_restore"),
	};
}
const closed = (c: SchemaCase) =>
	assert.deepEqual(gate(c), {
		customer_data_gate: "closed",
		provider_setup_performed: false,
		recovery_guarantee_claimed: false,
	});

async function witness(
	account: string,
	state: string,
	{ requested = new Date(NOW.getTime() - 31 * DAY), purged = null as Date | null, expires = null as Date | null } = {},
) {
	const id = randomUUID();
	await admin.execute(sql`INSERT INTO lifecycle_witness(id,kind,opaque_subject_id,account_id,request_id,request_revision,state,
		witness_checkpoint,cleanup_state,requested_at,cancel_until,live_purged_at,copy_expires_at)
		VALUES(${id}::uuid,'account',${account}::uuid,${account}::uuid,${randomUUID()}::uuid,1,${state},1,
		${purged ? "confirmed" : "in_progress"},${requested.toISOString()}::timestamptz,
		${new Date(requested.getTime() + 30 * DAY).toISOString()}::timestamptz,${purged?.toISOString() ?? null}::timestamptz,
		${expires?.toISOString() ?? null}::timestamptz)`);
	return id;
}
async function file(tenant: string, state = "ready", purpose = "generated") {
	const id = randomUUID();
	const key = `private/${tenant}/${randomUUID()}`;
	await admin.execute(sql`INSERT INTO file_object(id,tenant_id,purpose,opaque_key,media_type,max_bytes,byte_count,sha256,state,
		upload_key,claim_generation) VALUES(${id}::uuid,${tenant}::uuid,${purpose},${key},'application/pdf',8388608,4,
		${sha(id)},${state},${"upload-" + id},0)`);
	return { id, key };
}
const fileRow = (tenant: string, key: string, columns: { state: string; sha?: string | null; bytes?: number | null }) =>
	sql`INSERT INTO file_object(tenant_id,purpose,opaque_key,media_type,max_bytes,byte_count,sha256,state,upload_key,
		claim_generation) VALUES(${tenant}::uuid,'generated',${key},'application/pdf',8388608,${columns.bytes ?? null},
		${columns.sha ?? null},${columns.state},${"upload-" + randomUUID()},0)`;

const recovery = await testDatabase({ prefix: "baselinerec", clock: NOW });
after(() => recovery.close());
const recovered = seeds(recovery.admin);
await recovered.actor(await recovered.plant({ name: "Harvest Point" }), "owner");
async function restoreOf(createdAt: Date, expiresAt?: Date) {
	const target = `${recovery.schema}_${randomUUID().slice(0, 8)}`;
	after(() => dropTarget(recovery.admin, target));
	const copy = await snapshot(recovery.admin, new Map(), { createdAt, expiresAt });
	return restoreWithCurrentManifest(
		{
			admin: recovery.admin,
			source: recovery.schema,
			targetSchema: target,
			objects: objectStore(new Map()),
			clock: () => NOW,
		},
		{ capability: operator, target: "isolated", snapshot: copy, current: () => readCurrentManifest(recovery.admin) },
	);
}
let rehearsal: Awaited<ReturnType<typeof restoreOf>> | null = null;
async function restoreOnce() {
	rehearsal ??= await restoreOf(new Date(NOW.getTime() - 2 * HOUR));
	assert.equal(rehearsal.restore_success, true, JSON.stringify(rehearsal));
	return rehearsal;
}

test("AC:WP004-IDN-029 one account holds one active seat and a lead planter title grants no access, in the migrated database", async () => {
	const c = schemaCase("WP004-IDN-029");
	const { result } = c.expected;
	assert.deepEqual(c.action.arguments.tables, ["seat", "account", "organization"]);
	const A = await database.actor(P, "admin");
	const N = await database.organization("sending_network");
	const seat = (where: { kind: string; id: string }, role = "admin", ended = false) =>
		sql`INSERT INTO seat(account_id,plant_id,organization_id,role,accepted_at,ended_at)
		VALUES(${A.id}::uuid,${where.kind === "plant" ? where.id : null}::uuid,${where.kind === "plant" ? null : where.id}::uuid,
		${role},clock_timestamp(),${ended ? sql`clock_timestamp()` : null})`;
	const active = async () =>
		Number((await one(sql`SELECT count(*)::int AS n FROM seat WHERE account_id=${A.id}::uuid AND ended_at IS NULL`)).n);
	assert.equal(await active(), 1);
	for (const where of [Q, N]) {
		assert.equal(await accepts(admin, seat(where)), result.second_active_seat_accepted);
		assert.deepEqual(await failure(seat(where)), { code: "23505", why: "seat_uq_0" });
		assert.equal(await accepts(admin, seat(where, "admin", true)), true);
	}
	assert.equal(c.action.arguments.active_seats_per_account, 2);
	assert.equal(await active(), 1);
	const unique = await one(
		sql`SELECT indexdef FROM pg_indexes WHERE schemaname=current_schema() AND indexname='seat_uq_0'`,
	);
	assert.match(
		String(unique.indexdef),
		/UNIQUE INDEX seat_uq_0 ON .*seat USING btree \(account_id\) WHERE \(ended_at IS NULL\)/,
	);

	for (const title of ["lead_planter", "lead", "planter"])
		assert.equal(await accepts(admin, seat(Q, title)), result.lead_title_grants_access);
	const titled = await admin.execute<{ table_name: string; column_name: string }>(
		sql`SELECT table_name,column_name FROM information_schema.columns WHERE table_schema=current_schema()
		AND table_name IN ('seat','account','organization') AND column_name ~ '(title|lead|ministry)'`,
	);
	assert.deepEqual(titled.rows, []);
	const M = await database.actor(P, "member");
	const person = randomUUID();
	await admin.execute(sql`INSERT INTO person(id,tenant_id,plant_id,display_name,source,stage,adult_classification,
		commitment_state,pipeline_position,state,created_at,linked_account_id) VALUES(${person}::uuid,${P.id}::uuid,${P.id}::uuid,
		'Morgan Lead','other','leader','adult','active',0,'live',clock_timestamp(),${M.id}::uuid)`);
	const team = randomUUID(),
		role = randomUUID();
	await admin.execute(
		sql`INSERT INTO team(id,plant_id,name,state,sort_order) VALUES(${team}::uuid,${P.id}::uuid,'Leadership','active',0)`,
	);
	await admin.execute(sql`INSERT INTO team_role(id,plant_id,team_id,name,leadership,sort_order)
		VALUES(${role}::uuid,${P.id}::uuid,${team}::uuid,'Lead Planter',true,0)`);
	await admin.execute(sql`INSERT INTO team_tenure(plant_id,role_id,person_id,started_on)
		VALUES(${P.id}::uuid,${role}::uuid,${person}::uuid,'2026-10-01')`);
	await admin.execute(sql`UPDATE team SET leader_person_id=${person}::uuid,leader_source='role_derived',leader_role_id=${role}::uuid
		WHERE id=${team}::uuid`);
	const resolved = await actorOf(M);
	assert.equal(resolved.actor.context.kind, "seat");
	if (resolved.actor.context.kind !== "seat") assert.fail();
	assert.equal(resolved.actor.context.role !== "member", result.lead_title_grants_access);
	const roles = await one(sql`SELECT array_agg(role ORDER BY role) AS roles FROM seat WHERE account_id=${M.id}::uuid`);
	assert.deepEqual(roles.roles, ["member"]);
	closed(c);
	assert.equal(c.expected.event, null);
});

test("AC:WP004-KNOW-069 an account purge leaves a church document copied from it, and the copy's source key refuses removal until the purge detaches it", async () => {
	const c = schemaCase("WP004-KNOW-069");
	const { result } = c.expected;
	assert.deepEqual(c.action.arguments, { private_owner: "A", shared_owner: "P", delete_account: "A" });
	const A = await database.actor(P, "admin");
	const reader = await database.actor(P, "admin");
	const endSeat = () =>
		admin.execute(sql`UPDATE seat SET ended_at=clock_timestamp() WHERE account_id=${A.id}::uuid AND ended_at IS NULL`);
	await endSeat();
	const own = ok(
		await documentsWriter.saveNative(db, await actorOf(A), {
			title: "Personal values",
			body: nativeFromText("We serve our community."),
			expectedRevision: "0",
		}),
	);
	assert.equal(own.tenantId, A.id);
	const source = await one(sql`SELECT current_revision_id AS id FROM document WHERE id=${own.id}::uuid`);
	await admin.execute(sql`UPDATE seat SET ended_at=NULL WHERE account_id=${A.id}::uuid AND plant_id=${P.id}::uuid`);
	const copy = ok(
		await documentsWriter.useForChurch(db, await actorOf(A), {
			documentId: own.id,
			revisionId: String(source.id),
			requestKey: randomUUID(),
		}),
	);
	assert.deepEqual([copy.tenantId, copy.copiedFromRevisionId], [P.id, source.id]);

	const key = await one(sql`SELECT c.conname,c.confdeltype,c.confrelid::regclass::text AS target FROM pg_constraint c
		JOIN pg_attribute a ON a.attrelid=c.conrelid AND a.attnum=c.conkey[1]
		WHERE c.conrelid='document'::regclass AND c.contype='f' AND a.attname='copied_from_revision_id'`);
	assert.deepEqual([key.confdeltype, String(key.target).replace(/^.*\./, "")], ["r", "document_revision"]);
	const removed = await admin
		.transaction(async (tx) => {
			await tx.execute(sql`SET CONSTRAINTS ALL IMMEDIATE`);
			await tx.execute(sql`UPDATE document SET current_revision_id=NULL WHERE tenant_id=${A.id}::uuid`);
			await tx.execute(sql`DELETE FROM document_revision WHERE tenant_id=${A.id}::uuid`);
			await tx.execute(sql`DELETE FROM document WHERE tenant_id=${A.id}::uuid`);
			return null;
		})
		.then(
			() => assert.fail("the source revision was removed with the copy still naming it"),
			(error: unknown) => (error as { cause?: { code?: string; constraint?: string } }).cause,
		);
	assert.equal(
		removed?.code === "23001" && removed.constraint === key.conname,
		result.source_fk_requires_explicit_detach,
		JSON.stringify(removed),
	);
	assert.equal((await one(sql`SELECT count(*)::int AS n FROM document_revision WHERE tenant_id=${A.id}::uuid`)).n, 1);

	await endSeat();
	const witnessId = await witness(A.id, "purging");
	const purged = ok(await documentsWriter.purgeOwnedForDeletion(db, { witnessId }));
	assert.ok(purged.removed >= 1);
	const left = await one(sql`SELECT (SELECT count(*)::int FROM document WHERE tenant_id=${A.id}::uuid) AS own,
		(SELECT count(*)::int FROM document_revision WHERE tenant_id=${A.id}::uuid) AS revisions`);
	assert.deepEqual([left.own, left.revisions], [0, 0]);
	const survivor = await documentsWriter.read(db, await actorOf(reader), { documentId: copy.id });
	assert.equal(survivor.status === "ok", result.shared_document_survives);
	const shared = ok(survivor);
	assert.deepEqual([shared.body, shared.copiedFromRevisionId], [nativeFromText("We serve our community."), null]);
	closed(c);
	assert.equal(c.expected.event, null);
});

test("AC:WP004-KNOW-072 a purge in progress whose file cleanup failed keeps no completion time, and the account has no normal access", async () => {
	const c = schemaCase("WP004-KNOW-072");
	const { result } = c.expected;
	assert.deepEqual(c.action.arguments, { purge_state: "purging", provider_cleanup: "failed" });
	const A = await database.actor(P, "admin");
	await actorOf(A);
	const id = await witness(A.id, String(c.action.arguments.purge_state));
	const done = new Date(NOW.getTime() - HOUR).toISOString();
	assert.equal(
		await accepts(admin, sql`UPDATE lifecycle_witness SET live_purged_at=${done}::timestamptz WHERE id=${id}::uuid`),
		false,
	);
	assert.equal(
		await accepts(
			admin,
			sql`UPDATE lifecycle_witness SET live_purged_at=${done}::timestamptz,cleanup_state='confirmed' WHERE id=${id}::uuid`,
		),
		false,
	);
	assert.equal(await accepts(admin, sql`UPDATE lifecycle_witness SET state='purged' WHERE id=${id}::uuid`), false);
	assert.equal(
		await accepts(admin, sql`UPDATE lifecycle_witness SET cleanup_state='inaccessible' WHERE id=${id}::uuid`),
		true,
	);
	const row = await one(sql`SELECT state,cleanup_state,live_purged_at FROM lifecycle_witness WHERE id=${id}::uuid`);
	assert.deepEqual([row.state, row.cleanup_state], ["purging", "in_progress"]);
	assert.equal(row.live_purged_at, result.live_purged_at);
	const resolved = await RequestActor.resolve(db, A.session);
	assert.equal(resolved instanceof RequestActor, result.normal_access);
	closed(c);
	assert.equal(c.expected.event, null);
});

test("AC:WP004-KNOW-073 a recovery copy expires no later than seven days after the purge, a recopy cannot push it later, and a purged request cannot be cancelled", async () => {
	const c = schemaCase("WP004-KNOW-073");
	const { result } = c.expected;
	const args = c.action.arguments as { live_purged_at: string; copy_expires_at: string; recopy_at: string };
	const purged = new Date(args.live_purged_at);
	const requested = new Date(purged.getTime() - 31 * DAY);
	const A = await database.actor(P, "admin");
	const late = await database.actor(P, "admin");
	const beyond = new Date(purged.getTime() + 7 * DAY + 1000);
	await assert.rejects(
		witness(late.id, "purged", { requested, purged, expires: beyond }),
		(error) => code(error) === "23514",
	);
	const id = await witness(A.id, "purged", { requested, purged, expires: new Date(args.copy_expires_at) });
	const recopy = new Date(new Date(args.recopy_at).getTime() + 7 * DAY).toISOString();
	assert.deepEqual(
		await failure(sql`UPDATE lifecycle_witness SET copy_expires_at=${recopy}::timestamptz WHERE id=${id}::uuid`),
		{
			code: "23514",
			why: "immutable_lifecycle_clock",
		},
	);
	assert.equal(
		await accepts(admin, sql`UPDATE lifecycle_witness SET copy_expires_at=NULL WHERE id=${id}::uuid`),
		false,
	);
	assert.equal(
		await accepts(
			admin,
			sql`UPDATE lifecycle_witness SET live_purged_at=${args.recopy_at}::timestamptz WHERE id=${id}::uuid`,
		),
		false,
	);
	const row = await one(sql`SELECT copy_expires_at FROM lifecycle_witness WHERE id=${id}::uuid`);
	assert.equal(new Date(row.copy_expires_at as string).toISOString().replace(".000Z", "Z"), result.copy_expires_at);
	for (const at of [args.recopy_at, args.live_purged_at])
		assert.equal(
			await accepts(
				admin,
				sql`UPDATE lifecycle_witness SET state='cancelled',cancelled_at=${at}::timestamptz,live_purged_at=NULL,copy_expires_at=NULL
				WHERE id=${id}::uuid`,
			),
			result.cancellation_allowed,
		);
	assert.equal(
		await accepts(
			admin,
			sql`UPDATE lifecycle_witness SET state='cancelled',cancelled_at=${args.recopy_at}::timestamptz WHERE id=${id}::uuid`,
		),
		result.cancellation_allowed,
	);
	closed(c);
	assert.equal(c.expected.event, null);
});

test("AC:WP004-KNOW-078 the runtime login cannot create a table or change or delete a history row, and a fault before commit leaves no domain write", async () => {
	const c = schemaCase("WP004-KNOW-078");
	const { result } = c.expected;
	const args = c.action.arguments as { runtime_role: string; attempts: string[]; transaction_fault: string };
	const member = await one(
		sql`SELECT pg_has_role(current_user,${args.runtime_role},'MEMBER') AS member,
		has_schema_privilege(current_user,current_schema(),'CREATE') AS creates,
		has_table_privilege(current_user,'audit_event','UPDATE') AS updates,
		has_table_privilege(current_user,'audit_event','DELETE') AS deletes,
		has_table_privilege(current_user,'audit_event','INSERT') AS appends`,
		db,
	);
	assert.deepEqual(member, { member: true, creates: false, updates: false, deletes: false, appends: true });
	const statements: Record<string, string> = {
		"CREATE TABLE": "CREATE TABLE baseline_probe(id int)",
		"UPDATE event": "UPDATE audit_event SET kind='edit'",
		"DELETE event": "DELETE FROM audit_event",
	};
	const before = await one(sql`SELECT count(*)::int AS n FROM audit_event`);
	const allowed = [];
	for (const attempt of args.attempts) {
		const statement = statements[attempt] ?? assert.fail(attempt);
		const refused = await failure(sql.raw(statement), db);
		assert.equal(refused?.code ?? "accepted", refused ? "42501" : "accepted", attempt);
		allowed.push(refused === null);
	}
	assert.deepEqual(allowed, result.allowed);
	assert.deepEqual(await one(sql`SELECT count(*)::int AS n FROM audit_event`), before);
	assert.equal((await one(sql`SELECT to_regclass('baseline_probe') IS NULL AS missing`)).missing, true);

	assert.equal(args.transaction_fault, "before_commit");
	const A = await database.actor(P, "admin");
	const save = async () =>
		documentsWriter.saveNative(db, await actorOf(A), {
			title: "Runtime grants",
			body: nativeFromText("Ours."),
			expectedRevision: "0",
		});
	const { value, tables } = await touched(admin, () =>
		failingWrite(admin, { on: "audit_event", event: "INSERT", atCommit: true }, () =>
			save().then(
				(reply) => reply.status,
				() => "rejected",
			),
		),
	);
	assert.notEqual(value, "ok");
	assert.equal(tables.length, result.domain_writes_after_fault, tables.join());
	ok(await save());
	closed(c);
	assert.equal(c.expected.event, null);
});

test("AC:WP004-PPL-024 every Person foreign key and every frozen Person reference is registered, and the registry is code, not a runtime table", async () => {
	const c = schemaCase("WP004-PPL-024");
	const { result } = c.expected;
	assert.deepEqual(c.action.arguments, { enumerate_person_foreign_keys: true, include_frozen_references: true });
	const declared = await admin.execute<{ t: string; col: string }>(
		sql`SELECT c.conrelid::regclass::text AS t,a.attname AS col FROM pg_constraint c
		JOIN LATERAL unnest(c.conkey) WITH ORDINALITY k(n,i) ON k.i=1 JOIN pg_attribute a ON a.attrelid=c.conrelid AND a.attnum=k.n
		WHERE c.contype='f' AND c.confrelid='person'::regclass`,
	);
	const registered = new Set(registry.map((e) => `${e.table}.${e.column}`));
	const keys = declared.rows.map((d) => `${d.t.replace(/^.*\./, "")}.${d.col}`);
	assert.ok(keys.length >= 30, String(keys.length));
	const policies = JSON.parse(
		readFileSync(new URL("../../../../docs/architecture/person-references.json", import.meta.url), "utf8"),
	) as {
		person_references: { table: string; columns: string[] }[];
		person_snapshot_references: { table: string; field: string }[];
	};
	const columns = new Set(
		(
			await admin.execute<{ k: string }>(
				sql`SELECT table_name||'.'||column_name AS k FROM information_schema.columns WHERE table_schema=current_schema()`,
			)
		).rows.map((r) => r.k),
	);
	const frozen = policies.person_snapshot_references.flatMap((r) => r.field.split("/").map((f) => `${r.table}.${f}`));
	assert.ok(frozen.length > 0);
	const documented = new Set(policies.person_references.map((r) => `${r.table}.${r.columns[0]}`));
	const missing = [
		...keys.filter((k) => !registered.has(k)),
		...[...registered].filter((k) => !keys.includes(k)),
		...keys.filter((k) => !documented.has(k)),
		...frozen.filter((k) => !columns.has(k)),
		...frozen.filter((k) => keys.includes(k)),
	];
	assert.deepEqual(missing, result.missing_registrations);
	const tables = await admin.execute<{ table_name: string }>(
		sql`SELECT table_name FROM information_schema.tables WHERE table_schema=current_schema()
		AND (table_name ~ '(registry|registration|reference_policy)'
			OR table_name IN (SELECT table_name FROM information_schema.columns WHERE table_schema=current_schema()
				AND column_name IN ('treatment','referenced_table','referencing_column')))`,
	);
	assert.equal(tables.rows.length > 0, result.runtime_registry_table, JSON.stringify(tables.rows));
	closed(c);
	assert.equal(c.expected.event, null);
});

type Probe = (c: SchemaCase) => Promise<void>;
const probes: Record<string, Probe> = {
	"WP004-KNOW-012": async () => {
		const A = await database.actor(P, "admin");
		const purged = new Date(NOW.getTime() - DAY);
		const requested = new Date(purged.getTime() - 31 * DAY);
		await assert.rejects(
			witness(A.id, "purged", { requested, purged, expires: new Date(purged.getTime() + 8 * DAY) }),
			(error) => code(error) === "23514",
		);
		const id = await witness(A.id, "purged", { requested, purged, expires: new Date(purged.getTime() + 7 * DAY) });
		assert.deepEqual(
			await failure(
				sql`UPDATE lifecycle_witness SET copy_expires_at=copy_expires_at+interval '1 day' WHERE id=${id}::uuid`,
			),
			{ code: "23514", why: "immutable_lifecycle_clock" },
		);
		for (const reset of [sql`copy_expires_at=NULL`, sql`copy_expires_at=clock_timestamp()+interval '7 days'`])
			assert.deepEqual(await failure(sql`UPDATE lifecycle_witness SET ${reset} WHERE id=${id}::uuid`, db), {
				code: "23514",
				why: "immutable_lifecycle_clock",
			});
	},
	"WP004-KNOW-014": async () => {
		for (const table of ["auth_account", "schema_migration"]) {
			const read = await failure(sql.raw(`SELECT * FROM ${table} LIMIT 1`), db);
			assert.equal(read?.code, "42501", table);
		}
		const secrets = await admin.execute(
			sql`SELECT table_name,column_name FROM information_schema.columns WHERE table_schema=current_schema()
			AND column_name ~ '(backup|bucket|access_key|secret_key)'`,
		);
		assert.deepEqual(secrets.rows, []);
	},
	"WP004-KNOW-081": async () => {
		const foreign = await failure(fileRow(P.id, `private/${Q.id}/${randomUUID()}`, { state: "pending" }));
		assert.deepEqual(foreign, { code: "23514", why: "private_key_owner" });
		const open = await failure(fileRow(P.id, `public/${P.id}/${randomUUID()}`, { state: "pending" }));
		assert.equal(open?.code, "23514");
		assert.equal(await accepts(admin, fileRow(P.id, `private/${P.id}/${randomUUID()}`, { state: "pending" })), true);
		const A = await database.actor(P, "admin");
		const theirs = await file(P.id, "ready", "avatar");
		const mine = await file(A.id, "ready", "avatar");
		assert.equal(
			await accepts(admin, sql`UPDATE account SET avatar_object_id=${theirs.id}::uuid WHERE id=${A.id}::uuid`),
			false,
		);
		assert.equal(
			await accepts(admin, sql`UPDATE account SET avatar_object_id=${mine.id}::uuid WHERE id=${A.id}::uuid`),
			true,
		);
	},
	"WP004-KNOW-082": async () => {
		const paid = await admin.execute(
			sql`SELECT table_name,column_name FROM information_schema.columns WHERE table_schema=current_schema()
			AND (table_name ~ '(billing|subscription|invoice|pricing|paid_plan|cost_approval)'
				OR column_name ~ '(billing|monthly_usd|price|paid_plan|cost_approval|plan_tier)')`,
		);
		assert.deepEqual(paid.rows, []);
	},
	"WP004-KNOW-083": async () => {
		const key = () => `private/${P.id}/${randomUUID()}`;
		assert.equal(await accepts(admin, fileRow(P.id, key(), { state: "ready", bytes: 4 })), false);
		assert.equal(await accepts(admin, fileRow(P.id, key(), { state: "ready", sha: sha("x") })), false);
		assert.equal(await accepts(admin, fileRow(P.id, key(), { state: "ready", bytes: 4, sha: "NOT-A-DIGEST" })), false);
		assert.equal(await accepts(admin, fileRow(P.id, key(), { state: "ready", bytes: 4, sha: sha("x") })), true);
		const restored = await restoreOnce();
		assert.deepEqual([restored.service_opened, restored.customer_data_gate], [false, "blocked"]);
	},
	"WP004-KNOW-084": async () => {
		const stale = await restoreOf(new Date(NOW.getTime() - 8 * DAY), new Date(NOW.getTime() - DAY));
		assert.deepEqual([stale.restore_success, stale.refusal], [false, "copy_expired_or_invalid"]);
		const kept = await restoreOf(new Date(NOW.getTime() - 8 * DAY), new Date(NOW.getTime() + 30 * DAY));
		assert.deepEqual([kept.restore_success, kept.refusal], [false, "copy_expired_or_invalid"]);
	},
	"WP004-KNOW-085": async () => {
		const gone = await file(P.id, "ready");
		assert.equal(await accepts(admin, sql`UPDATE file_object SET state='purged' WHERE id=${gone.id}::uuid`), false);
		await admin.execute(sql`UPDATE file_object SET state='cleanup' WHERE id=${gone.id}::uuid`);
		await admin.execute(
			sql`UPDATE file_object SET state='purged',purged_at=clock_timestamp() WHERE id=${gone.id}::uuid`,
		);
		for (const state of ["ready", "cleanup", "pending"])
			assert.deepEqual(await failure(sql`UPDATE file_object SET state=${state} WHERE id=${gone.id}::uuid`), {
				code: "23514",
				why: "immutable_file_identity",
			});
	},
	"WP004-KNOW-086": async () => {
		const kept = await file(P.id, "ready");
		for (const change of [
			sql`sha256=${sha("replaced")}`,
			sql`byte_count=5`,
			sql`opaque_key=${`private/${P.id}/${randomUUID()}`}`,
		])
			assert.equal(await accepts(admin, sql`UPDATE file_object SET ${change} WHERE id=${kept.id}::uuid`), false);
		const restored = await restoreOnce();
		assert.equal(restored.observed_loss_hours, null);
		assert.equal(restored.internal_target_met, false);
	},
	"WP004-KNOW-087": async () => {
		const restored = await restoreOnce();
		assert.deepEqual(
			[
				restored.guaranteed_disaster_RTO,
				restored.customer_SLA,
				restored.observed_restore_hours,
				restored.internal_target_met,
			],
			[null, null, null, false],
		);
	},
	"WP004-KNOW-088": async () => {
		const old = await restoreOf(new Date(NOW.getTime() - 25 * HOUR));
		assert.deepEqual([old.restore_success, old.daily_fallback_eligible], [true, false]);
		const fresh = await restoreOnce();
		assert.equal(fresh.daily_fallback_eligible, true);
		for (const r of [old, fresh]) assert.deepEqual([r.guaranteed_disaster_RTO, r.customer_SLA], [null, null]);
	},
	"WP004-KNOW-089": async () => {
		const mail = (state: string, logical: string) =>
			sql`INSERT INTO mail(tenant_id,purpose,logical_key,payload_hash,audience_hash,state,created_at)
			VALUES(${P.id}::uuid,'notification',${logical},${sha("payload")},${sha("audience")},${state},clock_timestamp())`;
		const logical = `baseline/${randomUUID()}`;
		await admin.execute(mail("accepted", logical));
		for (const state of ["accepted", "unknown", "sent"])
			assert.deepEqual(await failure(mail(state, logical)), { code: "23505", why: "mail_uq_0" });
		assert.equal(await accepts(admin, mail("accepted", `baseline/${randomUUID()}`)), true);
		const restored = await restoreOnce();
		assert.equal(restored.service_opened, false);
	},
};

test("AC:WP004-KNOW-012 AC:WP004-KNOW-014 AC:WP004-KNOW-081 AC:WP004-KNOW-082 AC:WP004-KNOW-083 AC:WP004-KNOW-084 AC:WP004-KNOW-085 AC:WP004-KNOW-086 AC:WP004-KNOW-087 AC:WP004-KNOW-088 AC:WP004-KNOW-089 each producer baseline holds its constraint in the migrated database while the customer-data gate stays closed and nothing claims provider setup or recovery", async (t) => {
	for (const id of Object.keys(probes)) {
		const c = schemaCase(id);
		await t.test(id, async () => {
			assert.equal(c.action.operation, "sql.inspectConstraints");
			assert.deepEqual(c.action.arguments, {
				requirement: id.replace("WP004-", "REQ-"),
				customer_data: false,
				paid_setup_approved: false,
				recovery_setup_verified: false,
			});
			await probes[id]!(c);
			assert.deepEqual(gate(c), c.expected.result);
			assert.deepEqual(c.expected.state, {});
			assert.equal(c.expected.event, null);
		});
	}
});
