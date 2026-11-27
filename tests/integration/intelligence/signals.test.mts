import test, { after, before } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { instant } from "../../../packages/contracts/src/common/index.ts";
import { sql, type SQL } from "../../../packages/db/src/query.ts";
import { fixture, type Fixture } from "../identity/invitations-support.mts";
import {
	createFacts,
	createSignals,
	criteriaOf,
	type Signals,
} from "../../../packages/domain/src/intelligence/index.ts";
import { readCatalog } from "../../../packages/domain/src/phases/index.ts";
import { createWikiProducer } from "../../../packages/domain/src/wiki/index.ts";
import { seedFoundations } from "../../evry/runtime/foundations.mts";
import { caseOf } from "../target/sql/core/support.mts";
import { peopleWriter } from "../../../packages/domain/src/people/index.ts";
import type { SignalValue } from "../../../packages/contracts/src/intelligence/index.ts";
import { MANUAL_SIGNALS } from "../../../docs/reference/manual-signals.ts";
import { ok, refusedWith } from "../../support/fixture.mts";
import { gatedTransaction } from "../../../packages/domain/src/operations/writes.ts";

let f: Fixture;
let signals: Signals;
type Workspace = Awaited<ReturnType<Fixture["workspace"]>>;
type Planter = Awaited<ReturnType<Fixture["account"]>> & { w: Workspace };
type Seated = Planter & { actor: Awaited<ReturnType<Fixture["actor"]>> };
let now = "2026-10-13T16:00:00.000Z";
const clock = { now: () => instant.parse(now) };
const refusedBare = refusedWith({ details: {} });
const rows = async <T extends Record<string, unknown>>(q: SQL) => (await f.admin.execute<T>(q)).rows;
const one = async <T extends Record<string, unknown>>(q: SQL) => (await rows<T>(q))[0]!;
const rejects = (promise: Promise<unknown>, pattern: RegExp) =>
	assert.rejects(promise, (e) => {
		assert.ok(e instanceof Error);
		assert.match(e.cause instanceof Error ? e.cause.message : e.message, pattern);
		return true;
	});
const DAY = 86_400_000;
const at = (days: number) => new Date(Date.parse("2026-10-13T16:00:00.000Z") + days * DAY).toISOString();

let named = 0;
const founders = new Map<string, Planter>();
async function seated(w: Workspace, role: "owner" | "admin" | "member" = "admin"): Promise<Seated> {
	const a = await f.account();
	await f.seat(a, w, role);
	const who = { ...a, w, actor: await f.actor(a.session) };
	if (w.kind !== "plant") return who;
	if (role !== "member" && !founders.has(w.id)) founders.set(w.id, who);
	const own = await person(role === "member" ? founders.get(w.id)! : who, `Planter ${++named}`);
	await f.admin.execute(sql`UPDATE person SET linked_account_id=${a.id} WHERE id=${own.id}`);
	return who;
}
async function person(who: Planter, displayName: string): Promise<{ id: string }> {
	const { w } = who;
	assert.ok(w.kind === "plant");
	return ok(
		await gatedTransaction(f.db, (tx) =>
			peopleWriter.createPerson(
				tx,
				{ session: who.session, selected: w },
				{
					requestKey: randomUUID(),
					input: { displayName, adultClassification: "adult" },
				},
			),
		),
	).person;
}
const page = async (who: Seated) => ok(await signals.readAttestations(f.db, who.actor, {}));
const entry = async (who: Seated, key: string) => (await page(who)).signals.find((x) => x.key === key)!;
const attest = (
	who: Seated,
	key: string,
	value: SignalValue = "yes",
	extra: { asOf?: string; detail?: string; reference?: string } = {},
	expectedRevision = "0",
	requestKey: string = randomUUID(),
) => signals.attest(f.db, who.actor, { requestKey, expectedRevision, input: { key, value, ...extra } });
const correct = (who: Seated, input: unknown, expectedRevision: string, requestKey: string = randomUUID()) =>
	signals.correct(f.db, who.actor, { requestKey, expectedRevision, input });
const reaffirm = (
	who: Seated,
	key: string,
	expectedValue: SignalValue,
	expectedRevision: string,
	requestKey: string = randomUUID(),
) => signals.reaffirm(f.db, who.actor, { requestKey, expectedRevision, input: { key, expectedValue } });
const counts = (w: Workspace) =>
	one<{
		attestations: number;
		revisions: number;
		audits: number;
	}>(sql`SELECT (SELECT count(*)::int FROM attestation WHERE plant_id=${w.id}) attestations,
		(SELECT count(*)::int FROM attestation_revision WHERE plant_id=${w.id}) revisions,
		(SELECT count(*)::int FROM audit_event WHERE tenant_id=${w.id} AND action LIKE 'attestation.%') audits`);
before(async () => {
	f = await fixture();
	signals = createSignals({ clock });
});
after(() => f?.close());

test("AC:PI-015 listDefinitions returns the seven keys of manual-signals.ts in order, with no answer or author", async () => {
	const listed = ok(await signals.listDefinitions({}));
	assert.deepEqual(
		listed.map((d) => d.key),
		MANUAL_SIGNALS.map((d) => d.key),
	);
	for (const [i, d] of listed.entries()) {
		assert.deepEqual(Object.keys(d).sort(), ["description", "key", "label", "reaffirms", "windowDays"]);
		assert.equal(d.label, MANUAL_SIGNALS[i]!.label);
		assert.equal(d.description, MANUAL_SIGNALS[i]!.description);
		assert.equal(d.reaffirms, MANUAL_SIGNALS[i]!.reaffirms);
		assert.equal(d.windowDays, d.reaffirms ? 30 : null);
	}
	assert.deepEqual(
		listed.filter((d) => d.reaffirms).map((d) => d.key),
		["core_group_giving", "prayer_rhythm_established", "prayer_in_gatherings"],
	);
});

test("AC:PI-015 another key, including leadership_candidate and a later-package key, is refused and stores nothing", async () => {
	const w = await f.workspace();
	const a = await seated(w);
	for (const key of [
		"leadership_candidate",
		"worship_agreement",
		"community",
		"promotion_plan",
		"relationship",
		"nope",
	])
		refusedBare(await attest(a, key), "invalid_input");
	refusedBare(await correct(a, { action: "correct", key: "leadership_candidate", value: "yes" }, "1"), "invalid_input");
	refusedBare(await reaffirm(a, "relationship", "yes", "1"), "invalid_input");
	refusedBare(await signals.getHistory(f.db, a.actor, { key: "community" }), "invalid_input");
	assert.deepEqual(await counts(w), { attestations: 0, revisions: 0, audits: 0 });
});

