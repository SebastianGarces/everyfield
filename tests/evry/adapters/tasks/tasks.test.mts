// The Evry Tasks and Follow-up tools (WP-067 reads, WP-068 reviewed writes) against real rows: each read returns what
// the Tasks and Follow-ups pages read, and each reviewed write changes nothing until a person approves the exact review,
// then runs the native command once.
import test, { before, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import {
	approveProposal,
	createConversation,
	executeProposal,
	invokeRead,
	prepareProposal,
	readReview,
	submitTurn,
	READ_DOMAINS,
	type EvryActor,
	type Proposal,
} from "../../../../packages/evry/src/index.ts";
import type { ReadAdapter } from "../../../../packages/evry/src/catalog/types.ts";
import { EvryRefusal } from "../../../../packages/evry/src/context/errors.ts";
import { transaction } from "../../../../apps/web/src/server/platform/database.ts";
import { claimDue, finishClaim } from "../../../../apps/web/src/server/jobs/queue.ts";
import { accounts, actor, admin, db, plant, setup, sql, teardown } from "../../runtime/support.mts";

const reminders = async () => undefined;
before(async () => {
	await setup();
	// The Owner's account is linked to a leader, so it may own follow-ups (REQ-TSK-012); the Member's is linked to no
	// one, so it can hold tasks but never own a follow-up.
	await admin.execute(sql`INSERT INTO person(id,tenant_id,plant_id,display_name,source,created_at,stage,adult_classification,commitment_state,pipeline_position,state,linked_account_id)
		VALUES(${randomUUID()},${plant},${plant},'Olive Owner','other',clock_timestamp(),'leader','unknown','unknown',5000,'live',${accounts.owner.id})`);
	await admin.execute(sql`UPDATE auth_user SET name='Olive Owner' WHERE id=${accounts.owner.user}`);
	await admin.execute(sql`UPDATE auth_user SET name='Max Member' WHERE id=${accounts.member.user}`);
});
after(teardown);

const adapters = new Map<string, ReadAdapter<unknown>>(
	Object.values(READ_DOMAINS)
		.flat()
		.map((a) => [a.operation, a as ReadAdapter<unknown>]),
);
const read = async (who: EvryActor, operation: string, input: unknown) =>
	invokeRead(db, who, adapters.get(operation)!, input);

/** The church's local date `days` from today, by the database clock in America/Chicago. */
async function localDay(days: number) {
	const r = await admin.execute(
		sql`SELECT to_char((clock_timestamp() AT TIME ZONE 'America/Chicago')::date + ${days}::int,'YYYY-MM-DD') AS d`,
	);
	return String(r.rows[0]!.d);
}
async function task(
	title: string,
	fields: {
		due?: number | null;
		status?: string;
		owner?: string;
		personId?: string;
		category?: string;
		parentId?: string;
	} = {},
) {
	const id = randomUUID();
	const due = fields.due === undefined || fields.due === null ? null : await localDay(fields.due);
	await admin.execute(sql`INSERT INTO task(id,plant_id,title,category,priority,status,created_at,due_kind,due_date,person_id,parent_id,completed_at)
		VALUES(${id},${plant},${title},${fields.category ?? "general"},'medium',${fields.status ?? "not_started"},clock_timestamp(),
			${due ? "date_only" : "undated"},${due}::date,${fields.personId ?? null},${fields.parentId ?? null},
			${fields.status === "complete" ? sql`clock_timestamp()` : sql`NULL`})`);
	if (fields.owner)
		await admin.execute(
			sql`INSERT INTO task_assignee(plant_id,task_id,account_id) VALUES(${plant},${id},${fields.owner})`,
		);
	return id;
}
async function person(name: string, stage = "attendee") {
	const id = randomUUID();
	await admin.execute(sql`INSERT INTO person(id,tenant_id,plant_id,display_name,source,created_at,stage,adult_classification,commitment_state,pipeline_position,state,notes)
		VALUES(${id},${plant},${plant},${name},'other',clock_timestamp(),${stage},'unknown','unknown',6000,'live','Met at the park.')`);
	return id;
}

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
	return (operation: string, input: unknown) => prepareProposal(db, who, run, c.id, { operation, input });
}
/** The approval of the exact revision shown, then the effect run once through the WP-031 queue. */
async function approveAndRun(who: EvryActor, proposal: Proposal) {
	await approveProposal(db, who, proposal.id, { revision: proposal.revision, digest: proposal.digest }, null);
	const [claim] = await claimDue(db, ["evry_effect"], 1, 60);
	assert.ok(claim);
	const outcome = await executeProposal(
		db,
		{ jobId: claim.id, tenantId: claim.tenant_id, leaseOwner: claim.lease_owner, generation: claim.claim_generation },
		reminders,
	);
	await transaction(db, (tx) => finishClaim(tx, claim, { state: outcome === "failed" ? "failed" : "succeeded" }));
	return { outcome, review: await readReview(db, who, proposal.id) };
}
const refusal = (promise: Promise<unknown>) =>
	promise.then(
		() => null,
		(e) => (e instanceof EvryRefusal ? e.code : String(e)),
	);

