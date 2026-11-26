import "../../platform/setup.mts";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test, { after } from "node:test";
import {
	digest,
	owner,
	requestIdentity,
	revision,
	safeError,
	sameOwner,
	type RequestIdentity,
} from "../../../../packages/contracts/src/common/index.ts";
import { lockedPersonReference } from "../../../../packages/contracts/src/people/references.ts";
import { sql, type SQL } from "../../../../packages/db/src/query.ts";
import { RequestActor } from "../../../../packages/domain/src/access/session.ts";
import { brandReader } from "../../../../packages/domain/src/branding/reads.ts";
import { brandWriter } from "../../../../packages/domain/src/branding/writes.ts";
import { createPrivateCare } from "../../../../packages/domain/src/intelligence/index.ts";
import { defineRefusals } from "../../../../packages/domain/src/operations/refusals.ts";
import { finishAudit, gatedTransaction, prepareWrite } from "../../../../packages/domain/src/operations/writes.ts";
import { registry } from "../../../../packages/domain/src/people/person-reference-registry/index.ts";
import { fixture, ok, type Actor } from "../../../support/fixture.mts";
import { touched } from "../../../support/recorded.mts";
import { accepts, schemaCase } from "./schema-probe.mts";

const database = await fixture({
	prefix: "contractcases",
	plant: { name: "Harvest Point" },
	clock: new Date(schemaCase("C0-SCOPE-001").clock!.now),
});
const { admin } = database;
const db = database.pools.runtime;
const P = database.tenant;
const A = database.actors.admin;
const Q = await database.plant({ name: "Grace Hill", timezone: "America/New_York" });
const B = await database.actor(Q, "owner");
const N = await database.organization("sending_network");
after(() => database.close());

const shared = defineRefusals(safeError);
const one = async (query: SQL) => (await admin.execute(query)).rows[0] ?? assert.fail("no row");
const actorOf = async (who: Actor) => {
	const actor = await RequestActor.resolve(db, who.session);
	assert.ok(actor instanceof RequestActor, JSON.stringify(actor));
	return actor;
};
const codeOf = (reply: { status: string; error?: { code: string } }) =>
	reply.status === "refused" ? reply.error!.code : reply.status;
const values = (id: string) => (schemaCase(id).given["contract-fixtures"] as { values: Record<string, string> }).values;
const settings = (expectedRevision: string, primaryColor = "#123456") => ({
	expectedRevision,
	patch: { primaryColor },
});
const kitRevision = async () =>
	String((await one(sql`SELECT revision::text AS r FROM church_brand_kit WHERE tenant_id=${P.id}::uuid`)).r);