test("AC:PI-015 the page shows seven Unknown signals with counts; a Member, an ended seat and a foreign church get nothing", async () => {
	const w = await f.workspace(),
		other = await f.workspace();
	const admin = await seated(w);
	const member = await seated(w, "member");
	const stranger = await seated(other);
	const view = await page(admin);
	assert.deepEqual(
		view.signals.map((s) => s.key),
		MANUAL_SIGNALS.map((s) => s.key),
	);
	for (const s of view.signals) {
		assert.equal(s.state, "unanswered");
		assert.equal(s.value, null);
		assert.equal(s.revision, "0");
		assert.equal(s.renewal.status, "unknown");
	}
	assert.deepEqual(view.counts, { current: 0, needsRenewing: 0, notAnswered: 7 });
	const owned = await page(await seated(w, "owner"));
	assert.deepEqual([owned.signals, owned.counts], [view.signals, view.counts]);
	refusedBare(await signals.readAttestations(f.db, member.actor, {}), "access_denied");
	refusedBare(await signals.getHistory(f.db, member.actor, { key: null }), "access_denied");
	const ended = await seated(w);
	await f.admin.execute(sql`UPDATE seat SET ended_at=clock_timestamp() WHERE account_id=${ended.id}`);
	refusedBare(await signals.readAttestations(f.db, ended.actor, {}), "access_denied");
	assert.equal(
		(await page(stranger)).signals.every((s) => s.state === "unanswered"),
		true,
	);
	ok(await attest(admin, "values_documented"));
	assert.equal((await entry(stranger, "values_documented")).state, "unanswered");
});

test("AC:PI-015 AC:REQ-KNOW-050 a signal is answered with its name and date; detail and reference are never required; a retry replays", async () => {
	now = at(0);
	const w = await f.workspace();
	const a = await seated(w);
	const first = ok(await attest(a, "prayer_rhythm_established", "yes"));
	assert.equal(first.signal.state, "answered");
	assert.equal(first.signal.value, "yes");
	assert.equal(first.signal.asOf, "2026-10-13");
	assert.equal(first.signal.detail, null);
	assert.equal(first.signal.reference, null);
	assert.ok(first.signal.authorName);
	assert.equal(first.signal.revision, "1");
	const detailed = ok(
		await attest(a, "financial_base_established", "not_yet", {
			asOf: "2026-10-01",
			detail: "  Pledges due  ",
			reference: "Budget v2",
		}),
	);
	assert.equal(detailed.signal.value, "not_yet");
	assert.equal(detailed.signal.asOf, "2026-10-01");
	assert.equal(detailed.signal.detail, "Pledges due");
	assert.equal(detailed.signal.reference, "Budget v2");
	refusedBare(await attest(a, "systems_tested", "yes", { asOf: "2026-10-14" }), "invalid_input");
	assert.equal((await entry(a, "systems_tested")).state, "unanswered");
	const key = randomUUID();
	const before = await counts(w);
	const one_ = ok(await attest(a, "prayer_in_gatherings", "yes", {}, "0", key));
	const again = ok(await attest(a, "prayer_in_gatherings", "yes", {}, "0", key));
	assert.deepEqual(again, one_);
	assert.deepEqual(await counts(w), {
		attestations: before.attestations + 1,
		revisions: before.revisions + 1,
		audits: before.audits + 1,
	});
	refusedBare(await attest(a, "prayer_in_gatherings", "not_yet", {}, "0", key), "idempotency_conflict");
	assert.equal((await entry(a, "prayer_in_gatherings")).value, "yes");
});

test("AC:PI-014 a correction to another value keeps history; the same value and a double retract are refused; Retracted is not Not answered", async () => {
	now = at(0);
	const w = await f.workspace();
	const a = await seated(w);
	const made = ok(await attest(a, "prayer_leader_assigned", "yes", { detail: "Grace" }));
	refusedBare(
		await correct(a, { action: "correct", key: "prayer_leader_assigned", value: "yes" }, made.signal.revision),
		"no_change",
	);
	assert.equal((await counts(w)).revisions, 1);
	now = at(2);
	const fixed = ok(
		await correct(
			a,
			{ action: "correct", key: "prayer_leader_assigned", value: "not_yet", detail: "Waiting on Grace" },
			made.signal.revision,
		),
	);
	assert.equal(fixed.signal.value, "not_yet");
	assert.equal(fixed.signal.revision, "2");
	assert.equal(fixed.signal.asOf, "2026-10-15");
	now = at(3);
	const gone = ok(await correct(a, { action: "retract", key: "prayer_leader_assigned" }, fixed.signal.revision));
	assert.equal(gone.signal.state, "retracted");
	assert.equal(gone.signal.value, null);
	assert.equal(gone.signal.renewal.status, "unknown");
	assert.notEqual(gone.signal.state, "unanswered");
	refusedBare(
		await correct(a, { action: "retract", key: "prayer_leader_assigned" }, gone.signal.revision),
		"not_current",
	);
	refusedBare(
		await correct(a, { action: "correct", key: "prayer_leader_assigned", value: "yes" }, gone.signal.revision),
		"not_current",
	);
	refusedBare(await correct(a, { action: "retract", key: "systems_tested" }, "0"), "not_current");
	const view = await page(a);
	assert.deepEqual(view.counts, { current: 0, needsRenewing: 0, notAnswered: 7 });
	const shown = view.signals.find((s) => s.key === "prayer_leader_assigned")!;
	assert.deepEqual([shown.state, shown.value, shown.renewal], ["retracted", null, { status: "unknown" }]);
	const again = ok(await attest(a, "prayer_leader_assigned", "yes", {}, gone.signal.revision));
	assert.equal(again.signal.revision, "4");
	const all = ok(await signals.getHistory(f.db, a.actor, { key: "prayer_leader_assigned" })).revisions;
	assert.deepEqual(
		all.map((r) => [r.revision, r.kind, r.value]),
		[
			[4, "answered", "yes"],
			[3, "retracted", null],
			[2, "corrected", "not_yet"],
			[1, "answered", "yes"],
		],
	);
});

