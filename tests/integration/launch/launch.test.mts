import test, { after, before } from "node:test";
import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { sql } from "../../../packages/db/src/query.ts";
import { fixture } from "../identity/invitations-support.mts";
import { ok, refused } from "../../support/fixture.mts";
import { frozenClock, instant } from "../../../packages/contracts/src/common/index.ts";
import { countdown } from "../../../packages/contracts/src/launch/index.ts";
import {
	authorizeLaunchNotices,
	createLaunchReader,
	createLaunchWriter,
} from "../../../packages/domain/src/launch/index.ts";
import { createTaskWriter, withTaskWrite } from "../../../packages/domain/src/tasks/index.ts";
import { createMailService } from "../../../apps/web/src/server/jobs/mail.ts";
import { seatedNotificationService } from "../../../apps/web/src/server/jobs/seated-notifications.ts";
import { launchNotices } from "../../../apps/web/src/server/launch/notices.ts";

// WP-045: the Launch plan. Every write runs through the writer the /launch actions call, every read through the reader
// the page calls, on its own schema of the development or CI database. "Today" is fixed at Oct 13, 2026 in Harvest
// Point's time zone (America/Chicago): 03:00 UTC on Oct 14 is still Oct 13 there.

const inventory = JSON.parse(
	readFileSync(new URL("../../../docs/reference/launch-template-inventory.json", import.meta.url), "utf8"),
);
const TODAY = frozenClock(instant.parse("2026-10-14T03:00:00.000Z"));
let f, reader, writer, tasks;
const rows = async (q) => (await f.admin.execute(q)).rows;
const one = async (q) => (await rows(q))[0];
const plan = async (who) => ok(await reader.readPlan(f.db, who.actor)).plan;
const schedule = (who, date, reason, expectedRevision, requestKey = randomUUID()) =>
	writer.schedule(f.db, who.actor, { requestKey, expectedRevision, input: { date, reason } });
const postpone = (who, reason, expectedRevision) =>
	writer.postpone(f.db, who.actor, { requestKey: randomUUID(), expectedRevision, input: { reason } });
const complete = (who, m, requestKey = randomUUID()) =>
	writer.completeMilestone(f.db, who.actor, {
		requestKey,
		expectedRevision: m.revision,
		input: { milestoneId: m.id, reviewed: m.reviewed },
	});
const reopen = (who, m) =>
	writer.reopenMilestone(f.db, who.actor, {
		requestKey: randomUUID(),
		expectedRevision: m.revision,
		input: { milestoneId: m.id },
	});
const task = (who, op, input) =>
	withTaskWrite(f.db, who.actor, (tx, ctx) => tasks[op](tx, ctx, { requestKey: randomUUID(), ...input }));
const setStatus = (who, t, status) =>
	task(who, status === "complete" ? "complete" : "reopen", { expectedRevision: t.revision, input: { taskId: t.id } });
const milestone = (p, key) => p.milestones.find((m) => m.templateKey === key);
/** Every row a launch write can add, to prove a no-op or refusal wrote nothing. */
const footprint = (w) =>
	one(sql`SELECT (SELECT count(*)::int FROM launch_milestone WHERE plant_id=${w.id}) milestones,
		(SELECT count(*)::int FROM task WHERE plant_id=${w.id}) tasks,
		(SELECT count(*)::int FROM audit_event WHERE tenant_id=${w.id}) audits,
		(SELECT count(*)::int FROM notice WHERE tenant_id=${w.id}) notices,
		(SELECT revision::text FROM launch WHERE plant_id=${w.id}) revision`);