test("AC:C0-SCOPE-001 the actor and role come from the session's seat, a command carrying an actor or role is invalid input, and a foreign scope is denied", async () => {
	const c = schemaCase("C0-SCOPE-001");
	const { result } = c.expected;
	const v = values(c.id);
	assert.deepEqual(
		[v.session_account, v.selected_plant, v.current_role, v.submitted_actor, v.submitted_role],
		["A", "P", "admin", "B", "owner"],
	);
	const actor = await actorOf(A);
	const context = actor.actor.context;
	assert.equal(context.kind, "seat");
	if (context.kind !== "seat") assert.fail();
	assert.ok(sameOwner(context.owner, { kind: "plant", id: P.id } as never));
	assert.deepEqual(
		{ actor: actor.actor.accountId === A.id ? "A" : actor.actor.accountId, role: context.role },
		{ actor: result.actor, role: result.role },
	);
	ok(await brandWriter.saveSettings(db, actor, settings("0")));

	const forged = [
		{ actorId: B.id },
		{ accountId: B.id },
		{ role: v.submitted_role },
		{ actor: { account: B.id, role: v.submitted_role } },
		{ context: { kind: "plant", id: Q.id } },
	];
	for (const extra of forged) {
		const before = await kitRevision();
		const { value, tables } = await touched(admin, async () => [
			codeOf(await brandWriter.saveSettings(db, actor, { ...settings(before, "#654321"), ...extra })),
			codeOf(
				await brandWriter.saveSettings(db, actor, {
					...settings(before, "#654321"),
					patch: { primaryColor: "#654321", ...extra },
				}),
			),
			codeOf(await brandReader.get(db, actor, extra)),
		]);
		assert.deepEqual(
			value,
			[result.forged_command_error, result.forged_command_error, result.forged_command_error],
			JSON.stringify(extra),
		);
		assert.deepEqual(tables, []);
	}

	const seatOfB = await one(
		sql`SELECT id,revision::text AS revision FROM seat WHERE account_id=${B.id}::uuid AND ended_at IS NULL`,
	);
	const foreign = RequestActor.of(A.session, {
		status: "active",
		accountId: actor.actor.accountId,
		context: {
			kind: "seat",
			owner: { kind: "plant", id: Q.id } as never,
			seatId: seatOfB.id as never,
			role: v.submitted_role as "owner",
			revision: String(seatOfB.revision) as never,
		},
	});
	const { value, tables } = await touched(admin, async () => [
		codeOf(await brandReader.get(db, foreign, {})),
		codeOf(await brandWriter.saveSettings(db, foreign, settings("0"))),
	]);
	assert.deepEqual(value, [result.foreign_scope_error, result.foreign_scope_error]);
	assert.deepEqual(tables, []);
	assert.equal(sameOwner({ kind: "plant", id: P.id } as never, { kind: "plant", id: Q.id } as never), false);
	assert.deepEqual(
		[shared.refused("invalid_input").error.retry, shared.refused("access_denied").error.retry],
		["never", "never"],
	);
	assert.equal(c.expected.event, null);
});

test("AC:C0-REPLAY-001 the same request replays its stored outcome, changed input or reviewed state conflicts, and an unknown external outcome is reconciled", async () => {
	const c = schemaCase("C0-REPLAY-001");
	const { result } = c.expected;
	const v = values(c.id);
	const actor = await actorOf(A);
	const identity = (value: string): RequestIdentity =>
		requestIdentity.parse({
			owner: { kind: "plant", id: P.id },
			actorId: A.id,
			operation: "plant.updateProfile",
			requestKey: v.request_key,
			digest: value,
		});
	const stored = { saved: true };
	await gatedTransaction(db, async (tx) => {
		assert.ok(await actor.bind(tx, { kind: "plant", id: P.id } as never));
		const first = await prepareWrite(tx, identity(v.original_digest!));
		assert.equal(first.kind, "new");
		if (first.kind !== "new") assert.fail();
		await finishAudit(tx, first, identity(v.original_digest!), stored);
	});
	const decide = (value: string) =>
		touched(admin, () =>
			gatedTransaction(db, async (tx) => {
				assert.ok(await actor.bind(tx, { kind: "plant", id: P.id } as never));
				return prepareWrite(tx, identity(value));
			}),
		);
	assert.equal(digest.parse(v.same_digest), v.original_digest);
	const same = await decide(v.same_digest!);
	assert.equal(same.value.kind, result.same_request);
	if (same.value.kind !== "replay") assert.fail();
	assert.deepEqual(same.value.value, stored);
	const changed = await decide(v.changed_digest!);
	assert.equal(changed.value.kind, result.changed_input);
	assert.deepEqual([same.tables, changed.tables], [[], []]);
	const recorded = await one(sql`SELECT count(*)::int AS n FROM audit_event WHERE request_key=${v.request_key}`);
	assert.equal(recorded.n, 1);

	const reviewed = await kitRevision().catch(() => "0");
	if (reviewed === "0") ok(await brandWriter.saveSettings(db, actor, settings("0")));
	const current = await kitRevision();
	ok(await brandWriter.saveSettings(db, actor, settings(current, "#0a0b0c")));
	const stale = await brandWriter.saveSettings(db, actor, settings(current, "#0c0b0a"));
	assert.equal(`fixture-state-${codeOf(stale)}`, result.changed_reviewed_state);
	assert.equal(stale.status === "refused" && stale.error.retry, "refresh");
	assert.equal(shared.refused("conflict").error.retry, "refresh");
	assert.equal(shared.refused("unknown").error.retry, result.external_unknown_retry);
	assert.equal(safeError.safeParse({ ...shared.refused("unknown").error, retry: "same_request" }).success, false);
	assert.equal(c.expected.event, null);
});