test("AC:PI-014 history lists every revision newest first, and the runtime login cannot change or delete one", async () => {
	now = at(0);
	const w = await f.workspace();
	const a = await seated(w);
	const first = ok(
		await attest(a, "core_group_giving", "yes", { detail: "Monthly pledges", reference: "Giving sheet" }),
	);
	now = at(5);
	ok(await attest(a, "values_documented", "yes"));
	now = at(6);
	ok(await reaffirm(a, "core_group_giving", "yes", first.signal.revision));
	const one_ = ok(await signals.getHistory(f.db, a.actor, { key: "core_group_giving" })).revisions;
	assert.deepEqual(
		one_.map((r) => [r.revision, r.kind]),
		[
			[2, "reaffirmed"],
			[1, "answered"],
		],
	);
	assert.equal(one_[1]!.detail, "Monthly pledges");
	assert.equal(one_[1]!.reference, "Giving sheet");
	assert.equal(one_[1]!.questionVersion, "manual-signals/1");
	assert.equal(one_[1]!.asOf, "2026-10-13");
	assert.ok(one_[1]!.authorName);
	assert.ok(one_[1]!.recordedAt);
	const whole = ok(await signals.getHistory(f.db, a.actor, { key: null })).revisions;
	assert.equal(whole.length, 3);
	assert.deepEqual(
		whole.map((r) => r.key),
		["core_group_giving", "values_documented", "core_group_giving"],
	);
	await rejects(
		f.db.execute(sql`UPDATE attestation_revision SET detail='x' WHERE plant_id=${w.id}`),
		/permission denied/,
	);
	await rejects(f.db.execute(sql`DELETE FROM attestation_revision WHERE plant_id=${w.id}`), /permission denied/);
	await rejects(f.db.execute(sql`DELETE FROM attestation WHERE plant_id=${w.id}`), /permission denied/);
	await rejects(
		f.admin.execute(sql`UPDATE attestation_revision SET detail='x' WHERE plant_id=${w.id}`),
		/immutable_source_evidence/,
	);
	const member = await seated(w, "member");
	refusedBare(await attest(member, "systems_tested"), "access_denied");
	assert.equal((await counts(w)).revisions, 3);
});

test("AC:B01-026 ages, renewal at 31 days, and funding that never expires", async () => {
	const w = await f.workspace();
	const a = await seated(w);
	now = at(0);
	for (const key of [
		"prayer_rhythm_established",
		"prayer_in_gatherings",
		"core_group_giving",
		"financial_base_established",
		"values_documented",
		"prayer_leader_assigned",
	])
		ok(await attest(a, key, "yes"));
	const status = async (key: string) => (await entry(a, key)).renewal;
	now = at(30);
	assert.deepEqual(await status("prayer_rhythm_established"), { status: "current", daysLeft: 0 });
	assert.deepEqual(await status("core_group_giving"), { status: "current", daysLeft: 0 });
	now = at(12);
	assert.deepEqual(await status("prayer_in_gatherings"), { status: "current", daysLeft: 18 });
	now = at(31);
	for (const key of ["prayer_rhythm_established", "prayer_in_gatherings", "core_group_giving"]) {
		const e = await entry(a, key);
		assert.deepEqual(e.renewal, { status: "needs_renewing" }, key);
		assert.equal(e.value, "yes", "keeps its stored value");
		assert.equal(e.state, "answered");
		assert.equal(e.ageDays, 31);
	}
	now = at(100);
	for (const key of ["financial_base_established", "values_documented", "prayer_leader_assigned"]) {
		assert.deepEqual(await status(key), { status: "does_not_expire" }, key);
		assert.equal((await entry(a, key)).value, "yes");
	}
	const view = await page(a);
	assert.deepEqual(view.counts, { current: 3, needsRenewing: 3, notAnswered: 1 });
	const systems = await entry(a, "systems_tested");
	assert.equal(systems.state, "unanswered");
	assert.equal(systems.value, null);
	assert.equal(systems.renewal.status, "unknown");
	assert.equal(
		(await one(sql`SELECT count(*)::int n FROM attestation WHERE plant_id=${w.id} AND key='systems_tested'`)).n,
		0,
	);
});

test("AC:B01-026 ages count the church's calendar days in its own zone", async () => {
	const w = await f.workspace();
	await f.admin.execute(sql`UPDATE plant SET timezone='Pacific/Auckland' WHERE id=${w.id}`);
	const a = await seated(w);
	now = "2026-10-13T16:00:00.000Z";
	const made = ok(await attest(a, "prayer_rhythm_established"));
	assert.equal(made.signal.asOf, "2026-10-14");
	now = "2026-11-12T10:59:00.000Z";
	assert.deepEqual((await entry(a, "prayer_rhythm_established")).renewal, { status: "current", daysLeft: 1 });
	now = "2026-11-13T11:00:00.000Z";
	assert.equal((await entry(a, "prayer_rhythm_established")).ageDays, 31);
	assert.deepEqual((await entry(a, "prayer_rhythm_established")).renewal, { status: "needs_renewing" });
});

