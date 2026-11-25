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
} from "../../../packages/evry/src/index.ts";
import { createTaskWriter, withTaskWrite } from "../../../packages/domain/src/tasks/index.ts";
import { meetingsWriter, withMeetingsWrite } from "../../../packages/domain/src/meetings/index.ts";
import { peopleWriter, withPeopleWrite } from "../../../packages/domain/src/people/index.ts";
import { teamsWriter, withTeamsWrite } from "../../../packages/domain/src/teams/index.ts";
import { transaction } from "../../../packages/domain/src/jobs/transaction.ts";
import { claimDue, finishClaim } from "../../../packages/domain/src/jobs/queue.ts";
import { accounts, actor, admin, db, freshActor, people, plant, setup, sql, teardown } from "../runtime/support.mts";
import { localDate, seedMeetings } from "../adapters/meetings/support.mts";
import { ok, seeds, type Actor } from "../../support/fixture.mts";

let human: Actor, made: Awaited<ReturnType<typeof subjects>>;
before(async () => {
	await setup();
	human = await seeds(admin).actor({ kind: "plant", id: plant }, "admin");
	made = await subjects();
});
after(teardown);

const key = () => randomUUID();
const reminders = async () => undefined;
const taskWriter = createTaskWriter({ reminders });
const ports = {
	reminders,
	phaseNotices: async () => {
		throw Error("unexpected phase notice");
	},
};
const witness = (p: Proposal) => ({ revision: p.revision, digest: p.digest });
const refusal = (promise: Promise<unknown>) =>
	promise.then(
		() => "none",
		(error: { code?: string }) => error.code,
	);

async function propose(who: EvryActor, operation: string, input: unknown): Promise<Proposal> {
	const c = await createConversation(db, who, { requestKey: key() });
	await submitTurn(db, who, c.id, { requestKey: key(), text: "hold this turn" });
	const [claim] = await claimDue(db, ["assistant_turn"], 1, 240);
	assert.ok(claim);
	const proposal = await prepareProposal(db, who, lease(claim), c.id, { operation, input });
	await transaction(db, (tx) => finishClaim(tx, claim, { state: "succeeded" }));
	assert.ok(proposal);
	return proposal;
}
type Claim = Awaited<ReturnType<typeof claimDue>>[number];
const lease = (claim: Claim) => ({
	turnId: claim.id,
	jobId: claim.id,
	tenantId: claim.tenant_id,
	leaseOwner: claim.lease_owner,
	generation: claim.claim_generation,
});
async function approve(who: EvryActor, proposal: Proposal) {
	await approveProposal(db, who, proposal.id, witness(proposal), null);
	const [claim] = await claimDue(db, ["evry_effect"], 1, 60);
	assert.ok(claim);
	const outcome = await executeProposal(db, lease(claim), ports);
	await transaction(db, (tx) => finishClaim(tx, claim, { state: outcome === "failed" ? "failed" : "succeeded" }));
	assert.deepEqual(await claimDue(db, ["evry_effect"], 1, 60), [], "nothing else is queued");
	return { outcome, review: await readReview(db, who, proposal.id) };
}

type Kind = "person" | "meeting" | "task" | "team";
const COLUMNS: Record<Kind, { table: string; field: string; notes: string }> = {
	person: { table: "person", field: "city", notes: "notes" },
	meeting: { table: "meeting", field: "title", notes: "notes" },
	task: { table: "task", field: "title", notes: "description" },
	team: { table: "team", field: "name", notes: "description" },
};
async function stored(kind: Kind, id: string) {
	const { table, field, notes } = COLUMNS[kind];
	const r = await admin.execute(
		sql.raw(`SELECT ${field} AS field,${notes} AS notes,revision::text AS revision FROM ${table} WHERE id='${id}'`),
	);
	return r.rows[0] as { field: string; notes: string | null; revision: string };
}
async function save(kind: Kind, id: string, patch: Record<string, unknown>) {
	const who = await freshActor(human.session);
	assert.ok(who);
	const request = { requestKey: key(), expectedRevision: (await stored(kind, id)).revision };
	const ops = {
		person: () =>
			withPeopleWrite(db, who.authority, (tx, c) =>
				peopleWriter.updatePerson(tx, c, { ...request, input: { personId: id, patch } } as never),
			),
		meeting: () =>
			withMeetingsWrite(db, who.authority, (tx, c) =>
				meetingsWriter.edit(tx, c, { ...request, input: { meetingId: id, patch } }),
			),
		task: () =>
			withTaskWrite(db, who.authority, (tx, c) => taskWriter.edit(tx, c, { ...request, input: { taskId: id, patch } })),
		team: () =>
			withTeamsWrite(db, who.authority, (tx, c) =>
				teamsWriter.edit(tx, c, { ...request, input: { teamId: id, ...patch } }),
			),
	};
	ok(await ops[kind]());
}
async function history(id: string) {
	const r = await admin.execute(
		sql`SELECT actor_id,after_value FROM audit_event WHERE subject_id=${id}::uuid AND tenant_id=${plant}
			AND (request_key IS NOT NULL) ORDER BY occurred_at,id`,
	);
	return r.rows as { actor_id: string; after_value: Record<string, unknown> | null }[];
}

