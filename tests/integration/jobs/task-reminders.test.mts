import test, { after, before } from "node:test";
import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { sql } from "../../../packages/db/node_modules/drizzle-orm/index.js";
import { db, runtime, tenant, setup, teardown } from "./support.mts";
import { authorizeTaskReminders, reminderRecipients } from "../../../packages/domain/src/tasks/index.ts";
import { createMailService } from "../../../apps/web/src/server/jobs/mail.ts";
import { createNotificationService } from "../../../apps/web/src/server/jobs/notifications.ts";
import { taskReminderTimes } from "../../../apps/web/src/server/jobs/calendar.ts";
import { claimDue } from "../../../apps/web/src/server/jobs/queue.ts";
import { taskReminders } from "../../../apps/web/src/server/tasks/reminders.ts";

// The planned task reminders (REQ-TSK-014) for one batch of tasks with mixed due dates, assignees, preferences and
// recurrence, then for the same tasks after a reschedule, a reassignment, a completion, a replay and a closed
// successor. The mounts' real recipient and authority checks run, and the mail worker dispatches what is owed.

let reminders, mail, sent;
const people = {};
const tasks = {};
const zone = "America/Chicago";
const day = (n) => new Date(Date.now() + n * 86_400_000).toISOString().slice(0, 10);
const hours = (n) => new Date(Date.now() + n * 3_600_000).toISOString();

before(async () => {
	await setup();
	sent = [];
	mail = createMailService({
		db: runtime,
		encryptionKey: randomBytes(32),
		addressKey: randomBytes(32),
		from: "tasks@example.test",
		authorize: authorizeTaskReminders,
		transport: {
			async send(payload) {
				sent.push(payload.to);
				return { kind: "accepted", id: randomUUID() };
			},
			async lookup() {
				return { kind: "unknown" };
			},
		},
	});
	const notifications = createNotificationService({
		mail,
		async eligible(tx, inputs) {
			const found = await reminderRecipients(tx, inputs[0]?.owner.id ?? randomUUID(), [
				...new Set(inputs.map((i) => i.recipient)),
			]);
			return inputs.map((i) => (found.has(i.recipient) ? { address: found.get(i.recipient) } : null));
		},
	});
	reminders = taskReminders(notifications);
	for (const name of ["ana", "ben", "cy", "dee"]) {
		const id = randomUUID(),
			user = randomUUID(),
			email = `${name}-${id}@example.test`;
		await db.execute(
			sql`INSERT INTO auth_user(id,email,email_verified,name) VALUES(${user},${email},true,'Synthetic')`,
		);
		await db.execute(sql`INSERT INTO account(id,auth_user_id,registration_state,registration_kind)
			VALUES(${id},${user},'active','discovery')`);
		await db.execute(sql`INSERT INTO seat(account_id,plant_id,role,accepted_at)
			VALUES(${id},${tenant},${name === "ana" ? "owner" : "member"},now())`);
		people[name] = { id, email };
	}
	// Ben reads reminders in the app only; Cy gets them by email only; Dee's seat has ended.
	await db.execute(sql`INSERT INTO notification_preference(account_id,category,channel,enabled,unsubscribe_revision)
		VALUES (${people.ben.id},'task_due','email',false,1),(${people.ben.id},'task_overdue','email',false,1),
		(${people.cy.id},'task_due','in_app',false,1),(${people.cy.id},'task_overdue','in_app',false,1)`);
	await db.execute(sql`UPDATE seat SET ended_at=now() WHERE account_id=${people.dee.id}`);
});
after(teardown);

