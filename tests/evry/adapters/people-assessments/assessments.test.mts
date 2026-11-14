import test, { before, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import {
	approveProposal,
	createConversation,
	EvryRefusal,
	executeProposal,
	invokeRead,
	prepareProposal,
	readCatalog,
	readReview,
	submitTurn,
	type EvryActor,
	type Proposal,
} from "../../../../packages/evry/src/index.ts";
import { ASSESSMENT_READS } from "../../../../packages/evry/src/adapters/people-assessments/reads/index.ts";
import { liveRowKeys } from "../../../../packages/evry/src/conversations/liveness.ts";
import { mergeBlockedText } from "../../../../packages/contracts/src/people/merge/copy.ts";
import { transaction } from "../../../../apps/web/src/server/platform/database.ts";
import { claimDue, finishClaim } from "../../../../apps/web/src/server/jobs/queue.ts";
import { accounts, actor, admin, db, otherPlant, plant, setup, sql, teardown } from "../../runtime/support.mts";

// The Evry interview, 4 C's, commitment, merge and correction adapters (WP-061, WP-062) against the native People
// operations: an Owner reads and records exactly what they give after approving the review; a Member, an organization
// seat and another church get nothing from this area.

before(setup);
after(teardown);

const noReminders = async () => {
	throw Error("unexpected task reminder replan");
};
const reads = new Map(ASSESSMENT_READS.map((a) => [a.operation, a]));
const read = (who: EvryActor, operation: string, input: unknown) =>
	invokeRead(db, who, reads.get(operation)! as never, input as never);

async function addPerson(name: string, stage = "prospect", tenant = plant) {
	const id = randomUUID();
	await admin.execute(sql`INSERT INTO person(id,tenant_id,plant_id,display_name,source,created_at,stage,adult_classification,commitment_state,pipeline_position,state)
		VALUES(${id},${tenant},${tenant},${name},'other',clock_timestamp()-interval '1 day',${stage},'unknown','unknown',1000,'live')`);
	return id;
}
const churchToday = async () =>
	String(
		(await admin.execute(sql`SELECT (clock_timestamp() AT TIME ZONE 'America/Chicago')::date::text AS d`)).rows[0]!.d,
	);
const daysAgo = (day: string, n: number) =>
	new Date(Date.parse(`${day}T12:00:00Z`) - n * 86_400_000).toISOString().slice(0, 10);

async function turn(who: EvryActor) {
	const c = await createConversation(db, who, { requestKey: randomUUID() });
	await submitTurn(db, who, c.id, { requestKey: randomUUID(), text: "hold this turn" });
	const [claim] = await claimDue(db, ["assistant_turn"], 1, 240);
	assert.ok(claim);
	const lease = {
		turnId: claim.id,
		tenantId: claim.tenant_id,
		leaseOwner: claim.lease_owner,
		generation: claim.claim_generation,
	};
	return (operation: string, input: unknown) => prepareProposal(db, who, lease, c.id, { operation, input });
}
async function approveAndRun(who: EvryActor, proposal: Proposal) {
	await approveProposal(db, who, proposal.id, { revision: proposal.revision, digest: proposal.digest }, null);
	const [claim] = await claimDue(db, ["evry_effect"], 1, 60);
	assert.ok(claim);
	const outcome = await executeProposal(
		db,
		{ jobId: claim.id, tenantId: claim.tenant_id, leaseOwner: claim.lease_owner, generation: claim.claim_generation },
		{ reminders: noReminders, phaseNotices: async () => undefined },
	);
	await transaction(db, (tx) => finishClaim(tx, claim, { state: outcome === "failed" ? "failed" : "succeeded" }));
	return { outcome, review: await readReview(db, who, proposal.id) };
}
const stageOf = async (id: string) =>
	String((await admin.execute(sql`SELECT stage FROM person WHERE id=${id}`)).rows[0]!.stage);
const rating = (r: string, notes: string | null = null) => ({ rating: r, notes });
const INTERVIEW = {
	maturity: { rating: "pass" },
	gifted: { rating: "pass" },
	chemistry: { rating: "concern" },
	rightReasons: { rating: "pass" },
	season: { rating: "pass" },
	result: "qualified_with_notes",
};

test("INV-evry-assessments: only an Owner or Admin of the plant gets the interview, 4 C's, commitment and merge reads", async () => {
	const ops = (who: EvryActor) =>
		readCatalog(who)
			.domains.find((d) => d.domain === "peopleAssessments")
			?.operations.map((o) => o.operation) ?? [];
	assert.deepEqual(ops(await actor("owner")), [...reads.keys()]);
	assert.deepEqual(ops(await actor("member")), []);
	assert.deepEqual(ops(await actor("orgOwner")), []);
	// The reviewed writes follow the same floor.
	const writes = (who: EvryActor) => readCatalog(who).reviewedWrites.map((w) => w.operation);
	assert.ok(writes(await actor("owner")).includes("people.createInterview"));
	assert.equal(writes(await actor("member")).includes("people.createInterview"), false);
	const member = await actor("member");
	await assert.rejects(read(member, "people.getInterviews", { personId: randomUUID() }), (e) => {
		assert.ok(e instanceof EvryRefusal);
		assert.equal(e.code, "access_denied");
		return true;
	});
});

test("INV-evry-assessments SAF-01: an Owner reads a recorded interview exactly; another church's Admin reads nothing of it", async () => {
	const owner = await actor("owner");
	const daniel = await addPerson("Daniel Cruz", "following_up");
	const propose = await turn(owner);
	const proposal = await propose("people.createInterview", {
		personId: daniel,
		occurredOn: "2026-10-02",
		...INTERVIEW,
		chemistry: { rating: "concern", notes: "Still getting to know the team." },
	});
	assert.ok(proposal);
	assert.equal((await approveAndRun(owner, proposal)).outcome, "completed");
	const got = await read(owner, "people.getInterviews", { personId: daniel });
	assert.equal(got.rows.length, 1);
	assert.deepEqual(got.rows[0]!.fields, {
		record: "interview",
		personId: daniel,
		occurredOn: "2026-10-02",
		maturity: "pass",
		maturityNotes: null,
		gifted: "pass",
		giftedNotes: null,
		chemistry: "concern",
		chemistryNotes: "Still getting to know the team.",
		rightReasons: "pass",
		rightReasonsNotes: null,
		season: "pass",
		seasonNotes: null,
		result: "qualified_with_notes",
		nextSteps: null,
	});
	const foreign = await actor("foreign");
	assert.deepEqual((await read(foreign, "people.getInterviews", { personId: daniel })).rows, []);
	// A record row stays only while the conversation's account is an Owner or Admin of the church.
	const key = `record:${got.rows[0]!.id}`;
	assert.ok((await liveRowKeys(db, owner, [{ kind: "record", id: got.rows[0]!.id }])).has(key));
	await admin.execute(sql`UPDATE seat SET role='member' WHERE account_id=${accounts.owner.id}`);
	try {
		const demoted = await actor("owner");
		assert.equal((await liveRowKeys(db, demoted, [{ kind: "record", id: got.rows[0]!.id }])).has(key), false);
	} finally {
		await admin.execute(sql`UPDATE seat SET role='owner' WHERE account_id=${accounts.owner.id}`);
	}
});

test("INV-evry-assessments: an interview review holds exactly the given ratings and date, records nothing before approval, then advances the stage", async () => {
	const owner = await actor("owner");
	const person = await addPerson("Jordan Vale", "following_up");
	const yesterday = daysAgo(await churchToday(), 1);
	const propose = await turn(owner);
	// A request that leaves out a criterion cannot be proposed: nothing fills it in.
	const { season: _, ...partial } = INTERVIEW;
	await assert.rejects(propose("people.createInterview", { personId: person, occurredOn: yesterday, ...partial }), {
		code: "invalid_input",
	});
	const { result: __, ...noResult } = INTERVIEW;
	await assert.rejects(propose("people.createInterview", { personId: person, occurredOn: yesterday, ...noResult }), {
		code: "invalid_input",
	});
	const proposal = await propose("people.createInterview", { personId: person, occurredOn: yesterday, ...INTERVIEW });
	assert.ok(proposal);
	assert.deepEqual(proposal.review.changes, [
		{ field: "occurredOn", before: null, after: yesterday },
		{ field: "maturity", before: null, after: rating("pass") },
		{ field: "gifted", before: null, after: rating("pass") },
		{ field: "chemistry", before: null, after: rating("concern") },
		{ field: "rightReasons", before: null, after: rating("pass") },
		{ field: "season", before: null, after: rating("pass") },
		{ field: "result", before: null, after: "qualified_with_notes" },
		{ field: "stage", before: "following_up", after: "interviewed" },
	]);
	assert.equal(proposal.review.refusal, undefined);
	const count = async () =>
		(await admin.execute(sql`SELECT count(*)::int n FROM interview WHERE person_id=${person}`)).rows[0]!.n;
	assert.equal(await count(), 0);
	assert.equal((await approveAndRun(owner, proposal)).outcome, "completed");
	assert.equal(await count(), 1);
	assert.equal(await stageOf(person), "interviewed");
	const recorder = await admin.execute(
		sql`SELECT actor_id FROM audit_event WHERE subject_id=${person} AND action='people.recorded'`,
	);
	assert.deepEqual(recorder.rows, [{ actor_id: accounts.owner.id }]);
	// A date after the church's today is refused on the card itself.
	const future = await propose("people.createInterview", {
		personId: person,
		occurredOn: daysAgo(await churchToday(), -2),
		...INTERVIEW,
	});
	assert.match(String(future?.review.refusal), /after today/);
});

test("INV-evry-assessments: a 4 C's review shows the four scores and their total, and the stage stays", async () => {
	const owner = await actor("owner");
	const maria = await addPerson("Maria Santos", "prospect");
	const today = await churchToday();
	const propose = await turn(owner);
	const scores = {
		committed: { score: 4 },
		compelled: { score: 5 },
		contagious: { score: 3 },
		courageous: { score: 4 },
	};
	const { courageous: _, ...three } = scores;
	await assert.rejects(propose("people.createAssessment", { personId: maria, occurredOn: today, ...three }), {
		code: "invalid_input",
	});
	const proposal = await propose("people.createAssessment", { personId: maria, occurredOn: today, ...scores });
	assert.ok(proposal);
	assert.deepEqual(
		proposal.review.changes.map((c) => [c.field, c.after]),
		[
			["occurredOn", today],
			["committed", { score: 4, notes: null }],
			["compelled", { score: 5, notes: null }],
			["contagious", { score: 3, notes: null }],
			["courageous", { score: 4, notes: null }],
			["total", 16],
		],
	);
	assert.equal((await approveAndRun(owner, proposal)).outcome, "completed");
	const got = await read(owner, "people.getAssessments", { personId: maria });
	assert.equal(got.rows[0]!.fields.total, "16");
	assert.equal(await stageOf(maria), "prospect");
});

test("INV-evry-assessments: a commitment is recorded for this church's Alex only, and withdrawn and reactivated each through a review that keeps the stage", async () => {
	const owner = await actor("owner");
	const alex = await addPerson("Alex Signer", "interviewed");
	const otherAlex = await addPerson("Alex Signer", "core_group", otherPlant);
	const today = await churchToday();
	const signed = daysAgo(today, 9);
	const propose = await turn(owner);
	// Another church's person is never a target.
	assert.equal(
		await propose("people.createCommitment", { personId: otherAlex, kind: "core_group", occurredOn: signed }),
		null,
	);
	const card = await propose("people.createCommitment", { personId: alex, kind: "core_group", occurredOn: signed });
	assert.ok(card);
	assert.deepEqual(card.review.changes, [
		{ field: "kind", before: null, after: "core_group" },
		{ field: "occurredOn", before: null, after: signed },
		{ field: "stage", before: "interviewed", after: "core_group" },
	]);
	assert.equal((await approveAndRun(owner, card)).outcome, "completed");
	const got = await read(owner, "people.getCommitments", { personId: alex });
	assert.deepEqual(
		got.rows.map((r) => [r.fields.record, r.fields.state ?? r.fields.occurredOn]),
		[
			["commitment_status", "active"],
			["commitment", signed],
		],
	);
	assert.deepEqual((await read(owner, "people.getCommitments", { personId: otherAlex })).rows, []);

	const withdraw = await propose("people.withdrawCommitment", { personId: alex, effectiveOn: daysAgo(today, 2) });
	assert.ok(withdraw);
	assert.deepEqual(withdraw.review.changes, [
		{ field: "commitment", before: "active", after: "withdrawn" },
		{ field: "effectiveOn", before: signed, after: daysAgo(today, 2) },
	]);
	assert.equal((await approveAndRun(owner, withdraw)).outcome, "completed");
	assert.equal(await stageOf(alex), "core_group");
	// Withdrawing again has nothing to withdraw: the card says so and offers no approval.
	const again = await propose("people.withdrawCommitment", { personId: alex, effectiveOn: today });
	assert.equal(again?.review.refusal, "This person has no active commitment to withdraw.");
	const reactivate = await propose("people.reactivateCommitment", { personId: alex, effectiveOn: today });
	assert.ok(reactivate);
	assert.equal((await approveAndRun(owner, reactivate)).outcome, "completed");
	const after = await read(owner, "people.getCommitments", { personId: alex });
	assert.equal(after.rows[0]!.fields.state, "active");
	assert.equal(await stageOf(alex), "core_group");
});

test("INV-evry-assessments GAP-EVR-423: a card's signed document comes back as the People page's own download route", async () => {
	const owner = await actor("owner");
	const person = await addPerson("Ana Document", "core_group");
	const [object, card] = [randomUUID(), randomUUID()];
	await admin.execute(sql`INSERT INTO file_object(id,tenant_id,purpose,opaque_key,media_type,max_bytes,byte_count,sha256,state,upload_key,claim_generation)
		VALUES(${object},${plant},'commitment',${`private/${plant}/${object}`},'application/pdf',2048,2048,${"0".repeat(64)},'ready',${object},0)`);
	await admin.execute(sql`INSERT INTO commitment(id,plant_id,person_id,kind,signed_on,recorded_at,object_id)
		VALUES(${card},${plant},${person},'core_group','2026-09-20',clock_timestamp(),${object})`);
	const got = await read(owner, "people.getCommitmentDownload", { commitmentId: card });
	assert.deepEqual(got.rows[0]!.fields, {
		record: "commitment_document",
		href: `/people/${person}/commitments/${card}/document`,
		mediaType: "application/pdf",
		byteCount: "2048",
	});
	assert.deepEqual(
		(await read(await actor("foreign"), "people.getCommitmentDownload", { commitmentId: card })).rows,
		[],
	);
});

test("INV-evry-assessments CLN-03: a merge review shows who stays and what moves, merges once approved, and undoes through its own review", async () => {
	const owner = await actor("owner");
	const jon = await addPerson("Jon Merge");
	const john = await addPerson("John Merge");
	await admin.execute(
		sql`UPDATE person SET email='john.merge@example.org',created_at=clock_timestamp() WHERE id=${john}`,
	);
	await admin.execute(sql`INSERT INTO person_note(id,tenant_id,plant_id,person_id,author_id,body,occurred_at,recorded_at)
		VALUES(${randomUUID()},${plant},${plant},${john},${accounts.owner.id},'Met at the park.',clock_timestamp(),clock_timestamp())`);
	const review = await read(owner, "people.getMergeReview", { sourceId: john, survivorId: jon });
	const summary = review.rows.find((r) => r.kind === "merge")!;
	assert.deepEqual([summary.fields.moves, summary.fields.blocked], ["1 note", null]);
	const propose = await turn(owner);
	const merge = await propose("people.mergePeople", { sourceId: john, survivorId: jon });
	assert.ok(merge);
	assert.deepEqual(merge.review.changes, [
		{ field: "keeps", before: null, after: "Jon Merge" },
		{ field: "mergesIn", before: null, after: "John Merge" },
		{ field: "moves", before: null, after: "1 note" },
		// The People merge's default: the survivor's empty email takes the source's; the name stays Jon's.
		{ field: "email", before: null, after: "john.merge@example.org" },
		{ field: "keptDetails", before: null, after: "Name" },
	]);
	assert.equal((await approveAndRun(owner, merge)).outcome, "completed");
	const merged = await admin.execute(sql`SELECT state,merged_into_person_id FROM person WHERE id=${john}`);
	assert.deepEqual(merged.rows, [{ state: "merged", merged_into_person_id: jon }]);
	assert.equal(
		(await admin.execute(sql`SELECT email FROM person WHERE id=${jon}`)).rows[0]!.email,
		"john.merge@example.org",
	);

	const preview = await read(owner, "people.previewUnmerge", { personId: jon });
	const row = preview.rows[0]!;
	assert.deepEqual([row.fields.comesBack, row.fields.movesBack, row.fields.blocked], ["John Merge", "1 note", null]);
	const undo = await propose("people.unmergePeople", { mergeId: row.id });
	assert.ok(undo);
	assert.equal(undo.review.refusal, undefined);
	assert.equal((await approveAndRun(owner, undo)).outcome, "completed");
	assert.equal((await admin.execute(sql`SELECT state FROM person WHERE id=${john}`)).rows[0]!.state, "live");
	// Undone already: the preview and the card say so, and nothing can be approved.
	const done = await read(owner, "people.previewUnmerge", { mergeId: row.id });
	assert.equal(done.rows[0]!.fields.blocked, "This merge was already undone.");
});

test("INV-evry-assessments: a merge People can't carry yet gives the People screen's blocked answer and merges nothing", async () => {
	const owner = await actor("owner");
	const casey = await addPerson("Casey Kept");
	const brooks = await addPerson("Casey Blocked");
	await admin.execute(sql`INSERT INTO contact_outcome(plant_id,person_id,outcome,occurred_at,recorded_at,contact_channel)
		VALUES(${plant},${brooks},'contacted',clock_timestamp(),clock_timestamp(),'phone')`);
	const propose = await turn(owner);
	const merge = await propose("people.mergePeople", { sourceId: brooks, survivorId: casey });
	assert.ok(merge);
	const text = mergeBlockedText(
		{ causes: ["unregistered_reference"], references: ["contact_outcome"] },
		{ source: "Casey Blocked", survivor: "Casey Kept" },
	);
	assert.equal(
		text,
		"This merge cannot run. Casey Blocked has follow-up outcomes on record. Merging people with this history is not available in Everyfield yet.",
	);
	assert.equal(merge.review.refusal, text);
	await assert.rejects(approveProposal(db, owner, merge.id, { revision: merge.revision, digest: merge.digest }, null), {
		code: "review_closed",
	});
	assert.equal((await admin.execute(sql`SELECT state FROM person WHERE id=${brooks}`)).rows[0]!.state, "live");
});

test("INV-evry-assessments: correcting an interview's date shows the old and new date, and the history keeps the original", async () => {
	const owner = await actor("owner");
	const person = await addPerson("Dana Fix", "following_up");
	const propose = await turn(owner);
	const recorded = await propose("people.createInterview", {
		personId: person,
		occurredOn: "2026-10-03",
		...INTERVIEW,
	});
	assert.ok(recorded);
	await approveAndRun(owner, recorded);
	const [interview] = (await read(owner, "people.getInterviews", { personId: person })).rows;
	const fix = await propose("people.correctPersonRecord", {
		recordType: "interview",
		recordId: interview!.id,
		changes: { occurredOn: "2026-10-02" },
	});
	assert.ok(fix);
	assert.deepEqual(fix.review.changes, [{ field: "occurredOn", before: "2026-10-03", after: "2026-10-02" }]);
	assert.equal((await approveAndRun(owner, fix)).outcome, "completed");
	assert.equal(
		(await read(owner, "people.getInterviews", { personId: person })).rows[0]!.fields.occurredOn,
		"2026-10-02",
	);
	const history = await read(owner, "people.listRecordCorrections", { personId: person });
	assert.deepEqual(
		history.rows.map((r) => r.fields.changes),
		[JSON.stringify([{ field: "occurredOn", old: "2026-10-03", new: "2026-10-02" }])],
	);
	// A rating given without notes keeps the notes the criterion has.
	const keep = await propose("people.correctPersonRecord", {
		recordType: "interview",
		recordId: interview!.id,
		changes: { chemistry: { rating: "pass" } },
	});
	assert.deepEqual(keep?.review.changes, [{ field: "chemistry", before: rating("concern"), after: rating("pass") }]);
});
