// The phase and manual-signal reviewed writes (adapters/intelligence): Evry only prepares the exact review, and the
// native phases.* or signals.* command runs once, for the approving Owner, after that exact revision is approved.
// Before approval nothing in the church changes.
import test, { before, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import {
	approveProposal,
	createConversation,
	executeProposal,
	prepareProposal,
	readReview,
	submitTurn,
	type EvryActor,
	type Proposal,
} from "../../../../../packages/evry/src/index.ts";
import { transaction } from "../../../../../apps/web/src/server/platform/database.ts";
import { claimDue, finishClaim } from "../../../../../apps/web/src/server/jobs/queue.ts";
import { actor, admin, db, otherPlant, plant, setup, sql, teardown } from "../../../runtime/support.mts";

before(setup);
after(teardown);

/** No forward move here reaches a connected organization, and no write hands a task on. */
const ports = {
	reminders: async () => {
		throw Error("unexpected task reminder replan");
	},
	phaseNotices: async () => {
		throw Error("unexpected phase notice");
	},
};
/** Core Group Development's exit criteria (docs/reference/phase-exit-criteria.ts); none has measured data yet. */
const CORE_GROUP_CRITERIA = [
	"30 committed adults",
	"Growth still moving",
	"Launch funding viable",
	"Worship leader identified",
	"Geographic area set",
].map((label) => ({ label, status: "no data yet" }));

/** A running turn in a new conversation: the only place a proposal can be prepared. */
async function turn(who: EvryActor) {
	const c = await createConversation(db, who, { requestKey: randomUUID() });
	await submitTurn(db, who, c.id, { requestKey: randomUUID(), text: "hold this turn" });
	const [claim] = await claimDue(db, ["assistant_turn"], 1, 240);
	assert.ok(claim);
	const run = {
		turnId: claim.id,
		tenantId: claim.tenant_id,
		leaseOwner: claim.lease_owner,
		generation: claim.claim_generation,
	};
	return { propose: (operation: string, input: unknown) => prepareProposal(db, who, run, c.id, { operation, input }) };
}

/** The trusted approval of the exact revision shown, then the effect run once through the WP-031 queue. */
async function approveAndRun(who: EvryActor, proposal: Proposal) {
	await approveProposal(db, who, proposal.id, { revision: proposal.revision, digest: proposal.digest });
	const [claim] = await claimDue(db, ["evry_effect"], 1, 60);
	assert.ok(claim);
	const outcome = await executeProposal(
		db,
		{ jobId: claim.id, tenantId: claim.tenant_id, leaseOwner: claim.lease_owner, generation: claim.claim_generation },
		ports,
	);
	await transaction(db, (tx) => finishClaim(tx, claim, { state: outcome === "failed" ? "failed" : "succeeded" }));
	return { outcome, review: await readReview(db, who, proposal.id) };
}

const phaseOf = async (id: string) =>
	(await admin.execute(sql`SELECT phase,revision::text FROM plant WHERE id=${id}`)).rows[0] as {
		phase: number;
		revision: string;
	};
const moves = async (id: string) =>
	(
		await admin.execute(
			sql`SELECT kind,from_phase,to_phase,reason FROM phase_transition WHERE plant_id=${id} ORDER BY recorded_at,id`,
		)
	).rows;
/** The native command's own audit rows for the effect, keyed by the effect key. */
const effectAudits = async (proposalId: string) =>
	(
		await admin.execute(
			sql`SELECT actor_id,action FROM audit_event WHERE request_key LIKE ${"evry:" + proposalId + ":%"} ORDER BY recorded_at`,
		)
	).rows;
const today = () =>
	new Intl.DateTimeFormat("en-CA", { timeZone: "America/Chicago", year: "numeric", month: "2-digit", day: "2-digit" })
		.format(new Date())
		.slice(0, 10);

test("phases.declare is offered only while the church has no declared phase, and records it only after approval", async () => {
	// The foreign actor is an Admin of a church that has never declared or moved.
	const adminOfOther = await actor("foreign");
	const t = await turn(adminOfOther);
	const proposal = await t.propose("phases.declare", { phase: 0 });
	assert.ok(proposal);
	assert.deepEqual(proposal.review, {
		target: { kind: "plant", id: otherPlant, label: "Synthetic" },
		changes: [{ field: "phase", before: "Core Group Development", after: "Discovery" }],
	});
	assert.equal((await phaseOf(otherPlant)).phase, 1, "nothing changes before approval");
	assert.deepEqual(await moves(otherPlant), []);

	const run = await approveAndRun(adminOfOther, proposal);
	assert.deepEqual([run.outcome, run.review.outcome], ["completed", "completed"]);
	assert.equal((await phaseOf(otherPlant)).phase, 0);
	assert.deepEqual(
		(await moves(otherPlant)).map((m) => [m.kind, m.from_phase, m.to_phase]),
		[["initial_declaration", 1, 0]],
	);
	assert.deepEqual(await effectAudits(proposal.id), [{ actor_id: adminOfOther.accountId, action: "phase.declared" }]);
	// Declared once: no second declaration is offered.
	assert.equal(await t.propose("phases.declare", { phase: 2 }), null);
});

test("a phase move lists the open exit criteria, changes the phase only after approval and labels a move backward", async () => {
	const owner = await actor("owner");
	const t = await turn(owner);
	const reason = "Our core group is ready to form launch teams.";
	const forward = await t.propose("phases.transition", { toPhase: 2, reason });
	assert.ok(forward);
	assert.deepEqual(forward.review, {
		target: { kind: "plant", id: plant, label: "Synthetic" },
		changes: [
			{ field: "phase", before: "Core Group Development", after: "Launch Team Formation" },
			{ field: "direction", before: null, after: "forward" },
			{ field: "reason", before: null, after: reason },
			{ field: "openCriteria", before: null, after: CORE_GROUP_CRITERIA },
		],
	});
	const backward = await t.propose("phases.transition", { toPhase: 0, reason: "We are starting over." });
	assert.deepEqual(backward?.review.changes.slice(0, 2), [
		{ field: "phase", before: "Core Group Development", after: "Discovery" },
		{ field: "direction", before: null, after: "backward" },
	]);
	// The same phase is not a move: the card says why and offers no approval.
	const same = await t.propose("phases.transition", { toPhase: 1, reason: "Still here." });
	assert.equal(same?.review.refusal, "The church is already in Core Group Development.");
	assert.deepEqual(await phaseOf(plant), { phase: 1, revision: "1" }, "nothing changes before approval");

	const run = await approveAndRun(owner, forward);
	assert.equal(run.outcome, "completed");
	assert.equal((await phaseOf(plant)).phase, 2);
	assert.deepEqual(await moves(plant), [{ kind: "movement", from_phase: 1, to_phase: 2, reason }]);
	assert.deepEqual(await effectAudits(forward.id), [{ actor_id: owner.accountId, action: "phase.transitioned" }]);

	// The backward review was for phase 1: after the move it is stale and its effect refuses, changing nothing.
	const stale = await approveAndRun(owner, backward!);
	assert.deepEqual([stale.outcome, stale.review.receipt?.code], ["refused", "revision_conflict"]);
	assert.equal((await phaseOf(plant)).phase, 2);

	// A Member may propose none of them, the same floor as the native commands.
	const member = await actor("member");
	await assert.rejects(
		() =>
			prepareProposal(db, member, { turnId: randomUUID(), tenantId: plant, leaseOwner: "x", generation: "1" }, randomUUID(), {
				operation: "phases.transition",
				input: { toPhase: 3, reason },
			}),
		(e: { code?: string }) => e.code === "access_denied",
	);
});

test("a reported signal is recorded in the Owner's words only after approval; a correction and a reaffirmation each need their own", async () => {
	const owner = await actor("owner");
	const t = await turn(owner);
	const answers = async () =>
		(
			await admin.execute(
				sql`SELECT state,answer,as_of::text,statement,revision::text FROM attestation WHERE plant_id=${plant} AND key='prayer_rhythm_established'`,
			)
		).rows;
	const words = "We started prayer and fasting this week.";
	const asOf = today();
	const attest = await t.propose("signals.attest", {
		key: "prayer_rhythm_established",
		value: "yes",
		asOf,
		detail: words,
	});
	assert.ok(attest);
	assert.deepEqual(attest.review, {
		target: { kind: "plant", id: plant, label: "Synthetic" },
		changes: [
			{ field: "signal", before: null, after: "Corporate prayer rhythm established" },
			{ field: "value", before: null, after: "yes" },
			{ field: "asOf", before: null, after: asOf },
			{ field: "detail", before: null, after: words },
		],
	});
	// A date after today is shown with the reason it cannot be approved.
	const future = await t.propose("signals.attest", {
		key: "prayer_rhythm_established",
		value: "yes",
		asOf: "2999-01-01",
		detail: words,
	});
	assert.equal(future?.review.refusal, "A signal can't be true as of a date after today.");
	assert.deepEqual(await answers(), [], "nothing is recorded before approval");

	assert.equal((await approveAndRun(owner, attest)).outcome, "completed");
	assert.deepEqual(await answers(), [{ state: "answered", answer: true, as_of: asOf, statement: words, revision: "1" }]);
	const recorded = await admin.execute(
		sql`SELECT actor_id,action FROM audit_event WHERE tenant_id=${plant} AND action LIKE 'attestation.%'`,
	);
	assert.deepEqual(recorded.rows, [{ actor_id: owner.accountId, action: "attestation.recorded" }]);
	// Recorded once: a second record is shown as already answered.
	const again = await t.propose("signals.attest", {
		key: "prayer_rhythm_established",
		value: "yes",
		asOf,
		detail: words,
	});
	assert.equal(again?.review.refusal, "This signal already has an answer. Ask Evry to correct or reaffirm it instead.");

	const correction = "We stopped meeting to pray for now.";
	const correct = await t.propose("signals.correct", {
		action: "correct",
		key: "prayer_rhythm_established",
		value: "not_yet",
		asOf,
		detail: correction,
	});
	assert.deepEqual(correct?.review.changes, [
		{ field: "signal", before: null, after: "Corporate prayer rhythm established" },
		{ field: "value", before: "yes", after: "not_yet" },
		{ field: "asOf", before: asOf, after: asOf },
		{ field: "detail", before: words, after: correction },
	]);
	assert.equal((await answers())[0]!.revision, "1", "the correction waits for its own approval");
	assert.equal((await approveAndRun(owner, correct!)).outcome, "completed");
	assert.deepEqual(await answers(), [
		{ state: "answered", answer: false, as_of: asOf, statement: correction, revision: "2" },
	]);

	const reaffirm = await t.propose("signals.reaffirm", { key: "prayer_rhythm_established" });
	assert.deepEqual(reaffirm?.review.changes, [
		{ field: "signal", before: null, after: "Corporate prayer rhythm established" },
		{ field: "value", before: "not_yet", after: "not_yet" },
		{ field: "asOf", before: asOf, after: "today" },
	]);
	assert.equal((await answers())[0]!.revision, "2", "the reaffirmation waits for its own approval");
	assert.equal((await approveAndRun(owner, reaffirm!)).outcome, "completed");
	assert.equal((await answers())[0]!.revision, "3");
	const kinds = await admin.execute(
		sql`SELECT kind FROM attestation_revision WHERE plant_id=${plant} AND key='prayer_rhythm_established' ORDER BY revision`,
	);
	assert.deepEqual(
		kinds.rows.map((r) => r.kind),
		["answered", "corrected", "reaffirmed"],
	);
	// A signal that never renews cannot be reaffirmed.
	const fixed = await t.propose("signals.reaffirm", { key: "values_documented" });
	assert.equal(fixed?.review.refusal, "This signal doesn't need renewing, so it can't be reaffirmed.");
});
