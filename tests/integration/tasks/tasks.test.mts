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
import { peopleReader, peopleWriter } from "../../../packages/domain/src/people/index.ts";
import { createMailService } from "../../../apps/web/src/server/jobs/mail.ts";
import { createNotificationService } from "../../../apps/web/src/server/jobs/notifications.ts";
import { taskReminders } from "../../../apps/web/src/server/tasks/reminders.ts";

let f, writer, reminders, plant, other, owner, member, admin2, foreign;
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

before(async () => {
	f = await fixture();
	const sent = [];
	const mail = createMailService({
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
	refused(await attempt({ assigneeId: foreign.id }), "invalid_subject");
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
	refused(await attempt({ parentId: randomUUID() }), "invalid_subject");
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
	assert.deepEqual([first.task.due, first.task.overdue, first.task.assignee], [{ kind: "undated" }, null, null]);
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
					assigneeId: member.id,
					relation: { kind: "person", id: p },
					due: { kind: "local_date", date: "2026-10-20" },
				},
			},
		}),
	).task;
	assert.deepEqual(
		[edited.revision, edited.priority, edited.assignee.accountId, edited.relation, edited.due],
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
	const child = await create(owner, { title: "Bring chairs", parentId: first.task.id });
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
					assigneeId: n < 3 ? b.id : null,
					relation: n < 2 ? { kind: "team", id: hospitality } : null,
				})
			).id,
		);
	const dated = await create(me, { title: "Dated", due: { kind: "local_date", date: "2026-10-13" } });
	for (const title of ["One", "Two"]) await create(me, { title, parentId: dated.id });

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
		assigneeId: admin2.id,
		relation: { kind: "person", id: await person("Jamie") },
	});
	const moved = ok(
		await write(admin2, "edit", {
			requestKey: randomUUID(),
			expectedRevision: t.revision,
			input: { taskId: t.id, patch: { assigneeId: member.id } },
		}),
	).task;
	refused(await command(owner, "complete", t), "conflict");
	// A Member acts only on a task they hold.
	const others = await create(owner, { title: "Not yours", assigneeId: admin2.id });
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
	const again = ok(await command(member, "reopen", reopened));
	assert.equal(again.outcome, "noop");

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
	const origin = { at: "2026-10-13T23:00:00Z", date: "2026-10-13", zone: "America/Chicago" };
	// The meeting domain's reviewed command: its own audit row, the generated work, one write statement.
	const finalize = (meetingId, input, fault = false) =>
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
			const r = await ensureMeetingObligations(tx, cmd, reminders, { meetingId, origin, ...input });
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
	const counts = () =>
		rows(
			sql`SELECT (SELECT count(*)::int FROM task WHERE obligation_id IS NOT NULL) t,(SELECT count(*)::int FROM obligation) o`,
		);
	const input = {
		followUps: [
			{ personId: p1, assigneeId: member.id },
			{ personId: p2, assigneeId: null },
		],
		evaluation: { assigneeId: owner.id },
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
		[f1.title, f1.due, f1.assignee.accountId, f1.managed.kind, f2.assignee],
		[
			"Follow up with Alex Rivera",
			{ kind: "local_date", date: "2026-10-15" },
			member.id,
			"first_vision_follow_up",
			null,
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
	const second = await finalize(m2, { followUps: [{ personId: p1, assigneeId: null }], evaluation: null });
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
				obligationId: first[2].obligationId,
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
			peopleWriter.retirePerson(tx, ctx, {
				requestKey: randomUUID(),
				expectedRevision: review.revision,
				input: {
					personId: p1,
					reason: "Duplicate record",
					reviewRevision: review.reviewRevision,
					handoffs: review.openDuties.map((d) => ({ kind: "needs_owner", dutyId: d.id, expectedRevision: d.revision })),
				},
			}),
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
		finalize(await meeting("Third"), { followUps: [{ personId: p1, assigneeId: null }], evaluation: null }),
	);
});

test("AC:TARGET-TSK-014 due and overdue reminders follow the current assignee and stop when settled", async () => {
	const notices = (task) =>
		rows(sql`SELECT n.recipient_id, n.purpose, n.cancelled_at IS NOT NULL cancelled, m.state, m.id mail FROM notice n
			LEFT JOIN mail m ON m.notice_id=n.id WHERE n.source_record_id=${task} ORDER BY n.recipient_id, n.eligible_at`);
	const live = async (task) => (await notices(task)).filter((n) => !n.cancelled);
	const t = await create(owner, {
		title: "Book the venue",
		assigneeId: member.id,
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
			input: { taskId: t.id, patch: { assigneeId: admin2.id } },
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
	ok(
		await write(admin2, "complete", {
			requestKey: randomUUID(),
			expectedRevision: moved.revision,
			input: { taskId: t.id },
		}),
	);
	assert.deepEqual(await live(t.id), []);
	// Undated or unassigned tasks have no reminders.
	const undated = await create(owner, { assigneeId: member.id });
	const unassigned = await create(owner, { due: { kind: "local_date", date: "2099-01-15" } });
	assert.deepEqual([await notices(undated.id), await notices(unassigned.id)], [[], []]);
});