test("AC:B01-026 Still true refreshes only that signal; stale or wrong requests write nothing", async () => {
	const w = await f.workspace();
	const a = await seated(w);
	now = at(0);
	const answered = async (key: string) => ok(await attest(a, key, "yes")).signal;
	const made = {
		prayer_rhythm_established: await answered("prayer_rhythm_established"),
		prayer_in_gatherings: await answered("prayer_in_gatherings"),
		core_group_giving: await answered("core_group_giving"),
		financial_base_established: await answered("financial_base_established"),
	};
	now = at(20);
	const before = await counts(w);
	refusedBare(
		await reaffirm(a, "financial_base_established", "yes", made.financial_base_established.revision),
		"not_reaffirmable",
	);
	refusedBare(await reaffirm(a, "systems_tested", "yes", "0"), "not_reaffirmable");
	refusedBare(
		await reaffirm(a, "prayer_rhythm_established", "not_yet", made.prayer_rhythm_established.revision),
		"revision_conflict",
	);
	refusedBare(await reaffirm(a, "prayer_rhythm_established", "yes", "9"), "revision_conflict");
	assert.deepEqual(await counts(w), before);
	const renewed = ok(await reaffirm(a, "prayer_rhythm_established", "yes", made.prayer_rhythm_established.revision));
	assert.equal(renewed.signal.ageDays, 0);
	assert.equal(renewed.signal.revision, "2");
	assert.equal(renewed.signal.value, "yes");
	assert.deepEqual(renewed.signal.renewal, { status: "current", daysLeft: 30 });
	assert.equal((await entry(a, "prayer_in_gatherings")).ageDays, 20);
	assert.equal((await entry(a, "core_group_giving")).ageDays, 20);
	assert.equal((await entry(a, "financial_base_established")).ageDays, 20);
	assert.equal((await entry(a, "prayer_in_gatherings")).revision, "1");
	refusedBare(
		await reaffirm(a, "prayer_rhythm_established", "yes", made.prayer_rhythm_established.revision),
		"revision_conflict",
	);
	refusedBare(await reaffirm(a, "core_group_giving", "yes", "0"), "revision_conflict");
	const retracted = ok(
		await correct(a, { action: "retract", key: "core_group_giving" }, made.core_group_giving.revision),
	);
	refusedBare(await reaffirm(a, "core_group_giving", "yes", retracted.signal.revision), "not_current");
	const fresh = await seated(await f.workspace());
	refusedBare(await reaffirm(fresh, "prayer_in_gatherings", "yes", "0"), "not_current");
	const rows_ = await Promise.all([
		reaffirm(a, "prayer_in_gatherings", "yes", made.prayer_in_gatherings.revision),
		reaffirm(a, "core_group_giving", "yes", retracted.signal.revision),
	]);
	assert.equal(rows_[0].status, "ok");
	assert.equal(rows_[1].status, "refused");
	assert.equal((await entry(a, "prayer_in_gatherings")).ageDays, 0);
	const key = randomUUID();
	const current = await entry(a, "prayer_rhythm_established");
	const r1 = ok(await reaffirm(a, "prayer_rhythm_established", "yes", current.revision, key));
	const r2 = ok(await reaffirm(a, "prayer_rhythm_established", "yes", current.revision, key));
	assert.deepEqual(r2, r1);
	assert.equal((await entry(a, "prayer_rhythm_established")).revision, String(Number(current.revision) + 1));
});

test("AC:PI-014 AC:AUDIT-004 every accepted write has one audit row; refusals write nothing; two admins from one revision get one winner", async () => {
	now = at(0);
	const w = await f.workspace();
	const other = await f.workspace();
	const a = await seated(w);
	const b = await seated(w, "owner");
	const member = await seated(w, "member");
	const foreign = await seated(other);
	const before = await counts(w);
	ok(await attest(a, "systems_tested", "yes"));
	assert.deepEqual(await counts(w), { attestations: 1, revisions: 1, audits: 1 });
	const audit = await one(
		sql`SELECT action, kind, actor_id::text AS actor, metadata FROM audit_event WHERE tenant_id=${w.id} AND action LIKE 'attestation.%'`,
	);
	assert.deepEqual(
		[audit.action, audit.kind, audit.actor, audit.metadata],
		["attestation.recorded", "create", a.id, { key: "systems_tested" }],
	);
	ok(await correct(a, { action: "correct", key: "systems_tested", value: "not_yet" }, "1"));
	const corrected = await rows(
		sql`SELECT action FROM audit_event WHERE tenant_id=${w.id} AND action LIKE 'attestation.%' ORDER BY recorded_at, action`,
	);
	assert.deepEqual(corrected.map((r) => r.action).sort(), ["attestation.corrected", "attestation.recorded"]);
	const snapshot = await counts(w);
	refusedBare(await attest(member, "values_documented"), "access_denied");
	refusedBare(await correct(member, { action: "retract", key: "systems_tested" }, "2"), "access_denied");
	refusedBare(await reaffirm(member, "core_group_giving", "yes", "0"), "access_denied");
	ok(await attest(foreign, "systems_tested", "yes"));
	assert.deepEqual(await counts(w), snapshot);
	assert.equal((await one(sql`SELECT count(*)::int n FROM attestation WHERE plant_id=${other.id}`)).n, 1);
	await f.admin.execute(sql`UPDATE seat SET ended_at=clock_timestamp() WHERE account_id=${b.id}`);
	refusedBare(await attest(b, "values_documented"), "access_denied");
	const org = await f.workspace("sending_church");
	const orgAdmin = await seated(org);
	refusedBare(await signals.readAttestations(f.db, orgAdmin.actor, {}), "access_denied");
	refusedBare(await attest(orgAdmin, "values_documented"), "access_denied");
	assert.deepEqual(await counts(w), snapshot);
	void before;
	const c1 = await seated(w),
		c2 = await seated(w);
	for (let round = 0; round < 4; round++) {
		const key = ["values_documented", "prayer_leader_assigned", "prayer_rhythm_established", "core_group_giving"][
			round
		]!;
		const results = await Promise.all([attest(c1, key, "yes"), attest(c2, key, "not_yet")]);
		const wins = results.filter((r) => r.status === "ok"),
			losses = results.filter((r) => r.status === "refused");
		assert.equal(wins.length, 1, key);
		assert.equal(losses.length, 1, key);
		assert.equal(losses[0]!.error.code, "revision_conflict");
		assert.equal(
			(await one(sql`SELECT count(*)::int n FROM attestation_revision WHERE plant_id=${w.id} AND key=${key}`)).n,
			1,
		);
	}
	const base = ok(await attest(c1, "prayer_in_gatherings", "yes")).signal;
	const both = await Promise.all([
		correct(c1, { action: "correct", key: "prayer_in_gatherings", value: "not_yet" }, base.revision),
		correct(c2, { action: "retract", key: "prayer_in_gatherings" }, base.revision),
	]);
	assert.equal(both.filter((r) => r.status === "ok").length, 1);
	assert.equal(both.find((r) => r.status === "refused")!.error.code, "revision_conflict");
});