test("AC:C0-REVISION-001 a reviewed revision past 2^53 is compared exactly: unchanged is allowed, changed conflicts, a replay changes no input, and a private-care subject is refused", async () => {
	const c = schemaCase("C0-REVISION-001");
	const { result } = c.expected;
	const v = values(c.id);
	const exact = (state: string) => revision.parse(state.replace(/^fixture-state-/, ""));
	const observed = exact(v.observed_state!);
	assert.equal(observed, "9007199254740993");
	assert.equal(exact(v.replayed_state!), observed);
	assert.notEqual(revision.parse("9007199254740992"), observed);
	assert.equal(Number("9007199254740992"), Number(observed));
	assert.equal(revision.safeParse("9223372036854775808").success, false);
	assert.equal(revision.safeParse(9007199254740993).success, false);

	const actor = await actorOf(A);
	if ((await admin.execute(sql`SELECT 1 FROM church_brand_kit WHERE tenant_id=${P.id}::uuid`)).rows.length === 0)
		ok(await brandWriter.saveSettings(db, actor, settings("0")));
	await admin.execute(sql`UPDATE church_brand_kit SET revision=${observed}::bigint WHERE tenant_id=${P.id}::uuid`);
	const near = await brandWriter.saveSettings(db, actor, settings("9007199254740992", "#111111"));
	assert.equal(codeOf(near), "conflict");
	const unchanged = await brandWriter.saveSettings(db, actor, settings(exact(v.replayed_state!), "#222222"));
	assert.equal(unchanged.status === "ok" ? "allowed" : codeOf(unchanged), result.unchanged_reviewed_facts);
	assert.equal(await kitRevision(), "9007199254740994");
	const changed = await brandWriter.saveSettings(db, actor, settings(observed, "#333333"));
	assert.equal(codeOf(changed), result.changed_reviewed_facts);

	const key = randomUUID();
	const identity = requestIdentity.parse({
		owner: { kind: "plant", id: P.id },
		actorId: A.id,
		operation: "plant.updateProfile",
		requestKey: key,
		digest: "c".repeat(64),
	});
	await gatedTransaction(db, async (tx) => {
		assert.ok(await actor.bind(tx, { kind: "plant", id: P.id } as never));
		const first = await prepareWrite(tx, identity);
		if (first.kind !== "new") assert.fail(first.kind);
		await finishAudit(tx, first, identity, { revision: observed });
	});
	const material = async () =>
		one(sql`SELECT material_revision::text AS m,revision::text AS r FROM plant WHERE id=${P.id}::uuid`);
	const inputs = await material();
	const { value: replay, tables } = await touched(admin, () =>
		gatedTransaction(db, async (tx) => {
			assert.ok(await actor.bind(tx, { kind: "plant", id: P.id } as never));
			return prepareWrite(tx, identity);
		}),
	);
	assert.equal(replay.kind, "replay");
	assert.equal(tables.length > 0 || "writes" in replay, result.replay_changes_assessment_inputs);
	assert.deepEqual(await material(), inputs);

	assert.equal(v.private_care_subject, "private_week");
	await admin.execute(sql`UPDATE account SET personal_timezone='America/Chicago' WHERE id=${A.id}::uuid`);
	const care = createPrivateCare();
	const author = await actorOf(A);
	const before = await material();
	const { tables: careTables } = await touched(admin, async () => {
		const week = ok(await care.readCurrent(db, author, {}));
		ok(
			await care.save(db, author, {
				requestKey: randomUUID(),
				expectedRevision: week.revision,
				input: {
					answers: { spiritual: "strained", family: "steady", financial: "steady", pace: "steady" },
					note: "Private",
				},
			}),
		);
	});
	assert.deepEqual(await material(), before);
	assert.equal(careTables.includes("audit_event") || careTables.includes("record"), false, careTables.join());
	const week = await one(sql`SELECT id FROM private_week WHERE author_id=${A.id}::uuid`);
	const subject = (await admin.execute(sql`SELECT kind FROM record WHERE id=${week.id}::uuid`)).rows;
	assert.deepEqual(subject, []);
	const historyOf = (subjectId: unknown) =>
		sql`INSERT INTO audit_event(tenant_id,actor_id,action,kind,subject_type,subject_id)
		VALUES(${P.id}::uuid,${A.id}::uuid,'plant.profile_changed','edit',${v.private_care_subject},${subjectId}::uuid)`;
	const refusedSubject = !(await accepts(admin, historyOf(week.id)));
	assert.equal(refusedSubject ? "invalid_subject" : "accepted", result.private_care_error);
	assert.equal(await accepts(admin, historyOf(P.id)), true);
	assert.equal(
		await accepts(
			admin,
			sql`INSERT INTO record(id,kind,tenant_id) VALUES(${randomUUID()}::uuid,${v.private_care_subject},${P.id}::uuid)`,
		),
		false,
	);
	assert.equal(shared.refused(result.private_care_error as "invalid_subject").error.retry, "never");
	assert.equal(c.expected.event, null);
});

