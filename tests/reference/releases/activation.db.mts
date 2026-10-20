import { createDatabase, closeDatabase } from "../../../packages/db/src/client.ts";
import { sql as querySql } from "../../../packages/db/node_modules/drizzle-orm/index.js";
import test, { before, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { migrate } from "../../../packages/db/src/schema/migrate.ts";
import { referenceService, ReferenceRefusal } from "../../../packages/reference/src/server.ts";
import type { ReferenceAuthority, ReferenceDependencies } from "../../../packages/reference/src/server.ts";
import { promotion } from "../../../packages/contracts/src/reference/release.ts";
import type { Promotion } from "../../../packages/contracts/src/reference/release.ts";
import { hash, canonical } from "../../../packages/reference/src/hash.ts";
import { fixture } from "./fixtures.mts";

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
	throw Error("Only shared development or disposable CI endpoint permitted");
if (!localCi) source.searchParams.set("sslmode", "verify-full");
const schema = "wp032_test_" + randomUUID().replaceAll("-", "");
const db = createDatabase({
	connectionString: source.href,
	max: 6,
	options: `-c search_path=${schema},pg_catalog,pg_temp`,
});
const actor = randomUUID(),
	user = randomUUID(),
	session = randomUUID(),
	job = randomUUID(),
	plant = randomUUID();
const global = "00000000-0000-0000-0000-000000000000";
const artifacts = new Map<string, unknown>();
const reviews = new Map<string, { actorId: string; review: ReferenceAuthority["review"] }>();
let firstCommand: Promotion;
let claim: Extract<ReferenceAuthority, { mode: "worker" }>["claim"] | undefined;
const authorize: ReferenceDependencies["authorize"] = async (tx, command) => {
	const saved = reviews.get(command.requestKey);
	if (!saved) return null;
	const live = await tx.execute(
		querySql`SELECT id FROM auth_session WHERE id=${querySql.param(session)} AND user_id=${querySql.param(user)} AND expires_at>clock_timestamp() FOR SHARE`,
	);
	return live.rowCount === 1 ? { ...saved, ...(claim ? { mode: "worker", claim } : { mode: "operator" }) } : null;
};
const service = referenceService(db, {
	authorize,
	loadArtifact: async (locator) => artifacts.get(locator),
	policyFor: (key) => fixture(key).policy,
});
function command(key: string, expected: string, kind: "activate" | "rollback" = "activate"): Promotion {
	const f = fixture(key);
	artifacts.set(key, f.bundle);
	const cmd = promotion.parse({
		kind,
		generationKey: key,
		manifestHash: f.manifestHash,
		expectedActivation: expected,
		requestKey: randomUUID(),
		reason: "Synthetic reviewed reference proof",
	});
	reviews.set(cmd.requestKey, {
		actorId: actor,
		review: {
			commandDigest: hash(canonical(cmd)),
			approvalHash: hash("synthetic-reviewed:" + f.manifestHash),
			approvalLocator: "synthetic-review:" + cmd.requestKey,
		},
	});
	return cmd;
}
async function counts() {
	return (
		await db.execute(querySql`SELECT (SELECT count(*)::int FROM reference_activation) AS activations,
    (SELECT count(*)::int FROM reference_release) AS releases,(SELECT count(*)::int FROM audit_event) AS operations,
    (SELECT count(*)::int FROM audit_event) AS events`)
	).rows[0];
}
async function refused(cmd: Promotion, code: string) {
	await assert.rejects(
		service.promote(cmd, cmd.generationKey),
		(e) => e instanceof ReferenceRefusal && e.code === code,
	);
}
before(async () => {
	await db.execute(querySql.raw(`CREATE SCHEMA ${schema}`));
	await migrate(db, schema);
	await db.execute(
		querySql`INSERT INTO auth_user(id,email,email_verified,name) VALUES(${querySql.param(user)},${querySql.param(user + "@example.test")},true,'Synthetic')`,
	);
	await db.execute(
		querySql`INSERT INTO account(id,auth_user_id,registration_state,registration_kind) VALUES(${querySql.param(actor)},${querySql.param(user)},'active','discovery')`,
	);
	await db.execute(
		querySql`INSERT INTO auth_session(id,user_id,token,expires_at) VALUES(${querySql.param(session)},${querySql.param(user)},${querySql.param(randomUUID())},now()+interval '1 hour')`,
	);
	await db.execute(
		querySql`INSERT INTO platform_grant(account_id,capability) VALUES(${querySql.param(actor)},'reference_publish')`,
	);
	await db.execute(querySql`INSERT INTO plant(id,name,timezone,warning_days,alert_days,digest_weekday,digest_hour,phase,material_revision)
    VALUES(${querySql.param(plant)},'Synthetic existing plant','America/Chicago',7,14,1,8,1,1)`);
	await db.execute(querySql`INSERT INTO task(plant_id,title,category,priority,status,created_at,due_kind)
    VALUES(${querySql.param(plant)},'Keep edited title','launch_prep','medium','in_progress',now(),'undated')`);
	await db.execute(querySql`INSERT INTO job(id,tenant_id,kind,producer_key,state,eligible_at,attempt_count,max_attempts,lease_owner,lease_until,claim_generation)
    VALUES(${querySql.param(job)},${querySql.param(global)},'reference_generation','sweep','claimed',now(),1,3,'synthetic-worker',now()+interval '5 minutes',2)`);
});
after(async () => {
	await db.execute(querySql.raw(`DROP SCHEMA IF EXISTS ${schema} CASCADE`));
	await closeDatabase(db);
});

test("AC:REFREL-001 initial install, exact replay and changed immutable hash refuse without rewriting originals", async () => {
	const cmd = command("R1", "0");
	firstCommand = cmd;
	const first = await service.promote(cmd, "R1");
	assert.equal(first.number, "1");
	assert.deepEqual(await counts(), { activations: 1, releases: 1, operations: 1, events: 1 });
	assert.deepEqual(await service.promote(cmd, "R1"), { ...first, replayed: true });
	const noOp = await service.promote(command("R1", "1"), "R1");
	assert.equal(noOp.activationId, first.activationId);
	assert.deepEqual(await counts(), { activations: 1, releases: 1, operations: 2, events: 2 });
	const forged = { ...cmd, reason: "changed" };
	await refused(forged, "access_denied");
	reviews.get(cmd.requestKey)!.review.commandDigest = hash(canonical(forged));
	await refused(forged, "idempotency_conflict");
	reviews.get(cmd.requestKey)!.review.commandDigest = hash(canonical(cmd));
	const changed = structuredClone(fixture("R1").bundle);
	changed.passages[0]!.embedding = [1, 2, 3];
	const { vectorHash } = await import("../../../packages/reference/src/hash.ts");
	changed.passages[0]!.embeddingChecksum = vectorHash([1, 2, 3]);
	const conflict = command("R1", "1");
	conflict.manifestHash = hash(canonical(changed));
	artifacts.set("R1", changed);
	reviews.get(conflict.requestKey)!.review.commandDigest = hash(canonical(conflict));
	await refused(conflict, "immutable_conflict");
	artifacts.set("R1", fixture("R1").bundle);
	const wrongCatalog = structuredClone(fixture("R1").bundle);
	wrongCatalog.catalogSha256 = "0".repeat(64);
	const mismatch = command("R1", "1");
	mismatch.manifestHash = hash(canonical(wrongCatalog));
	artifacts.set("R1", wrongCatalog);
	reviews.get(mismatch.requestKey)!.review.commandDigest = hash(canonical(mismatch));
	await refused(mismatch, "invalid_generation");
	artifacts.set("R1", fixture("R1").bundle);
	assert.deepEqual(await counts(), { activations: 1, releases: 1, operations: 2, events: 2 });
	const published = await db.execute(
		querySql`SELECT count(*)::int AS n FROM article_revision a JOIN reference_activation r ON r.release_id=a.release_id WHERE r.activation_number=1`,
	);
	assert.equal(published.rows[0]!.n, 96);
	const mail = await db.execute(querySql`SELECT count(*)::int AS n FROM reference_item WHERE kind='mail_template'`);
	assert.equal(mail.rows[0]!.n, 7);
	const sideEffects = await db.execute(
		querySql`SELECT (SELECT count(*)::int FROM message_template) AS forks,(SELECT count(*)::int FROM mail) AS mail,(SELECT count(*)::int FROM task) AS tasks`,
	);
	assert.deepEqual(sideEffects.rows[0], { forks: 0, mail: 0, tasks: 1 });
	await db.execute(querySql`INSERT INTO message_template(plant_id,source_item_id,source_version_id,name,category,subject,body_html)
    SELECT ${querySql.param(plant)},i.id,v.id,'Plant fork','meeting_invitation','My reviewed subject','<p>Plant edit survives</p>'
    FROM reference_item i JOIN reference_version v ON v.item_id=i.id WHERE i.kind='mail_template' AND i.canonical_key='Vision Meeting Invitation'`);
});

test("AC:REFREL-004 concurrent promotions have one winner and stale claim loses", async () => {
	const outcomes = await Promise.allSettled(["R2", "R3"].map((key) => service.promote(command(key, "1"), key)));
	assert.equal(outcomes.filter((o) => o.status === "fulfilled").length, 1);
	const loser = outcomes.find((o) => o.status === "rejected");
	assert.equal(loser?.status === "rejected" && loser.reason.code, "revision_conflict");
	assert.equal((await service.current())?.activation_number, "2");
	await db.execute(
		querySql`UPDATE job SET checkpoint_key=${querySql.param(fixture("R4").manifestHash)} WHERE id=${querySql.param(job)}`,
	);
	claim = { jobId: job, generation: "1", leaseOwner: "synthetic-worker" };
	await refused(command("R4", "2"), "stale_claim");
	claim = undefined;
	assert.deepEqual(await counts(), { activations: 2, releases: 2, operations: 3, events: 3 });
});

test("AC:REFREL-005 rollback appends attributable activation and preserves old generations", async () => {
	const rollback = await service.promote(command("R1", "2", "rollback"), "R1");
	assert.equal(rollback.number, "3");
	assert.equal((await service.current())?.release_key, "R1");
	const history = await db.execute<{
		activation_number: string;
		expected_prior_number: string;
		previous_id: string | null;
		actor_id: string;
		reason: string;
	}>(
		querySql`SELECT activation_number::text,expected_prior_number::text,previous_id,actor_id,reason FROM reference_activation ORDER BY activation_number`,
	);
	assert.deepEqual(
		history.rows.map((r: { activation_number: string; expected_prior_number: string }) => [
			r.activation_number,
			r.expected_prior_number,
		]),
		[
			["1", "0"],
			["2", "1"],
			["3", "2"],
		],
	);
	assert.equal(history.rows[2]!.actor_id, actor);
	assert.equal(history.rows[2]!.reason, "Synthetic reviewed reference proof");
	const invalid = command("never-active", "3", "rollback");
	await refused(invalid, "rollback_unavailable");
	assert.deepEqual(await counts(), { activations: 3, releases: 2, operations: 4, events: 4 });
	assert.deepEqual((await db.execute(querySql`SELECT title,status,due_kind FROM task`)).rows, [
		{ title: "Keep edited title", status: "in_progress", due_kind: "undated" },
	]);
	assert.deepEqual((await db.execute(querySql`SELECT subject,body_html FROM message_template`)).rows, [
		{ subject: "My reviewed subject", body_html: "<p>Plant edit survives</p>" },
	]);
});

test("INV-reference-authority: live session, current grant and exact trusted review are required even on replay", async () => {
	const cmd = firstCommand;
	await db.execute(querySql`UPDATE platform_grant SET revoked_at=now() WHERE account_id=${querySql.param(actor)}`);
	await refused(cmd, "access_denied");
	await db.execute(
		querySql`UPDATE platform_grant SET revoked_at=null,expires_at=now()-interval '1 minute' WHERE account_id=${querySql.param(actor)}`,
	);
	await refused(cmd, "access_denied");
	await db.execute(querySql`UPDATE platform_grant SET expires_at=null WHERE account_id=${querySql.param(actor)}`);
	await db.execute(
		querySql`UPDATE auth_session SET expires_at=now()-interval '1 minute' WHERE id=${querySql.param(session)}`,
	);
	await refused(cmd, "access_denied");
	await db.execute(
		querySql`UPDATE auth_session SET expires_at=now()+interval '1 hour' WHERE id=${querySql.param(session)}`,
	);
	reviews.delete(cmd.requestKey);
	await refused(cmd, "access_denied");
	const fresh = command("R1", "3");
	const racing = referenceService(db, {
		authorize,
		policyFor: (key) => fixture(key).policy,
		loadArtifact: async (locator) => {
			await db.execute(querySql`UPDATE platform_grant SET revoked_at=now() WHERE account_id=${querySql.param(actor)}`);
			return artifacts.get(locator);
		},
	});
	try {
		await assert.rejects(
			racing.promote(fresh, "R1"),
			(e) => e instanceof ReferenceRefusal && e.code === "access_denied",
		);
	} finally {
		await db.execute(querySql`UPDATE platform_grant SET revoked_at=null WHERE account_id=${querySql.param(actor)}`);
	}
	assert.deepEqual(await counts(), { activations: 3, releases: 2, operations: 4, events: 4 });
});

test("INV-reference-atomicity: required audit fault rolls back candidate, mapping, activation and receipt", async () => {
	await db.execute(
		querySql`CREATE FUNCTION fail_reference_audit() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'synthetic audit fault' USING ERRCODE='P0001'; END $$`,
	);
	await db.execute(
		querySql`CREATE TRIGGER fail_reference_audit BEFORE INSERT ON audit_event FOR EACH ROW EXECUTE FUNCTION fail_reference_audit()`,
	);
	try {
		await assert.rejects(
			service.promote(command("R5", "3"), "R5"),
			(e: unknown) =>
				typeof e === "object" &&
				e !== null &&
				"cause" in e &&
				e.cause instanceof Error &&
				"code" in e.cause &&
				e.cause.code === "P0001",
		);
	} finally {
		await db.execute(querySql`DROP TRIGGER fail_reference_audit ON audit_event`);
	}
	assert.deepEqual(await counts(), { activations: 3, releases: 2, operations: 4, events: 4 });
	assert.equal((await service.current())?.release_key, "R1");
	const orphans = await db.execute(
		querySql`SELECT count(*)::int AS n FROM record WHERE kind='reference_release' AND id NOT IN(SELECT id FROM reference_release)`,
	);
	assert.equal(orphans.rows[0]!.n, 0);
});

test("INV-reference-revalidation: changed persisted derivatives refuse while current claim can replay clean data", async () => {
	const saved = (
		await db.execute<{ id: string; content: string; embedding: string }>(
			querySql`SELECT id,content,embedding::text FROM passage WHERE release_id=(SELECT release_id FROM reference_activation ORDER BY activation_number DESC LIMIT 1) LIMIT 1`,
		)
	).rows[0]!;
	await db.execute(
		querySql`UPDATE passage SET embedding=${querySql.param("[9,9,9]")}::public.vector WHERE id=${querySql.param(saved.id)}`,
	);
	try {
		await refused(command("R1", "3"), "immutable_conflict");
	} finally {
		await db.execute(
			querySql`UPDATE passage SET embedding=${querySql.param(saved.embedding)}::public.vector WHERE id=${querySql.param(saved.id)}`,
		);
	}
	assert.deepEqual(await counts(), { activations: 3, releases: 2, operations: 4, events: 4 });
	await db.execute(
		querySql`UPDATE job SET checkpoint_key=${querySql.param(fixture("R1").manifestHash)} WHERE id=${querySql.param(job)}`,
	);
	claim = { jobId: job, generation: "2", leaseOwner: "another-worker" };
	await refused(command("R1", "3"), "stale_claim");
	claim = { jobId: job, generation: "2", leaseOwner: "synthetic-worker" };
	await db.execute(
		querySql`UPDATE job SET checkpoint_key=${querySql.param("wrong-manifest")} WHERE id=${querySql.param(job)}`,
	);
	await refused(command("R1", "3"), "stale_claim");
	await db.execute(
		querySql`UPDATE job SET checkpoint_key=${querySql.param(fixture("R1").manifestHash)} WHERE id=${querySql.param(job)}`,
	);
	try {
		assert.equal((await service.promote(command("R1", "3"), "R1")).number, "3");
	} finally {
		claim = undefined;
	}
	assert.deepEqual(await counts(), { activations: 3, releases: 2, operations: 5, events: 5 });
});
