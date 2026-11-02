import test, { after, before } from "node:test";
import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { sql } from "../../../packages/db/src/query.ts";
import { fixture } from "../identity/invitations-support.mts";
import { requestIdentity } from "../../../packages/contracts/src/common/index.ts";
import { auditTransaction, finishAudit, prepareWrite } from "../../../packages/domain/src/operations/writes.ts";
import {
	applyManagedStatus,
	authorizeTaskReminders,
	createTaskWriter,
	ensureMeetingObligations,
	reminderRecipients,
	taskReader,
	withTaskWrite,
} from "../../../packages/domain/src/tasks/index.ts";
import { peopleReader, peopleWriter, withPeopleWrite } from "../../../packages/domain/src/people/index.ts";
import { createMailService } from "../../../apps/web/src/server/jobs/mail.ts";
import { createNotificationService } from "../../../apps/web/src/server/jobs/notifications.ts";
import { taskReminders } from "../../../apps/web/src/server/tasks/reminders.ts";
import { claimDue } from "../../../apps/web/src/server/jobs/queue.ts";

let f, writer, reminders, mail, sent, plant, other, owner, member, admin2, foreign;
const ok = (r) => {
	assert.equal(r.status, "ok", JSON.stringify(r));
	return r.value;
};
const refused = (r, code) => {
	assert.equal(r.status, "refused", JSON.stringify(r));
	assert.equal(r.error.code, code);
	return r.error;
};
const write = (who, op, input) => withTaskWrite(f.db, who.actor, (tx, ctx) => writer[op](tx, ctx, input));
const read = (who, op, input) => f.db.transaction((tx) => taskReader[op](tx, who.actor, input));
const create = async (who, input) =>
	ok(await write(who, "create", { requestKey: randomUUID(), input: { title: "Task", ...input } })).task;
// A weekly task, made recurring by the owner; returns it at its current revision.
async function recurring(input, rule = { frequency: "weekly", until: null }) {
	const t = await create(owner, input);
	return ok(
		await write(owner, "configureRecurrence", {
			requestKey: randomUUID(),
			expectedRevision: t.revision,
			input: { taskId: t.id, rule },
		}),
	).task;
}
const subtask = async (who, parent, title) =>
	ok(
		await write(who, "createSubtask", {
			requestKey: randomUUID(),
			expectedRevision: parent.revision,
			input: { parentId: parent.id, title },
		}),
	).task;
const rows = async (q) => (await f.admin.execute(q)).rows;
async function person(name, who = owner) {
	const ctx = { session: who.actor.session, selected: who.actor.actor.context.owner };
	const r = await f.db.transaction((tx) =>
		peopleWriter.createPerson(tx, ctx, { requestKey: randomUUID(), input: { displayName: name } }),
	);
	return ok(r).person.id;
}
async function meeting(title, date = "2026-10-13", w = plant) {
	const id = randomUUID();
	await f.admin.execute(
		sql`INSERT INTO meeting(id,plant_id,type,title,local_date,local_time,timezone,starts_at,resolver_version,status,attendance_revision) VALUES(${id},${w.id},'vision_meeting',${title},${date},'18:00','America/Chicago',${date + "T23:00:00Z"},'1','completed',1)`,
	);
	return id;
}
async function team(w = plant) {
	const id = randomUUID();
	await f.admin.execute(
		sql`INSERT INTO team(id,plant_id,name,state,sort_order) VALUES(${id},${w.id},'Hospitality','active',1)`,
	);
	return id;
}

// The meeting domain's reviewed command: its own audit row, the generated work, one write statement.
const finalize = (
	meetingId,
	input,
	fault = false,
	origin = { at: "2026-10-13T23:00:00Z", date: "2026-10-13", zone: "America/Chicago" },
) =>
	auditTransaction(f.db, async (tx) => {
		if (!(await owner.actor.bind(tx, plant))) throw Error("unbound");
		const identity = requestIdentity.parse({
			owner: plant,
			actorId: owner.id,
			operation: "meetings.finalizeAttendance",
			requestKey: randomUUID(),
			digest: "0".repeat(64),
		});
		const claim = await prepareWrite(tx, identity);
		const cmd = { ...claim, actor: { accountId: owner.id, plantId: plant.id } };
		const r = await ensureMeetingObligations(tx, cmd, reminders, { meetings: [{ meetingId, origin, ...input }] });
		cmd.events.unshift({
			id: cmd.id,
			tenant_id: plant.id,
			actor_id: owner.id,
			action: "meetings.finalized",
			kind: "finalize",
			subject_type: "meeting",
			subject_id: meetingId,
		});
		await finishAudit(tx, cmd, identity, r.value);
		await r.after();
		if (fault) throw Error("outer_audit_before_commit");
		return r.value;
	});
// Statements this test's runtime pool sends while `body` runs.
let statements = 0;
async function counted(body) {
	const start = statements;
	await body();
	return statements - start;
}

