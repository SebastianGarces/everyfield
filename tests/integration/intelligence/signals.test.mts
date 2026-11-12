import test, { after, before } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { sql } from "../../../packages/db/src/query.ts";
import { fixture } from "../identity/invitations-support.mts";
import { createSignals } from "../../../packages/domain/src/intelligence/index.ts";
import { peopleWriter } from "../../../packages/domain/src/people/index.ts";
import { MANUAL_SIGNALS } from "../../../docs/reference/manual-signals.ts";
import { ok, refusedWith } from "../../support/fixture.mts";

// WP-039 slice 2: manual signals and leadership-candidate attestations through the signals operations the Attestations
// page calls, on a scratch schema of the development or CI database. The clock is injected so ages are exact.

let f, signals;
let now = "2026-10-13T16:00:00.000Z";
const clock = { now: () => now };
const refusedBare = refusedWith({ details: {} });
const rows = async (q) => (await f.admin.execute(q)).rows;
const one = async (q) => (await rows(q))[0];
const rejects = (promise, pattern) =>
	assert.rejects(promise, (e) => {
		assert.match(String(e.cause?.message ?? e.message), pattern);
		return true;
	});
const DAY = 86_400_000;
const at = (days) => new Date(Date.parse("2026-10-13T16:00:00.000Z") + days * DAY).toISOString();

let named = 0;
/** The first Owner or Admin of each church, whose session creates the Persons Members cannot create. */
const founders = new Map();
/** An account with a seat in `w` and, like a planter, its own Person in that church to show its name. */
async function seated(w, role = "admin") {
	const a = await f.account();
	await f.seat(a, w, role);
	const who = { ...a, w, actor: await f.actor(a.session) };
	if (w.kind !== "plant") return who;
	if (role !== "member" && !founders.has(w.id)) founders.set(w.id, who);
	const own = await person(role === "member" ? founders.get(w.id) : who, `Planter ${++named}`);
	await f.admin.execute(sql`UPDATE person SET linked_account_id=${a.id} WHERE id=${own.id}`);
	return who;
}
async function person(who, displayName) {
	return ok(
		await f.db.transaction((tx) =>
			peopleWriter.createPerson(
				tx,
				{ session: who.session, selected: { kind: "plant", id: who.w.id } },
				{
					requestKey: randomUUID(),
					input: { displayName, adultClassification: "adult" },
				},
			),
		),
	).person;
}
const page = async (who) => ok(await signals.readAttestations(f.db, who.actor, {}));
const entry = async (who, key) => (await page(who)).signals.find((x) => x.key === key);
const attest = (who, key, value = "yes", extra = {}, expectedRevision = "0", requestKey = randomUUID()) =>
	signals.attest(f.db, who.actor, { requestKey, expectedRevision, input: { key, value, ...extra } });
const correct = (who, input, expectedRevision, requestKey = randomUUID()) =>
	signals.correct(f.db, who.actor, { requestKey, expectedRevision, input });
const reaffirm = (who, key, expectedValue, expectedRevision, requestKey = randomUUID()) =>
	signals.reaffirm(f.db, who.actor, { requestKey, expectedRevision, input: { key, expectedValue } });