async function seated(w, role) {
	const a = await f.account();
	await f.seat(a, w, role);
	return { ...a, actor: await f.actor(a.session) };
}
/** Harvest Point with its Owner, two Admins and a Member. A church has one Owner seat. */
async function church() {
	const w = await f.workspace("plant");
	await f.admin.execute(sql`UPDATE plant SET name='Harvest Point', timezone='America/Chicago' WHERE id=${w.id}`);
	const [owner, admin2, admin, member] = [
		await seated(w, "owner"),
		await seated(w, "admin"),
		await seated(w, "admin"),
		await seated(w, "member"),
	];
	return { w, owner, admin2, admin, member };
}
/** A church whose Owner has set Launch Sunday to Nov 10, 2026. */
async function scheduled() {
	const c = await church();
	ok(await schedule(c.owner, "2026-11-10", null, "1"));
	return { ...c, plan: await plan(c.owner) };
}
async function practice(w, { status = "completed", heldAt = "2026-10-04T15:00:00Z", type = "prelaunch_practice" } = {}) {
	const id = randomUUID();
	const teamId = type === "team_meeting" ? await teamOf(w) : null;
	await f.admin.execute(sql`INSERT INTO meeting(id,plant_id,type,team_id,title,local_date,local_time,timezone,starts_at,
		resolver_version,status,attendance_revision,actual_occurrence_at)
		VALUES(${id},${w.id},${type},${teamId},'Practice','2026-10-04','10:00','America/Chicago',${heldAt},'1',${status},1,
		${status === "completed" ? heldAt : null})`);
	return id;
}
async function teamOf(w) {
	const id = randomUUID();
	await f.admin.execute(sql`INSERT INTO team(id,plant_id,name,state,sort_order) VALUES(${id},${w.id},'Welcome','active',1)`);
	return id;
}

before(async () => {
	f = await fixture();
	const mail = createMailService({
		db: f.db,
		encryptionKey: randomBytes(32),
		addressKey: randomBytes(32),
		from: "launch@example.test",
		authorize: authorizeLaunchNotices,
		transport: {
			async send() {
				return { kind: "accepted", id: randomUUID() };
			},
			async lookup() {
				return { kind: "unknown" };
			},
		},
	});
	reader = createLaunchReader(TODAY);
	writer = createLaunchWriter({ notices: launchNotices(seatedNotificationService(mail)), clock: TODAY });
	tasks = createTaskWriter({ reminders: async () => {} });
});
after(() => f?.close());

test("AC:CASE-LCH-008 the countdown counts church-local days: 28 days, today, overdue, postponed and no date", () => {
	assert.deepEqual(countdown({ status: "scheduled", targetDate: "2026-11-10" }, "2026-10-13"), {
		kind: "ahead",
		days: 28,
		window: true,
	});
	assert.deepEqual(countdown({ status: "scheduled", targetDate: "2026-11-11" }, "2026-10-13"), {
		kind: "ahead",
		days: 29,
		window: false,
	});
	assert.deepEqual(countdown({ status: "scheduled", targetDate: "2026-10-13" }, "2026-10-13"), {
		kind: "today",
		window: true,
	});
	assert.deepEqual(countdown({ status: "scheduled", targetDate: "2026-11-10" }, "2026-11-12"), {
		kind: "overdue",
		days: 2,
	});
	assert.deepEqual(countdown({ status: "postponed", targetDate: null }, "2026-10-13"), { kind: "postponed" });
	assert.deepEqual(countdown({ status: "planning", targetDate: null }, "2026-10-13"), { kind: "none" });
	assert.deepEqual(countdown(null, "2026-10-13"), { kind: "none" });
});