before(async () => {
	f = await fixture();
	f.db.$client.on("connect", (client) => {
		const query = client.query;
		client.query = function (...args) {
			statements++;
			return Reflect.apply(query, this, args);
		};
	});
	sent = [];
	mail = createMailService({
		db: f.db,
		encryptionKey: randomBytes(32),
		addressKey: randomBytes(32),
		from: "tasks@example.test",
		authorize: authorizeTaskReminders,
		transport: {
			async send(payload) {
				sent.push(payload);
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
			const found = await reminderRecipients(
				tx,
				inputs[0]?.owner.id ?? randomUUID(),
				inputs.map((i) => i.recipient),
			);
			return inputs.map((i) => (found.has(i.recipient) ? { address: found.get(i.recipient) } : null));
		},
	});
	reminders = taskReminders(notifications);
	writer = createTaskWriter({ reminders });
	plant = await f.workspace();
	other = await f.workspace();
	await f.admin.execute(sql`UPDATE plant SET timezone='America/Chicago' WHERE id IN (${plant.id},${other.id})`);
	const seated = async (w, role) => {
		const a = await f.account();
		await f.seat(a, w, role);
		return { ...a, actor: await f.actor(a.session) };
	};
	owner = await seated(plant, "owner");
	member = await seated(plant, "member");
	// A follow-up owner needs a committed Person linked to their account (REQ-TSK-012).
	await f.admin.execute(sql`INSERT INTO person(tenant_id,plant_id,display_name,source,stage,adult_classification,
		commitment_state,pipeline_position,state,created_at,linked_account_id) VALUES(${plant.id},${plant.id},'Member Person',
		'other','core_group','unknown','unknown',0,'live',clock_timestamp(),${member.id})`);
	admin2 = await seated(plant, "admin");
	foreign = await seated(other, "owner");
});
after(() => f?.close());

test("AC:TARGET-TSK-002 AC:B03-007 AC:B03-008 AC:B03-009 AC:TARGET-TSK-018 create, edit and delete keep a valid task or change nothing", async () => {
	const foreignPerson = await person("Foreign", foreign);
	const before = await rows(sql`SELECT (SELECT count(*)::int FROM task) t,(SELECT count(*)::int FROM audit_event) a`);
	const attempt = (input) => write(owner, "create", { requestKey: randomUUID(), input: { title: "Task", ...input } });
	refused(await attempt({ title: "   " }), "invalid_input");
	refused(await attempt({ due: { kind: "local_date", date: "2026-02-30" } }), "invalid_input");
	refused(await attempt({ assigneeIds: [foreign.id] }), "invalid_subject");
	refused(await attempt({ relation: { kind: "facility", id: randomUUID() } }), "invalid_input");
	refused(await attempt({ relation: { kind: "person", id: foreignPerson } }), "invalid_subject");
	// Spring gap: 02:30 does not exist in Chicago, so nothing is saved.
	const gap = refused(
		await attempt({ due: { kind: "resolved_instant", local: "2026-03-08T02:30:00" } }),
		"nonexistent_local_time",
	);
	assert.equal(gap.details.local, "2026-03-08T02:30:00");
	// Fall fold: 01:30 happens twice; the refusal shows both offsets and each choice saves its own instant.
	const fold = refused(
		await attempt({ due: { kind: "resolved_instant", local: "2026-11-01T01:30:00" } }),
		"ambiguous_local_time",
	);
	assert.deepEqual(
		fold.details.choices.map((c) => c.offsetSeconds),
		[-18000, -21600],
	);
	// A checklist row comes only from createSubtask.
	refused(await attempt({ parentId: randomUUID() }), "invalid_input");
	assert.deepEqual(
		await rows(sql`SELECT (SELECT count(*)::int FROM task) t,(SELECT count(*)::int FROM audit_event) a`),
		before,
	);
	const saved = [];
	for (const offsetSeconds of [-18000, -21600]) {
		const t = await create(owner, { due: { kind: "resolved_instant", local: "2026-11-01T01:30:00", offsetSeconds } });
		saved.push(ok(await read(owner, "get", { taskId: t.id })).task.due.instant);
	}
	assert.deepEqual(saved, ["2026-11-01T06:30:00.000Z", "2026-11-01T07:30:00.000Z"]);

	// Undated stays undated: no epoch, no today.
	const request = {
		requestKey: randomUUID(),
		input: { title: "  Call the venue  ", priority: "high", category: "facilities" },
	};
	const first = ok(await write(owner, "create", request));
	assert.deepEqual(ok(await write(owner, "create", request)), first);
	assert.equal(first.task.title, "Call the venue");
	assert.deepEqual([first.task.due, first.task.overdue, first.task.assignees], [{ kind: "undated" }, null, []]);
	refused(await write(member, "create", { requestKey: randomUUID(), input: { title: "Member task" } }), "unavailable");

	// Edit: omitted fields stay, explicit null clears, a stale revision refuses without a hidden change.
	const p = await person("Alex Rivera");
	const edited = ok(
		await write(owner, "edit", {
			requestKey: randomUUID(),
			expectedRevision: first.task.revision,
			input: {
				taskId: first.task.id,
				patch: {
					assigneeIds: [member.id],
					relation: { kind: "person", id: p },
					due: { kind: "local_date", date: "2026-10-20" },
				},
			},
		}),
	).task;
	assert.deepEqual(
		[edited.revision, edited.priority, edited.assignees[0].accountId, edited.relation, edited.due],
		[
			"2",
			"high",
			member.id,
			{ kind: "person", id: p, label: "Alex Rivera" },
			{ kind: "local_date", date: "2026-10-20" },
		],
	);
	refused(
		await write(owner, "edit", {
			requestKey: randomUUID(),
			expectedRevision: first.task.revision,
			input: { taskId: first.task.id, patch: { title: "Hidden change" } },
		}),
		"conflict",
	);
	const cleared = ok(
		await write(owner, "edit", {
			requestKey: randomUUID(),
			expectedRevision: edited.revision,
			input: { taskId: first.task.id, patch: { relation: null, description: "Line one\r\nLine two  " } },
		}),
	).task;
	assert.deepEqual(
		[cleared.title, cleared.relation, cleared.description],
		["Call the venue", null, "Line one\nLine two"],
	);

	// Deleting a parent deletes its checklist rows too; both keep their history.
	const child = await subtask(owner, cleared, "Bring chairs");
	const withChild = ok(await read(owner, "get", { taskId: first.task.id })).task;
	assert.deepEqual(
		withChild.checklistItems.map((k) => k.id),
		[child.id],
	);
	ok(
		await write(owner, "delete", {
			requestKey: randomUUID(),
			expectedRevision: withChild.revision,
			input: { taskId: first.task.id },
		}),
	);
	assert.deepEqual(ok(await read(owner, "get", { taskId: first.task.id })), { status: "unavailable" });
	assert.deepEqual(
		await rows(
			sql`SELECT count(*)::int n FROM task WHERE id IN (${first.task.id},${child.id}) AND deleted_at IS NOT NULL`,
		),
		[{ n: 2 }],
	);
	assert.equal(ok(await read(owner, "statusHistory", { taskId: child.id })).items.length, 1);
});

test("AC:TARGET-TSK-001 AC:B03-001 AC:B03-002 AC:B03-003 views, stable pages, counts and due state", async () => {
	const w = await f.workspace();
	await f.admin.execute(sql`UPDATE plant SET timezone='America/Chicago' WHERE id=${w.id}`);
	const a = await f.account();
	await f.seat(a, w, "owner");
	const me = { ...a, actor: await f.actor(a.session) };
	const b = await f.account();
	await f.seat(b, w, "member");
	const mine = { ...b, actor: await f.actor(b.session) };
	const hospitality = await team(w);
	const foreignTeam = await team(other);
	// 51 tasks with the same (null) due key, one dated task and two checklist rows.
	const undated = [];
	for (let n = 0; n < 51; n++)
		undated.push(
			(
				await create(me, {
					title: "Same",
					assigneeIds: n < 3 ? [b.id] : [],
					relation: n < 2 ? { kind: "team", id: hospitality } : null,
				})
			).id,
		);
	const dated = await create(me, { title: "Dated", due: { kind: "local_date", date: "2026-10-13" } });
	for (const title of ["One", "Two"]) await subtask(me, dated, title);

	const pages = [1, 2].map(async (page) => ok(await read(me, "list", { sort: "due", page })));
	const [one, two] = await Promise.all(pages);
	assert.deepEqual([one.items.length, two.items.length, one.total, one.next, two.next], [50, 2, 52, 2, null]);
	assert.equal(one.items[0].id, dated.id);
	const ids = [...one.items, ...two.items].map((t) => t.id);
	assert.equal(new Set(ids).size, 52);
	assert.deepEqual(ids.slice(1), [...undated].sort());
	assert.deepEqual(one.items[0].checklist, { total: 2, complete: 0 });

	const counts = ok(await read(mine, "count", {}));
	assert.deepEqual(
		[counts.topLevelTotal, counts.childTaskTotal, counts.childTaskComplete, counts.byStatus],
		[52, 2, 0, [{ value: "not_started", count: 52 }]],
	);
	const my = ok(await read(mine, "list", { view: "my" }));
	assert.equal(my.total, 3);
	assert.equal(ok(await read(mine, "list", { view: "my", teamId: hospitality })).total, 2);
	assert.equal(ok(await read(mine, "count", { view: "all", teamId: hospitality })).topLevelTotal, 2);
	assert.deepEqual(ok(await read(mine, "list", { teamId: foreignTeam })).items, []);
	assert.equal(
		ok(await read(foreign, "list", {})).items.some((t) => ids.includes(t.id)),
		false,
	);

	// Due state at frozen instants, independent of the host zone.
	const overdue = async (taskId, asOf) => ok(await read(me, "get", { taskId, asOf })).task.overdue;
	assert.deepEqual(
		[await overdue(dated.id, "2026-10-14T03:00:00Z"), await overdue(dated.id, "2026-10-14T05:00:00Z")],
		[false, true],
	);
	for (const [date, end] of [
		["2026-03-08", "2026-03-09T05:00:00Z"],
		["2026-11-01", "2026-11-02T06:00:00Z"],
	]) {
		const t = await create(me, { due: { kind: "local_date", date } });
		const justBefore = new Date(Date.parse(end) - 1000).toISOString();
		assert.deepEqual([await overdue(t.id, justBefore), await overdue(t.id, end)], [false, true]);
		assert.equal(t.due.date, date);
	}
	const timed = await create(me, { due: { kind: "resolved_instant", local: "2026-10-13T13:00:00" } });
	assert.equal(timed.due.instant, "2026-10-13T18:00:00.000Z");
	assert.deepEqual(
		[await overdue(timed.id, "2026-10-13T17:59:59Z"), await overdue(timed.id, "2026-10-13T18:00:01Z")],
		[false, true],
	);
});

test("AC:TARGET-TSK-003 AC:TARGET-TSK-015 own-duty completion, one result per request, reopen and history", async () => {
	const command = (who, op, t, extra = {}) =>
		write(who, op, { requestKey: randomUUID(), expectedRevision: t.revision, input: { taskId: t.id, ...extra } });
	// The assignee changed after the owner looked: the old revision refuses and nothing completes.
	const t = await create(owner, {
		title: "Welcome packs",
		assigneeIds: [admin2.id],
		relation: { kind: "person", id: await person("Jamie") },
	});
	const moved = ok(
		await write(admin2, "edit", {
			requestKey: randomUUID(),
			expectedRevision: t.revision,
			input: { taskId: t.id, patch: { assigneeIds: [member.id] } },
		}),
	).task;
	refused(await command(owner, "complete", t), "conflict");
	// A Member acts only on a task they hold.
	const others = await create(owner, { title: "Not yours", assigneeIds: [admin2.id] });
	refused(await command(member, "complete", others), "unavailable");
	refused(await command(member, "edit", moved, { patch: { title: "Renamed" } }), "unavailable");

	// The assignee may change the status of their own task.
	const started = ok(await command(member, "changeStatus", moved, { status: "in_progress" })).task;
	assert.equal(started.status, "in_progress");
	const request = { requestKey: randomUUID(), expectedRevision: started.revision, input: { taskId: t.id } };
	const done = ok(await write(member, "complete", request));
	// A lost response: the same request shows the earlier result and adds no history.
	assert.deepEqual(ok(await write(member, "complete", request)), done);
	assert.equal(done.task.status, "complete");
	assert.ok(done.task.completedAt);
	refused(await command(member, "complete", started), "conflict");
	const reopened = ok(await command(member, "reopen", done.task)).task;
	assert.deepEqual([reopened.status, reopened.completedAt], ["not_started", null]);
	const same = { requestKey: randomUUID(), expectedRevision: reopened.revision, input: { taskId: t.id } };
	const again = ok(await write(member, "reopen", same));
	assert.equal(again.outcome, "noop");
	// A retried no-op returns the same answer.
	assert.deepEqual(ok(await write(member, "reopen", same)), again);
	// A command that changes nothing records exactly one audit row, of kind noop (C98).
	const keyed = (key) =>
		rows(
			sql`SELECT kind, subject_type, subject_id FROM audit_event WHERE tenant_id=${plant.id} AND request_key=${key}`,
		);
	const plain = await recurring({ title: "Stack chairs" });
	const unchanged = [["reopen", same.requestKey, t.id]];
	for (const [op, input] of [
		["edit", { patch: { title: "Stack chairs" } }],
		["replacePrerequisites", { prerequisiteIds: [] }],
		["configureRecurrence", { rule: { frequency: "weekly", until: null } }],
	]) {
		const requestKey = randomUUID();
		const r = ok(
			await write(owner, op, { requestKey, expectedRevision: plain.revision, input: { taskId: plain.id, ...input } }),
		);
		assert.equal(r.outcome, "noop", op);
		unchanged.push([op, requestKey, plain.id]);
	}
	for (const [op, key, id] of unchanged)
		assert.deepEqual(await keyed(key), [{ kind: "noop", subject_type: "task", subject_id: id }], op);

	const history = ok(await read(member, "statusHistory", { taskId: t.id }));
	assert.deepEqual(
		history.items.map((h) => [h.from, h.to, h.actor.kind === "account" ? h.actor.accountId : h.actor.kind, h.source]),
		[
			[null, "not_started", owner.id, "person"],
			["not_started", "in_progress", member.id, "person"],
			["in_progress", "complete", member.id, "person"],
			["complete", "not_started", member.id, "person"],
		],
	);
	// Completing a person-linked task records no contact.
	assert.deepEqual(await rows(sql`SELECT count(*)::int n FROM contact_outcome`), [{ n: 0 }]);
	refused(await read(foreign, "statusHistory", { taskId: t.id }), "unavailable");

	// A readable task with no status audit row (a direct-SQL seed) reads an empty history, never a denial; a caller
	// outside its church still gets the refusal, with or without audit rows.
	const seeded = randomUUID();
	await f.admin.execute(sql`INSERT INTO task (id, plant_id, title, category, priority, status, created_at, due_kind)
		VALUES (${seeded}, ${plant.id}, 'Call James', 'general', 'medium', 'not_started', now(), 'undated')`);
	for (const who of [owner, member])
		assert.deepEqual(ok(await read(who, "statusHistory", { taskId: seeded })), {
			taskId: seeded,
			items: [],
			next: null,
			completeness: "complete",
		});
	refused(await read(foreign, "statusHistory", { taskId: seeded }), "unavailable");
	refused(await read(owner, "statusHistory", { taskId: randomUUID() }), "unavailable");

	// An older occurrence cannot reopen while a later one of its series is open; the refusal names it.
	const older = await create(owner, { title: "Weekly check-in" });
	const newer = await create(owner, { title: "Weekly check-in" });
	const series = randomUUID();
	await f.admin.execute(
		sql`INSERT INTO recurrence(id,plant_id,interval,timezone,source_task_id,source_revision) VALUES(${series},${plant.id},'weekly','America/Chicago',${older.id},1)`,
	);
	await f.admin.execute(
		sql`UPDATE task SET series_id=${series},occurrence_key='1',status='complete',completed_at=now() WHERE id=${older.id}`,
	);
	await f.admin.execute(
		sql`UPDATE task SET series_id=${series},occurrence_key='2',predecessor_id=${older.id} WHERE id=${newer.id}`,
	);
	const conflict = refused(await command(owner, "reopen", older), "open_successor");
	assert.equal(conflict.details.successorId, newer.id);
});

test("AC:TARGET-TSK-017 AC:PERSONREF-TASK-PERSON-FOLLOW-UP-RETIRE generated follow-ups and evaluation never duplicate or return", async () => {
	const p1 = await person("Alex Rivera"),
		p2 = await person("Alex Chen");
	const m1 = await meeting("Vision night"),
		m2 = await meeting("Second vision night");
	const counts = () =>
		rows(
			sql`SELECT (SELECT count(*)::int FROM task WHERE obligation_id IS NOT NULL) t,(SELECT count(*)::int FROM obligation) o`,
		);
	const input = {
		followUps: [
			{ personId: p1, assigneeIds: [member.id] },
			{ personId: p2, assigneeIds: [] },
		],
		evaluation: { assigneeIds: [owner.id] },
	};
	const first = await finalize(m1, input);
	assert.deepEqual(
		first.map((r) => [r.kind, r.personId, r.outcome]),
		[
			["first_vision_follow_up", p1, "created"],
			["first_vision_follow_up", p2, "created"],
			["meeting_evaluation", null, "created"],
		],
	);
	const task = async (id) => ok(await read(owner, "get", { taskId: id })).task;
	const [f1, f2, evaluation] = await Promise.all(first.map((r) => task(r.taskId)));
	assert.deepEqual(
		[f1.title, f1.due, f1.assignees[0].accountId, f1.managed.kind, f2.assignees],
		[
			"Follow up with Alex Rivera",
			{ kind: "local_date", date: "2026-10-15" },
			member.id,
			"first_vision_follow_up",
			[],
		],
	);
	assert.deepEqual(
		[evaluation.relation, evaluation.managed.kind],
		[{ kind: "meeting", id: m1, label: "Vision night" }, "meeting_evaluation"],
	);
	assert.equal(ok(await read(owner, "statusHistory", { taskId: f1.id })).items[0].source, "generated");

	// A failure before the finalize commits leaves nothing; a retry adds nothing.
	const settled = await counts();
	await assert.rejects(finalize(m2, input, true), /outer_audit_before_commit/);
	assert.deepEqual(await counts(), settled);
	assert.deepEqual(
		(await finalize(m1, input)).map((r) => r.outcome),
		["existing", "existing", "existing"],
	);
	assert.deepEqual(await counts(), settled);
	// Two meetings on the same day give the same person two follow-ups.
	const second = await finalize(m2, { followUps: [{ personId: p1, assigneeIds: [] }], evaluation: null });
	assert.notEqual(second[0].obligationId, first[0].obligationId);

	// Waived stays waived through an edit; a deleted task is not recreated; the source relation is protected.
	const waived = ok(
		await write(owner, "waive", {
			requestKey: randomUUID(),
			expectedRevision: f2.revision,
			input: { taskId: f2.id, reason: "Moved away" },
		}),
	).task;
	ok(
		await write(owner, "edit", {
			requestKey: randomUUID(),
			expectedRevision: waived.revision,
			input: { taskId: f2.id, patch: { title: "Closed" } },
		}),
	);
	ok(
		await write(owner, "delete", { requestKey: randomUUID(), expectedRevision: f1.revision, input: { taskId: f1.id } }),
	);
	assert.deepEqual(
		(await finalize(m1, input)).map((r) => r.outcome),
		["existing", "existing", "existing"],
	);
	assert.deepEqual(
		await rows(sql`SELECT waived_at IS NOT NULL w, waiver_reason r FROM obligation WHERE id=${first[1].obligationId}`),
		[{ w: true, r: "Moved away" }],
	);
	assert.equal((await counts())[0].t, settled[0].t + 1);
	for (const patch of [{ relation: { kind: "meeting", id: m2 } }, { category: "general" }])
		refused(
			await write(owner, "edit", {
				requestKey: randomUUID(),
				expectedRevision: evaluation.revision,
				input: { taskId: evaluation.id, patch },
			}),
			"protected_source",
		);
	// Recording the evaluation completes its task inside the same command, attributed as generated work; a repeat
	// leaves it as it is.
	const recordEvaluation = () =>
		auditTransaction(f.db, async (tx) => {
			await owner.actor.bind(tx, plant);
			const identity = requestIdentity.parse({
				owner: plant,
				actorId: owner.id,
				operation: "meetings.recordEvaluation",
				requestKey: randomUUID(),
				digest: "1".repeat(64),
			});
			const claim = await prepareWrite(tx, identity);
			const cmd = { ...claim, actor: { accountId: owner.id, plantId: plant.id } };
			const r = await applyManagedStatus(tx, cmd, reminders, {
				obligationIds: [first[2].obligationId],
				status: "complete",
			});
			cmd.events.unshift({
				id: cmd.id,
				tenant_id: plant.id,
				actor_id: owner.id,
				action: "meetings.changed",
				kind: "edit",
				subject_type: "meeting",
				subject_id: m1,
			});
			await finishAudit(tx, cmd, identity, r.value);
			return r.value.outcome;
		});
	assert.deepEqual([await recordEvaluation(), await recordEvaluation()], ["changed", "noop"]);
	assert.deepEqual(
		ok(await read(owner, "statusHistory", { taskId: evaluation.id })).items.map((h) => [h.to, h.source]),
		[
			["not_started", "generated"],
			["complete", "generated"],
		],
	);

	// Retiring Alex Rivera: the open follow-up keeps its historical Person, new references and selectors refuse him.
	const ctx = { session: owner.actor.session, selected: plant };
	const review = ok(await f.db.transaction((tx) => peopleReader.getStatusWarnings(tx, ctx, { personId: p1 })));
	ok(
		await f.db.transaction((tx) =>
			peopleWriter.retirePerson(
				tx,
				ctx,
				{
					requestKey: randomUUID(),
					expectedRevision: review.revision,
					input: {
						personId: p1,
						reason: "Duplicate record",
						reviewRevision: review.reviewRevision,
						handoffs: review.openDuties.map((d) => ({
							kind: "needs_owner",
							dutyId: d.id,
							expectedRevision: d.revision,
						})),
					},
				},
				reminders,
			),
		),
	);
	assert.deepEqual(await rows(sql`SELECT person_id FROM task WHERE id=${second[0].taskId}`), [{ person_id: p1 }]);
	assert.equal(
		ok(await read(owner, "relationOptions", { kind: "person", search: "Alex" })).items.some((o) => o.id === p1),
		false,
	);
	refused(
		await write(owner, "create", {
			requestKey: randomUUID(),
			input: { title: "Call", relation: { kind: "person", id: p1 } },
		}),
		"invalid_subject",
	);
	await assert.rejects(
		finalize(await meeting("Third"), { followUps: [{ personId: p1, assigneeIds: [] }], evaluation: null }),
	);
});

test("AC:TARGET-TSK-014 due and overdue reminders follow the current assignee and stop when settled", async () => {
	const notices = (task) =>
		rows(sql`SELECT n.recipient_id, n.purpose, n.cancelled_at IS NOT NULL cancelled, m.state, m.id mail FROM notice n
			LEFT JOIN mail m ON m.notice_id=n.id WHERE n.source_record_id=${task} ORDER BY n.recipient_id, n.eligible_at`);
	const live = async (task) => (await notices(task)).filter((n) => !n.cancelled);
	const t = await create(owner, {
		title: "Book the venue",
		assigneeIds: [member.id],
		due: { kind: "local_date", date: "2099-01-15" },
	});
	assert.deepEqual(
		(await live(t.id)).map((n) => [n.recipient_id, n.state]),
		[
			[member.id, "pending"],
			[member.id, "pending"],
		],
	);
	const before = (await live(t.id)).map((n) => n.mail);
	const moved = ok(
		await write(owner, "edit", {
			requestKey: randomUUID(),
			expectedRevision: t.revision,
			input: { taskId: t.id, patch: { assigneeIds: [admin2.id] } },
		}),
	).task;
	assert.deepEqual(
		(await live(t.id)).map((n) => n.recipient_id),
		[admin2.id, admin2.id],
	);
	// A stale reminder never reaches the former owner.
	const mailRows = await rows(
		sql`SELECT id, recipient_account_id recipient, notice_id notice FROM mail WHERE notice_id IN (SELECT id FROM notice WHERE source_record_id=${t.id})`,
	);
	const allowed = await f.db.transaction((tx) => authorizeTaskReminders(tx, mailRows));
	assert.deepEqual(
		mailRows.filter((m) => allowed.has(m.id)).map((m) => m.recipient),
		[admin2.id, admin2.id],
	);
	assert.equal(
		before.some((id) => allowed.has(id)),
		false,
	);
	// Every write that moves the revision replans the reminders, so the assignee's mail still goes out.
	const prerequisite = await create(owner, { title: "Sign the lease" });
	const blocked = ok(
		await write(owner, "replacePrerequisites", {
			requestKey: randomUUID(),
			expectedRevision: moved.revision,
			input: { taskId: t.id, prerequisiteIds: [prerequisite.id] },
		}),
	).task;
	const repeating = ok(
		await write(owner, "configureRecurrence", {
			requestKey: randomUUID(),
			expectedRevision: blocked.revision,
			input: { taskId: t.id, rule: { frequency: "weekly", until: null } },
		}),
	).task;
	const replanned = await rows(
		sql`SELECT m.id, m.recipient_account_id recipient, m.notice_id notice FROM mail m JOIN notice n ON n.id=m.notice_id
			WHERE n.source_record_id=${t.id} AND n.cancelled_at IS NULL`,
	);
	const sendable = await f.db.transaction((tx) => authorizeTaskReminders(tx, replanned));
	assert.deepEqual(
		replanned.filter((m) => sendable.has(m.id)).map((m) => m.recipient),
		[admin2.id, admin2.id],
	);
	ok(
		await write(admin2, "complete", {
			requestKey: randomUUID(),
			expectedRevision: repeating.revision,
			input: { taskId: t.id },
		}),
	);
	assert.deepEqual(await live(t.id), []);
	// Reopening a dated, assigned task plans its reminders again; completing an occurrence plans the next one's.
	const pending = async (task) => (await live(task)).map((n) => [n.recipient_id, n.state]);
	const twice = [
		[admin2.id, "pending"],
		[admin2.id, "pending"],
	];
	const once = await recurring({
		title: "Order chairs",
		assigneeIds: [admin2.id],
		due: { kind: "local_date", date: "2099-02-01" },
	});
	const done = ok(
		await write(owner, "completeOccurrence", {
			requestKey: randomUUID(),
			expectedRevision: once.revision,
			input: { taskId: once.id },
		}),
	);
	assert.deepEqual([await pending(once.id), await pending(done.successor.id)], [[], twice]);
	ok(
		await write(owner, "delete", {
			requestKey: randomUUID(),
			expectedRevision: done.successor.revision,
			input: { taskId: done.successor.id },
		}),
	);
	ok(
		await write(owner, "reopen", {
			requestKey: randomUUID(),
			expectedRevision: done.task.revision,
			input: { taskId: once.id },
		}),
	);
	assert.deepEqual(await pending(once.id), twice);
	// Undated or unassigned tasks have no reminders.
	const undated = await create(owner, { assigneeIds: [member.id] });
	const unassigned = await create(owner, { due: { kind: "local_date", date: "2099-01-15" } });
	assert.deepEqual([await notices(undated.id), await notices(unassigned.id)], [[], []]);
});

test("INV-statements: page reads are one statement and generated work costs the same for any batch size", async () => {
	const guests = [];
	for (let n = 0; n < 6; n++) guests.push(await person("Guest " + n));
	const batch = async (n) => {
		const m = await meeting("Batch " + n, "2099-01-10");
		const followUps = guests.slice(0, n).map((personId) => ({ personId, assigneeIds: [member.id] }));
		const origin = { at: "2099-01-11T00:00:00Z", date: "2099-01-10", zone: "America/Chicago" };
		return counted(() => finalize(m, { followUps, evaluation: { assigneeIds: [owner.id] } }, false, origin));
	};
	// Each generated task is dated and assigned, so each one also gets its two reminders.
	const [one, five] = [await batch(1), await batch(5)];
	assert.ok(one > 0);
	assert.equal(five, one);
	assert.deepEqual(
		await rows(
			sql`SELECT count(*)::int n FROM notice WHERE recipient_id=${member.id} AND cancelled_at IS NULL AND eligible_at>'2099-01-01'`,
		),
		[{ n: 12 }],
	);
	// A page read is BEGIN, one query and COMMIT, with few or many tasks on the page.
	const t = await create(owner, { title: "Read me" });
	const reads = async () => [
		await counted(() => read(owner, "list", { limit: 100 })),
		await counted(() => read(owner, "count", {})),
		await counted(() => read(owner, "get", { taskId: t.id })),
		await counted(() => read(owner, "statusHistory", { taskId: t.id })),
		await counted(() => read(owner, "listSubtasks", { parentId: t.id })),
		await counted(() => read(owner, "listPrerequisites", { taskId: t.id })),
		await counted(() => read(owner, "prerequisiteCandidates", { taskId: t.id })),
		await counted(() => read(owner, "findOpenOccurrence", { taskId: t.id })),
	];
	const few = await reads();
	for (let n = 0; n < 40; n++) await create(owner, { title: "More " + n, assigneeIds: [member.id] });
	assert.deepEqual([few, await reads()], [Array(8).fill(3), Array(8).fill(3)]);

	// A bulk completion costs the same statements for one task or twenty, each recurring, dated and assigned, so each
	// also creates a successor with its reminders.
	const bulkOf = async (n) => {
		const items = [];
		for (let i = 0; i < n; i++) {
			const task = await recurring({ assigneeIds: [member.id], due: { kind: "local_date", date: "2099-02-01" } });
			items.push({ taskId: task.id, expectedRevision: task.revision });
		}
		let result;
		const count = await counted(async () => {
			result = ok(await write(owner, "bulkComplete", { requestKey: randomUUID(), items }));
		});
		assert.equal(result.changed, n);
		return count;
	};
	const [single, twenty] = [await bulkOf(1), await bulkOf(20)];
	assert.equal(twenty, single);
});

test("AC:TARGET-TSK-014 a delivered due reminder is not sent again after the deadline moves", async () => {
	const dispatch = async () => {
		for (const claim of await claimDue(f.db, ["mail"], 10)) await mail.dispatch(claim);
	};
	const wait = (ms) => new Promise((resolve) => setTimeout(resolve, Math.max(0, ms - Date.now()) + 200));
	const before = sent.length;
	const first = Date.now() + 3000;
	const t = await create(owner, {
		title: "Print programs",
		assigneeIds: [member.id],
		due: deadline(first),
	});
	await wait(first);
	await dispatch();
	assert.equal(sent.length, before + 1);
	const second = Date.now() + 3000;
	ok(
		await write(owner, "edit", {
			requestKey: randomUUID(),
			expectedRevision: t.revision,
			input: { taskId: t.id, patch: { due: deadline(second) } },
		}),
	);
	await wait(second);
	await dispatch();
	assert.equal(sent.length, before + 1);
	// The overdue slot is still owed, once, at the new deadline plus 24 hours.
	assert.deepEqual(
		await rows(
			sql`SELECT split_part(logical_key,'/',2) slot, to_char(eligible_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS".000Z"') eligible_at FROM notice WHERE source_record_id=${t.id} AND cancelled_at IS NULL`,
		),
		[
			{
				slot: "task_overdue",
				eligible_at: new Date(Date.parse(new Date(second).toISOString().slice(0, 19) + "Z") + 86_400_000).toISOString(),
			},
		],
	);
});

// A plant-local deadline for an instant, as the task form sends it. The form sends the chosen offset at a fold
// (REQ-TSK-018), so the helper always sends the offset of this instant: in the repeated hour after a fall-back the
// wall time alone is ambiguous and the server refuses it.
function deadline(ms) {
	const local = new Intl.DateTimeFormat("sv-SE", {
		timeZone: "America/Chicago",
		year: "numeric",
		month: "2-digit",
		day: "2-digit",
		hour: "2-digit",
		minute: "2-digit",
		second: "2-digit",
	})
		.format(ms)
		.replace(" ", "T");
	const offsetSeconds = (Date.parse(`${local}Z`) - Math.floor(ms / 1000) * 1000) / 1000;
	return { kind: "resolved_instant", local, offsetSeconds };
}
// The mail worker: claim the due mail jobs and send each one through the reminder authorization.
const dispatch = async () => {
	for (const claim of await claimDue(f.db, ["mail"], 10)) await mail.dispatch(claim);
};
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, Math.max(0, ms - Date.now()) + 200));
test("AC:TARGET-TSK-014 a duty handed off when its person leaves reminds its new assignee", async () => {
	// Team members with their own Person records, as account links make them.
	const linked = async (name) => {
		const a = await f.account();
		await f.seat(a, plant, "member");
		const id = await person(name);
		await f.admin.execute(sql`UPDATE person SET linked_account_id=${a.id} WHERE id=${id}`);
		return { ...a, person: id };
	};
	const [leaving, staying, moving, taking] = [
		await linked("Leaving Member"),
		await linked("Staying Member"),
		await linked("Moving Member"),
		await linked("Taking Member"),
	];
	await f.admin.execute(sql`UPDATE person SET stage='leader' WHERE id=${moving.person}`);
	const ctx = { session: owner.actor.session, selected: plant };
	const warnings = (id) => f.db.transaction((tx) => peopleReader.getStatusWarnings(tx, ctx, { personId: id }));
	const handTo = (duties, to) =>
		duties.map((d) => ({ kind: "assign", dutyId: d.id, expectedRevision: d.revision, toPersonId: to }));
	const due = Date.now() + 4000;
	const dated = (assigneeId, title) =>
		create(owner, { title, assigneeIds: [assigneeId], due: deadline(due) });
	const [retired, demoted] = [await dated(leaving.id, "Set up chairs"), await dated(moving.id, "Lead worship")];
	// Retiring a person hands the duty to another member; leaving the core stages does the same.
	const review = ok(await warnings(leaving.person));
	ok(
		await withPeopleWrite(f.db, owner.actor, (tx, c) =>
			peopleWriter.retirePerson(
				tx,
				c,
				{
					requestKey: randomUUID(),
					expectedRevision: review.revision,
					input: {
						personId: leaving.person,
						reason: "Moved away",
						reviewRevision: review.reviewRevision,
						handoffs: handTo(review.openDuties, staying.person),
					},
				},
				reminders,
			),
		),
	);
	const stage = ok(await warnings(moving.person));
	ok(
		await withPeopleWrite(f.db, owner.actor, (tx, c) =>
			peopleWriter.changeStatus(
				tx,
				c,
				{
					requestKey: randomUUID(),
					expectedRevision: stage.revision,
					input: {
						personId: moving.person,
						stage: "prospect",
						reason: "Stepping back",
						handoffs: handTo(stage.openDuties, taking.person),
					},
				},
				reminders,
			),
		),
	);
	await wait(due);
	await dispatch();
	// Each duty's due reminder went to its new assignee and was sent, and the overdue one waits for them; the former
	// assignee's two reminders were withdrawn.
	const delivered = async (task) =>
		rows(sql`SELECT n.recipient_id, n.cancelled_at IS NOT NULL cancelled, m.state FROM notice n LEFT JOIN mail m ON m.notice_id=n.id
			WHERE n.source_record_id=${task} ORDER BY n.cancelled_at IS NOT NULL, n.eligible_at`);
	for (const [task, from, to] of [
		[retired.id, leaving.id, staying.id],
		[demoted.id, moving.id, taking.id],
	])
		assert.deepEqual(
			(await delivered(task)).map((n) => [n.recipient_id, n.cancelled, n.state]),
			[
				[to, false, "accepted"],
				[to, false, "pending"],
				[from, true, "cancelled"],
				[from, true, "cancelled"],
			],
		);
});

