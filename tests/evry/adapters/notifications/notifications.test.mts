import test, { before, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import {
	approveProposal,
	createConversation,
	executeProposal,
	invokeRead,
	prepareProposal,
	readCatalog,
	readReview,
	submitTurn,
	type EvryActor,
	type Proposal,
} from "../../../../packages/evry/src/index.ts";
import { NOTIFICATION_READS } from "../../../../packages/evry/src/adapters/notifications/reads/index.ts";
import { NOTIFICATION_COMMANDS } from "../../../../packages/evry/src/adapters/notifications/commands/index.ts";
import { modelTools } from "../../../../packages/evry/src/runtime/tools.ts";
import { transaction } from "../../../../apps/web/src/server/platform/database.ts";
import { claimDue, finishClaim } from "../../../../apps/web/src/server/jobs/queue.ts";
import { accounts, actor, admin, db, plant, setup, sql, teardown } from "../../runtime/support.mts";

// WP-081 and WP-082: Evry reads the signed-in account's own bell and notification settings, and changes them only
// through an exact review the account approves. The database is real and every effect runs through the real queue.

const noReminders = async () => {
	throw Error("unexpected task reminder replan");
};
const CARE = "Confidential: Robin asked us to pray about a hard diagnosis.";
const DAY = 86_400_000;
const ago = (days: number) => new Date(Date.now() - days * DAY).toISOString();
const localDate = (at: number) =>
	new Intl.DateTimeFormat("en-CA", { timeZone: "America/Chicago" }).format(new Date(at));

let owner: EvryActor;
let member: EvryActor;
let task: string;
const N: string[] = [];
let read: string;
let others: string[] = [];

async function newTask(title: string, due: string) {
	const id = randomUUID();
	await admin.execute(sql`INSERT INTO task(id,plant_id,title,category,priority,status,created_at,due_kind,due_date)
		VALUES(${id},${plant},${title},'general','medium','not_started',clock_timestamp(),'date_only',${due})`);
	return id;
}
async function notice(recipient: string, category: string, title: string, eligible: string, source = task) {
	const id = randomUUID();
	const coarse = category.startsWith("task") ? "task" : "meeting";
	const purpose = category === "task_overdue" ? "task_due" : category === "task_due" ? "task_due" : "meeting_reminder";
	await admin.execute(sql`INSERT INTO notice(id,tenant_id,recipient_id,category,purpose,logical_key,source_record_id,source_revision,title,eligible_at,created_at,timezone)
		VALUES(${id},${plant},${recipient},${coarse},${purpose},${`${plant}/${category}/${id}`},${source},1,${title},${eligible},clock_timestamp(),'America/Chicago')`);
	return id;
}
const unreadIds = async (account: string) =>
	(
		await admin.execute(
			sql`SELECT id FROM notice WHERE recipient_id=${account} AND read_at IS NULL AND eligible_at<=clock_timestamp() ORDER BY id`,
		)
	).rows.map((r) => String(r.id));
const reads = new Map(NOTIFICATION_READS.map((a) => [a.operation, a]));
const readAs = (who: EvryActor, operation: string, input: unknown = {}) =>
	invokeRead(db, who, reads.get(operation as never)! as never, input);

before(async () => {
	await setup();
	owner = await actor("owner");
	member = await actor("member");
	task = await newTask("Call the venue", localDate(Date.now() - 2 * DAY));
	N.push(
		await notice(accounts.owner.id, "task_due", "Call the venue is due", ago(2.2)),
		await notice(accounts.owner.id, "task_overdue", "Call the venue is overdue", ago(1.9)),
		await notice(accounts.owner.id, "meeting_reminder", "Interest meeting Sunday", ago(1.6)),
		await notice(accounts.owner.id, "meeting_reminder", "Core group dinner", ago(1.3)),
	);
	read = await notice(accounts.owner.id, "task_due", "Old reminder", ago(5));
	await admin.execute(sql`UPDATE notice SET read_at=clock_timestamp() WHERE id=${read}`);
	// Another account in the same church, with unread notices of its own.
	others = [
		await notice(accounts.member.id, "task_due", "Member reminder", ago(1)),
		await notice(accounts.member.id, "meeting_reminder", "Member meeting", ago(1)),
	];
	// Private care in the same church: a confidential note no notification answer may hold.
	const person = randomUUID();
	await admin.execute(sql`INSERT INTO person(id,tenant_id,plant_id,display_name,source,created_at,stage,adult_classification,commitment_state,pipeline_position,state)
		VALUES(${person},${plant},${plant},'Robin Care','other',clock_timestamp(),'prospect','unknown','unknown',5,'live')`);
	await admin.execute(sql`INSERT INTO person_note(tenant_id,plant_id,person_id,author_id,body,occurred_at,recorded_at)
		VALUES(${plant},${plant},${person},${accounts.owner.id},${CARE},clock_timestamp(),clock_timestamp())`);
});
after(teardown);

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
async function runNext() {
	const [claim] = await claimDue(db, ["evry_effect"], 1, 60);
	if (!claim) return null;
	const outcome = await executeProposal(
		db,
		{ jobId: claim.id, tenantId: claim.tenant_id, leaseOwner: claim.lease_owner, generation: claim.claim_generation },
		noReminders,
	);
	await transaction(db, (tx) => finishClaim(tx, claim, { state: outcome === "failed" ? "failed" : "succeeded" }));
	return outcome;
}
async function approve(who: EvryActor, proposal: Proposal) {
	const approved = await approveProposal(
		db,
		who,
		proposal.id,
		{ revision: proposal.revision, digest: proposal.digest },
		null,
	);
	return { approved, outcome: await runNext(), review: await readReview(db, who, proposal.id) };
}
const audits = async () => Number((await admin.execute(sql`SELECT count(*)::int n FROM audit_event`)).rows[0]!.n);

test("AC:GAP-EVR-421 AC:NOTIFY47-010 the feed and count show only the account's own notices and reading marks none read", async () => {
	const before = await unreadIds(accounts.owner.id);
	const feed = await readAs(owner, "notifications.feed", { unread: true });
	assert.deepEqual(feed.rows.map((r) => r.id).sort(), [...N].sort());
	assert.equal(feed.total, 4);
	assert.deepEqual(
		feed.rows.map((r) => r.fields.category),
		["meeting_reminder", "meeting_reminder", "task_overdue", "task_due"],
	);
	assert.ok(feed.rows.every((r) => r.kind === "notice" && r.fields.read === false));
	const all = await readAs(owner, "notifications.feed");
	assert.ok(all.rows.some((r) => r.id === read && r.fields.read === true));
	assert.ok(!all.rows.some((r) => others.includes(r.id)));
	const meetings = await readAs(owner, "notifications.feed", { unread: true, category: "meeting_reminder" });
	assert.deepEqual([meetings.total, meetings.rows.length], [2, 2]);
	assert.deepEqual(await unreadIds(accounts.owner.id), before);
	// The member reads only their own two.
	assert.deepEqual(
		(await readAs(member, "notifications.feed", { unread: true })).rows.map((r) => r.id).sort(),
		[...others].sort(),
	);
});

test("AC:INH-NOTIFICATIONS-03 a review lists exactly the three asked notices, approval marks only them and a second approval writes nothing", async () => {
	const propose = await turn(owner);
	// Another account's notice id is never part of the review, even when the model names it.
	const proposal = await propose("notifications.markSelectedRead", { noticeIds: [N[0], N[1], N[2], others[0]] });
	assert.ok(proposal);
	assert.equal(proposal.status, "pending");
	assert.deepEqual(
		proposal.review.changes.map((c) => (c.before as { id: string }).id).sort(),
		[N[0], N[1], N[2]].sort(),
	);
	assert.ok(proposal.review.changes.every((c) => c.field === "notice" && c.after === "read"));
	assert.deepEqual(await unreadIds(accounts.owner.id), [...N].sort(), "nothing is read before approval");
	const first = await approve(owner, proposal);
	assert.equal(first.outcome, "completed");
	assert.equal(first.review.outcome, "completed");
	assert.deepEqual(await unreadIds(accounts.owner.id), [N[3]]);
	assert.deepEqual(await unreadIds(accounts.member.id), [...others].sort());
	// Approving the same card again returns it as already applied and writes nothing.
	const writes = await audits();
	const again = await approveProposal(
		db,
		owner,
		proposal.id,
		{ revision: proposal.revision, digest: proposal.digest },
		null,
	);
	assert.equal(again.replayed, true);
	assert.equal(again.proposal.outcome, "completed");
	assert.equal(await runNext(), null);
	assert.equal(await audits(), writes);
	// A review of notices that are all read already, or none of them the account's own, has nothing to show.
	assert.equal(await propose("notifications.markSelectedRead", { noticeIds: [N[0], others[1]] }), null);
});

test("AC:CASE-NTF-003 marking a task notice read leaves the task as it was", async () => {
	const before = (await admin.execute(sql`SELECT status,revision,title FROM task WHERE id=${task}`)).rows[0];
	// N1 and N2 are this task's reminders; the earlier test marked them read through Evry.
	const marked = await admin.execute(
		sql`SELECT count(*)::int n FROM notice WHERE id IN (${N[0]},${N[1]}) AND read_at IS NOT NULL`,
	);
	assert.equal(marked.rows[0]!.n, 2);
	assert.deepEqual((await admin.execute(sql`SELECT status,revision,title FROM task WHERE id=${task}`)).rows[0], before);
	assert.equal(before!.status, "not_started");
});

test("AC:NOTIFY47-001 mark all states the visible unread count, marks them all and leaves later and other accounts' notices", async () => {
	for (let n = 0; n < 11; n++) await notice(accounts.owner.id, "meeting_reminder", `Reminder ${n + 1}`, ago(0.5));
	const count = (await unreadIds(accounts.owner.id)).length;
	assert.equal(count, 12);
	const propose = await turn(owner);
	const proposal = await propose("notifications.markAllVisibleRead", {});
	assert.ok(proposal);
	assert.deepEqual(proposal.review.changes, [{ field: "unread", before: 12, after: 0 }]);
	// One that arrives after the review is not part of it.
	const later = await notice(
		accounts.owner.id,
		"meeting_reminder",
		"Arrived after the review",
		new Date().toISOString(),
	);
	const done = await approve(owner, proposal);
	assert.equal(done.outcome, "completed");
	assert.deepEqual(await unreadIds(accounts.owner.id), [later]);
	assert.deepEqual(await unreadIds(accounts.member.id), [...others].sort());
	await admin.execute(sql`UPDATE notice SET read_at=clock_timestamp() WHERE id=${later}`);
	assert.equal(await propose("notifications.markAllVisibleRead", {}), null, "nothing unread, nothing to review");
});

test("INV-notification-settings email off for task reminders is reviewed with in-app kept, then saved as Settings shows it", async () => {
	const propose = await turn(owner);
	const choices = [
		{ category: "task_due", channel: "email", enabled: false },
		{ category: "task_overdue", channel: "email", enabled: false },
	];
	const proposal = await propose("notifications.setPreferences", { choices });
	assert.ok(proposal);
	assert.deepEqual(proposal.review.changes, [
		{ field: "task_due.email", before: true, after: false },
		{ field: "task_due.in_app", before: true, after: true },
		{ field: "task_overdue.email", before: true, after: false },
		{ field: "task_overdue.in_app", before: true, after: true },
	]);
	const settings = () =>
		readAs(owner, "notifications.preferences.get").then((r) =>
			r.rows.filter((row) => row.id.startsWith("task_")).map((row) => [row.id, row.fields.email, row.fields.inApp]),
		);
	assert.deepEqual(await settings(), [
		["task_due", "on", "on"],
		["task_overdue", "on", "on"],
	]);
	assert.equal((await approve(owner, proposal)).outcome, "completed");
	assert.deepEqual(await settings(), [
		["task_due", "off", "on"],
		["task_overdue", "off", "on"],
	]);
	// The member's own settings are untouched.
	const theirs = await readAs(member, "notifications.preferences.get");
	assert.equal(theirs.rows.find((r) => r.id === "task_due")?.fields.email, "on");
	// Asking again for what is already set is a review that can't be approved.
	const same = await propose("notifications.setPreferences", { choices });
	assert.ok(same?.review.refusal);
});

test("INV-notification-settings no input names an account, so Evry can change only the signed-in account's own settings", async () => {
	for (const [operation, write] of Object.entries(NOTIFICATION_COMMANDS)) {
		const shape = JSON.stringify(write.input.toJSONSchema());
		assert.doesNotMatch(shape, /account|recipient|person|user/i, operation);
	}
	for (const adapter of NOTIFICATION_READS)
		assert.doesNotMatch(
			JSON.stringify(adapter.input.toJSONSchema()),
			/account|recipient|person|user/i,
			adapter.operation,
		);
	const propose = await turn(owner);
	await assert.rejects(
		propose("notifications.setPreferences", {
			accountId: accounts.member.id,
			choices: [{ category: "task_due", channel: "email", enabled: false }],
		}),
		/invalid_input/,
	);
});

test("INV-digest-cadence the cadence takes only daily or weekly; weekly to daily is reviewed and saved; a Member is not offered it", async () => {
	const propose = await turn(owner);
	await assert.rejects(propose("notifications.digestCadence.set", { cadence: "every_3_hours" }), /invalid_input/);
	await assert.rejects(propose("notifications.digestCadence.set", { cadence: "hourly" }), /invalid_input/);
	const proposal = await propose("notifications.digestCadence.set", { cadence: "daily" });
	assert.ok(proposal);
	assert.deepEqual(proposal.review.changes, [
		{
			field: "planter_digest.cadence",
			before: { cadence: "weekly", weekday: 1, hour: 8 },
			after: { cadence: "daily", weekday: 1, hour: 8 },
		},
	]);
	assert.equal((await approve(owner, proposal)).outcome, "completed");
	const settings = await readAs(owner, "notifications.preferences.get");
	assert.equal(settings.rows.find((r) => r.id === "planter_digest")?.fields.cadence, "daily");
	assert.equal(
		readCatalog(member).reviewedWrites.some((w) => w.operation === "notifications.digestCadence.set"),
		false,
	);
	assert.equal(
		readCatalog(member)
			.domains.find((d) => d.domain === "notifications")
			?.operations.some((o) => o.operation === "notifications.previewPlanterDigest"),
		false,
	);
	await admin.execute(
		sql`UPDATE notification_preference SET cadence='weekly' WHERE account_id=${accounts.owner.id} AND category='planter_digest'`,
	);
});

test("INV-digest-preview the next church digest preview has its send time, date range and items, and no notification answer holds private care", async () => {
	const due = localDate(Date.now() + 2 * DAY);
	const open = await newTask("Book the school gym", due);
	for (const id of [open, task])
		await admin.execute(
			sql`INSERT INTO task_assignee(plant_id,task_id,account_id) VALUES(${plant},${id},${accounts.owner.id})`,
		);
	const preview = await readAs(owner, "notifications.previewPlanterDigest");
	const [head, ...lines] = preview.rows;
	assert.equal(head!.kind, "digest");
	// Weekly on Mondays at 08:00 in the church's zone (the plant's schedule): seven days ending on the send day.
	const to = String(head!.fields.to);
	assert.match(String(head!.fields.sendsAt), /^Mon, /);
	assert.equal(new Date(`${to}T12:00:00Z`).getUTCDay(), 1);
	assert.equal(head!.fields.from, new Date(Date.parse(`${to}T00:00:00Z`) - 6 * DAY).toISOString().slice(0, 10));
	assert.match(head!.label, /^Church digest: \d+ open items?, /);
	assert.ok(
		lines.some((l) => l.label.endsWith(`: Book the school gym.`)),
		JSON.stringify(lines),
	);
	assert.ok(
		lines.some((l) => /^Overdue task, due .*: Call the venue\.$/.test(l.label)),
		JSON.stringify(lines),
	);
	const answers = [
		preview,
		await readAs(owner, "notifications.feed"),
		await readAs(owner, "notifications.preferences.get"),
	];
	for (const answer of answers) assert.doesNotMatch(JSON.stringify(answer), /Robin|diagnosis|pray/);
	assert.equal(await readAs(member, "notifications.feed").then((r) => r.rows.length), 2);
});

test("INV-notification-tools an organization login is offered no notification tool, and a plant seat is offered them", async () => {
	const org = await actor("orgOwner");
	const tools = modelTools(org, { read: async () => ({}), select: async () => ({}), propose: async () => ({}) });
	assert.equal("notifications_read" in tools, false);
	assert.equal(
		readCatalog(org).reviewedWrites.some((w) => w.operation.startsWith("notifications.")),
		false,
	);
	const plantTools = modelTools(owner, { read: async () => ({}), select: async () => ({}), propose: async () => ({}) });
	assert.ok("notifications_read" in plantTools);
});