async function put(name, t) {
	const id = (tasks[name] ??= randomUUID());
	const due =
		t.due.kind === "timed"
			? sql`'timed',${t.due.at.slice(0, 10)}::date,'12:00'::time,${zone},${t.due.at}::timestamptz,1`
			: t.due.kind === "date_only"
				? sql`'date_only',${t.due.date}::date,NULL,NULL,NULL,NULL`
				: sql`'undated',NULL,NULL,NULL,NULL,NULL`;
	await db.execute(sql`INSERT INTO task(id,plant_id,title,category,priority,status,created_at,completed_at,
		due_kind,due_date,due_time,timezone,due_at,resolver_version,revision)
		VALUES (${id},${tenant},${name},'general','medium',${t.status ?? "not_started"},now(),
		${t.status === "complete" ? sql`now()` : null},${due},${t.revision})
		ON CONFLICT (id) DO UPDATE SET status=excluded.status,completed_at=excluded.completed_at,
		due_kind=excluded.due_kind,due_date=excluded.due_date,due_time=excluded.due_time,timezone=excluded.timezone,
		due_at=excluded.due_at,resolver_version=excluded.resolver_version,revision=excluded.revision`);
	// The assignee set is replaced as a whole, like a write does: `assignees` names the set, `assignee` a set of one.
	const names = t.assignees ?? (t.assignee ? [t.assignee] : []);
	await db.execute(sql`DELETE FROM task_assignee WHERE task_id=${id}`);
	for (const name of names)
		await db.execute(sql`INSERT INTO task_assignee(plant_id,task_id,account_id) VALUES (${tenant},${id},${people[name].id})`);
	return {
		plantId: tenant,
		taskId: id,
		revision: String(t.revision),
		title: name,
		assigneeIds: names.map((name) => people[name].id),
		due: t.due.kind === "date_only" ? { ...t.due, zone } : t.due,
		open: !t.status || t.status === "not_started",
		created: t.created ?? false,
	};
}
const sync = (sources) => runtime.transaction((tx) => reminders(tx, sources));
const times = (due) =>
	Object.fromEntries(taskReminderTimes(due.kind === "date_only" ? { ...due, zone } : due).map((t) => [t.slot, t.at]));

/** Every notice of the batch's tasks, with its mail and job state, in a stable order. */
async function planned() {
	const names = new Map(Object.entries(tasks).map(([k, v]) => [v, k]));
	const who = new Map(Object.entries(people).map(([k, v]) => [v.id, k]));
	const r =
		await db.execute(sql`SELECT n.source_record_id AS task,n.recipient_id AS recipient,n.source_revision::int AS revision,
		split_part(n.logical_key,'/',2) AS category,n.eligible_at,n.cancelled_at IS NOT NULL AS cancelled,n.archived_at IS NOT NULL AS archived,
		m.state AS mail,j.state AS job
		FROM notice n LEFT JOIN mail m ON m.notice_id=n.id LEFT JOIN job j ON j.id=m.job_id
		WHERE n.tenant_id=${tenant}`);
	return r.rows
		.map((row) => ({
			task: names.get(row.task),
			to: who.get(row.recipient),
			revision: row.revision,
			category: row.category,
			at: new Date(row.eligible_at).toISOString(),
			cancelled: row.cancelled,
			archived: row.archived,
			mail: row.mail,
			job: row.job,
		}))
		.sort((a, b) => `${a.task}/${a.revision}/${a.category}`.localeCompare(`${b.task}/${b.revision}/${b.category}`));
}
const row = (task, to, revision, category, at, rest = {}) => ({
	task,
	to,
	revision,
	category,
	at,
	cancelled: false,
	archived: false,
	mail: "pending",
	job: "ready",
	...rest,
});