test("AC:TARGET-TSK-014 AC:TARGET-IDN-019 a duty handed off when a seat is removed reminds its new assignee", async () => {
	const seated = async () => {
		const a = await f.account();
		return { ...a, seat: await f.seat(a, plant, "member") };
	};
	const [leaving, taking] = [await seated(), await seated()];
	const due = Date.now() + 4000;
	const dated = (title) =>
		create(owner, { title, assigneeIds: [leaving.id], due: deadline(due) });
	const [handed, unowned] = [await dated("Print bulletins"), await dated("Order supplies")];
	// Removing the seat hands one duty to another member and leaves the other needing an owner.
	const review = await f.seats.readRemoval(owner.session, plant, { seatId: leaving.seat });
	const result = await f.seats.remove(
		owner.actor,
		plant,
		{
			requestKey: randomUUID(),
			expectedRevision: review.expectedRevision,
			input: {
				seatId: review.seatId,
				expectedRole: review.expectedRole,
				handoffs: review.duties.map((d) =>
					d.dutyId === handed.id
						? { kind: "assign", dutyId: d.dutyId, expectedRevision: d.expectedRevision, recipientAccountId: taking.id }
						: { kind: "needs_owner", dutyId: d.dutyId, expectedRevision: d.expectedRevision },
				),
			},
		},
		reminders,
	);
	assert.equal(result.outcome, "changed");
	await wait(due);
	await dispatch();
	// The handed duty's due reminder went to its new assignee and was sent, and the overdue one waits for them. The
	// removed member's reminders were withdrawn from both duties; the duty without an owner reminds nobody.
	const delivered = async (task) =>
		(
			await rows(sql`SELECT n.recipient_id, n.cancelled_at IS NOT NULL cancelled, m.state FROM notice n LEFT JOIN mail m ON m.notice_id=n.id
			WHERE n.source_record_id=${task} ORDER BY n.cancelled_at IS NOT NULL, n.eligible_at`)
		).map((n) => [n.recipient_id, n.cancelled, n.state]);
	assert.deepEqual(await delivered(handed.id), [
		[taking.id, false, "accepted"],
		[taking.id, false, "pending"],
		[leaving.id, true, "cancelled"],
		[leaving.id, true, "cancelled"],
	]);
	assert.deepEqual(await delivered(unowned.id), [
		[leaving.id, true, "cancelled"],
		[leaving.id, true, "cancelled"],
	]);
});

