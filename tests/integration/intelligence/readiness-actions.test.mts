import { appCookie, appModule, closeAppPools, inRequest, useApp } from "../target/wp-056/security-web.mts";
import test, { after, before } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { sql } from "../../../packages/db/src/query.ts";
import { fixture, type Fixture } from "../identity/invitations-support.mts";
import { createFacts, createSignals } from "../../../packages/domain/src/intelligence/index.ts";
import { ok } from "../../support/fixture.mts";
import { gatedTransaction } from "../../../packages/domain/src/operations/writes.ts";
import { peopleWriter } from "../../../packages/domain/src/people/index.ts";

type Outcome = { status: "ok"; value: { attestation: Record<string, unknown> } } | { status: string; error?: unknown };
type Actions = {
	attestReadiness: (key: string, revision: string, input: unknown) => Promise<Outcome>;
	correctReadiness: (key: string, revision: string, input: unknown) => Promise<Outcome>;
};
let f: Fixture;
let actions: Actions;
const signals = createSignals();
const facts = createFacts();
type Workspace = Awaited<ReturnType<Fixture["workspace"]>>;

before(async () => {
	f = await fixture();
	useApp(f.runtimeUrl);
	actions = await appModule<Actions>("features/intelligence/readiness-actions.ts");
});
after(async () => {
	await closeAppPools();
	await f?.close();
});

async function seated(w: Workspace, role: "owner" | "admin" | "member") {
	const a = await f.account();
	await f.seat(a, w, role);
	return { ...a, cookie: await appCookie(f.admin, a.session), actor: await f.actor(a.session) };
}
type Seated = Awaited<ReturnType<typeof seated>>;
const as = (who: { cookie: string }) => ({
	attest: (revision: string, input: unknown, key = randomUUID()) =>
		inRequest({ cookie: who.cookie }, () => actions.attestReadiness(key, revision, input)),
	correct: (revision: string, input: unknown, key = randomUUID()) =>
		inRequest({ cookie: who.cookie }, () => actions.correctReadiness(key, revision, input)),
});
const saved = (r: Outcome) => {
	assert.equal(r.status, "ok", JSON.stringify(r));
	return (r as Extract<Outcome, { status: "ok" }>).value.attestation;
};
const refused = (r: Outcome, code: string) => {
	assert.equal(r.status, "refused", JSON.stringify(r));
	assert.equal((r as { error: { code: string } }).error.code, code);
};
const criterion = async (who: Seated, key: string) =>
	(ok(await facts.readFacts(f.db, who.actor)).criteria as Record<string, unknown>)[key];
const history = async (who: Seated, key: string) =>
	ok(await signals.readReadiness(f.db, who.actor, { key })).history.map((h) => [h.kind, h.named, h.reference]);
const counts = async () =>
	(
		await f.admin.execute(sql`SELECT (SELECT count(*)::int FROM attestation_revision) revisions,
		(SELECT count(*)::int FROM seat) seats,(SELECT count(*)::int FROM affiliation) affiliations,
		(SELECT count(*)::int FROM platform_grant) grants,(SELECT count(*)::int FROM invitation) invitations`)
	).rows[0];
const today = () => new Date().toISOString().slice(0, 10);

test("INV-readiness-actions: record, correct, retract and record again; the criterion follows", async () => {
	const w = await f.workspace();
	const admin = await seated(w, "admin");
	const before = await counts();
	assert.notEqual(await criterion(admin, "coach_assigned"), "met");
	const first = saved(
		await as(admin).attest("0", { key: "relationship", organization: "Hill Country Network", mentor: "Pat Mentor" }),
	);
	assert.deepEqual([first.named, first.reference, first.revision], ["Hill Country Network", "Pat Mentor", "1"]);
	assert.equal(await criterion(admin, "coach_assigned"), "met");
	const after = await counts();
	assert.deepEqual(
		{ ...after, revisions: 0 },
		{ ...before, revisions: 0 },
		"no seat, affiliation, grant or invitation",
	);

	const fixed = saved(
		await as(admin).correct("1", {
			action: "correct",
			attestation: { key: "relationship", organization: "Hill Country Network", mentor: "", asOf: today() },
		}),
	);
	assert.deepEqual([fixed.reference, fixed.revision], [null, "2"]);
	refused(
		await as(admin).correct("2", {
			action: "correct",
			attestation: { key: "relationship", organization: "Hill Country Network", mentor: "", asOf: today() },
		}),
		"no_change",
	);
	refused(await as(admin).correct("1", { action: "retract", key: "relationship" }), "revision_conflict");
	const gone = saved(await as(admin).correct("2", { action: "retract", key: "relationship" }));
	assert.deepEqual([gone.state, gone.named], ["retracted", null]);
	assert.notEqual(await criterion(admin, "coach_assigned"), "met");
	assert.deepEqual(await history(admin, "relationship"), [
		["retracted", "Hill Country Network", null],
		["corrected", "Hill Country Network", null],
		["answered", "Hill Country Network", "Pat Mentor"],
	]);
	const again = saved(await as(admin).attest("3", { key: "relationship", organization: "Grace Church" }));
	assert.deepEqual([again.state, again.named, again.revision], ["answered", "Grace Church", "4"]);
});

test("INV-readiness-actions: a worship agreement names a person with no account", async () => {
	const w = await f.workspace();
	const owner = await seated(w, "owner");
	const dana = ok(
		await gatedTransaction(f.db, (tx) =>
			peopleWriter.createPerson(
				tx,
				{ session: owner.session, selected: w },
				{ requestKey: randomUUID(), input: { displayName: "Dana Worship", adultClassification: "adult" } },
			),
		),
	).person.id;
	const linked = await f.admin.execute(sql`SELECT linked_account_id FROM person WHERE id=${dana}`);
	assert.equal(linked.rows[0]?.linked_account_id, null, "Dana has no account");
	const worship = saved(
		await as(owner).attest("0", { key: "worship_agreement", personId: dana, statement: "Agreed at lunch" }),
	);
	assert.deepEqual([worship.named, worship.personId, worship.statement], ["Dana Worship", dana, "Agreed at lunch"]);
	assert.equal(await criterion(owner, "worship_leader"), "met");
	const area = saved(await as(owner).attest("0", { key: "community", area: "East Riverside", plan: "Plan v2" }));
	assert.deepEqual([area.named, area.reference], ["East Riverside", "Plan v2"]);
	assert.equal(await criterion(owner, "geographic_area"), "met");
});

test("INV-readiness-actions: a Member or no seat is refused and nothing is saved", async () => {
	const w = await f.workspace();
	const member = await seated(w, "member");
	const before = await counts();
	refused(await as(member).attest("0", { key: "community", area: "East Riverside" }), "access_denied");
	refused(await as(member).correct("1", { action: "retract", key: "community" }), "access_denied");
	refused(await as({ cookie: "" }).attest("0", { key: "community", area: "East Riverside" }), "access_denied");
	assert.deepEqual(await counts(), before);
});