test("AC:CASE-LCH-001 AC:CASE-LCH-003 setting Launch Sunday seeds the nine milestones and 23 undated, unassigned prep tasks once", async () => {
	const c = await church();
	const empty = await plan(c.owner);
	assert.equal(empty.launch, null);
	assert.equal(empty.today, "2026-10-13");
	assert.deepEqual(empty.milestones, []);

	const set = ok(await schedule(c.owner, "2026-11-10", null, "1"));
	assert.equal(set.outcome, "changed");
	assert.deepEqual(set.plan.launch, { status: "scheduled", targetDate: "2026-11-10", revision: "2" });
	assert.deepEqual(countdown(set.plan.launch, set.plan.today), { kind: "ahead", days: 28, window: true });
	assert.deepEqual(
		set.plan.milestones.map((m) => [m.templateKey, m.tasks.map((t) => t.title)]),
		inventory.milestones.map((m) => [m.template_key, m.task_titles]),
	);
	assert.deepEqual(
		set.plan.milestones.map((m) => m.tasks.length),
		[3, 3, 2, 2, 3, 3, 2, 3, 2],
	);
	const stored = await rows(sql`SELECT k.category,k.due_kind,k.status,
		(SELECT count(*)::int FROM task_assignee a WHERE a.task_id=k.id) assignees
		FROM task k WHERE k.plant_id=${c.w.id} AND k.launch_task_key IS NOT NULL`);
	assert.equal(stored.length, 23);
	for (const t of stored)
		assert.deepEqual(t, { category: "launch_prep", due_kind: "undated", status: "not_started", assignees: 0 });

	const before = await footprint(c.w);
	const again = ok(await schedule(c.owner, "2026-11-10", null, "2"));
	assert.equal(again.outcome, "noop");
	assert.deepEqual(await footprint(c.w), before);
	const history = await rows(sql`SELECT kind,before_value,after_value,actor_id FROM audit_event
		WHERE tenant_id=${c.w.id} AND subject_type='launch'`);
	assert.deepEqual(history, [
		{
			kind: "create",
			before_value: { status: "planning", targetDate: null },
			after_value: { status: "scheduled", targetDate: "2026-11-10" },
			actor_id: c.owner.id,
		},
	]);
});

test("AC:CASE-LCH-009 a date saved in onboarding gets its readiness once, even from two tabs at the same time", async () => {
	const c = await church();
	await f.admin.execute(
		sql`INSERT INTO launch(plant_id,target_date,status) VALUES(${c.w.id},'2026-11-10','scheduled')`,
	);
	const read = ok(await reader.readPlan(f.db, c.owner.actor));
	assert.equal(read.repair, true);
	assert.deepEqual(read.plan.milestones, []);
	const both = await Promise.all([writer.ensureReadiness(f.db, c.owner.actor), writer.ensureReadiness(f.db, c.owner.actor)]);
	assert.deepEqual(
		both.map(ok).map((r) => [r.milestones, r.tasks]).sort(),
		[
			[0, 0],
			[9, 23],
		],
	);
	const after = ok(await reader.readPlan(f.db, c.owner.actor));
	assert.equal(after.repair, false);
	assert.equal(after.plan.milestones.length, 9);
	assert.equal(after.plan.milestones.flatMap((m) => m.tasks).length, 23);
	// A Member opening the plan creates nothing.
	refused(await writer.ensureReadiness(f.db, c.member.actor), "access_denied");
});

test("AC:CASE-LCH-009 repair adds only what is missing: a renamed task keeps its name and a deleted one stays deleted", async () => {
	const c = await scheduled();
	// Readiness only partly created: one milestone and one task of another never made it.
	await f.admin.execute(sql`DELETE FROM task WHERE plant_id=${c.w.id} AND launch_task_key LIKE 'promotion.partner_churches/%'`);
	await f.admin.execute(
		sql`DELETE FROM launch_milestone WHERE plant_id=${c.w.id} AND template_key='promotion.partner_churches'`,
	);
	await f.admin.execute(sql`DELETE FROM task WHERE plant_id=${c.w.id} AND launch_task_key='promotion.plan/2'`);
	const partial = await plan(c.owner);
	const ops = milestone(partial, "operations.equipment_on_site");
	const [renamed, deleted] = ops.tasks;
	ok(await task(c.owner, "edit", { expectedRevision: renamed.revision, input: { taskId: renamed.id, patch: { title: "Order the chairs" } } }));
	ok(await task(c.owner, "delete", { expectedRevision: deleted.revision, input: { taskId: deleted.id } }));

	const read = ok(await reader.readPlan(f.db, c.owner.actor));
	assert.equal(read.repair, true);
	assert.deepEqual(ok(await writer.ensureReadiness(f.db, c.owner.actor)), { milestones: 1, tasks: 3 });
	const repaired = await plan(c.owner);
	assert.equal(repaired.milestones.length, 9);
	assert.deepEqual(
		milestone(repaired, "operations.equipment_on_site").tasks.map((t) => t.title),
		["Order the chairs", "Label and store the equipment where the team will find it"],
	);
	assert.deepEqual(
		milestone(repaired, "promotion.plan").tasks.map((t) => t.title),
		["Choose the promotion channels your budget supports", "Set the launch team's personal invitation goal"],
	);
	assert.equal(milestone(repaired, "promotion.partner_churches").tasks.length, 2);
	assert.deepEqual(ok(await writer.ensureReadiness(f.db, c.owner.actor)), { milestones: 0, tasks: 0 });
});