async function subjects() {
	const owner = await actor("owner");
	const seeded = await seedMeetings(owner);
	const task = ok(
		await withTaskWrite(db, owner.authority, (tx, c) =>
			taskWriter.create(tx, c, { requestKey: key(), input: { title: "Book the hall" } }),
		),
	) as { task: { id: string } };
	const team = ok(
		await withTeamsWrite(db, owner.authority, (tx, c) =>
			teamsWriter.create(tx, c, { requestKey: key(), input: { name: "Welcome" } }),
		),
	) as { team: { id: string } };
	return { person: people.casey, meeting: seeded.training.id, task: task.task.id, team: team.team.id };
}

const DRAFT: Record<
	Kind,
	{ operation: string; input(id: string): unknown; field: string; human: string; draft: string }
> = {
	person: {
		operation: "people.updatePerson",
		input: (personId) => ({ personId, patch: { city: "Austin" } }),
		field: "city",
		human: "Elgin",
		draft: "Austin",
	},
	meeting: {
		operation: "meetings.edit",
		input: (meetingId) => ({ meetingId, title: "Evry's training night" }),
		field: "title",
		human: "Leader training",
		draft: "Evry's training night",
	},
	task: {
		operation: "tasks.edit",
		input: (taskId) => ({ taskId, patch: { title: "Book the big hall", due: "2026-12-04T09:00" } }),
		field: "title",
		human: "Book the small hall",
		draft: "Book the big hall",
	},
	team: {
		operation: "teams.edit",
		input: (teamId) => ({ teamId, name: "Hosts", reason: "Clearer name" }),
		field: "name",
		human: "Greeters",
		draft: "Hosts",
	},
};
const NOTES: Record<Kind, string> = {
	person: "summaryNotes",
	meeting: "notes",
	task: "description",
	team: "description",
};

test("INV-evry-collision: a human save before Evry's approved draft stands; the card asks again against the saved version", async (t) => {
	const owner = await actor("owner");
	for (const kind of ["person", "meeting", "task", "team"] as const)
		await t.test(kind, async () => {
			const id = made[kind];
			const { operation, input, field, human: saved, draft } = DRAFT[kind];
			const first = await propose(owner, operation, input(id));
			const opened = (await stored(kind, id)).field;
			await save(kind, id, { [field]: saved, [NOTES[kind]]: "Saved by a person" });

			const { outcome, review } = await approve(owner, first);
			assert.deepEqual([outcome, review.status, review.outcome, review.revision], ["reviewing", "pending", null, 2]);
			const now = await stored(kind, id);
			assert.deepEqual([now.field, now.notes], [saved, "Saved by a person"], "the human's save stands");
			assert.notEqual(review.digest, first.digest);
			assert.deepEqual(
				review.review.changes.find((c) => c.field === field),
				{ field, before: saved, after: draft },
				"the draft is shown against the saved version",
			);
			assert.deepEqual(
				review.review.earlier?.find((c) => c.field === field),
				{ field, before: opened, after: draft },
				"and against what Evry prepared it from",
			);
			assert.deepEqual(
				(review.review.earlier ?? []).map((c) => c.field),
				first.review.changes.map((c) => c.field),
			);
			assert.deepEqual(
				(await history(id)).filter((h) => h.actor_id === accounts.owner.id && h.after_value?.[field] === draft),
				[],
				"nothing of the draft is in the history",
			);
			assert.equal(await refusal(approveProposal(db, owner, first.id, witness(first), null)), "review_changed");

			const second = await approve(owner, review);
			assert.deepEqual([second.outcome, second.review.outcome], ["completed", "completed"]);
			const after = await stored(kind, id);
			assert.deepEqual([after.field, after.notes], [draft, "Saved by a person"], "only the drafted field changed");
			const writers = (await history(id)).map((h) => h.actor_id);
			assert.deepEqual(writers.slice(-2), [human.id, accounts.owner.id], "both saves are in the history");
		});
});

for (const [operation, opened, draft] of [
	["people.recordAdultClassification", "unknown", "adult"],
	["people.correctAdultClassification", "adult", "child"],
] as const)
	test(`INV-evry-collision: ${operation} asks again after a person saves first`, async () => {
		const owner = await actor("owner");
		const id = people.alexChen;
		const classification = async () => {
			const r = await admin.execute(sql`SELECT adult_classification AS value FROM person WHERE id=${id}`);
			return (r.rows[0] as { value: string }).value;
		};
		assert.equal(await classification(), opened);
		const first = await propose(owner, operation, {
			personId: id,
			classification: draft,
			occurredOn: "2026-11-01",
			reason: "They told me",
		});
		const city = `Aurora ${draft}`;
		await save("person", id, { city });
		const { outcome, review } = await approve(owner, first);
		assert.deepEqual([outcome, review.status, review.outcome, review.revision], ["reviewing", "pending", null, 2]);
		assert.deepEqual([await classification(), (await stored("person", id)).field], [opened, city]);
		assert.deepEqual([review.review.changes, review.review.earlier], [first.review.changes, first.review.changes]);
		assert.equal(await refusal(approveProposal(db, owner, first.id, witness(first), null)), "review_changed");

		const second = await approve(owner, review);
		assert.deepEqual([second.outcome, second.review.outcome], ["completed", "completed"]);
		assert.deepEqual([await classification(), (await stored("person", id)).field], [draft, city]);
	});