test("INV-tenancy: a seat ended, demoted or signed out after the viewer lookup reads no task data", async () => {
	const t = await create(owner, { title: "Private plan" });
	const seated = async (role) => {
		const a = await f.account();
		const seat = await f.seat(a, plant, role);
		return { ...a, seat, actor: await f.actor(a.session) };
	};
	const reads = (who) => [
		["get", { taskId: t.id }],
		["list", {}],
		["count", {}],
		["statusHistory", { taskId: t.id }],
		["listSubtasks", { parentId: t.id }],
		["listPrerequisites", { taskId: t.id }],
		["findOpenOccurrence", { taskId: t.id }],
		["eligibleAssignees", undefined],
		["relationOptions", { kind: "person" }],
		["prerequisiteCandidates", { taskId: t.id }],
	];
	const [removed, demoted, signedOut] = [await seated("admin"), await seated("admin"), await seated("admin")];
	for (const who of [removed, demoted, signedOut]) for (const [op, input] of reads(who)) ok(await read(who, op, input));
	// Each change lands after the actor was resolved, as in a request that already looked up its viewer.
	await f.admin.execute(sql`UPDATE seat SET ended_at=now() WHERE id=${removed.seat}`);
	await f.admin.execute(sql`UPDATE seat SET role='member' WHERE id=${demoted.seat}`);
	await f.admin.execute(sql`UPDATE auth_session SET expires_at=now() WHERE id=${signedOut.session}`);
	for (const who of [removed, signedOut])
		for (const [op, input] of reads(who)) refused(await read(who, op, input), "unavailable");
	// A demoted Admin keeps Member reads and loses the Admin-only selectors.
	assert.equal(ok(await read(demoted, "get", { taskId: t.id })).task.id, t.id);
	for (const [op, input] of reads(demoted).slice(7)) refused(await read(demoted, op, input), "unavailable");
});