test("AC:GAP-EVR-405 INV-task-windows: overdue and due-today match the Tasks page and the account, never a Person's name", async () => {
	const owner = await actor("owner");
	const ids = {
		late: await task("Order chairs", { due: -3, owner: accounts.owner.id }),
		lateOther: await task("Print flyers", { due: -1, owner: accounts.member.id }),
		today: await task("Call the school", { due: 0, owner: accounts.owner.id }),
		tomorrow: await task("Book the hall", { due: 1, owner: accounts.owner.id }),
		done: await task("Old errand", { due: -5, status: "complete", owner: accounts.owner.id }),
		undated: await task("Someday idea", { owner: accounts.owner.id }),
	};
	// A task linked to a Person who shares the Owner's name is not the Owner's task.
	const namesake = await person("Olive Owner");
	await task("Visit Olive", { due: 0, personId: namesake });

	const overdue = await read(owner, "tasks.list", { due: "overdue" });
	const titles = (r: typeof overdue) => r.rows.map((row) => row.label).sort();
	assert.deepEqual(titles(overdue), ["Order chairs", "Print flyers"]);
	assert.equal(overdue.total, 2);
	assert.ok(overdue.rows.every((r) => r.fields.overdue === true && r.fields.due !== null));
	assert.equal(overdue.rows.find((r) => r.id === ids.lateOther)!.fields.owners, "Max Member");

	const mine = await read(owner, "tasks.list", { due: "today", mine: true });
	assert.deepEqual(titles(mine), ["Call the school", "Order chairs"]);
	assert.equal(mine.rows.find((r) => r.id === ids.today)!.fields.owners, "you");
	assert.ok(!mine.rows.some((r) => [ids.tomorrow, ids.done, ids.undated].includes(r.id)));
});

test("INV-review-first: a weekly task on Mondays is created with its recurrence only after approval", async () => {
	const owner = await actor("owner");
	const propose = await turn(owner);
	const monday = await admin.execute(
		sql`SELECT to_char(d,'YYYY-MM-DD') AS d FROM (SELECT (clock_timestamp() AT TIME ZONE 'America/Chicago')::date + ((8 - extract(isodow FROM clock_timestamp() AT TIME ZONE 'America/Chicago')::int) % 7 + 0) AS d) x`,
	);
	const date = String(monday.rows[0]!.d);
	const proposal = await propose("tasks.create", {
		title: "Review the pipeline",
		due: date,
		assigneeIds: ["me"],
		recurrence: { frequency: "weekly" },
	});
	assert.ok(proposal);
	const changes = Object.fromEntries(proposal.review.changes.map((c) => [c.field, c.after]));
	assert.deepEqual(changes, {
		title: "Review the pipeline",
		due: `${date} America/Chicago`,
		owners: "Olive Owner",
		recurrence: "weekly on Mondays, America/Chicago",
	});
	const count = async () =>
		(await admin.execute(sql`SELECT count(*)::int n FROM task WHERE plant_id=${plant} AND title='Review the pipeline'`))
			.rows[0]!.n;
	assert.equal(await count(), 0, "nothing exists before approval");
	const { outcome } = await approveAndRun(owner, proposal);
	assert.equal(outcome, "completed");
	const made = await admin.execute(sql`SELECT t.category,r.interval,r.timezone,r.stopped_at,
			(SELECT array_agg(a.account_id::text) FROM task_assignee a WHERE a.task_id=t.id) AS owners
		FROM task t JOIN recurrence r ON r.id=t.series_id WHERE t.plant_id=${plant} AND t.title='Review the pipeline'`);
	assert.deepEqual(made.rows, [
		{
			category: "recurring",
			interval: "weekly",
			timezone: "America/Chicago",
			stopped_at: null,
			owners: [accounts.owner.id],
		},
	]);
});