test("INV-evry-collision: a status a person recorded first is shown, and Evry's record draft can't replace it", async () => {
	const owner = await actor("owner");
	const id = people.alexRivera;
	const about = { personId: id, occurredOn: "2026-11-01" };
	const first = await propose(owner, "people.recordAdultClassification", {
		...about,
		classification: "adult",
		reason: "They told me",
	});
	const who = await freshActor(human.session);
	assert.ok(who);
	const request = { requestKey: key(), expectedRevision: (await stored("person", id)).revision };
	ok(
		await withPeopleWrite(db, who.authority, (tx, c) =>
			peopleWriter.recordAdultClassification(tx, c, {
				...request,
				input: { ...about, classification: "child", reason: "Seen at check-in" },
			}),
		),
	);
	const { outcome, review } = await approve(owner, first);
	assert.deepEqual([outcome, review.status], ["reviewing", "pending"]);
	assert.deepEqual(review.review.changes[0], { field: "adultClassification", before: "child", after: "adult" });
	assert.match(review.review.refusal ?? "", /already recorded as Child/);
	assert.equal(await refusal(approveProposal(db, owner, first.id, witness(review), null)), "review_closed");
	const r = await admin.execute(sql`SELECT adult_classification AS value FROM person WHERE id=${id}`);
	assert.deepEqual(r.rows, [{ value: "child" }]);
});

test("BUG-101e8d9: a task draft due at a time saves that church time", async () => {
	const owner = await actor("owner");
	const draft = await propose(owner, "tasks.create", { title: "Open the doors", due: "2026-12-06T08:30" });
	assert.equal((await approve(owner, draft)).outcome, "completed");
	const r = await admin.execute(
		sql`SELECT due_kind,due_date::text AS day,to_char(due_time,'HH24:MI') AS time FROM task WHERE plant_id=${plant} AND title='Open the doors'`,
	);
	assert.deepEqual(r.rows, [{ due_kind: "timed", day: "2026-12-06", time: "08:30" }]);
});

test("INV-evry-collision: a second human save asks a third time, and cancelling keeps the saved version", async () => {
	const owner = await actor("owner");
	const first = await propose(owner, "people.updatePerson", { personId: people.alexChen, patch: { city: "Joliet" } });
	await save("person", people.alexChen, { city: "Aurora" });
	const second = await approve(owner, first);
	await save("person", people.alexChen, { city: "Elgin" });
	const third = await approve(owner, second.review);
	assert.deepEqual([third.outcome, third.review.revision], ["reviewing", 3]);
	assert.deepEqual(
		[third.review.review.changes, third.review.review.earlier],
		[[{ field: "city", before: "Elgin", after: "Joliet" }], [{ field: "city", before: "Aurora", after: "Joliet" }]],
	);
	assert.equal((await stored("person", people.alexChen)).field, "Elgin");
});

test("INV-evry-collision: a draft that moves only a meeting's time keeps the day a person saved", async () => {
	const owner = await actor("owner");
	const id = made.meeting;
	const first = await propose(owner, "meetings.edit", { meetingId: id, time: "20:15" });
	const day = localDate(21);
	await save("meeting", id, { date: day, time: "18:30" });
	const { outcome, review } = await approve(owner, first);
	assert.equal(outcome, "reviewing");
	assert.equal((await approve(owner, review)).outcome, "completed");
	const r = await admin.execute(
		sql`SELECT local_date::text AS day,to_char(local_time,'HH24:MI') AS time FROM meeting WHERE id=${id}`,
	);
	assert.deepEqual(r.rows, [{ day, time: "20:15" }]);
});

test("INV-evry-collision: an approver who lost their seat gets no new review of the changed record", async () => {
	const owner = await actor("owner");
	const draft = await propose(owner, "people.updatePerson", { personId: people.alexRivera, patch: { city: "Joliet" } });
	await save("person", people.alexRivera, { city: "Aurora" });
	await approveProposal(db, owner, draft.id, witness(draft), null);
	await admin.execute(sql`UPDATE seat SET role='member' WHERE account_id=${accounts.owner.id} AND plant_id=${plant}`);
	const [claim] = await claimDue(db, ["evry_effect"], 1, 60);
	assert.ok(claim);
	assert.equal(await executeProposal(db, lease(claim), ports), "refused");
	await admin.execute(sql`UPDATE seat SET role='owner' WHERE account_id=${accounts.owner.id} AND plant_id=${plant}`);
	assert.deepEqual((await admin.execute(sql`SELECT state,outcome,revision FROM proposal WHERE id=${draft.id}`)).rows, [
		{ state: "approved", outcome: "refused", revision: 1 },
	]);
});
