import test, { after, before } from "node:test";
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
import { allowedWrites } from "../../../../../packages/evry/src/proposals/store.ts";
import { transaction } from "../../../../../apps/web/src/server/platform/database.ts";
import { claimDue, finishClaim } from "../../../../../apps/web/src/server/jobs/queue.ts";
import { meetingsWriter } from "../../../../../packages/domain/src/meetings/index.ts";
import { accounts, actor, admin, db, plant, setup, sql, teardown } from "../../../runtime/support.mts";
import { localDate, native, seedMeetings, type Seeded } from "../support.mts";

// The Meetings reviewed writes end to end: a turn proposes, the review shows the exact change and everything it
// generates, nothing changes before Approve, and the approval runs the native command once under the approver's
// current authority. A review whose target changed since, or an approver who lost the authority, is refused.

let owner: EvryActor, seeded: Seeded;
before(async () => {
	await setup();
	owner = await actor("owner");
	seeded = await seedMeetings(owner);
});
after(teardown);

/** A running turn in a new conversation: the only place a proposal can be prepared. */
async function turn(who: EvryActor) {
	const c = await createConversation(db, who, { requestKey: randomUUID() });
	await submitTurn(db, who, c.id, { requestKey: randomUUID(), text: "hold this turn" });
	const [claim] = await claimDue(db, ["assistant_turn"], 1, 240);
	assert.ok(claim);
	const lease = { turnId: claim.id, tenantId: claim.tenant_id, leaseOwner: claim.lease_owner, generation: claim.claim_generation };
	return (operation: string, input: unknown) => prepareProposal(db, who, lease, c.id, { operation, input });
}
const reminders: unknown[] = [];
/** Approve the exact revision shown, then run the effect once through the WP-031 queue. */
async function approveAndRun(who: EvryActor, proposal: Proposal) {
	await approveProposal(db, who, proposal.id, { revision: proposal.revision, digest: proposal.digest }, null);
	const [claim] = await claimDue(db, ["evry_effect"], 1, 60);
	assert.ok(claim);
	const outcome = await executeProposal(
		db,
		{ jobId: claim.id, tenantId: claim.tenant_id, leaseOwner: claim.lease_owner, generation: claim.claim_generation },
		async (_tx, sources) => void reminders.push(sources),
	);
	await transaction(db, (tx) => finishClaim(tx, claim, { state: outcome === "failed" ? "failed" : "succeeded" }));
	assert.deepEqual(await claimDue(db, ["evry_effect"], 1, 60), [], "the effect is queued once");
	return { outcome, review: await readReview(db, who, proposal.id) };
}
const field = (p: Proposal, name: string) => p.review.changes.find((c) => c.field === name)?.after;
const count = async (query: ReturnType<typeof sql>) => Number((await admin.execute(query)).rows[0]!.n);
const audits = async (proposalId: string) =>
	count(sql`SELECT count(*)::int n FROM audit_event WHERE request_key LIKE ${"evry:" + proposalId + ":%"}`);

test("a meeting is scheduled at the reviewed church-local time and venue only after Approve, once", async () => {
	const propose = await turn(owner);
	const meetings = () => count(sql`SELECT count(*)::int n FROM meeting WHERE plant_id=${plant}`);
	const before = await meetings();
	const date = localDate(9);
	const proposal = await propose("meetings.schedule", {
		type: "vision_meeting",
		date,
		time: "19:00",
		venueId: seeded.venue,
	});
	assert.ok(proposal);
	assert.equal(proposal.review.target, null);
	assert.match(String(field(proposal, "when")), /, 7:00 PM C[DS]T$/);
	assert.match(String(field(proposal, "when")), new RegExp(new Date(`${date}T12:00:00Z`).getUTCDate() + ", "));
	assert.equal(field(proposal, "venue"), "Coffee shop, 12 Main St, Oak Park, IL");
	assert.equal(field(proposal, "type"), "Vision meeting");
	assert.equal(await meetings(), before, "Meetings is unchanged before Approve");
	const { outcome, review } = await approveAndRun(owner, proposal);
	assert.equal(outcome, "completed");
	assert.equal(review.outcome, "completed");
	assert.equal(await meetings(), before + 1);
	const made = (
		await admin.execute(sql`SELECT local_date::text AS d, to_char(local_time,'HH24:MI') AS t, venue_name, timezone
			FROM meeting WHERE plant_id=${plant} AND local_date=${date}::date`)
	).rows;
	assert.deepEqual(made, [{ d: date, t: "19:00", venue_name: "Coffee shop", timezone: "America/Chicago" }]);
	assert.equal(await audits(proposal.id), 1, "the native command's own audit row, once");
});