test("AC:PI-014 a leadership candidate needs both behaviors and 60 inclusive days; shorter periods say why", async () => {
	now = at(0);
	const w = await f.workspace();
	const a = await seated(w);
	const alex = await person(a, "Alex Rivera");
	const base = {
		personId: alex.id,
		periodStart: "2026-08-15",
		periodEnd: "2026-10-13",
		attended: true,
		volunteered: true,
		statement: "Seen at every setup.",
	};
	const made = ok(
		await signals.attestCandidate(f.db, a.actor, { requestKey: randomUUID(), expectedRevision: "0", input: base }),
	).candidate;
	assert.equal(made.days, 60);
	assert.equal(made.established, true);
	assert.deepEqual(made.reasons, []);
	assert.equal(made.statement, "Seen at every setup.");
	assert.ok(made.authorName);
	assert.equal(made.asOf, "2026-10-13");
	const listed = (await page(a)).candidates;
	assert.deepEqual(
		listed.map((x) => [x.personName, x.established]),
		[["Alex Rivera", true]],
	);
	const sam = await person(a, "Sam Ortiz");
	const short = ok(
		await signals.attestCandidate(f.db, a.actor, {
			requestKey: randomUUID(),
			expectedRevision: "0",
			input: { ...base, personId: sam.id, periodStart: "2026-08-16" },
		}),
	).candidate;
	assert.equal(short.days, 59);
	assert.equal(short.established, false);
	assert.deepEqual(short.reasons, ["period_too_short"]);
	const jo = await person(a, "Jo Park");
	const half = ok(
		await signals.attestCandidate(f.db, a.actor, {
			requestKey: randomUUID(),
			expectedRevision: "0",
			input: { ...base, personId: jo.id, volunteered: false, attended: false },
		}),
	).candidate;
	assert.deepEqual(half.reasons, ["attendance_not_attested", "volunteering_not_attested"]);
	for (const [name, attended, volunteered, reasons] of [
		["Pat Mixed", true, false, ["volunteering_not_attested"]],
		["Ray Mixed", false, true, ["attendance_not_attested"]],
	] as const) {
		const who = await person(a, name);
		const saved = ok(
			await signals.attestCandidate(f.db, a.actor, {
				requestKey: randomUUID(),
				expectedRevision: "0",
				input: { ...base, personId: who.id, attended, volunteered },
			}),
		).candidate;
		const read = (await page(a)).candidates.find((x) => x.personId === who.id)!;
		for (const c of [saved, read])
			assert.deepEqual(
				[c.attended, c.volunteered, c.established, c.reasons],
				[attended, volunteered, false, reasons],
				name,
			);
	}
	const key = randomUUID();
	const kay = await person(a, "Kay Lee");
	const one_ = ok(
		await signals.attestCandidate(f.db, a.actor, {
			requestKey: key,
			expectedRevision: "0",
			input: { ...base, personId: kay.id },
		}),
	);
	assert.deepEqual(
		ok(
			await signals.attestCandidate(f.db, a.actor, {
				requestKey: key,
				expectedRevision: "0",
				input: { ...base, personId: kay.id },
			}),
		),
		one_,
	);
	const lee = await person(a, "Lee Day");
	refusedBare(
		await signals.attestCandidate(f.db, a.actor, {
			requestKey: randomUUID(),
			expectedRevision: "0",
			input: { ...base, personId: lee.id, periodEnd: "2026-10-14", asOf: "2026-10-13" },
		}),
		"invalid_input",
	);
	refusedBare(
		await signals.attestCandidate(f.db, a.actor, {
			requestKey: randomUUID(),
			expectedRevision: "0",
			input: { ...base, personId: lee.id, periodStart: "2026-10-13", periodEnd: "2026-10-12" },
		}),
		"invalid_input",
	);
	const stranger = await seated(await f.workspace());
	const foreignPerson = await person(stranger, "Foreign Canary");
	const nothing = await counts(w);
	refusedBare(
		await signals.attestCandidate(f.db, a.actor, {
			requestKey: randomUUID(),
			expectedRevision: "0",
			input: { ...base, personId: foreignPerson.id },
		}),
		"not_found",
	);
	refusedBare(
		await signals.attestCandidate(f.db, a.actor, {
			requestKey: randomUUID(),
			expectedRevision: "0",
			input: { ...base, personId: randomUUID() },
		}),
		"not_found",
	);
	await f.admin.execute(sql`UPDATE person SET state='retired', retired_at=clock_timestamp() WHERE id=${lee.id}`);
	refusedBare(
		await signals.attestCandidate(f.db, a.actor, {
			requestKey: randomUUID(),
			expectedRevision: "0",
			input: { ...base, personId: lee.id },
		}),
		"not_found",
	);
	assert.deepEqual(await counts(w), nothing);
	assert.equal((await page(a)).signals.length, 7);
	const member = await seated(w, "member");
	refusedBare(
		await signals.attestCandidate(f.db, member.actor, {
			requestKey: randomUUID(),
			expectedRevision: "0",
			input: { ...base, personId: alex.id },
		}),
		"access_denied",
	);
});

test("AC:PI-014 a candidate corrects and retracts with history, and a retired Person keeps its row and history", async () => {
	now = at(0);
	const w = await f.workspace();
	const a = await seated(w);
	const mo = await person(a, "Mo Hart");
	const input = {
		personId: mo.id,
		periodStart: "2026-08-01",
		periodEnd: "2026-10-13",
		attended: true,
		volunteered: true,
	};
	const made = ok(
		await signals.attestCandidate(f.db, a.actor, { requestKey: randomUUID(), expectedRevision: "0", input }),
	).candidate;
	refusedBare(
		await signals.correctCandidate(f.db, a.actor, {
			requestKey: randomUUID(),
			expectedRevision: made.revision,
			input: { action: "correct", ...input },
		}),
		"no_change",
	);
	now = at(1);
	const fixed = ok(
		await signals.correctCandidate(f.db, a.actor, {
			requestKey: randomUUID(),
			expectedRevision: made.revision,
			input: { action: "correct", ...input, volunteered: false, asOf: "2026-10-14" },
		}),
	).candidate;
	assert.equal(fixed.established, false);
	assert.equal(fixed.revision, "2");
	const reread = (await page(a)).candidates[0]!;
	assert.deepEqual([reread.personId, reread.attended, reread.volunteered, reread.revision], [mo.id, true, false, "2"]);
	const gone = ok(
		await signals.correctCandidate(f.db, a.actor, {
			requestKey: randomUUID(),
			expectedRevision: fixed.revision,
			input: { action: "retract", personId: mo.id },
		}),
	).candidate;
	assert.equal(gone.state, "retracted");
	assert.equal(gone.established, false);
	refusedBare(
		await signals.correctCandidate(f.db, a.actor, {
			requestKey: randomUUID(),
			expectedRevision: gone.revision,
			input: { action: "retract", personId: mo.id },
		}),
		"not_current",
	);
	refusedBare(
		await signals.correctCandidate(f.db, a.actor, {
			requestKey: randomUUID(),
			expectedRevision: "9",
			input: { action: "retract", personId: mo.id },
		}),
		"revision_conflict",
	);
	const back = ok(
		await signals.attestCandidate(f.db, a.actor, { requestKey: randomUUID(), expectedRevision: gone.revision, input }),
	).candidate;
	assert.equal(back.revision, "4");
	assert.equal(back.established, true);
	const trail = (await page(a)).history.filter((r) => r.key === "leadership_candidate");
	assert.deepEqual(
		trail.map((r) => [r.revision, r.kind]),
		[
			[4, "answered"],
			[3, "retracted"],
			[2, "corrected"],
			[1, "answered"],
		],
	);
	assert.equal(trail[0]!.personName, "Mo Hart");
	assert.equal(trail[0]!.questionVersion, "leadership-candidate/1");
	await f.admin.execute(sql`UPDATE person SET state='retired', retired_at=clock_timestamp() WHERE id=${mo.id}`);
	const view = await page(a);
	assert.deepEqual(view.candidates, [{ ...back, personState: "retired" }]);
	assert.equal(view.history.filter((r) => r.personId === mo.id).length, 4);
	assert.equal(
		view.people.some((x) => x.id === mo.id),
		false,
	);
});