const counts = (w) =>
	one(sql`SELECT (SELECT count(*)::int FROM attestation WHERE plant_id=${w.id}) attestations,
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
		assert.equal(d.label, MANUAL_SIGNALS[i].label);
		assert.equal(d.description, MANUAL_SIGNALS[i].description);
		assert.equal(d.reaffirms, MANUAL_SIGNALS[i].reaffirms);
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
	// An Owner reads the same page as an Admin.
	const owned = await page(await seated(w, "owner"));
	assert.deepEqual([owned.signals, owned.counts], [view.signals, view.counts]);
	refusedBare(await signals.readAttestations(f.db, member.actor, {}), "access_denied");
	refusedBare(await signals.getHistory(f.db, member.actor, { key: null }), "access_denied");
	const ended = await seated(w);
	await f.admin.execute(sql`UPDATE seat SET ended_at=clock_timestamp() WHERE account_id=${ended.id}`);
	refusedBare(await signals.readAttestations(f.db, ended.actor, {}), "access_denied");
	// A foreign church's admin reads only its own page.
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
	// An answer with a detail, a reference and an earlier date.
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
	// Tomorrow in the church's zone is the future.
	refusedBare(await attest(a, "systems_tested", "yes", { asOf: "2026-10-14" }), "invalid_input");
	assert.equal((await entry(a, "systems_tested")).state, "unanswered");
	// A retry with the same key returns the first result and writes nothing again.
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
	// The same key for a different request is refused and writes nothing.
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
	// Never-answered signals have nothing to correct or retract.
	refusedBare(await correct(a, { action: "retract", key: "systems_tested" }, "0"), "not_current");
	const view = await page(a);
	assert.equal(view.counts.notAnswered, 7);
	// A retracted signal is answered again, and every earlier answer stays.
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
	assert.equal(one_[1].detail, "Monthly pledges");
	assert.equal(one_[1].reference, "Giving sheet");
	assert.equal(one_[1].questionVersion, "manual-signals/1");
	assert.equal(one_[1].asOf, "2026-10-13");
	assert.ok(one_[1].authorName);
	assert.ok(one_[1].recordedAt);
	const whole = ok(await signals.getHistory(f.db, a.actor, { key: null })).revisions;
	assert.equal(whole.length, 3);
	assert.deepEqual(
		whole.map((r) => r.key),
		["core_group_giving", "values_documented", "core_group_giving"],
	);
	// The runtime login (f.db) cannot rewrite or delete history.
	await rejects(
		f.db.execute(sql`UPDATE attestation_revision SET detail='x' WHERE plant_id=${w.id}`),
		/permission denied/,
	);
	await rejects(f.db.execute(sql`DELETE FROM attestation_revision WHERE plant_id=${w.id}`), /permission denied/);
	await rejects(f.db.execute(sql`DELETE FROM attestation WHERE plant_id=${w.id}`), /permission denied/);
	// Even the owner role cannot change a recorded field (SCHEMA-007).
	await rejects(
		f.admin.execute(sql`UPDATE attestation_revision SET detail='x' WHERE plant_id=${w.id}`),
		/immutable_source_evidence/,
	);
	// No other authority writes a revision: a Member cannot.
	const member = await seated(w, "member");
	refusedBare(await attest(member, "systems_tested"), "access_denied");
	assert.equal((await counts(w)).revisions, 3);
});

test("AC:B01-025 AC:B01-026 ages, renewal at 31 days, and funding that never expires", async () => {
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
	const status = async (key) => (await entry(a, key)).renewal;
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
	// Funding at 100 days is not expired; the other non-reaffirming signals never expire either.
	now = at(100);
	for (const key of ["financial_base_established", "values_documented", "prayer_leader_assigned"]) {
		assert.deepEqual(await status(key), { status: "does_not_expire" }, key);
		assert.equal((await entry(a, key)).value, "yes");
	}
	const view = await page(a);
	assert.deepEqual(view.counts, { current: 3, needsRenewing: 3, notAnswered: 1 });
	// A systems owner or completed systems task is not an answer: nothing here wrote one.
	const systems = await entry(a, "systems_tested");
	assert.equal(systems.state, "unanswered");
	assert.equal(systems.value, null);
	assert.equal(systems.renewal.status, "unknown");
	assert.equal(
		(await one(sql`SELECT count(*)::int n FROM attestation WHERE plant_id=${w.id} AND key='systems_tested'`)).n,
		0,
	);
});

test("AC:B01-025 ages count the church's calendar days in its own zone", async () => {
	const w = await f.workspace();
	await f.admin.execute(sql`UPDATE plant SET timezone='Pacific/Auckland' WHERE id=${w.id}`);
	const a = await seated(w);
	// 2026-10-13T16:00Z is already Oct 14 in Auckland (UTC+13 in October).
	now = "2026-10-13T16:00:00.000Z";
	const made = ok(await attest(a, "prayer_rhythm_established"));
	assert.equal(made.signal.asOf, "2026-10-14");
	now = "2026-11-12T10:59:00.000Z"; // Nov 12 23:59 in Auckland: age 29
	assert.deepEqual((await entry(a, "prayer_rhythm_established")).renewal, { status: "current", daysLeft: 1 });
	now = "2026-11-13T11:00:00.000Z"; // Nov 14 00:00 in Auckland: age 31
	assert.equal((await entry(a, "prayer_rhythm_established")).ageDays, 31);
	assert.deepEqual((await entry(a, "prayer_rhythm_established")).renewal, { status: "needs_renewing" });
});

test("AC:B01-025 AC:B01-026 Still true refreshes only that signal; stale or wrong requests write nothing", async () => {
	const w = await f.workspace();
	const a = await seated(w);
	now = at(0);
	const made = {};
	for (const key of [
		"prayer_rhythm_established",
		"prayer_in_gatherings",
		"core_group_giving",
		"financial_base_established",
	])
		made[key] = ok(await attest(a, key, "yes")).signal;
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
	// A stale reviewed revision is refused after the signal moved on.
	refusedBare(
		await reaffirm(a, "prayer_rhythm_established", "yes", made.prayer_rhythm_established.revision),
		"revision_conflict",
	);
	// An unanswered signal and a retracted signal cannot be reaffirmed.
	refusedBare(await reaffirm(a, "core_group_giving", "yes", "0"), "revision_conflict");
	const retracted = ok(
		await correct(a, { action: "retract", key: "core_group_giving" }, made.core_group_giving.revision),
	);
	refusedBare(await reaffirm(a, "core_group_giving", "yes", retracted.signal.revision), "not_current");
	const fresh = await seated(await f.workspace());
	refusedBare(await reaffirm(fresh, "prayer_in_gatherings", "yes", "0"), "not_current");
	// One failed row does not undo the others: each reaffirm is its own write.
	const rows_ = await Promise.all([
		reaffirm(a, "prayer_in_gatherings", "yes", made.prayer_in_gatherings.revision),
		reaffirm(a, "core_group_giving", "yes", retracted.signal.revision),
	]);
	assert.equal(rows_[0].status, "ok");
	assert.equal(rows_[1].status, "refused");
	assert.equal((await entry(a, "prayer_in_gatherings")).ageDays, 0);
	// A reaffirm keeps the value, detail and reference, and replays on its key.
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
	// Refusals leave nothing behind.
	const snapshot = await counts(w);
	refusedBare(await attest(member, "values_documented"), "access_denied");
	refusedBare(await correct(member, { action: "retract", key: "systems_tested" }, "2"), "access_denied");
	refusedBare(await reaffirm(member, "core_group_giving", "yes", "0"), "access_denied");
	// An admin of another church names this church's signal: it is theirs alone.
	ok(await attest(foreign, "systems_tested", "yes"));
	assert.deepEqual(await counts(w), snapshot);
	assert.equal((await one(sql`SELECT count(*)::int n FROM attestation WHERE plant_id=${other.id}`)).n, 1);
	await f.admin.execute(sql`UPDATE seat SET ended_at=clock_timestamp() WHERE account_id=${b.id}`);
	refusedBare(await attest(b, "values_documented"), "access_denied");
	// An organization seat has no authority over a church.
	const org = await f.workspace("sending_church");
	const orgAdmin = await seated(org);
	refusedBare(await signals.readAttestations(f.db, orgAdmin.actor, {}), "access_denied");
	refusedBare(await attest(orgAdmin, "values_documented"), "access_denied");
	assert.deepEqual(await counts(w), snapshot);
	void before;
	// Two admins save a first answer from the same revision: one wins, one revision_conflict.
	const c1 = await seated(w),
		c2 = await seated(w);
	for (let round = 0; round < 4; round++) {
		const key = ["values_documented", "prayer_leader_assigned", "prayer_rhythm_established", "core_group_giving"][
			round
		];
		const results = await Promise.all([attest(c1, key, "yes"), attest(c2, key, "not_yet")]);
		const wins = results.filter((r) => r.status === "ok"),
			losses = results.filter((r) => r.status === "refused");
		assert.equal(wins.length, 1, key);
		assert.equal(losses.length, 1, key);
		assert.equal(losses[0].error.code, "revision_conflict");
		assert.equal(
			(await one(sql`SELECT count(*)::int n FROM attestation_revision WHERE plant_id=${w.id} AND key=${key}`)).n,
			1,
		);
	}
	// And two corrections of the same revision.
	const base = ok(await attest(c1, "prayer_in_gatherings", "yes")).signal;
	const both = await Promise.all([
		correct(c1, { action: "correct", key: "prayer_in_gatherings", value: "not_yet" }, base.revision),
		correct(c2, { action: "retract", key: "prayer_in_gatherings" }, base.revision),
	]);
	assert.equal(both.filter((r) => r.status === "ok").length, 1);
	assert.equal(both.find((r) => r.status === "refused").error.code, "revision_conflict");
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
	// Aug 15 to Oct 13 is 60 inclusive days.
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
	// 59 days, one behavior missing, and both.
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
	// Each box is stored as sent, and the list reads back the current statement's values.
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
		const read = (await page(a)).candidates.find((x) => x.personId === who.id);
		for (const c of [saved, read])
			assert.deepEqual(
				[c.attended, c.volunteered, c.established, c.reasons],
				[attended, volunteered, false, reasons],
				name,
			);
	}
	// A retry replays; a period ending after the as-of date, or after today, is invalid.
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
	// A foreign or retired Person gives not_found.
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
	// Not an eighth signal: the signal list is unchanged and a Member cannot record one.
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
	// The same facts are no change.
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
	const reread = (await page(a)).candidates[0];
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
	// Recording again after the retraction is allowed.
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
	assert.equal(trail[0].personName, "Mo Hart");
	assert.equal(trail[0].questionVersion, "leadership-candidate/1");
	// Retiring the Person keeps its row, marked retired, and its history on that Person; the picker drops it.
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
	// Only the person's state changes: name, statement, period, status, author and date stay as they were.
	assert.deepEqual(retired.candidates, [{ ...made, personState: "retired" }]);
	// The picker still offers only live Persons, and a write for the retired Person still refuses.
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
		const out = {};
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
	// Organization reads get nothing new: the organization seat cannot read candidates or history.
	const org = await seated(await f.workspace("sending_church"));
	refusedBare(await signals.getHistory(f.db, org.actor, { key: null }), "access_denied");
});