test("AC:CASE-LCH-001 moving Launch Sunday keeps every task's due date, assignee and status and the phase", async () => {
	const c = await scheduled();
	const t = milestone(c.plan, "promotion.plan").tasks[0];
	ok(
		await task(c.owner, "edit", {
			expectedRevision: t.revision,
			input: { taskId: t.id, patch: { due: { kind: "local_date", date: "2026-11-01" }, assigneeIds: [c.admin.id] } },
		}),
	);
	const phase = (await one(sql`SELECT phase FROM plant WHERE id=${c.w.id}`)).phase;
	const before = await one(sql`SELECT due_date::text,status,revision::text FROM task WHERE id=${t.id}`);

	refused(await schedule(c.owner, "2026-11-17", null, "2"), "invalid_reason");
	refused(await schedule(c.owner, "2026-11-17", "x".repeat(2001), "2"), "invalid_reason");
	const moved = ok(await schedule(c.owner, "2026-11-17", "The school gym is booked on the 17th", "2"));
	assert.deepEqual(moved.plan.launch, { status: "scheduled", targetDate: "2026-11-17", revision: "3" });
	assert.deepEqual(countdown(moved.plan.launch, moved.plan.today), { kind: "ahead", days: 35, window: false });
	assert.deepEqual(await one(sql`SELECT due_date::text,status,revision::text FROM task WHERE id=${t.id}`), before);
	assert.deepEqual(
		(await rows(sql`SELECT account_id FROM task_assignee WHERE task_id=${t.id}`)).map((r) => r.account_id),
		[c.admin.id],
	);
	assert.equal((await one(sql`SELECT phase FROM plant WHERE id=${c.w.id}`)).phase, phase);
	const entry = await one(sql`SELECT before_value,after_value,reason,actor_id,metadata->>'event' AS event
		FROM audit_event WHERE tenant_id=${c.w.id} AND subject_type='launch' ORDER BY occurred_at DESC LIMIT 1`);
	assert.deepEqual(entry, {
		before_value: { status: "scheduled", targetDate: "2026-11-10" },
		after_value: { status: "scheduled", targetDate: "2026-11-17" },
		reason: "The school gym is booked on the 17th",
		actor_id: c.owner.id,
		event: "moved",
	});
	refused(await schedule(c.owner, "2026-11-24", "Stale", "2"), "conflict");
});

test("AC:CASE-LCH-001 postponing clears the countdown and a later date schedules Launch Sunday again", async () => {
	const c = await scheduled();
	refused(await postpone(c.owner, " ", "2"), "invalid_reason");
	const off = ok(await postpone(c.owner, "Kids leader still open", "2"));
	assert.deepEqual(off.plan.launch, { status: "postponed", targetDate: null, revision: "3" });
	assert.deepEqual(countdown(off.plan.launch, off.plan.today), { kind: "postponed" });
	assert.equal(off.plan.milestones.length, 9);
	const back = ok(await schedule(c.owner, "2026-12-06", null, "3"));
	assert.deepEqual(back.plan.launch, { status: "scheduled", targetDate: "2026-12-06", revision: "4" });
	assert.equal((await footprint(c.w)).milestones, 9);
	assert.equal((await footprint(c.w)).tasks, 23);
});