test("AC:PI-014 a retired Person's candidate keeps its row and statement, marked retired, until a restore clears the mark", async () => {
	now = at(0);
	const w = await f.workspace();
	const a = await seated(w);
	const quinn = await person(a, "Quinn Keeper");
	const others = await person(a, "Robin Stay");
	const input = {
		personId: quinn.id,
		periodStart: "2026-08-01",
		periodEnd: "2026-10-13",
		attended: true,
		volunteered: true,
		statement: "Set up chairs every Sunday since August.",
	};
	const made = ok(
		await signals.attestCandidate(f.db, a.actor, { requestKey: randomUUID(), expectedRevision: "0", input }),
	).candidate;
	assert.equal(made.personState, "live");
	assert.deepEqual((await page(a)).candidates, [made]);

	await f.admin.execute(sql`UPDATE person SET state='retired', retired_at=clock_timestamp() WHERE id=${quinn.id}`);
	const retired = await page(a);
	assert.deepEqual(retired.candidates, [{ ...made, personState: "retired" }]);
	assert.equal(
		retired.people.some((x) => x.id === quinn.id),
		false,
	);
	assert.equal(
		retired.people.some((x) => x.id === others.id),
		true,
	);
	const untouched = await counts(w);
	refusedBare(
		await signals.correctCandidate(f.db, a.actor, {
			requestKey: randomUUID(),
			expectedRevision: made.revision,
			input: { action: "correct", ...input, volunteered: false },
		}),
		"not_found",
	);
	assert.deepEqual(await counts(w), untouched);

	await f.admin.execute(sql`UPDATE person SET state='live', retired_at=NULL WHERE id=${quinn.id}`);
	const restored = await page(a);
	assert.deepEqual(restored.candidates, [made]);
	assert.equal(
		restored.people.some((x) => x.id === quinn.id),
		true,
	);
	const fixed = ok(
		await signals.correctCandidate(f.db, a.actor, {
			requestKey: randomUUID(),
			expectedRevision: made.revision,
			input: { action: "correct", ...input, volunteered: false },
		}),
	).candidate;
	assert.equal(fixed.personState, "live");
	assert.equal(fixed.statement, "Set up chairs every Sunday since August.");
});

test("AC:REQ-TEAM-017 recording, correcting and retracting a candidate changes no team, task, phase, notice or job", async () => {
	now = at(0);
	const w = await f.workspace();
	const a = await seated(w);
	const pat = await person(a, "Pat Wills");
	const watched = ["team", "team_role", "team_tenure", "task", "commitment", "phase_transition", "notice", "job"];
	const snapshot = async () => {
		const out: Record<string, unknown> = {};
		for (const t of watched)
			out[t] = (
				await one(
					sql`SELECT count(*)::int n FROM ${sql.identifier(t)} WHERE ${t === "job" || t === "notice" ? sql`tenant_id` : sql`${sql.identifier(t === "task" || t === "commitment" || t === "team" ? "plant_id" : "plant_id")}`}=${w.id}`,
				).catch(() => ({ n: -1 }))
			).n;
		const p = await one(
			sql`SELECT revision::text, stage, commitment_state, household_role FROM person WHERE id=${pat.id}`,
		);
		const plant = await one(sql`SELECT phase, material_revision::text FROM plant WHERE id=${w.id}`);
		return { out, p, plant };
	};
	const before = await snapshot();
	const input = {
		personId: pat.id,
		periodStart: "2026-08-01",
		periodEnd: "2026-10-13",
		attended: true,
		volunteered: true,
	};
	const made = ok(
		await signals.attestCandidate(f.db, a.actor, { requestKey: randomUUID(), expectedRevision: "0", input }),
	).candidate;
	const fixed = ok(
		await signals.correctCandidate(f.db, a.actor, {
			requestKey: randomUUID(),
			expectedRevision: made.revision,
			input: { action: "correct", ...input, attended: false },
		}),
	).candidate;
	ok(
		await signals.correctCandidate(f.db, a.actor, {
			requestKey: randomUUID(),
			expectedRevision: fixed.revision,
			input: { action: "retract", personId: pat.id },
		}),
	);
	assert.deepEqual(await snapshot(), before);
	const org = await seated(await f.workspace("sending_church"));
	refusedBare(await signals.getHistory(f.db, org.actor, { key: null }), "access_denied");
});