test("INV-own-duty: a Member completes only their own task; anyone else's refuses before any review", async () => {
	const member = await actor("member");
	const propose = await turn(member);
	const theirs = await task("Set up sound", { due: 2, owner: accounts.owner.id });
	const own = await task("Bring coffee", { due: 2, owner: accounts.member.id });
	assert.equal(await refusal(propose("tasks.complete", { taskId: theirs })), "not_assigned");
	const reviews = await admin.execute(sql`SELECT count(*)::int n FROM proposal WHERE account_id=${accounts.member.id}`);
	assert.equal(reviews.rows[0]!.n, 0, "no review appears");
	const proposal = await propose("tasks.complete", { taskId: own });
	assert.ok(proposal);
	assert.deepEqual(proposal.review.changes, [{ field: "status", before: "not_started", after: "complete" }]);
	assert.equal((await approveAndRun(member, proposal)).outcome, "completed");
	const status = await admin.execute(sql`SELECT status FROM task WHERE id=${own}`);
	assert.equal(status.rows[0]!.status, "complete");
});

test("INV-eligible-owner: follow-ups go only to accounts that may own them, in one review", async () => {
	const owner = await actor("owner");
	const propose = await turn(owner);
	const guests = [await person("Gia Guest"), await person("Hal Guest")];
	const duties = [];
	for (const g of guests) duties.push(await task(`Follow up`, { personId: g, category: "follow_up" }));

	const seats = await read(owner, "tasks.eligibleAssignees", {});
	assert.deepEqual(
		seats.rows.map((r) => [r.label, r.fields.canOwnFollowUps]),
		[
			["Max Member", false],
			["Olive Owner", true],
		],
	);
	assert.equal(
		await refusal(
			propose("tasks.assignFollowUp", {
				items: duties.map((taskId) => ({ taskId, assigneeIds: [accounts.member.id] })),
			}),
		),
		"owner_ineligible",
	);
	const proposal = await propose("tasks.assignFollowUp", {
		items: duties.map((taskId) => ({ taskId, assigneeIds: [accounts.owner.id] })),
	});
	assert.ok(proposal);
	assert.deepEqual(proposal.review, {
		target: null,
		changes: [
			{ field: "Gia Guest", before: "Needs owner", after: "Olive Owner" },
			{ field: "Hal Guest", before: "Needs owner", after: "Olive Owner" },
		],
	});
	const owned = async () =>
		(
			await admin.execute(
				sql`SELECT count(*)::int n FROM task_assignee WHERE task_id=ANY(${sql.param(duties)}::uuid[])`,
			)
		).rows[0]!.n;
	assert.equal(await owned(), 0, "nobody is assigned before approval");
	assert.equal((await approveAndRun(owner, proposal)).outcome, "completed");
	assert.equal(await owned(), 2);
	const list = await read(owner, "tasks.listFollowUpOwners", { personId: guests[0] });
	assert.deepEqual(
		list.rows.map((r) => [r.label, r.fields.owners, r.fields.needsOwner]),
		[["Gia Guest", "you", false]],
	);
});