test("a walk-in named only Luis is reviewed with the meeting and duplicate hints, and recorded as attended after Approve", async () => {
	// Another Luis is already in People: the review names that possible duplicate (a same-name hint, never proof).
	const earlier = randomUUID();
	await admin.execute(sql`INSERT INTO person(id,tenant_id,plant_id,display_name,source,created_at,stage,adult_classification,commitment_state,pipeline_position,state)
		VALUES(${earlier},${plant},${plant},'Luis','other',clock_timestamp(),'attendee','unknown','unknown',900,'live')`);
	const propose = await turn(owner);
	const luis = () =>
		admin.execute(sql`SELECT id,first_name,last_name,email,phone,stage FROM person
			WHERE plant_id=${plant} AND display_name='Luis' AND id<>${earlier}`);
	const people = () => count(sql`SELECT count(*)::int n FROM person WHERE plant_id=${plant}`);
	const guests = () => count(sql`SELECT count(*)::int n FROM participation WHERE meeting_id=${seeded.vision.id}`);
	const [peopleBefore, guestsBefore] = [await people(), await guests()];
	const proposal = await propose("meetings.createWalkInContact", { meetingId: seeded.vision.id, displayName: "Luis" });
	assert.ok(proposal);
	assert.deepEqual(proposal.review.target, { kind: "meeting", id: seeded.vision.id, label: "Vision night" });
	assert.equal(field(proposal, "newPerson"), "Luis");
	assert.deepEqual(field(proposal, "possibleDuplicates"), ["Luis (same name)"]);
	assert.equal(field(proposal, "attendance"), "attended (walk-in)");
	assert.deepEqual(
		proposal.review.changes.map((c) => c.field).filter((f) => /email|phone|last/i.test(f)),
		[],
	);
	assert.equal(await people(), peopleBefore, "People is unchanged before Approve");
	assert.equal(await guests(), guestsBefore, "the meeting is unchanged before Approve");
	const { outcome } = await approveAndRun(owner, proposal);
	assert.equal(outcome, "completed");
	assert.equal(await people(), peopleBefore + 1);
	const [row] = (await luis()).rows as { id: string; last_name: string | null; email: string | null; phone: string | null }[];
	assert.ok(row);
	assert.deepEqual([row.last_name, row.email, row.phone], [null, null, null]);
	const presence = await admin.execute(
		sql`SELECT presence FROM participation WHERE meeting_id=${seeded.vision.id} AND person_id=${row.id}`,
	);
	assert.deepEqual(presence.rows, [{ presence: "attended" }]);
});

test("marking three attended and finalizing is one review listing every task it creates; after Approve exactly those exist", async () => {
	const propose = await turn(owner);
	const meetingId = seeded.middle.id;
	const { maria, alex, casey } = seeded.guests;
	const tasks = () =>
		admin.execute(sql`SELECT t.title FROM task t JOIN obligation o ON t.obligation_id=o.id AND t.deleted_at IS NULL
			WHERE o.meeting_id=${meetingId} ORDER BY t.title`);
	const proposal = await propose("meetings.finalizeAttendance", { meetingId, attendeeIds: [maria, alex, casey] });
	assert.ok(proposal);
	assert.equal(proposal.review.refusal, undefined);
	assert.deepEqual(field(proposal, "attended"), [
		"Maria Santos (first Vision)",
		"Alex Kim (first Vision)",
		"Casey Lee (first Vision)",
	]);
	const listed = field(proposal, "tasks") as string[];
	assert.equal(listed.length, 4, "three first-Vision follow-ups and the evaluation task");
	assert.deepEqual((await tasks()).rows, [], "no task exists before Approve");
	const finalized = () => admin.execute(sql`SELECT finalized_at IS NOT NULL AS f FROM meeting WHERE id=${meetingId}`);
	assert.deepEqual((await finalized()).rows, [{ f: false }]);
	const { outcome } = await approveAndRun(owner, proposal);
	assert.equal(outcome, "completed");
	assert.deepEqual((await finalized()).rows, [{ f: true }]);
	const made = ((await tasks()).rows as { title: string }[]).map((t) => `${t.title} (needs an owner)`).sort();
	assert.deepEqual(made, [...listed].sort(), "the card's task list is exactly the tasks created");
});