test("AC:PI-DISC-001 AC:PI-DISC-002 Foundational modules complete needs one current lead who read all six past 80 percent: such a reader meets it with no new grant, and two readers' halves never pool", async () => {
	const articles = await seedFoundations(f.admin);
	const wiki = createWikiProducer();
	const facts = createFacts();
	const catalog = await readCatalog();
	const readAs = async (who: Seated, ratios: number[]) => {
		for (const [n, ratio] of ratios.entries())
			if (ratio > 0)
				ok(
					await wiki.updateProgress(f.db, who.actor, {
						requestKey: randomUUID(),
						input: { articleId: articles[n]!, fraction: ratio.toFixed(2) },
					}),
				);
	};
	const criterion = async (who: Seated) => {
		const read = ok(await facts.readFacts(f.db, who.actor, {}));
		const row = criteriaOf(catalog, 0, read).find((x) => x.key === "foundations_complete")!;
		assert.equal(row.label, "Foundational modules complete");
		assert.equal(row.status, read.criteria.foundations_complete);
		return row.status;
	};
	const qualifies = async (who: Seated) => ok(await wiki.readingStats(f.db, who.actor, {})).qualifyingReader;
	const grants = () =>
		one<{ seats: number; grants: number }>(sql`SELECT (SELECT count(*)::int FROM seat) seats,
			(SELECT count(*)::int FROM platform_grant) grants`);
	const readAudits = (w: Workspace) =>
		one<{ n: number }>(sql`SELECT count(*)::int n FROM audit_event WHERE tenant_id=${w.id}`);

	const one1 = caseOf("intelligence", "PI-DISC-001");
	const in1 = one1.given["case-input"] as {
		Owner_A_read: number;
		eligibleLead_B_read: number;
		ratios_B: number[];
		lead_B_current_same_plant_Admin: boolean;
	};
	assert.equal(in1.lead_B_current_same_plant_Admin, true);
	const w1 = await f.workspace();
	const A1 = await seated(w1, "owner");
	const B1 = await seated(w1, "admin");
	assert.equal(await criterion(A1), "not_met", "no lead has read the six yet");
	const before = await grants();
	await readAs(
		A1,
		Array.from({ length: in1.Owner_A_read }, () => 0.81),
	);
	assert.equal(in1.ratios_B.length, in1.eligibleLead_B_read);
	await readAs(B1, in1.ratios_B);
	const audited = await readAudits(w1);
	const met = {
		criterion: await criterion(A1),
		qualifying_reader: (await qualifies(B1)) && !(await qualifies(A1)) ? "B" : null,
		new_grants: (await grants()).seats - before.seats + ((await grants()).grants - before.grants),
	};
	assert.deepEqual(met, one1.expected.result);
	assert.equal(await criterion(B1), "met", "the lead's own read agrees");
	assert.deepEqual(await readAudits(w1), audited, "the read writes no audit row");

	const two = caseOf("intelligence", "PI-DISC-002");
	const in2 = two.given["behavior-inputs"] as { reader_progress: { A: number[]; B: number[] } };
	const w2 = await f.workspace();
	const A2 = await seated(w2, "owner");
	const B2 = await seated(w2, "admin");
	await readAs(A2, in2.reader_progress.A);
	await readAs(B2, in2.reader_progress.B);
	assert.deepEqual(
		{
			foundations_complete: (await criterion(A2)) === "met",
			pooled_credit: (await qualifies(A2)) || (await qualifies(B2)),
		},
		two.expected.result,
	);
	assert.equal(await criterion(B2), "not_met");
});

const readiness = (who: Seated, input: unknown, expectedRevision = "0", requestKey: string = randomUUID()) =>
	signals.attestReadiness(f.db, who.actor, { requestKey, expectedRevision, input });
const correctReadiness = (who: Seated, input: unknown, expectedRevision: string, requestKey: string = randomUUID()) =>
	signals.correctReadiness(f.db, who.actor, { requestKey, expectedRevision, input });
const readinessPage = async (who: Seated, key: string | null = null) =>
	ok(await signals.readReadiness(f.db, who.actor, { key }));
const day = (days: number) => at(days).slice(0, 10);

test("AC:PI-028 a dated relationship, worship agreement and community are recorded by an Owner or Admin, replay by request key and refuse a Member, a future date and a stale revision", async () => {
	now = at(0);
	const w = await f.workspace();
	const admin = await seated(w);
	const owner = await seated(w, "owner");
	const member = await seated(w, "member");
	const dana = await person(admin, "Dana Worship");
	assert.equal(
		(await one<{ linked: string | null }>(sql`SELECT linked_account_id AS linked FROM person WHERE id=${dana.id}`))
			.linked,
		null,
	);
	const seen = await readinessPage(admin);
	assert.deepEqual(
		seen.attestations.map((x) => [x.key, x.state, x.revision]),
		[
			["relationship", "unanswered", "0"],
			["worship_agreement", "unanswered", "0"],
			["community", "unanswered", "0"],
		],
	);
	const roots = () =>
		one(sql`SELECT (SELECT count(*)::int FROM plant) plants,(SELECT count(*)::int FROM seat) seats,
			(SELECT count(*)::int FROM affiliation) affiliations,(SELECT count(*)::int FROM platform_grant) grants,
			(SELECT count(*)::int FROM invitation) invitations`);
	const plain = await f.workspace();
	const plainAdmin = await seated(plain);
	const before = await roots();

	const key = randomUUID();
	const relationship = {
		key: "relationship",
		organization: "Hill Country Network",
		mentor: "Pat Mentor",
		asOf: day(-30),
	};
	const first = ok(await readiness(admin, relationship, "0", key)).attestation;
	assert.deepEqual(
		[first.state, first.named, first.reference, first.asOf, first.revision, first.personId, first.statement],
		["answered", "Hill Country Network", "Pat Mentor", day(-30), "1", null, null],
	);
	assert.deepEqual(ok(await readiness(admin, relationship, "0", key)).attestation, first, "a retry replays");
	refusedBare(await readiness(admin, { ...relationship, mentor: "Someone else" }, "0", key), "idempotency_conflict");
	refusedBare(await readiness(owner, { key: "relationship", organization: "Other Network" }), "revision_conflict");
	const noMentor = ok(await readiness(plainAdmin, { key: "relationship", organization: "Grace Church" })).attestation;
	assert.deepEqual([noMentor.reference, noMentor.asOf], [null, day(0)], "the mentor is optional; the date defaults");

	const worship = ok(
		await readiness(owner, {
			key: "worship_agreement",
			personId: dana.id,
			statement: "Agreed at lunch",
			asOf: day(-5),
		}),
	).attestation;
	assert.deepEqual(
		[worship.named, worship.personId, worship.statement, worship.authorName],
		[
			"Dana Worship",
			dana.id,
			"Agreed at lunch",
			(await one<{ n: string }>(sql`SELECT display_name AS n FROM person WHERE linked_account_id=${owner.id}`)).n,
		],
	);
	const area = ok(
		await readiness(admin, { key: "community", area: "  East Riverside  ", plan: "Plan v2" }),
	).attestation;
	assert.deepEqual([area.named, area.reference, area.asOf], ["East Riverside", "Plan v2", day(0)]);

	const kept = await counts(w);
	assert.deepEqual(kept, { attestations: 3, revisions: 3, audits: 3 });
	refusedBare(await readiness(member, { key: "community", area: "Elsewhere" }, "1"), "access_denied");
	refusedBare(
		await correctReadiness(member, { action: "retract", key: "relationship" }, first.revision),
		"access_denied",
	);
	refusedBare(await signals.readReadiness(f.db, member.actor, { key: null }), "access_denied");
	refusedBare(await readiness(plainAdmin, { key: "community", area: "Tomorrow town", asOf: day(1) }), "invalid_input");
	refusedBare(
		await correctReadiness(admin, { action: "correct", attestation: { ...relationship, asOf: day(1) } }, "1"),
		"invalid_input",
	);
	refusedBare(await readiness(plainAdmin, { key: "community", area: "  " }), "invalid_input");
	refusedBare(await readiness(plainAdmin, { key: "worship_agreement", personId: randomUUID() }), "not_found");
	refusedBare(await readiness(plainAdmin, { key: "worship_agreement", personId: dana.id }), "not_found");
	refusedBare(
		await readiness(plainAdmin, { key: "relationship", organization: "X", mentor: "x".repeat(501) }),
		"invalid_input",
	);
	refusedBare(
		await correctReadiness(admin, { action: "correct", attestation: { key: "community", area: "Westside" } }, "7"),
		"revision_conflict",
	);
	assert.deepEqual(await counts(w), kept, "refusals write nothing");

	const audits = await rows<{ action: string; kind: string; key: string }>(
		sql`SELECT action, kind, metadata->>'key' AS key FROM audit_event WHERE tenant_id=${w.id}
			AND action LIKE 'attestation.%' ORDER BY recorded_at, metadata->>'key'`,
	);
	assert.deepEqual(
		audits.map((a) => [a.action, a.kind]),
		[
			["attestation.recorded", "create"],
			["attestation.recorded", "create"],
			["attestation.recorded", "create"],
		],
	);
	assert.deepEqual(await roots(), before, "the attestations add no plant, seat, affiliation, grant or invitation");

	const old = await page(admin);
	assert.equal(old.signals.length, 7);
	assert.deepEqual(old.history, [], "the manual-signal page lists none of the new attestations");
	assert.deepEqual(ok(await signals.getHistory(f.db, admin.actor, { key: null })).revisions, []);
});