test("AC:CASE-LCH-008 a passed Launch Sunday with no recorded launch is overdue, and today reads as today", async () => {
	const c = await church();
	ok(await schedule(c.owner, "2026-10-13", null, "1"));
	let p = await plan(c.owner);
	assert.deepEqual(countdown(p.launch, p.today), { kind: "today", window: true });
	await f.admin.execute(sql`UPDATE launch SET target_date='2026-10-01' WHERE plant_id=${c.w.id}`);
	p = await plan(c.owner);
	assert.deepEqual(countdown(p.launch, p.today), { kind: "overdue", days: 12 });
	assert.equal(p.launch.status, "scheduled");
});

test("AC:CASE-LCH-004 a milestone completes with an open task, refuses a stale review, needs review when a done task reopens", async () => {
	const c = await scheduled();
	const promo = milestone(c.plan, "promotion.plan");
	const [first, second] = promo.tasks;
	const done = ok(await setStatus(c.owner, first, "complete")).task;

	// The page still shows the tasks before that completion: nothing saves, and the current tasks come back.
	const stale = refused(await complete(c.owner, promo), "stale_review");
	const current = stale.details.milestone;
	assert.deepEqual(
		current.tasks.map((t) => t.status),
		["complete", "not_started"],
	);
	assert.equal(milestone(await plan(c.owner), "promotion.plan").completion, null);

	const saved = ok(await complete(c.owner, current));
	assert.equal(saved.outcome, "changed");
	assert.equal(saved.milestone.completion.by.accountId, c.owner.id);
	assert.equal(saved.milestone.needsReview, false);
	assert.equal((await one(sql`SELECT status FROM task WHERE id=${second.id}`)).status, "not_started");

	// Reopening the task that was done at completion asks for review and keeps the completion listed.
	ok(await setStatus(c.owner, done, "reopen"));
	const review = milestone(await plan(c.owner), "promotion.plan");
	assert.equal(review.needsReview, true);
	assert.equal(review.completion.by.accountId, c.owner.id);

	const reopened = ok(await reopen(c.owner, review));
	assert.equal(reopened.milestone.completion, null);
	assert.equal(reopened.milestone.needsReview, false);
});

test("AC:CASE-LCH-005 progress follows the live tasks, and finishing every task never completes the milestone", async () => {
	const c = await scheduled();
	let m = milestone(c.plan, "operations.equipment_on_site");
	for (const t of m.tasks.slice(0, 2)) ok(await setStatus(c.owner, t, "complete"));
	m = milestone(await plan(c.owner), "operations.equipment_on_site");
	assert.deepEqual(m.tasks.map((t) => t.status), ["complete", "complete", "not_started"]);

	ok(await setStatus(c.owner, m.tasks[0], "reopen"));
	ok(await task(c.owner, "delete", { expectedRevision: m.tasks[1].revision, input: { taskId: m.tasks[1].id } }));
	m = milestone(await plan(c.owner), "operations.equipment_on_site");
	assert.deepEqual(m.tasks.map((t) => t.status), ["not_started", "not_started"]);

	for (const t of m.tasks) ok(await setStatus(c.owner, t, "complete"));
	m = milestone(await plan(c.owner), "operations.equipment_on_site");
	assert.deepEqual(m.tasks.map((t) => t.status), ["complete", "complete"]);
	assert.equal(m.completion, null);
});