const get = async (who, taskId) => ok(await read(who, "get", { taskId })).task;
const tick = (who, parent, child, complete) =>
	write(who, "setSubtaskCompletion", {
		requestKey: randomUUID(),
		expectedRevision: child.revision,
		input: { parentId: parent.id, taskId: child.id, complete },
	});

test("AC:TARGET-TSK-005 AC:EVRY-REAL-CHILD-TASK-PARITY checklist rows are one-level tasks with their own assignee and history", async () => {
	const child = (who, parent, input) =>
		write(who, "createSubtask", {
			requestKey: randomUUID(),
			expectedRevision: parent.revision,
			input: { parentId: parent.id, title: "Item", ...input },
		});
	// Parent P is held by Admin B. Omitted inherits B; an Owner may also name an eligible account or null.
	const p = await create(owner, { title: "Plan picnic", assigneeIds: [admin2.id] });
	const inherited = ok(await child(owner, p, {})).task;
	const c = ok(await child(owner, p, { title: "Call venue", assigneeIds: [member.id] })).task;
	const unassigned = ok(await child(owner, p, { assigneeIds: [] })).task;
	assert.deepEqual(
		[inherited.assignees[0].accountId, c.assignees[0].accountId, unassigned.assignees],
		[admin2.id, member.id, []],
	);
	refused(await child(owner, p, { assigneeIds: [foreign.id] }), "invalid_subject");
	// One level only: no row under a row, no parent from another church, no stale parent review.
	refused(await child(owner, c, {}), "invalid_subject");
	refused(await child(foreign, p, {}), "unavailable");
	refused(await child(owner, { ...p, revision: "9" }, {}), "conflict");
	// A Member adds only under a parent they hold, and the row is theirs: no other account, no null.
	const pa = await create(owner, { title: "Member plan", assigneeIds: [member.id] });
	const l = ok(await child(member, pa, {})).task;
	assert.equal(l.assignees[0].accountId, member.id);
	for (const assigneeIds of [[owner.id], [], [member.id]])
		refused(await child(member, pa, { assigneeIds }), "access_denied");
	refused(await child(member, p, {}), "unavailable");

	// The child assignee ticks their row; holding the parent does not let a Member tick someone else's row.
	const ticked = ok(await tick(member, p, c, true)).task;
	assert.equal(ticked.status, "complete");
	refused(await tick(member, p, inherited, true), "unavailable");
	const pm = await create(owner, { title: "Member parent", assigneeIds: [member.id] });
	const x = await subtask(owner, pm, "Someone else's row");
	await write(owner, "edit", {
		requestKey: randomUUID(),
		expectedRevision: x.revision,
		input: { taskId: x.id, patch: { assigneeIds: [admin2.id] } },
	});
	refused(await tick(member, pm, await get(owner, x.id), true), "unavailable");
	refused(await tick(member, pa, ticked, false), "unavailable");
	// The last row ticked leaves the parent open: no automatic completion.
	for (const row of [inherited, unassigned]) ok(await tick(owner, p, row, true));
	const parent = await get(owner, p.id);
	assert.deepEqual([parent.status, parent.revision, parent.checklist], ["not_started", "1", { total: 3, complete: 3 }]);
	const reopened = ok(await tick(member, p, ticked, false)).task;
	assert.equal(reopened.status, "not_started");
	const history = ok(await read(member, "statusHistory", { taskId: c.id })).items.map((h) => [h.from, h.to]);
	assert.deepEqual(history, [
		[null, "not_started"],
		["not_started", "complete"],
		["complete", "not_started"],
	]);
	const page = ok(await read(member, "listSubtasks", { parentId: p.id }));
	assert.deepEqual(
		page.items.map((k) => k.id),
		[inherited.id, c.id, unassigned.id],
	);

	// A row has no deadline, recurrence, source or relation, through the API or directly in the database.
	refused(
		await write(owner, "edit", {
			requestKey: randomUUID(),
			expectedRevision: reopened.revision,
			input: { taskId: c.id, patch: { due: { kind: "local_date", date: "2026-10-20" } } },
		}),
		"invalid_input",
	);
	await assert.rejects(
		f.admin.execute(sql`UPDATE task SET due_kind='date_only', due_date='2026-10-20' WHERE id=${c.id}`),
	);
	await assert.rejects(f.admin.execute(sql`UPDATE task SET prerequisite_ids=ARRAY[${p.id}]::uuid[] WHERE id=${c.id}`));

	// A parent holds at most the 500 rows a task reads back with; the next one refuses and the parent stays readable.
	const full = await create(owner, { title: "Full" });
	await f.admin
		.execute(sql`INSERT INTO task (id, plant_id, title, category, priority, status, created_at, due_kind, parent_id)
		SELECT gen_random_uuid(), ${plant.id}, 'Row ' || n, 'general', 'medium', 'not_started', now(), 'undated', ${full.id}
		FROM generate_series(1, 500) n`);
	refused(await child(owner, full, {}), "invalid_input");
	assert.equal((await get(owner, full.id)).checklistItems.length, 500);

	// Removal retires the row with its history; the parent stays as it was. Owner/Admin only.
	const remove = (who, row) =>
		write(who, "removeSubtask", {
			requestKey: randomUUID(),
			expectedRevision: row.revision,
			input: { parentId: p.id, taskId: row.id },
		});
	refused(await remove(member, reopened), "unavailable");
	ok(await remove(owner, reopened));
	const after = await get(owner, p.id);
	assert.deepEqual([after.revision, after.checklist], ["1", { total: 2, complete: 2 }]);
	assert.equal(ok(await read(owner, "statusHistory", { taskId: c.id })).items.length, 3);
});