test("INV-contact-log: a logged call goes in the contact log after approval, never the profile notes", async () => {
	const owner = await actor("owner");
	const propose = await turn(owner);
	const jess = await person("Jess Caller");
	const duty = await task("Follow up with Jess", { personId: jess, category: "follow_up", owner: accounts.owner.id });
	const before = await read(owner, "followups.listContactHistory", { personId: jess });
	assert.equal(before.status, "not_found", "no outcome is recorded yet");

	const proposal = await propose("followups.recordOutcome", {
		taskId: duty,
		outcome: "contacted",
		occurred: "now",
		channel: "phone",
		notes: "She wants to join a group.",
	});
	assert.ok(proposal);
	assert.deepEqual(proposal.review.target, { kind: "person", id: jess, label: "Jess Caller" });
	const changes = Object.fromEntries(proposal.review.changes.map((c) => [c.field, c.after]));
	assert.equal(changes.outcome, "contacted");
	assert.equal(changes.channel, "phone");
	assert.equal(changes.notes, "She wants to join a group.");
	assert.equal(changes.followUp, "complete");
	assert.equal((await read(owner, "followups.listContactHistory", { personId: jess })).status, "not_found");

	assert.equal((await approveAndRun(owner, proposal)).outcome, "completed");
	const log = await read(owner, "followups.listContactHistory", { personId: jess });
	assert.deepEqual(
		log.rows.map((r) => [r.fields.outcome, r.fields.conversationHappened, r.fields.channel, r.fields.recordedBy]),
		[["contacted", true, "phone", "you"]],
	);
	const notes = await admin.execute(sql`SELECT notes FROM person WHERE id=${jess}`);
	assert.equal(notes.rows[0]!.notes, "Met at the park.", "her profile notes are unchanged");

	// An attempt is recorded as an attempt: never a conversation that happened.
	const attempt = await propose("followups.recordOutcome", {
		personId: jess,
		outcome: "attempted_no_contact",
		occurred: "now",
		completeTask: false,
	});
	assert.ok(attempt);
	assert.equal((await approveAndRun(owner, attempt)).outcome, "completed");
	const after = await read(owner, "followups.listContactHistory", { personId: jess });
	assert.deepEqual(
		after.rows.map((r) => [r.fields.outcome, r.fields.conversationHappened]),
		[
			["attempted_no_contact", false],
			["contacted", true],
		],
	);
});

test("AC:EVRY-REAL-CHILD-TASK-PARITY INV-checklist: adding one row and ticking another is one review of real subtasks", async () => {
	const owner = await actor("owner");
	const propose = await turn(owner);
	const parent = await task("Launch Sunday prep", { due: 5, owner: accounts.owner.id });
	const chairs = await task("Set out chairs", { parentId: parent });
	const proposal = await propose("tasks.createSubtask", {
		parentId: parent,
		add: ["Test the projector"],
		tick: [{ taskId: chairs, complete: true }],
	});
	assert.ok(proposal);
	assert.deepEqual(proposal.review.changes, [
		{ field: "Set out chairs", before: "not_started", after: "complete" },
		{ field: "Test the projector", before: null, after: "added" },
	]);
	assert.equal((await approveAndRun(owner, proposal)).outcome, "completed");
	const rows = await read(owner, "tasks.listSubtasks", { parentId: parent });
	assert.deepEqual(rows.rows.map((r) => [r.label, r.fields.status]).sort(), [
		["Set out chairs", "complete"],
		["Test the projector", "not_started"],
	]);
	const history = await read(owner, "tasks.statusHistory", { taskId: chairs });
	assert.deepEqual(
		history.rows.map((r) => r.fields.to),
		["complete"],
	);
});

test("INV-needs-owner: a follow-up nobody owns reads as needing an owner, with no owner guessed", async () => {
	const owner = await actor("owner");
	const dan = await person("Dan Unowned");
	await task("Follow up with Dan", { personId: dan, category: "follow_up" });
	const found = await read(owner, "tasks.listFollowUpOwners", { personId: dan });
	assert.deepEqual(
		found.rows.map((r) => [r.label, r.fields.owners, r.fields.needsOwner]),
		[["Dan Unowned", null, true]],
	);
});

test("INV-plant-only: no task or follow-up tool reaches an organization seat", async () => {
	const org = await actor("orgOwner");
	for (const [domain, list] of Object.entries(READ_DOMAINS))
		if (domain === "tasks" || domain === "followups")
			assert.deepEqual(
				list.filter((a) => a.allowed(org)).map((a) => a.operation),
				[],
			);
});