test("AC:CASE-LCH-005 three pre-launch services held counts only held, past, unvoided practices", async () => {
	const c = await scheduled();
	const held = async () => milestone(await plan(c.owner), "launch_team.pre_launch_services").practices.held;
	await practice(c.w);
	const second = await practice(c.w);
	assert.equal(await held(), 2);
	// None of these count.
	const services = milestone(c.plan, "launch_team.pre_launch_services").tasks;
	for (const t of services.slice(1)) ok(await setStatus(c.owner, t, "complete"));
	await practice(c.w, { type: "team_meeting" });
	await practice(c.w, { type: "vision_meeting" });
	await practice(c.w, { status: "cancelled" });
	await practice(c.w, { status: "planning", heldAt: "2026-10-04T15:00:00Z" });
	await practice(c.w, { heldAt: "2099-01-01T15:00:00Z" });
	assert.equal(await held(), 2);
	const third = await practice(c.w);
	assert.equal(await held(), 3);
	const m = milestone(await plan(c.owner), "launch_team.pre_launch_services");
	assert.equal(m.completion, null);
	// Voiding or correcting a held practice changes the count.
	await f.admin.execute(sql`UPDATE meeting SET occurrence_voided_at=clock_timestamp() WHERE id=${third}`);
	assert.equal(await held(), 2);
	await f.admin.execute(sql`UPDATE meeting SET status='planning',actual_occurrence_at=NULL WHERE id=${second}`);
	assert.equal(await held(), 1);
});

test("AC:CASE-LCH-001 AC:CASE-LCH-004 a Member reads the plan and completes their own task, and nothing else", async () => {
	const c = await scheduled();
	const assimilation = milestone(c.plan, "launch_team.ministry_training").tasks[2];
	assert.equal(assimilation.title, "Test assimilation end to end");
	const assigned = ok(
		await task(c.owner, "edit", {
			expectedRevision: assimilation.revision,
			input: { taskId: assimilation.id, patch: { assigneeIds: [c.member.id] } },
		}),
	).task;
	const seen = await plan(c.member);
	assert.equal(seen.launch.targetDate, "2026-11-10");
	assert.equal(seen.milestones.length, 9);

	const before = await footprint(c.w);
	refused(await schedule(c.member, "2026-11-17", "Member move", "2"), "access_denied");
	refused(await postpone(c.member, "Member postpone", "2"), "access_denied");
	const promo = milestone(seen, "promotion.plan");
	refused(await complete(c.member, promo), "access_denied");
	refused(await reopen(c.member, promo), "access_denied");
	const other = milestone(seen, "promotion.plan").tasks[0];
	refused(await setStatus(c.member, other, "complete"));
	assert.deepEqual(await footprint(c.w), before);

	assert.equal(ok(await setStatus(c.member, assigned, "complete")).task.status, "complete");
});

test("AC:CASE-NTF-009 completing a milestone tells each other Owner and Admin once, and a repeat tells no one", async () => {
	const c = await scheduled();
	const promo = milestone(c.plan, "promotion.plan");
	const key = randomUUID();
	ok(await complete(c.owner, promo, key));
	const notices = () =>
		rows(sql`SELECT recipient_id,category,purpose,title FROM notice WHERE tenant_id=${c.w.id} ORDER BY recipient_id`);
	const sent = await notices();
	assert.deepEqual(
		sent.map((n) => n.recipient_id),
		[c.admin2.id, c.admin.id].sort(),
	);
	for (const n of sent) {
		assert.equal(n.category, "launch");
		assert.equal(n.purpose, "launch_milestone");
		assert.match(n.title, /completed “Promotion plan chosen”/);
	}
	// The same request replays its answer; a new save of the same completion is a no-op. Neither tells anyone again.
	assert.equal(ok(await complete(c.owner, promo, key)).outcome, "changed");
	const now = milestone(await plan(c.owner), "promotion.plan");
	assert.equal(ok(await complete(c.owner, now)).outcome, "noop");
	assert.equal((await notices()).length, 2);
	// Turning the Launch notification off stops the in-app notice for that person.
	ok(await reopen(c.owner, now));
	await f.admin.execute(sql`INSERT INTO notification_preference(account_id,category,channel,enabled,unsubscribe_revision)
		VALUES(${c.admin.id},'launch_milestone','in_app',false,1),(${c.admin.id},'launch_milestone','email',false,1)`);
	ok(await complete(c.owner, milestone(await plan(c.owner), "promotion.plan")));
	assert.deepEqual(
		(await rows(sql`SELECT recipient_id FROM notice WHERE tenant_id=${c.w.id} AND archived_at IS NULL`))
			.map((n) => n.recipient_id)
			.filter((id) => id === c.admin.id).length,
		1,
	);
});