test("AC:TARGET-TSK-006 prerequisites never form a cycle, even proposed at once, and settled or deleted ones stop blocking", async () => {
	const replace = (who, task, ids, requestKey = randomUUID()) =>
		write(who, "replacePrerequisites", {
			requestKey,
			expectedRevision: task.revision,
			input: { taskId: task.id, prerequisiteIds: ids },
		});
	const [a, b, c] = [
		await create(owner, { title: "A" }),
		await create(owner, { title: "B" }),
		await create(owner, { title: "C" }),
	];
	// A needs B, B needs C; C needing A would close A -> B -> C -> A.
	const key = randomUUID();
	const aNeedsB = ok(await replace(owner, a, [b.id], key));
	assert.deepEqual(ok(await replace(owner, a, [b.id], key)), aNeedsB);
	ok(await replace(owner, b, [c.id]));
	refused(await replace(owner, c, [a.id]), "dependency_cycle");
	assert.deepEqual((await get(owner, c.id)).prerequisiteIds, []);
	// Self, foreign, deleted and checklist rows are not candidates.
	const gone = await create(owner, { title: "Gone" });
	ok(
		await write(owner, "delete", {
			requestKey: randomUUID(),
			expectedRevision: gone.revision,
			input: { taskId: gone.id },
		}),
	);
	const row = await subtask(owner, c, "Row");
	const theirs = await create(foreign, { title: "Theirs" });
	const fresh = await get(owner, c.id);
	for (const id of [c.id, theirs.id, gone.id, row.id]) refused(await replace(owner, fresh, [id]), "invalid_subject");
	refused(await replace(member, fresh, [b.id]), "unavailable");
	assert.deepEqual(
		ok(await read(owner, "prerequisiteCandidates", { taskId: c.id })).items.filter((t) =>
			[a.id, b.id, c.id].includes(t.id),
		),
		[],
	);

	// Opposite edges proposed at once: one saves, the other refuses. Also for two disjoint edges that close a
	// four-task cycle, which no lock on the edge's own tasks would catch.
	const both = async (pairs) => {
		const results = await Promise.all(pairs.map(([from, to]) => replace(owner, from, [to.id])));
		return results.map((r) => (r.status === "ok" ? "ok" : r.error.code)).sort();
	};
	const [x, y] = [await create(owner, { title: "X" }), await create(owner, { title: "Y" })];
	assert.deepEqual(
		await both([
			[x, y],
			[y, x],
		]),
		["dependency_cycle", "ok"],
	);
	const [p, q, r, s] = await Promise.all(["P", "Q", "R", "S"].map((title) => create(owner, { title })));
	const pq = ok(await replace(owner, p, [q.id])).task,
		rs = ok(await replace(owner, r, [s.id])).task;
	assert.deepEqual(
		await both([
			[q, r],
			[s, p],
		]),
		["dependency_cycle", "ok"],
	);
	assert.ok(pq && rs);

	// The derived badge counts open live prerequisites, apart from the manual blocked status, and never stops completion.
	const [open, waived, deleted] = [
		await create(owner, { title: "Open" }),
		await create(owner, { title: "Waived" }),
		await create(owner, { title: "Deleted" }),
	];
	const t = ok(
		await replace(owner, await create(owner, { title: "Dependent" }), [open.id, waived.id, deleted.id]),
	).task;
	assert.deepEqual([t.openPrerequisites, t.status], [3, "not_started"]);
	ok(
		await write(owner, "waive", {
			requestKey: randomUUID(),
			expectedRevision: waived.revision,
			input: { taskId: waived.id },
		}),
	);
	ok(
		await write(owner, "delete", {
			requestKey: randomUUID(),
			expectedRevision: deleted.revision,
			input: { taskId: deleted.id },
		}),
	);
	const list = ok(await read(member, "listPrerequisites", { taskId: t.id }));
	assert.deepEqual(
		list.items.map((i) => [i.title, i.deleted, i.blocking]),
		[
			["Open", false, true],
			["Waived", false, false],
			["Deleted", true, false],
		],
	);
	assert.equal((await get(owner, t.id)).openPrerequisites, 1);
	const done = ok(
		await write(owner, "complete", { requestKey: randomUUID(), expectedRevision: t.revision, input: { taskId: t.id } }),
	);
	assert.equal(done.task.status, "complete");
	// No success credit for the waived or deleted prerequisite: neither has a completion.
	assert.deepEqual(
		await rows(
			sql`SELECT count(*)::int n FROM task WHERE id IN (${waived.id},${deleted.id}) AND completed_at IS NOT NULL`,
		),
		[{ n: 0 }],
	);
	// The edge change is in the history record with the set before and after.
	assert.deepEqual(
		await rows(
			sql`SELECT before_value, after_value FROM audit_event WHERE subject_id=${a.id} AND after_value ? 'prerequisite_ids'`,
		),
		[{ before_value: { prerequisite_ids: [] }, after_value: { prerequisite_ids: [b.id] } }],
	);
});