test("an evaluation review shows exactly the planter's scores, and nothing is recorded before Approve", async () => {
	const propose = await turn(owner);
	const scores = {
		attendanceScore: 4,
		locationScore: 5,
		logisticsScore: 3,
		agendaScore: 4,
		vibeScore: 5,
		messageScore: 4,
		closeScore: 3,
		nextStepsScore: 4,
	};
	const proposal = await propose("meetings.recordEvaluation", { meetingId: seeded.last.id, scores });
	assert.ok(proposal);
	assert.deepEqual(
		Object.fromEntries(Object.keys(scores).map((k) => [k, field(proposal, k)])),
		Object.fromEntries(Object.entries(scores).map(([k, v]) => [k, String(v)])),
	);
	assert.equal(field(proposal, "average"), "4");
	const evaluated = () => admin.execute(sql`SELECT evaluation_scores FROM meeting WHERE id=${seeded.last.id}`);
	assert.deepEqual((await evaluated()).rows, [{ evaluation_scores: null }]);
	assert.equal((await approveAndRun(owner, proposal)).outcome, "completed");
	assert.deepEqual((await evaluated()).rows, [{ evaluation_scores: [4, 5, 3, 4, 5, 4, 3, 4] }]);
});

test("a review whose meeting changed since is refused at execution and overwrites nothing", async () => {
	const propose = await turn(owner);
	const proposal = await propose("meetings.edit", { meetingId: seeded.training.id, title: "Team training night" });
	assert.ok(proposal);
	assert.deepEqual(proposal.review.changes, [{ field: "title", before: "Team training", after: "Team training night" }]);
	const rev = (await admin.execute(sql`SELECT revision::text AS r FROM meeting WHERE id=${seeded.training.id}`)).rows[0]!.r;
	await native(owner, meetingsWriter.edit as never, {
		expectedRevision: rev,
		input: { meetingId: seeded.training.id, patch: { notes: "Bring laptops" } },
	});
	const { outcome, review } = await approveAndRun(owner, proposal);
	assert.equal(outcome, "refused");
	assert.equal(review.receipt?.code, "revision_conflict");
	const title = (await admin.execute(sql`SELECT title FROM meeting WHERE id=${seeded.training.id}`)).rows[0]!.title;
	assert.equal(title, "Team training");
});

test("an approver who is no longer an Owner or Admin cannot approve a delete; a Member is never offered one", async () => {
	const member = await actor("member");
	assert.equal(
		allowedWrites(member).some((w) => w.operation === "meetings.delete"),
		false,
	);
	await assert.rejects(
		(await turn(member))("meetings.delete", { meetingId: seeded.training.id, reason: "No longer needed" }),
		{ code: "access_denied" },
	);
	const propose = await turn(owner);
	const proposal = await propose("meetings.delete", { meetingId: seeded.training.id, reason: "No longer needed" });
	assert.ok(proposal);
	await admin.execute(sql`UPDATE seat SET role='member' WHERE account_id=${accounts.owner.id}`);
	try {
		const demoted = await actor("owner");
		await assert.rejects(
			approveProposal(db, demoted, proposal.id, { revision: proposal.revision, digest: proposal.digest }, null),
		);
		const live = (await admin.execute(sql`SELECT retired_at FROM meeting WHERE id=${seeded.training.id}`)).rows[0]!;
		assert.equal(live.retired_at, null);
	} finally {
		await admin.execute(sql`UPDATE seat SET role='owner' WHERE account_id=${accounts.owner.id}`);
	}
});

test("a Member who is not the ministry's leader gets a review that says who can make the change, with no Approve", async () => {
	const member = await actor("member");
	const proposal = await (await turn(member))("meetings.schedule", {
		type: "vision_meeting",
		date: localDate(10),
		time: "19:00",
	});
	assert.ok(proposal);
	assert.match(String(proposal.review.refusal), /Owner or Admin/);
	await assert.rejects(
		approveProposal(db, member, proposal.id, { revision: proposal.revision, digest: proposal.digest }, null),
	);
});