test("AC:PI-028 the three attestations correct and retract with their history kept; a retracted one answers again only from its revision", async () => {
	now = at(0);
	const w = await f.workspace();
	const a = await seated(w);
	const sam = await person(a, "Sam Singer");
	const lee = await person(a, "Lee Leader");
	const area = ok(await readiness(a, { key: "community", area: "Northside", asOf: day(-20) })).attestation;
	refusedBare(
		await correctReadiness(
			a,
			{ action: "correct", attestation: { key: "community", area: "Northside", asOf: day(-20) } },
			area.revision,
		),
		"no_change",
	);
	const moved = ok(
		await correctReadiness(
			a,
			{ action: "correct", attestation: { key: "community", area: "Southside", plan: "Plan B", asOf: day(-2) } },
			area.revision,
		),
	).attestation;
	assert.deepEqual([moved.named, moved.reference, moved.asOf, moved.revision], ["Southside", "Plan B", day(-2), "2"]);

	const worship = ok(await readiness(a, { key: "worship_agreement", personId: sam.id, asOf: day(-10) })).attestation;
	const swapped = ok(
		await correctReadiness(
			a,
			{ action: "correct", attestation: { key: "worship_agreement", personId: lee.id, asOf: day(-10) } },
			worship.revision,
		),
	).attestation;
	assert.deepEqual([swapped.named, swapped.personId], ["Lee Leader", lee.id]);
	const gone = ok(
		await correctReadiness(a, { action: "retract", key: "worship_agreement" }, swapped.revision),
	).attestation;
	assert.deepEqual(
		[gone.state, gone.named, gone.personId, gone.asOf, gone.revision],
		["retracted", null, null, day(0), "3"],
	);
	refusedBare(await correctReadiness(a, { action: "retract", key: "worship_agreement" }, gone.revision), "not_current");
	refusedBare(await correctReadiness(a, { action: "retract", key: "relationship" }, "0"), "not_current");
	refusedBare(await readiness(a, { key: "worship_agreement", personId: sam.id }, "0"), "revision_conflict");
	const again = ok(await readiness(a, { key: "worship_agreement", personId: sam.id }, gone.revision)).attestation;
	assert.deepEqual([again.state, again.named, again.revision], ["answered", "Sam Singer", "4"]);

	const history = (await readinessPage(a, "worship_agreement")).history;
	assert.deepEqual(
		history.map((h) => [h.kind, h.revision, h.asOf, h.named, h.questionVersion]),
		[
			["answered", 4, day(0), "Sam Singer", "readiness-attestations/1"],
			["retracted", 3, day(0), "Lee Leader", "readiness-attestations/1"],
			["corrected", 2, day(-10), "Lee Leader", "readiness-attestations/1"],
			["answered", 1, day(-10), "Sam Singer", "readiness-attestations/1"],
		],
	);
	const all = await readinessPage(a);
	assert.equal(all.history.length, 6);
	assert.deepEqual(
		all.attestations.map((x) => [x.key, x.state, x.named]),
		[
			["relationship", "unanswered", null],
			["worship_agreement", "answered", "Sam Singer"],
			["community", "answered", "Southside"],
		],
	);
	assert.deepEqual(await counts(w), { attestations: 2, revisions: 6, audits: 6 });
	const both = await Promise.all([
		correctReadiness(a, { action: "retract", key: "community" }, moved.revision),
		correctReadiness(a, { action: "correct", attestation: { key: "community", area: "Westside" } }, moved.revision),
	]);
	assert.equal(both.filter((r) => r.status === "ok").length, 1);
	assert.equal(both.find((r) => r.status === "refused")!.error.code, "revision_conflict");
	const racers = await Promise.all([
		readiness(a, { key: "relationship", organization: "First Network" }),
		readiness(a, { key: "relationship", organization: "Second Network" }),
	]);
	assert.equal(racers.filter((r) => r.status === "ok").length, 1);
	assert.equal(racers.find((r) => r.status === "refused")!.error.code, "revision_conflict");
	const fresh = await f.workspace();
	const b = await seated(fresh);
	const [one1, two] = [await person(b, "First Singer"), await person(b, "Second Singer")];
	const singers = await Promise.all([
		readiness(b, { key: "worship_agreement", personId: one1.id }),
		readiness(b, { key: "worship_agreement", personId: two.id }),
	]);
	assert.equal(singers.filter((r) => r.status === "ok").length, 1, "one worship agreement per church");
	assert.equal(singers.find((r) => r.status === "refused")!.error.code, "revision_conflict");
	assert.equal(
		(
			await one<{ n: number }>(
				sql`SELECT count(*)::int n FROM attestation WHERE plant_id=${fresh.id} AND key='worship_agreement'`,
			)
		).n,
		1,
	);
});