test("AC:TARGET-TSK-007 AC:TARGET-TSK-018 completing a recurring task creates exactly one next task with a fresh checklist", async () => {
	const complete = (who, task, requestKey = randomUUID()) =>
		write(who, "completeOccurrence", { requestKey, expectedRevision: task.revision, input: { taskId: task.id } });
	const due = (date) => ({ kind: "local_date", date });
	// January 31 monthly: the next one is due February 28. A retry returns the same answer and creates nothing.
	const t = await recurring(
		{ title: "Pay rent", assigneeIds: [member.id], due: due("2026-01-31") },
		{ frequency: "monthly", until: null },
	);
	const item = await subtask(owner, t, "Call venue");
	ok(await tick(owner, t, item, true));
	const key = randomUUID(),
		reviewed = await get(owner, t.id);
	const first = ok(await complete(member, reviewed, key));
	assert.deepEqual(ok(await complete(member, reviewed, key)), first);
	assert.deepEqual(
		[first.task.status, first.successor.due, first.successor.assignees[0].accountId],
		["complete", due("2026-02-28"), member.id],
	);
	assert.deepEqual(
		first.successor.checklistItems.map((k) => [k.title, k.status]),
		[["Call venue", "not_started"]],
	);
	// The completed occurrence keeps its own checked row; the copy has no due date or completion.
	assert.equal((await get(owner, t.id)).checklistItems[0].status, "complete");
	assert.deepEqual(
		await rows(sql`SELECT due_kind, completed_at, series_id FROM task WHERE parent_id=${first.successor.id}`),
		[{ due_kind: "undated", completed_at: null, series_id: null }],
	);
	assert.deepEqual(await rows(sql`SELECT count(*)::int n FROM task WHERE predecessor_id=${t.id}`), [{ n: 1 }]);
	const open = ok(await read(member, "findOpenOccurrence", { taskId: t.id }));
	assert.deepEqual(open.open, { taskId: first.successor.id, occurrence: 2, predecessorId: t.id, revision: "1" });
	// The older occurrence cannot reopen while the next one is open.
	refused(
		await write(owner, "reopen", {
			requestKey: randomUUID(),
			expectedRevision: first.task.revision,
			input: { taskId: t.id },
		}),
		"open_successor",
	);
	// Deleting the open occurrence keeps the series: reopen and complete the older one, and the next task returns.
	ok(
		await write(owner, "delete", {
			requestKey: randomUUID(),
			expectedRevision: first.successor.revision,
			input: { taskId: first.successor.id },
		}),
	);
	const reopened = ok(
		await write(owner, "reopen", {
			requestKey: randomUUID(),
			expectedRevision: first.task.revision,
			input: { taskId: t.id },
		}),
	).task;
	const again = ok(await complete(owner, reopened));
	assert.deepEqual([again.successor?.due, again.successor?.occurrenceId], [due("2026-02-28"), "2"]);
	assert.deepEqual(ok(await read(member, "findOpenOccurrence", { taskId: t.id })).open, {
		taskId: again.successor.id,
		occurrence: 2,
		predecessorId: t.id,
		revision: "1",
	});

	// Leap day yearly, the inclusive end date, and late completion (the next one is already overdue).
	const cases = [
		[due("2024-02-29"), { frequency: "yearly", until: null }, due("2025-02-28")],
		[due("2026-01-31"), { frequency: "monthly", until: "2026-02-28" }, due("2026-02-28")],
		[due("2026-01-28"), { frequency: "monthly", until: "2026-02-27" }, null],
		[due("2026-01-05"), { frequency: "weekly", until: null }, due("2026-01-12")],
		[due("2026-01-05"), { frequency: "biweekly", until: null }, due("2026-01-19")],
		[due("2026-01-15"), { frequency: "quarterly", until: null }, due("2026-04-15")],
		// Automatic wall time over the spring gap moves forward by the gap: 02:30 becomes 03:30 CDT.
		[
			due("2026-03-07"),
			{ frequency: "daily", until: null, localTime: "02:30" },
			{
				kind: "resolved_instant",
				local: "2026-03-08T03:30:00",
				zone: "America/Chicago",
				instant: "2026-03-08T08:30:00.000Z",
				offsetSeconds: -18000,
			},
		],
	];
	for (const [from, rule, expected] of cases) {
		const task = await recurring({ due: from }, rule);
		const result = ok(await complete(owner, task));
		assert.deepEqual(result.successor?.due ?? null, expected, JSON.stringify(rule));
		if (rule.frequency === "weekly") assert.equal(result.successor.overdue, true);
	}
	// Undated: one interval from the church-local completion date.
	const undated = ok(await complete(owner, await recurring({})));
	const today = new Intl.DateTimeFormat("en-CA", { timeZone: "America/Chicago" }).format(new Date());
	const week = new Date(Date.parse(today + "T00:00:00Z") + 7 * 86_400_000).toISOString().slice(0, 10);
	assert.deepEqual(undated.successor.due, due(week));

	// Two completions at once: one completes and creates the next task, the other refuses.
	const raced = await recurring({ due: due("2026-05-01") });
	const results = await Promise.all([complete(owner, raced), complete(owner, raced)]);
	assert.deepEqual(results.map((r) => (r.status === "ok" ? "ok" : r.error.code)).sort(), ["conflict", "ok"]);
	assert.deepEqual(await rows(sql`SELECT count(*)::int n FROM task WHERE predecessor_id=${raced.id}`), [{ n: 1 }]);

	// A failed checklist copy rolls back the completion too; the same request then completes once.
	const failing = await recurring({ due: due("2026-06-01") });
	await subtask(owner, failing, "Fail copy");
	const fault = "tasks_fail_copy";
	await f.admin.execute(
		sql.raw(`CREATE FUNCTION ${fault}() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
		IF NEW.title='Fail copy' AND NEW.parent_id IS NOT NULL AND TG_OP='INSERT' THEN RAISE EXCEPTION 'fault'; END IF; RETURN NEW; END $$`),
	);
	const retry = randomUUID();
	try {
		await f.admin.execute(
			sql.raw(`CREATE TRIGGER ${fault} BEFORE INSERT ON task FOR EACH ROW EXECUTE FUNCTION ${fault}()`),
		);
		await assert.rejects(complete(owner, failing, retry));
	} finally {
		await f.admin.execute(sql.raw(`DROP TRIGGER IF EXISTS ${fault} ON task; DROP FUNCTION IF EXISTS ${fault}()`));
	}
	assert.equal((await get(owner, failing.id)).status, "not_started");
	const recovered = ok(await complete(owner, failing, retry));
	assert.deepEqual(
		recovered.successor.checklistItems.map((k) => k.title),
		["Fail copy"],
	);

	// Stopping keeps the series and its history; the next completion creates nothing.
	const stopped = await recurring({ due: due("2026-07-01") });
	const halted = ok(
		await write(owner, "configureRecurrence", {
			requestKey: randomUUID(),
			expectedRevision: stopped.revision,
			input: { taskId: stopped.id, rule: null },
		}),
	).task;
	assert.equal(halted.recurrence.stopped, true);
	assert.equal(ok(await complete(owner, halted)).successor, null);
	// No occurrence count: the strict rule refuses it.
	refused(
		await write(owner, "configureRecurrence", {
			requestKey: randomUUID(),
			expectedRevision: halted.revision,
			input: { taskId: stopped.id, rule: { frequency: "weekly", until: null, count: 3 } },
		}),
		"invalid_input",
	);
});

test("AC:TARGET-TSK-008 bulk changes report each task, commit all valid tasks or none, and never repeat on retry", async () => {
	const bulk = (who, op, tasks, extra = {}, requestKey = randomUUID()) =>
		write(who, op, {
			requestKey,
			items: tasks.map((t) => ({ taskId: t.id, expectedRevision: t.revision })),
			...extra,
		});
	const mine = await create(owner, { title: "Mine", assigneeIds: [member.id] });
	const others = await create(owner, { title: "Others" });
	const series = await recurring({
		title: "Weekly",
		assigneeIds: [member.id],
		due: { kind: "local_date", date: "2026-10-01" },
	});
	const waived = await create(owner, { title: "Waived", assigneeIds: [member.id] });
	const w = ok(
		await write(owner, "waive", {
			requestKey: randomUUID(),
			expectedRevision: waived.revision,
			input: { taskId: waived.id },
		}),
	).task;
	const changed = await create(owner, { title: "Changed", assigneeIds: [member.id] });
	const stale = { ...changed };
	await write(owner, "edit", {
		requestKey: randomUUID(),
		expectedRevision: changed.revision,
		input: { taskId: changed.id, patch: { title: "Changed again" } },
	});
	const theirs = await create(foreign, { title: "Theirs" });
	const missing = { id: randomUUID(), revision: "1" };
	const boom = await create(owner, { title: "Boom", assigneeIds: [member.id] });
	const selection = [mine, others, series, series, w, stale, theirs, missing, boom];

	// A fault before commit leaves every task as it was.
	const fault = "tasks_fail_bulk";
	await f.admin.execute(
		sql.raw(`CREATE FUNCTION ${fault}() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
		IF NEW.title='Boom' AND NEW.status='complete' THEN RAISE EXCEPTION 'fault'; END IF; RETURN NEW; END $$`),
	);
	const key = randomUUID();
	try {
		await f.admin.execute(
			sql.raw(`CREATE TRIGGER ${fault} BEFORE UPDATE ON task FOR EACH ROW EXECUTE FUNCTION ${fault}()`),
		);
		await assert.rejects(bulk(member, "bulkComplete", selection, {}, key));
	} finally {
		await f.admin.execute(sql.raw(`DROP TRIGGER IF EXISTS ${fault} ON task; DROP FUNCTION IF EXISTS ${fault}()`));
	}
	assert.deepEqual(
		await rows(
			sql`SELECT count(*)::int n FROM task WHERE id IN (${mine.id},${series.id},${boom.id}) AND status='complete'`,
		),
		[{ n: 0 }],
	);
	// The same request then completes each valid task once; a retry returns the stored answer.
	const result = ok(await bulk(member, "bulkComplete", selection, {}, key));
	assert.deepEqual(ok(await bulk(member, "bulkComplete", selection, {}, key)), result);
	assert.deepEqual(
		result.items.map((i) => [i.taskId, i.outcome]),
		[
			[mine.id, "changed"],
			[others.id, "unauthorized"],
			[series.id, "changed"],
			[w.id, "closed"],
			[changed.id, "stale"],
			[theirs.id, "not_found"],
			[missing.id, "not_found"],
			[boom.id, "changed"],
		],
	);
	assert.deepEqual([result.changed, result.remaining], [3, [others.id, changed.id]]);
	assert.deepEqual(await rows(sql`SELECT count(*)::int n FROM task WHERE predecessor_id=${series.id}`), [{ n: 1 }]);
	assert.equal((await get(foreign, theirs.id)).status, "not_started");

	// A request where nothing changes still answers each task and replays from its stored receipt.
	const quiet = [missing, w, stale, await get(owner, mine.id)];
	const quietKey = randomUUID();
	const nothing = ok(await bulk(owner, "bulkComplete", quiet, {}, quietKey));
	assert.deepEqual(
		[nothing.changed, nothing.items.map((i) => i.outcome)],
		[0, ["not_found", "closed", "stale", "noop"]],
	);
	assert.deepEqual(ok(await bulk(owner, "bulkComplete", quiet, {}, quietKey)), nothing);

	// Reschedule: Owner/Admin, open top-level tasks only, and an invalid date writes nothing.
	const later = await create(owner, { title: "Later" });
	const row = await subtask(owner, later, "Row");
	const done = await get(owner, mine.id);
	refused(
		await bulk(member, "bulkReschedule", [later], { due: { kind: "local_date", date: "2026-11-01" } }),
		"unavailable",
	);
	refused(
		await bulk(owner, "bulkReschedule", [later], { due: { kind: "local_date", date: "2026-02-30" } }),
		"invalid_input",
	);
	refused(await bulk(owner, "bulkReschedule", Array(101).fill(later), { due: { kind: "undated" } }), "invalid_input");
	const moved = ok(
		await bulk(owner, "bulkReschedule", [later, row, done], { due: { kind: "local_date", date: "2026-11-01" } }),
	);
	assert.deepEqual(
		moved.items.map((i) => i.outcome),
		["changed", "ineligible", "closed"],
	);
	assert.deepEqual((await get(owner, later.id)).due, { kind: "local_date", date: "2026-11-01" });
	assert.deepEqual((await get(owner, others.id)).due, { kind: "undated" });
});