test("AC:C0-PERSON-001 a Person reference names one owner: a foreign owner is denied, a second owner is invalid input, and history is never rewritten", async () => {
	const c = schemaCase("C0-PERSON-001");
	const { result } = c.expected;
	const v = values(c.id);
	assert.deepEqual([v.kind, v.owner, v.foreign_owner, v.extra_owner], ["person", "P", "Q", "N"]);
	const alex = randomUUID();
	const plantP = owner.parse({ kind: "plant", id: P.id });
	const reference = lockedPersonReference.parse({ owner: plantP, personId: alex, revision: "1", state: "live" });
	assert.deepEqual(
		{ kind: "personId" in reference ? "person" : null, owner: sameOwner(reference.owner, plantP) ? "P" : null },
		{ kind: result.kind, owner: result.owner },
	);
	const plantQ = owner.parse({ kind: "plant", id: Q.id });
	assert.equal(sameOwner(reference.owner, plantQ), false);
	assert.equal(
		sameOwner(reference.owner, plantQ) ? "ok" : shared.refused("access_denied").error.code,
		result.foreign_subject_error,
	);
	const network = { kind: "organization", id: N.id, organizationKind: "sending_network" };
	const doubled = [
		{ owner: plantP, organization: network },
		{ owner: [plantP, network] },
		{ owner: { ...plantP, organizationKind: "sending_network" } },
		{ owner: plantP, owners: [plantP, network] },
	];
	for (const extra of doubled) {
		const parsed = lockedPersonReference.safeParse({
			personId: alex,
			revision: "1",
			state: "live",
			...extra,
		});
		assert.equal(
			parsed.success ? "ok" : shared.refused("invalid_input").error.code,
			result.double_owner_error,
			JSON.stringify(extra),
		);
	}
	const both = sql`INSERT INTO person(id,tenant_id,plant_id,organization_id,display_name,source,stage,adult_classification,
		commitment_state,pipeline_position,state,created_at) VALUES(${randomUUID()}::uuid,${P.id}::uuid,${P.id}::uuid,${N.id}::uuid,
		'Alex','other','prospect','unknown','unknown',0,'live',clock_timestamp())`;
	assert.equal(await accepts(admin, both), false);
	for (const state of ["merged", "retired"])
		assert.equal(
			lockedPersonReference.safeParse({ owner: plantP, personId: alex, revision: "1", state }).success,
			false,
		);
	const history = registry.filter((e) => /history|merge_record/.test(e.kind));
	assert.ok(history.length >= 3, JSON.stringify(history.map((e) => e.kind)));
	assert.equal(
		history.some((e) => e.treatment !== "keep"),
		result.history_rewrite,
	);
	assert.equal(c.expected.event, null);
});