test("CASE-NTF-005: one sync plans and replans the owed reminders of mixed tasks, and the worker sends only those", async () => {
	const due = {
		t1: { kind: "date_only", date: day(10) },
		t2: { kind: "timed", at: hours(5 * 24) },
		t3: { kind: "date_only", date: day(3) },
		t4: { kind: "date_only", date: day(4) },
		t5: { kind: "date_only", date: day(5) },
		t7: { kind: "timed", at: hours(-2) },
		t8: { kind: "date_only", date: day(7) },
	};
	const first = await sync([
		await put("t1", { assignee: "ana", due: due.t1, revision: 1 }),
		await put("t2", { assignee: "ben", due: due.t2, revision: 1 }),
		await put("t3", { assignee: "cy", due: due.t3, revision: 1 }),
		await put("t4", { assignee: "dee", due: due.t4, revision: 1 }),
		await put("t5", { due: due.t5, revision: 1 }),
		await put("t6", { assignee: "ana", due: { kind: "undated" }, revision: 1 }),
		await put("t7", { assignee: "ana", due: due.t7, revision: 1 }),
		await put("t8", { assignee: "ana", due: due.t8, revision: 1, created: true }),
	]);
	assert.equal(first.length, 11, "one result for each planned slot, null for the departed member");
	assert.deepEqual(first.slice(6, 8), [
		{ notice: null, mail: null },
		{ notice: null, mail: null },
	]);
	const t = Object.fromEntries(Object.entries(due).map(([k, v]) => [k, times(v)]));
	const app = { mail: null, job: null };
	assert.deepEqual(await planned(), [
		row("t1", "ana", 1, "task_due", t.t1.due),
		row("t1", "ana", 1, "task_overdue", t.t1.overdue),
		row("t2", "ben", 1, "task_due", t.t2.due, app),
		row("t2", "ben", 1, "task_overdue", t.t2.overdue, app),
		row("t3", "cy", 1, "task_due", t.t3.due, { archived: true }),
		row("t3", "cy", 1, "task_overdue", t.t3.overdue, { archived: true }),
		row("t7", "ana", 1, "task_overdue", t.t7.overdue),
		row("t8", "ana", 1, "task_due", t.t8.due),
		row("t8", "ana", 1, "task_overdue", t.t8.overdue),
	]);

	// t1's due notice was already shown in the inbox, so the reschedule never plans that slot again.
	await db.execute(
		sql`UPDATE notice SET eligible_at=now()-interval '1 hour' WHERE source_record_id=${tasks.t1} AND logical_key LIKE '%/task_due/%'`,
	);
	const shown = (await planned())[0].at,
		earlier = t.t1;
	due.t1 = { kind: "date_only", date: day(12) };
	t.t1 = times(due.t1);
	const second = await sync([
		await put("t1", { assignee: "ana", due: due.t1, revision: 2 }),
		await put("t2", { assignee: "ana", due: due.t2, revision: 2 }),
		await put("t3", { assignee: "cy", due: due.t3, revision: 2, status: "complete" }),
		await put("t7", { assignee: "ana", due: due.t7, revision: 1 }),
		await put("t8", { assignee: "ana", due: due.t8, revision: 2, status: "no_longer_needed" }),
	]);
	assert.equal(second.length, 4);
	assert.deepEqual(second[3], first[8], "a replay at the same revision keeps its notice and mail");
	const gone = { cancelled: true, mail: "cancelled", job: "cancelled" };
	assert.deepEqual(await planned(), [
		row("t1", "ana", 1, "task_due", shown, gone),
		row("t1", "ana", 1, "task_overdue", earlier.overdue, gone),
		row("t1", "ana", 2, "task_overdue", t.t1.overdue),
		row("t2", "ben", 1, "task_due", t.t2.due, { ...app, cancelled: true }),
		row("t2", "ben", 1, "task_overdue", t.t2.overdue, { ...app, cancelled: true }),
		row("t2", "ana", 2, "task_due", t.t2.due),
		row("t2", "ana", 2, "task_overdue", t.t2.overdue),
		row("t3", "cy", 1, "task_due", t.t3.due, { ...gone, archived: true }),
		row("t3", "cy", 1, "task_overdue", t.t3.overdue, { ...gone, archived: true }),
		row("t7", "ana", 1, "task_overdue", t.t7.overdue),
		row("t8", "ana", 1, "task_due", t.t8.due, gone),
		row("t8", "ana", 1, "task_overdue", t.t8.overdue, gone),
	]);

	await db.execute(
		sql`UPDATE job SET eligible_at=now()-interval '1 second' WHERE tenant_id=${tenant} AND state='ready'`,
	);
	for (let claims = await claimDue(runtime, ["mail"]); claims.length; claims = await claimDue(runtime, ["mail"]))
		for (const claim of claims) await mail.dispatch(claim);
	assert.deepEqual(sent.sort(), Array(4).fill(people.ana.email));
	assert.deepEqual(
		(await planned())
			.filter((r) => r.mail === "accepted" || r.mail === "sent")
			.map((r) => `${r.task}/${r.revision}/${r.category}`),
		["t1/2/task_overdue", "t2/2/task_due", "t2/2/task_overdue", "t7/1/task_overdue"],
	);
});