// ---------------------------------------------------------------------------------------------------------------
// WP-023 F07b: a task has one or more assignees.

test("AC:TARGET-TSK-002 F07b criteria 2 to 4: a list of assignees is checked as a whole, kept as a set and audited", async () => {
	const assigneeIds = async (id) =>
		(await rows(sql`SELECT account_id FROM task_assignee WHERE task_id=${id} ORDER BY account_id`)).map(
			(r) => r.account_id,
		);
	// One account that cannot hold the task refuses the whole write, names it and creates nothing.
	const before = (await rows(sql`SELECT count(*)::int n FROM task`))[0].n;
	const bad = refused(
		await write(owner, "create", {
			requestKey: randomUUID(),
			input: { title: "Mixed", assigneeIds: [member.id, foreign.id] },
		}),
		"invalid_subject",
	);
	assert.equal(bad.details.accountId, foreign.id);
	assert.equal((await rows(sql`SELECT count(*)::int n FROM task`))[0].n, before);
	// A repeated ID collapses to one; more than ten distinct accounts are refused.
	const t = await create(owner, { title: "Pair", assigneeIds: [member.id, admin2.id, member.id] });
	assert.deepEqual(
		t.assignees.map((a) => a.accountId).sort(),
		[member.id, admin2.id].sort(),
	);
	assert.deepEqual(await assigneeIds(t.id), [member.id, admin2.id].sort());
	refused(
		await write(owner, "create", {
			requestKey: randomUUID(),
			input: { title: "Crowd", assigneeIds: Array.from({ length: 11 }, () => randomUUID()) },
		}),
		"invalid_input",
	);
	// The list reads by display name, then account ID.
	const names = t.assignees.map((a) => a.displayName.toLowerCase());
	assert.deepEqual(names, [...names].sort());
	// An edit with the list omitted leaves the set; one bad account in a list changes nothing.
	const same = ok(
		await write(owner, "edit", {
			requestKey: randomUUID(),
			expectedRevision: t.revision,
			input: { taskId: t.id, patch: { title: "Pair, renamed" } },
		}),
	).task;
	assert.equal(same.assignees.length, 2);
	refused(
		await write(owner, "edit", {
			requestKey: randomUUID(),
			expectedRevision: same.revision,
			input: { taskId: t.id, patch: { assigneeIds: [admin2.id, foreign.id] } },
		}),
		"invalid_subject",
	);
	assert.deepEqual(await assigneeIds(t.id), [member.id, admin2.id].sort());
	// A change to the set bumps the revision once and writes one audit row with the set before and after.
	const trimmed = ok(
		await write(owner, "edit", {
			requestKey: randomUUID(),
			expectedRevision: same.revision,
			input: { taskId: t.id, patch: { assigneeIds: [admin2.id] } },
		}),
	).task;
	assert.equal(BigInt(trimmed.revision) - BigInt(same.revision), 1n);
	const audit = await rows(
		sql`SELECT before_value, after_value FROM audit_event WHERE subject_id=${t.id} AND after_revision=${trimmed.revision}::bigint`,
	);
	assert.equal(audit.length, 1);
	assert.deepEqual(audit[0].before_value.assigneeIds, [member.id, admin2.id].sort());
	assert.deepEqual(audit[0].after_value.assigneeIds, [admin2.id]);
	// An empty list clears the set: Needs owner.
	const cleared = ok(
		await write(owner, "edit", {
			requestKey: randomUUID(),
			expectedRevision: trimmed.revision,
			input: { taskId: t.id, patch: { assigneeIds: [] } },
		}),
	).task;
	assert.deepEqual([cleared.assignees, await assigneeIds(t.id)], [[], []]);
});

test("AC:TARGET-TSK-003 AC:TARGET-TSK-005 F07b criteria 5 and 6: any assignee acts, a Member adds nobody, children and successors keep the set", async () => {
	const shared = await create(owner, { title: "Shared duty", assigneeIds: [member.id, admin2.id] });
	// Another Member is not an assignee and cannot complete it; one of the assignees can.
	const stranger = await (async () => {
		const a = await f.account();
		await f.seat(a, plant, "member");
		return { ...a, actor: await f.actor(a.session) };
	})();
	refused(
		await write(stranger, "complete", {
			requestKey: randomUUID(),
			expectedRevision: shared.revision,
			input: { taskId: shared.id },
		}),
		"unavailable",
	);
	// A Member cannot name other accounts on a step; the step inherits the parent's whole set.
	refused(
		await write(member, "createSubtask", {
			requestKey: randomUUID(),
			expectedRevision: shared.revision,
			input: { parentId: shared.id, title: "Mine", assigneeIds: [owner.id] },
		}),
		"access_denied",
	);
	const step = await subtask(member, shared, "Check the list");
	assert.deepEqual(
		step.assignees.map((a) => a.accountId).sort(),
		[member.id, admin2.id].sort(),
	);
	// The next occurrence of a recurring task copies the set.
	const weekly = await recurring({
		title: "Weekly set-up",
		assigneeIds: [member.id, admin2.id],
		due: { kind: "local_date", date: "2099-03-01" },
	});
	const next = ok(
		await write(member, "completeOccurrence", {
			requestKey: randomUUID(),
			expectedRevision: weekly.revision,
			input: { taskId: weekly.id },
		}),
	).successor;
	assert.deepEqual(
		next.assignees.map((a) => a.accountId).sort(),
		[member.id, admin2.id].sort(),
	);
	// One of the assignees completes the shared task, once, and "My tasks" lists it for each of them.
	const mine = async (who) =>
		ok(await read(who, "list", { view: "my", search: "Shared duty", statuses: ["not_started", "in_progress", "blocked"] })).items.map(
			(t) => t.id,
		);
	assert.ok((await mine(member)).includes(shared.id));
	assert.ok((await mine(admin2)).includes(shared.id));
	assert.equal((await mine(stranger)).includes(shared.id), false);
	assert.equal(
		ok(
			await write(member, "complete", {
				requestKey: randomUUID(),
				expectedRevision: shared.revision,
				input: { taskId: shared.id },
			}),
		).task.status,
		"complete",
	);
});

test("INV-statements F07b criterion 10: a page read sends the same statements for one assignee or three", async () => {
	const third = await (async () => {
		const a = await f.account();
		await f.seat(a, plant, "member");
		return a;
	})();
	const one = await create(owner, { title: "Solo", assigneeIds: [member.id] });
	const three = await create(owner, { title: "Trio", assigneeIds: [member.id, admin2.id, third.id] });
	assert.equal(three.assignees.length, 3);
	const each = async (id) => [
		await counted(() => read(owner, "list", { search: id === one.id ? "Solo" : "Trio" })),
		await counted(() => read(owner, "get", { taskId: id })),
		await counted(() => read(owner, "listSubtasks", { parentId: id })),
	];
	assert.deepEqual(await each(three.id), await each(one.id));
});

test("AC:TARGET-TSK-014 F07b criterion 11: each assignee gets their own reminders, and removing one withdraws only theirs", async () => {
	const notices = (task) =>
		rows(sql`SELECT n.recipient_id, n.purpose, n.cancelled_at IS NOT NULL cancelled FROM notice n
			WHERE n.source_record_id=${task} ORDER BY n.recipient_id, n.eligible_at`);
	const live = async (task) => (await notices(task)).filter((n) => !n.cancelled).map((n) => n.recipient_id);
	const t = await create(owner, {
		title: "Set up the room",
		assigneeIds: [member.id, admin2.id],
		due: { kind: "local_date", date: "2099-01-15" },
	});
	// A due and an overdue reminder each.
	const both = [member.id, admin2.id].sort().flatMap((id) => [id, id]);
	assert.deepEqual(await live(t.id), both);
	const trimmed = ok(
		await write(owner, "edit", {
			requestKey: randomUUID(),
			expectedRevision: t.revision,
			input: { taskId: t.id, patch: { assigneeIds: [admin2.id] } },
		}),
	).task;
	assert.deepEqual(await live(t.id), [admin2.id, admin2.id]);
	// A stale reminder never reaches the removed assignee.
	const stale = await rows(
		sql`SELECT m.id, m.recipient_account_id recipient, m.notice_id notice FROM mail m JOIN notice n ON n.id=m.notice_id
			WHERE n.source_record_id=${t.id}`,
	);
	const allowed = await f.db.transaction((tx) => authorizeTaskReminders(tx, stale));
	assert.deepEqual(
		[...new Set(stale.filter((m) => allowed.has(m.id)).map((m) => m.recipient))],
		[admin2.id],
	);
	// Adding one plans theirs.
	ok(
		await write(owner, "edit", {
			requestKey: randomUUID(),
			expectedRevision: trimmed.revision,
			input: { taskId: t.id, patch: { assigneeIds: [admin2.id, member.id] } },
		}),
	);
	assert.deepEqual(await live(t.id), both);
});
