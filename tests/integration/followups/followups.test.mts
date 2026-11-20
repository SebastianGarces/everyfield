import test, { after, before } from "node:test";
import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { sql } from "../../../packages/db/src/query.ts";
import { fixture } from "../identity/invitations-support.mts";
import { requestIdentity } from "../../../packages/contracts/src/common/index.ts";
import { followUpDueDate } from "../../../packages/contracts/src/tasks/index.ts";
import { within48Hours } from "../../../packages/contracts/src/followups/index.ts";
import {
	auditTransaction,
	finishAudit,
	prepareWrite,
	gatedTransaction,
} from "../../../packages/domain/src/operations/writes.ts";
import {
	authorizeTaskReminders,
	createTaskWriter,
	ensureMeetingObligations,
	taskReader,
	reminderRecipients,
	withTaskWrite,
} from "../../../packages/domain/src/tasks/index.ts";
import {
	createFollowUpWriter,
	followUpReader,
	withFollowUpWrite,
} from "../../../packages/domain/src/followups/index.ts";
import { peopleReader, peopleWriter } from "../../../packages/domain/src/people/index.ts";
import { PeopleReadContext } from "../../../packages/domain/src/people/core.ts";
import { createMailService } from "../../../packages/domain/src/jobs/mail.ts";
import { createNotificationService } from "../../../packages/domain/src/jobs/notifications.ts";
import { taskReminders } from "../../../apps/web/src/features/tasks/reminders.ts";
import { ok, refused } from "../../support/fixture.mts";

let f, followups, tasks, reminders;
const write = (who, op, input) => withFollowUpWrite(f.db, who.actor, (tx, ctx) => followups[op](tx, ctx, input));
const taskWrite = (who, op, input) => withTaskWrite(f.db, who.actor, (tx, ctx) => tasks[op](tx, ctx, input));
const read = (who, op, input) => gatedTransaction(f.db, (tx) => followUpReader[op](tx, who.actor, input));
const rows = async (q) => (await f.admin.execute(q)).rows;
const key = () => randomUUID();
const hours = (iso, h) => new Date(Date.parse(iso) + h * 3_600_000).toISOString();

async function church() {
	const w = await f.workspace();
	await f.admin.execute(sql`UPDATE plant SET timezone='America/Chicago' WHERE id=${w.id}`);
	const seated = async (role) => {
		const a = await f.account();
		await f.seat(a, w, role);
		return { ...a, actor: await f.actor(a.session) };
	};
	return { w, owner: await seated("owner"), admin: await seated("admin"), member: await seated("member"), seated };
}
async function person(c, name, fields = {}) {
	const ctx = { session: c.owner.actor.session, selected: c.w };
	const r = await gatedTransaction(f.db, (tx) =>
		peopleWriter.createPerson(tx, ctx, { requestKey: key(), input: { displayName: name } }),
	);
	const id = ok(r).person.id;
	if (fields.stage) await f.admin.execute(sql`UPDATE person SET stage=${fields.stage} WHERE id=${id}`);
	if (fields.linked) await f.admin.execute(sql`UPDATE person SET linked_account_id=${fields.linked} WHERE id=${id}`);
	return id;
}
const committed = (c, who, stage = "core_group") => person(c, "Owner " + who.id.slice(0, 4), { stage, linked: who.id });
async function meeting(c, title, origin) {
	const id = randomUUID();
	await f.admin.execute(
		sql`INSERT INTO meeting(id,plant_id,type,title,local_date,local_time,timezone,starts_at,resolver_version,status,attendance_revision) VALUES(${id},${c.w.id},'vision_meeting',${title},${origin.date},'18:00','America/Chicago',${origin.at},'1','completed',1)`,
	);
	return id;
}
const finalize = (c, meetingId, origin, input) =>
	auditTransaction(f.db, async (tx) => {
		if (!(await c.owner.actor.bind(tx, c.w))) throw Error("unbound");
		const identity = requestIdentity.parse({
			owner: c.w,
			actorId: c.owner.id,
			operation: "meetings.finalizeAttendance",
			requestKey: key(),
			digest: "0".repeat(64),
		});
		const claim = await prepareWrite(tx, identity);
		const cmd = { ...claim, actor: { accountId: c.owner.id, plantId: c.w.id } };
		const r = await ensureMeetingObligations(tx, cmd, reminders, { meetings: [{ meetingId, origin, ...input }] });
		cmd.events.unshift({
			id: cmd.id,
			tenant_id: c.w.id,
			actor_id: c.owner.id,
			action: "meetings.finalized",
			kind: "finalize",
			subject_type: "meeting",
			subject_id: meetingId,
		});
		await finishAudit(tx, cmd, identity, r.value);
		await r.after();
		return r.value;
	});
async function generated(c, personId, title, origin) {
	const m = await meeting(c, title, origin);
	await finalize(c, m, origin, { followUps: [{ personId, assigneeIds: [] }], evaluation: null });
	const [o] = ok(await read(c.owner, "readObligations", { meetingId: m })).items;
	return { meetingId: m, obligation: o };
}
const record = (who, target, outcome, extra = {}) =>
	write(who, "recordOutcome", {
		requestKey: key(),
		input: { target, outcome, completeTask: false, ...extra },
	});
const onTask = (task) => ({ kind: "task", taskId: task.id, expectedRevision: task.revision });

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
	const mail = createMailService({
		db: f.db,
		encryptionKey: randomBytes(32),
		addressKey: randomBytes(32),
		from: "tasks@example.test",
		authorize: authorizeTaskReminders,
		transport: {
			async send() {
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
	followups = createFollowUpWriter({ reminders });
	tasks = createTaskWriter({ reminders });
});
after(() => f?.close());

test("AC:B03-004 AC:B03-005 INV-dates: due day is meeting day plus two; the 48-hour window is exact elapsed time", async () => {
	assert.deepEqual(
		["2026-03-07", "2026-10-31", "2026-12-31"].map((d) => followUpDueDate(d)),
		["2026-03-09", "2026-11-02", "2027-01-02"],
	);
	const c = await church();
	const origin = { at: "2026-03-07T15:00:00Z", date: "2026-03-07", zone: "America/Chicago" };
	const exact = await generated(c, await person(c, "Exact"), "Exact", origin);
	const late = await generated(c, await person(c, "Late"), "Late", origin);
	const completions = ["2026-03-09T15:00:00Z", "2026-03-09T15:00:00.001Z"];
	assert.deepEqual(
		completions.map((at) => within48Hours(origin.at, at)),
		[true, false],
	);
	for (const [{ obligation }, at] of [
		[exact, completions[0]],
		[late, completions[1]],
	])
		ok(await record(c.owner, onTask(obligation.task), "contacted", { occurredAt: at, completeTask: true }));
	const read48 = async (m) =>
		ok(await read(c.owner, "readObligations", { meetingId: m, asOf: "2026-03-20T00:00:00Z" })).items[0];
	const [a, b] = [await read48(exact.meetingId), await read48(late.meetingId)];
	assert.deepEqual(
		[a, b].map((o) => [o.dueDate, o.measurement.success, o.completion.occurredAt]),
		[
			["2026-03-09", true, "2026-03-09T15:00:00.000Z"],
			["2026-03-09", false, "2026-03-09T15:00:00.001Z"],
		],
	);
});

test("AC:TARGET-MTG-021 AC:TARGET-TSK-011 AC:TARGET-TSK-017 AC:TARGET-MTG-020 AC:ROLE43-015 AC:TARGET-TSK-004 obligations measure 48 hours at a frozen asOf, separate from contact and waiver", async () => {
	const c = await church();
	const alex = await person(c, "Alex Rivera");
	const asOf = "2026-09-20T12:00:00Z";
	const at = (h) => ({ at: hours(asOf, h), date: hours(asOf, h).slice(0, 10), zone: "America/Chicago" });
	const same = at(-72);
	const [bea, cy, dee] = [await person(c, "Bea Lopez"), await person(c, "Cy Nakamura"), await person(c, "Dee Foster")];
	const m = {
		pending23: await generated(c, alex, "M1", at(-23)),
		pending48: await generated(c, alex, "M2", at(-48)),
		admin2h: await generated(c, alex, "M3", same),
		contact48: await generated(c, bea, "M4", same),
		contactLate: await generated(c, cy, "M5", same),
		waived: await generated(c, alex, "M6", same),
		future: await generated(c, alex, "M7", at(1)),
		preOrigin: await generated(c, alex, "M8", same),
		afterAsOf: await generated(c, dee, "M9", same),
		checkbox: await generated(c, alex, "M10", same),
	};
	assert.equal(new Set(Object.values(m).map((x) => x.obligation.id)).size, 10);
	const complete = (x, outcome, occurredAt) =>
		record(c.owner, onTask(x.obligation.task), outcome, { occurredAt, completeTask: true });
	ok(await complete(m.admin2h, "administrative_completion", hours(same.at, 2)));
	ok(await complete(m.contact48, "contacted", hours(same.at, 48)));
	ok(await complete(m.contactLate, "contacted", new Date(Date.parse(hours(same.at, 48)) + 1).toISOString()));
	ok(await complete(m.preOrigin, "administrative_completion", hours(same.at, -1)));
	ok(await complete(m.afterAsOf, "contacted", hours(asOf, 1)));
	ok(await record(c.owner, onTask(m.waived.obligation.task), "no_longer_needed"));
	ok(
		await taskWrite(c.owner, "complete", {
			requestKey: key(),
			expectedRevision: m.checkbox.obligation.task.revision,
			input: { taskId: m.checkbox.obligation.task.id },
		}),
	);
	const page = ok(await read(c.member, "readObligations", { asOf, limit: 100 }));
	const byMeeting = new Map(page.items.map((o) => [o.meeting.id, o]));
	const result = Object.fromEntries(
		Object.entries(m).map(([name, x]) => {
			const o = byMeeting.get(x.meetingId);
			return [name, [o.state, o.measurement.eligible, o.measurement.success, o.measurement.reason, o.contacted]];
		}),
	);
	assert.deepEqual(result, {
		pending23: ["open", false, null, "immature", false],
		pending48: ["open", true, false, "measured", false],
		admin2h: ["complete", true, true, "measured", false],
		contact48: ["complete", true, true, "measured", true],
		contactLate: ["complete", true, false, "measured", true],
		waived: ["no_longer_needed", false, null, "waived", false],
		future: ["open", false, null, "future_origin", false],
		preOrigin: ["complete", false, null, "invalid_completion", false],
		afterAsOf: ["complete", false, null, "invalid_completion", true],
		checkbox: ["complete", true, false, "measured", false],
	});
	assert.deepEqual(byMeeting.get(m.admin2h.meetingId).dueDate, followUpDueDate(same.date));

	const w = byMeeting.get(m.waived.meetingId);
	const edited = ok(
		await taskWrite(c.owner, "edit", {
			requestKey: key(),
			expectedRevision: w.task.revision,
			input: { taskId: w.task.id, patch: { title: "Renamed" } },
		}),
	).task;
	ok(
		await taskWrite(c.owner, "delete", {
			requestKey: key(),
			expectedRevision: edited.revision,
			input: { taskId: w.task.id },
		}),
	);
	await finalize(c, m.waived.meetingId, same, { followUps: [{ personId: alex, assigneeIds: [] }], evaluation: null });
	const [after] = ok(await read(c.owner, "readObligations", { meetingId: m.waived.meetingId, asOf })).items;
	assert.deepEqual(
		[after.id, after.state, after.task.deleted, after.waiver !== null, after.measurement.reason],
		[w.id, "no_longer_needed", true, true, "waived"],
	);
	assert.deepEqual(await rows(sql`SELECT count(*)::int n FROM task WHERE obligation_id=${w.id}`), [{ n: 1 }]);
	const other = byMeeting.get(m.pending48.meetingId);
	const waived = ok(
		await taskWrite(c.owner, "waive", {
			requestKey: key(),
			expectedRevision: other.task.revision,
			input: { taskId: other.task.id },
		}),
	).task;
	ok(
		await taskWrite(c.owner, "reopen", {
			requestKey: key(),
			expectedRevision: waived.revision,
			input: { taskId: other.task.id },
		}),
	);
	const [reopened] = ok(await read(c.owner, "readObligations", { meetingId: m.pending48.meetingId, asOf })).items;
	assert.deepEqual([reopened.state, reopened.waiver, reopened.measurement.reason], ["open", null, "measured"]);
	assert.deepEqual(
		await rows(
			sql`SELECT kind FROM audit_event WHERE subject_id=${other.task.id} AND after_value ? 'status' ORDER BY occurred_at,id`,
		),
		[{ kind: "create" }, { kind: "waive" }, { kind: "reopen" }],
	);

	const empty = await meeting(c, "Empty Vision", at(-30));
	for (let n = 0; n < 2; n++) await finalize(c, empty, at(-30), { followUps: [], evaluation: { assigneeIds: [] } });
	const evaluation = ok(await read(c.owner, "readObligations", { meetingId: empty, asOf })).items;
	assert.deepEqual(
		evaluation.map((o) => [o.kind, o.person, o.owners, o.state, o.measurement]),
		[["meeting_evaluation", null, [], "open", null]],
	);
});

test("AC:TARGET-COM-011 AC:TARGET-MTG-022 AC:ROLE43-008 contact log: only an effective contacted outcome is contact; corrections keep history", async () => {
	const c = await church();
	const alex = await person(c, "Alex Rivera");
	const standalone = { kind: "person", personId: alex };
	const contactAt = async () =>
		ok(await read(c.member, "listContactHistory", { personId: alex })).lastConfirmedContactAt;
	const material = async () => (await rows(sql`SELECT material_revision::int n FROM plant WHERE id=${c.w.id}`))[0].n;

	const first = ok(await record(c.owner, standalone, "contacted", { occurredAt: "2026-09-01T15:00:00Z" }));
	assert.equal(first.lastConfirmedContactAt, "2026-09-01T15:00:00.000Z");
	const attempt = ok(await record(c.owner, standalone, "attempted_no_contact", { occurredAt: "2026-10-10T15:00:00Z" }));
	const admin = ok(
		await write(c.owner, "createFollowUp", { requestKey: key(), input: { personId: alex, title: "Mail packet" } }),
	).task;
	const done = ok(
		await record(c.owner, onTask(admin), "administrative_completion", {
			occurredAt: "2026-10-11T15:00:00Z",
			completeTask: true,
		}),
	);
	assert.deepEqual([done.task.status, done.record.contact, done.record.completedTask], ["complete", false, true]);
	const activity = ok(
		await gatedTransaction(f.db, (tx) =>
			peopleReader.getActivities(tx, new PeopleReadContext(c.owner.actor), { personId: alex, kinds: ["follow_up"] }),
		),
	);
	assert.deepEqual(
		activity.items.map((i) => [i.outcome, i.obligationId]),
		[
			["administrative_completion", null],
			["attempted_no_contact", null],
			["contacted", null],
		],
	);
	const before = await material();
	const wrong = ok(await record(c.owner, standalone, "contacted", { occurredAt: "2026-10-12T15:00:00Z" }));
	assert.equal(await contactAt(), "2026-10-12T15:00:00.000Z");
	assert.equal(await material(), before + 1);
	const voided = ok(
		await write(c.owner, "correctOutcome", {
			requestKey: key(),
			expectedRevision: wrong.record.revision,
			input: { outcomeId: wrong.record.id, correction: { kind: "void" }, reason: "Entered on the wrong person" },
		}),
	);
	assert.deepEqual(
		[voided.record.state, voided.record.voided.reason, voided.lastConfirmedContactAt],
		["voided", "Entered on the wrong person", "2026-09-01T15:00:00.000Z"],
	);
	assert.equal(await material(), before + 2);
	const log = ok(await read(c.member, "listContactHistory", { personId: alex }));
	assert.deepEqual(
		log.items.map((i) => [i.outcome, i.occurredAt, i.state, i.contact]),
		[
			["contacted", "2026-10-12T15:00:00.000Z", "voided", false],
			["administrative_completion", "2026-10-11T15:00:00.000Z", "effective", false],
			["attempted_no_contact", "2026-10-10T15:00:00.000Z", "effective", false],
			["contacted", "2026-09-01T15:00:00.000Z", "effective", true],
		],
	);
	assert.deepEqual([log.total, log.lastConfirmedContactAt], [4, "2026-09-01T15:00:00.000Z"]);
	assert.equal(log.items[0].actor.accountId, c.owner.id);

	const corrected = ok(
		await write(c.admin, "correctOutcome", {
			requestKey: key(),
			expectedRevision: attempt.record.revision,
			input: {
				outcomeId: attempt.record.id,
				correction: { kind: "replace", outcome: "contacted", occurredAt: "2026-10-10T18:00:00Z" },
				reason: "Reached on the second call",
			},
		}),
	);
	assert.deepEqual(
		[
			corrected.record.corrects,
			corrected.previous.state,
			corrected.previous.voided.actor.accountId,
			corrected.lastConfirmedContactAt,
		],
		[
			{ id: attempt.record.id, reason: "Reached on the second call" },
			"corrected",
			c.admin.id,
			"2026-10-10T18:00:00.000Z",
		],
	);
	assert.deepEqual(
		await rows(
			sql`SELECT before_value->>'outcome' AS old, after_value->>'outcome' AS new, reason, actor_id FROM audit_event WHERE subject_id=${corrected.record.id}`,
		),
		[{ old: "attempted_no_contact", new: "contacted", reason: "Reached on the second call", actor_id: c.admin.id }],
	);
	refused(
		await write(c.owner, "correctOutcome", {
			requestKey: key(),
			expectedRevision: attempt.record.revision,
			input: { outcomeId: attempt.record.id, correction: { kind: "void" }, reason: "Again" },
		}),
		"conflict",
	);
	refused(await record(c.owner, standalone, "contacted"), "invalid_input");
	refused(
		await record(c.owner, standalone, "contacted", { occurredAt: hours(new Date().toISOString(), 1) }),
		"future_occurrence",
	);
	const request = {
		requestKey: key(),
		input: { target: standalone, outcome: "attempted_no_contact", completeTask: false },
	};
	const once = ok(await write(c.owner, "recordOutcome", request));
	assert.deepEqual(ok(await write(c.owner, "recordOutcome", request)), once);
	assert.deepEqual(await rows(sql`SELECT count(*)::int n FROM contact_outcome WHERE person_id=${alex}`), [{ n: 6 }]);

	await committed(c, c.member);
	refused(await record(c.member, standalone, "attempted_no_contact"), "unavailable");
	const own = ok(
		await write(c.owner, "createFollowUp", {
			requestKey: key(),
			input: { personId: alex, assigneeIds: [c.member.id] },
		}),
	).task;
	refused(await record(c.member, onTask(admin), "attempted_no_contact"), "unavailable");
	const mine = ok(await record(c.member, onTask(own), "attempted_no_contact"));
	refused(
		await write(c.member, "correctOutcome", {
			requestKey: key(),
			expectedRevision: first.record.revision,
			input: { outcomeId: first.record.id, correction: { kind: "void" }, reason: "Not mine" },
		}),
		"unavailable",
	);
	ok(
		await write(c.member, "correctOutcome", {
			requestKey: key(),
			expectedRevision: mine.record.revision,
			input: {
				outcomeId: mine.record.id,
				correction: { kind: "replace", outcome: "contacted", occurredAt: "2026-10-13T15:00:00Z" },
				reason: "They called back",
			},
		}),
	);
	assert.equal(await contactAt(), "2026-10-13T15:00:00.000Z");
	const other = await church();
	refused(await read(other.owner, "listContactHistory", { personId: alex }), "unavailable");
});

test("AC:TARGET-MTG-022 a Just now within the 2-minute clock allowance is stored as the server's clock; later is future", async () => {
	const c = await church();
	const alex = await person(c, "Alex Rivera");
	const standalone = { kind: "person", personId: alex };
	const count = async () => (await rows(sql`SELECT count(*)::int n FROM contact_outcome WHERE person_id=${alex}`))[0].n;
	const ahead = new Date(Date.now() + 90_000).toISOString();
	const saved = ok(await record(c.owner, standalone, "contacted", { occurredAt: ahead }));
	const [stored] = await rows(
		sql`SELECT occurred_at <= recorded_at AS ok, occurred_at < ${ahead}::timestamptz AS before FROM contact_outcome WHERE id=${saved.record.id}`,
	);
	assert.deepEqual(stored, { ok: true, before: true });
	assert.ok(Date.parse(saved.record.occurredAt) <= Date.parse(saved.record.recordedAt));
	const before = await count();
	refused(
		await record(c.owner, standalone, "contacted", { occurredAt: new Date(Date.now() + 180_000).toISOString() }),
		"future_occurrence",
	);
	assert.equal(await count(), before);
});

test("AC:PERSONREF-TASK-PERSON-FOLLOW-UP-RETIRE AC:PERSONREF-MEETING-INVITATION-RSVP-ATTENDANCE-CARD-RETIRE a retired Person keeps follow-up history and gets no new follow-up work", async () => {
	const c = await church();
	const [p1, p2] = [await person(c, "Alex Rivera"), await person(c, "Alex Chen")];
	const origin = { at: "2026-10-01T23:00:00Z", date: "2026-10-01", zone: "America/Chicago" };
	const m = await meeting(c, "Vision", origin);
	await finalize(c, m, origin, {
		followUps: [p1, p2].map((personId) => ({ personId, assigneeIds: [] })),
		evaluation: null,
	});
	const [o2] = ok(await read(c.owner, "readObligations", { personId: p2 })).items;
	ok(
		await record(c.owner, onTask(o2.task), "contacted", {
			occurredAt: "2026-10-02T15:00:00Z",
			completeTask: true,
		}),
	);
	await f.admin.execute(sql`UPDATE person SET state='retired', retired_at=now() WHERE id=${p2}`);
	await finalize(c, m, origin, {
		followUps: [p1].map((personId) => ({ personId, assigneeIds: [] })),
		evaluation: null,
	});
	const history = ok(await read(c.owner, "listContactHistory", { personId: p2 }));
	const [kept] = ok(await read(c.owner, "readObligations", { personId: p2 })).items;
	assert.deepEqual(
		[history.lastConfirmedContactAt, kept.id, kept.state, kept.contacted],
		["2026-10-02T15:00:00.000Z", o2.id, "complete", true],
	);
	assert.deepEqual(await rows(sql`SELECT count(*)::int n FROM obligation WHERE meeting_id=${m}`), [{ n: 2 }]);
	const coverage = ok(await read(c.owner, "followUpCoverage", {}));
	assert.deepEqual(coverage.items.map((i) => i.person.id).sort(), [p1]);
	refused(await record(c.owner, { kind: "person", personId: p2 }, "attempted_no_contact"), "invalid_subject");
	refused(await write(c.owner, "createFollowUp", { requestKey: key(), input: { personId: p2 } }), "invalid_subject");
	const other = await church();
	const foreign = await person(other, "Foreign canary");
	refused(await record(c.owner, { kind: "person", personId: foreign }, "attempted_no_contact"), "invalid_subject");
	assert.deepEqual(await rows(sql`SELECT count(*)::int n FROM contact_outcome WHERE person_id=${foreign}`), [{ n: 0 }]);
});

test("AC:TARGET-TSK-012 AC:TARGET-PPL-022 AC:GAP-PPL-022 only a currently eligible account owns a follow-up; uncovered contacts are not urgent work", async () => {
	const c = await church();
	const casey = await person(c, "Casey", { stage: "prospect" });
	const none = ok(await read(c.owner, "followUpCoverage", { personId: casey }));
	assert.deepEqual(
		[none.items.map((i) => [i.coverage, i.duties]), none.uncovered, none.needsOwner],
		[[["uncovered", []]], 1, 0],
	);
	assert.equal(ok(await read(c.owner, "listContactHistory", { personId: casey })).total, 0);
	const ctx = { session: c.owner.actor.session, selected: c.w };
	const current = (await rows(sql`SELECT revision::text r FROM person WHERE id=${casey}`))[0].r;
	ok(
		await gatedTransaction(f.db, (tx) =>
			peopleWriter.changeStatus(
				tx,
				ctx,
				{
					requestKey: key(),
					expectedRevision: current,
					input: { personId: casey, stage: "following_up", reason: "Met at coffee", handoffs: [] },
				},
				reminders,
			),
		),
	);
	assert.deepEqual(await rows(sql`SELECT count(*)::int n FROM task WHERE person_id=${casey}`), [{ n: 0 }]);

	const eligible = await c.seated("member");
	await committed(c, eligible, "leader");
	const unlinked = await c.seated("admin");
	const shared = await c.seated("member");
	const sharedPerson = await person(c, "Shared inbox", { stage: "core_group" });
	await f.admin.execute(sql`UPDATE person SET email=${shared.email} WHERE id=${sharedPerson}`);
	const departed = await c.seated("member");
	await committed(c, departed);
	await f.admin.execute(sql`UPDATE seat SET ended_at=now() WHERE account_id=${departed.id} AND plant_id=${c.w.id}`);
	const create = (who, input) =>
		write(who, "createFollowUp", { requestKey: key(), input: { personId: casey, ...input } });
	for (const who of [unlinked, shared, departed])
		refused(await create(c.owner, { assigneeIds: [who.id] }), "owner_ineligible");
	refused(await create(c.member, {}), "unavailable");
	const manual = ok(await create(c.admin, { assigneeIds: [eligible.id] })).task;
	assert.deepEqual(
		[manual.title, manual.due, manual.overdue, manual.managed, manual.assignees[0].accountId],
		["Follow up with Casey", { kind: "undated" }, null, null, eligible.id],
	);
	assert.deepEqual(ok(await read(c.owner, "readObligations", { personId: casey })).items, []);
	assert.equal(ok(await read(c.owner, "listContactHistory", { personId: casey })).total, 0);
	const dated = ok(
		await create(c.owner, {
			personId: await person(c, "Dana"),
			assigneeIds: [eligible.id],
			due: { kind: "local_date", date: "2099-01-15" },
		}),
	).task;
	assert.deepEqual(
		await rows(sql`SELECT count(*)::int n FROM notice WHERE source_record_id=${dated.id} AND cancelled_at IS NULL`),
		[{ n: 2 }],
	);

	const demoted = await c.seated("member");
	const demotedPerson = await committed(c, demoted);
	refused(
		await write(c.owner, "assignFollowUp", {
			requestKey: key(),
			expectedRevision: manual.revision,
			input: { taskId: manual.id, assigneeIds: [unlinked.id] },
		}),
		"owner_ineligible",
	);
	const moved = ok(
		await write(c.owner, "assignFollowUp", {
			requestKey: key(),
			expectedRevision: manual.revision,
			input: { taskId: manual.id, assigneeIds: [demoted.id] },
		}),
	).task;
	assert.equal(moved.assignees[0].accountId, demoted.id);
	await f.admin.execute(sql`UPDATE person SET stage='prospect' WHERE id=${demotedPerson}`);
	const owners = ok(await read(c.member, "listFollowUpOwners", { personId: casey }));
	assert.deepEqual(
		[
			owners.items.map((d) => [d.taskId, d.owners.map((o) => [o.accountId, o.eligible, o.reason]), d.due, d.overdue]),
			owners.unassigned,
			owners.matched,
		],
		[[[manual.id, [[demoted.id, false, "not_committed"]], { kind: "undated" }, null]], 1, 1],
	);
	assert.deepEqual(await rows(sql`SELECT account_id FROM task_assignee WHERE task_id=${manual.id}`), [
		{ account_id: demoted.id },
	]);
	const covered = ok(await read(c.owner, "followUpCoverage", { personId: casey }));
	assert.deepEqual([covered.items[0].coverage, covered.needsOwner, covered.uncovered], ["needs_owner", 1, 0]);
	refused(await read(c.member, "followUpCoverage", {}), "unavailable");
	const back = ok(
		await write(c.owner, "assignFollowUp", {
			requestKey: key(),
			expectedRevision: moved.revision,
			input: { taskId: manual.id, assigneeIds: [eligible.id] },
		}),
	).task;
	const tally = ok(await read(c.owner, "listFollowUpOwners", { owner: eligible.id }));
	assert.deepEqual([tally.matched, tally.owners.map((o) => [o.accountId, o.open])], [2, [[eligible.id, 2]]]);
	assert.equal(back.assignees[0].accountId, eligible.id);
});

test("INV-paging a follow-up page past the end answers with the last page in the same read", async () => {
	const c = await church();
	for (const name of ["Ada", "Bea", "Cy"]) await person(c, name, { stage: "prospect" });
	const past = ok(await read(c.owner, "followUpCoverage", { page: 9, limit: 2 }));
	assert.deepEqual([past.page, past.items.length, past.total, past.next], [2, 1, 3, null]);
	const empty = ok(await read(c.owner, "listFollowUpOwners", { page: 4, limit: 2 }));
	assert.deepEqual([empty.page, empty.items, empty.matched, empty.next], [1, [], 0, null]);
});

test("AC:TARGET-TSK-013 INV-statements handoff moves reviewed open follow-ups or nothing; reads cost one statement", async () => {
	const c = await church();
	const alex = await person(c, "Alex");
	const leaving = await c.seated("member");
	const leavingPerson = await committed(c, leaving);
	const recipient = await c.seated("member");
	const recipientPerson = await committed(c, recipient);
	const bystander = await c.seated("member");
	const insert = (status, n) =>
		f.admin
			.execute(sql`WITH ins AS (INSERT INTO task(id,plant_id,title,category,priority,status,created_at,due_kind,person_id,completed_at)
			SELECT gen_random_uuid(),${c.w.id},'Call Alex '||g,'follow_up','medium',${status},now(),'undated',${alex},
				CASE WHEN ${status}='complete' THEN now() END FROM generate_series(1,${n}) g RETURNING id)
			INSERT INTO task_assignee(plant_id,task_id,account_id) SELECT ${c.w.id},id,${leaving.id} FROM ins`);
	await insert("not_started", 102);
	await insert("complete", 1);
	await insert("no_longer_needed", 1);
	await f.admin.execute(sql`UPDATE person SET stage='prospect' WHERE id=${leavingPerson}`);
	const plan = ok(await read(c.admin, "planHandoff", { fromAccountId: leaving.id }));
	assert.deepEqual(
		[plan.from.eligible, plan.from.protectedOwner, plan.total, plan.duties.length],
		[false, false, 102, 102],
	);
	assert.deepEqual(
		plan.recipients.map((r) => r.accountId),
		[recipient.id],
	);
	assert.equal(ok(await read(c.admin, "planHandoff", { fromAccountId: c.owner.id })).from.protectedOwner, true);
	refused(await read(c.admin, "planHandoff", { fromAccountId: (await church()).owner.id }), "unavailable");
	refused(await read(c.member, "planHandoff", { fromAccountId: leaving.id }), "unavailable");

	const items = plan.duties.map((d) => ({ taskId: d.taskId, expectedRevision: d.revision }));
	const handoff = (to, chunk, requestKey = key(), from = leaving.id) =>
		write(c.admin, "executeHandoff", { requestKey, input: { fromAccountId: from, toAccountId: to, items: chunk } });
	const held = async () =>
		(
			await rows(sql`SELECT count(*)::int n FROM task_assignee WHERE account_id=${leaving.id} AND plant_id=${c.w.id}`)
		)[0].n;
	refused(await handoff(bystander.id, items.slice(0, 100)), "handoff_target_ineligible");
	refused(await handoff(recipient.id, items.slice(0, 1), key(), c.owner.id), "protected_owner");
	const stale = items.slice(0, 100).map((i, n) => (n === 99 ? { ...i, expectedRevision: "7" } : i));
	refused(await handoff(recipient.id, stale), "conflict");
	assert.equal(await held(), 104);

	const first = key();
	const moved = ok(await handoff(recipient.id, items.slice(0, 100), first));
	assert.deepEqual(
		[moved.moved.length, moved.remaining.sort(), moved.remainingTotal],
		[
			100,
			items
				.slice(100)
				.map((i) => i.taskId)
				.sort(),
			2,
		],
	);
	const audits = async () => (await rows(sql`SELECT count(*)::int n FROM audit_event WHERE tenant_id=${c.w.id}`))[0].n;
	const before = await audits();
	assert.deepEqual(ok(await handoff(recipient.id, items.slice(0, 100), first)), moved);
	assert.equal(await audits(), before);
	await f.admin.execute(sql`UPDATE person SET stage='prospect' WHERE id=${recipientPerson}`);
	refused(await handoff(recipient.id, items.slice(100)), "handoff_target_ineligible");
	await f.admin.execute(sql`UPDATE person SET stage='core_group' WHERE id=${recipientPerson}`);
	const rest = ok(await handoff(recipient.id, items.slice(100)));
	assert.deepEqual([rest.moved.length, rest.remaining, rest.remainingTotal], [2, [], 0]);
	assert.deepEqual(
		await rows(
			sql`SELECT t.status FROM task t JOIN task_assignee a ON a.task_id=t.id WHERE a.account_id=${leaving.id} AND t.plant_id=${c.w.id} ORDER BY t.status`,
		),
		[{ status: "complete" }, { status: "no_longer_needed" }],
	);

	const departed = await c.seated("member");
	await committed(c, departed);
	await f.admin
		.execute(sql`WITH ins AS (INSERT INTO task(id,plant_id,title,category,priority,status,created_at,due_kind,person_id)
		SELECT gen_random_uuid(),${c.w.id},'Visit Alex '||g,'follow_up','medium','not_started',now(),'undated',${alex}
		FROM generate_series(1,2) g RETURNING id)
		INSERT INTO task_assignee(plant_id,task_id,account_id) SELECT ${c.w.id},id,${departed.id} FROM ins`);
	await f.admin.execute(sql`UPDATE seat SET ended_at=now() WHERE account_id=${departed.id} AND plant_id=${c.w.id}`);
	const coverage = ok(await read(c.admin, "followUpCoverage", { personId: alex }));
	assert.deepEqual(
		coverage.formerOwners.map((o) => [o.accountId, o.open]),
		[[departed.id, 2]],
	);
	const waiting = ok(await read(c.admin, "listFollowUpOwners", { owner: "needs_owner", personId: alex })).items;
	assert.deepEqual(
		waiting.flatMap((d) => d.owners.map((o) => [o.accountId, o.eligible, o.reason])),
		[
			[departed.id, false, "no_seat"],
			[departed.id, false, "no_seat"],
		],
	);
	const gone = ok(await read(c.admin, "planHandoff", { fromAccountId: departed.id }));
	assert.deepEqual([gone.from.eligible, gone.total], [false, 2]);
	const out = ok(
		await handoff(
			recipient.id,
			gone.duties.map((d) => ({ taskId: d.taskId, expectedRevision: d.revision })),
			key(),
			departed.id,
		),
	);
	assert.deepEqual([out.moved.length, out.remainingTotal], [2, 0]);
	assert.deepEqual(ok(await read(c.admin, "followUpCoverage", { personId: alex })).formerOwners, []);

	const reads = async () => [
		await counted(() => read(c.owner, "listFollowUpOwners", { limit: 100 })),
		await counted(() => read(c.owner, "followUpCoverage", { limit: 100 })),
		await counted(() => read(c.owner, "planHandoff", { fromAccountId: recipient.id })),
		await counted(() => read(c.owner, "readObligations", { limit: 100 })),
		await counted(() => read(c.owner, "listContactHistory", { personId: alex })),
	];
	assert.deepEqual(await reads(), Array(5).fill(3));
});

test("AC:TARGET-PPL-007 INV-inactivity: a card warns after the church's inactivity days without activity; new activity clears it", async () => {
	const c = await church();
	await f.admin.execute(sql`UPDATE plant SET warning_days=7, alert_days=14 WHERE id=${c.w.id}`);
	const added = async (name, daysAgo) => {
		const id = randomUUID();
		await f.admin
			.execute(sql`INSERT INTO person(id,tenant_id,plant_id,display_name,source,stage,adult_classification,commitment_state,pipeline_position,state,created_at)
			VALUES(${id},${c.w.id},${c.w.id},${name},'other','prospect','unknown','unknown',0,'live',now()-make_interval(days=>${daysAgo}))`);
		return id;
	};
	const people = {
		recent: await added("Recent", 1),
		quiet: await added("Quiet", 10),
		silent: await added("Silent", 20),
	};
	const levels = async () => {
		const pipeline = ok(
			await gatedTransaction(f.db, (tx) => peopleReader.getPipelineData(tx, new PeopleReadContext(c.member.actor), {})),
		);
		const cards = pipeline.groups.flatMap((g) => g.cards);
		return Object.fromEntries(
			Object.entries(people).map(([name, id]) => [name, cards.find((k) => k.person.id === id).inactivity.level]),
		);
	};
	assert.deepEqual(await levels(), { recent: "none", quiet: "warning", silent: "alert" });
	ok(
		await record(c.owner, { kind: "person", personId: people.silent }, "contacted", {
			occurredAt: hours(new Date().toISOString(), -48),
		}),
	);
	const wrong = ok(
		await record(c.owner, { kind: "person", personId: people.quiet }, "contacted", {
			occurredAt: hours(new Date().toISOString(), -1),
		}),
	);
	ok(
		await write(c.owner, "correctOutcome", {
			requestKey: key(),
			expectedRevision: wrong.record.revision,
			input: { outcomeId: wrong.record.id, correction: { kind: "void" }, reason: "Wrong person" },
		}),
	);
	assert.deepEqual(await levels(), { recent: "none", quiet: "warning", silent: "none" });
});

async function assigned(c, personId, title, assigneeId) {
	const id = randomUUID();
	await f.admin
		.execute(sql`INSERT INTO task(id,plant_id,title,category,priority,status,created_at,due_kind,person_id,creator_id)
		VALUES(${id},${c.w.id},${title},'follow_up','medium','not_started',now(),'undated',${personId},${c.owner.id})`);
	if (assigneeId)
		await f.admin.execute(
			sql`INSERT INTO task_assignee(plant_id,task_id,account_id) VALUES(${c.w.id},${id},${assigneeId})`,
		);
	return id;
}

test("AC:TARGET-TSK-012 AC:TARGET-TSK-013 one owner view: every read names a follow-up's assignee and why they cannot own it the same way", async () => {
	const c = await church();
	const pia = await person(c, "Pia Dalton");
	const eligible = await c.seated("member");
	await committed(c, eligible);
	const unlinked = await c.seated("member");
	const prospect = await c.seated("member");
	await person(c, "Prospect owner", { stage: "prospect", linked: prospect.id });
	const departed = await c.seated("member");
	await committed(c, departed);
	await f.admin.execute(sql`UPDATE seat SET ended_at=now() WHERE account_id=${departed.id} AND plant_id=${c.w.id}`);
	const expected = {
		[eligible.id]: [true, null],
		[unlinked.id]: [false, "no_person"],
		[prospect.id]: [false, "not_committed"],
		[departed.id]: [false, "no_seat"],
	};
	const taskOf = {};
	for (const a of [eligible, unlinked, prospect, departed])
		taskOf[a.id] = await assigned(c, pia, "Visit " + a.id.slice(0, 4), a.id);
	const shape = (o) => o && [o.accountId, o.eligible, o.reason];
	const owners = ok(await read(c.member, "listFollowUpOwners", { personId: pia })).items;
	const coverage = ok(await read(c.admin, "followUpCoverage", { personId: pia })).items[0].duties;
	const list = ok(await gatedTransaction(f.db, (tx) => taskReader.list(tx, c.admin.actor, {}))).items;
	for (const [account, [ok_, reason]] of Object.entries(expected)) {
		const id = taskOf[account];
		const views = [
			owners.find((d) => d.taskId === id).owners[0],
			coverage.find((d) => d.taskId === id).owners[0],
			list.find((t) => t.id === id).followUpOwners[0],
		];
		assert.deepEqual(
			views.map(shape),
			views.map(() => [account, ok_, reason]),
		);
		assert.deepEqual(new Set(views.map((v) => v.displayName)).size, 1);
	}
	assert.equal(ok(await read(c.member, "listFollowUpOwners", { personId: pia, owner: "needs_owner" })).matched, 3);
	assert.deepEqual(
		ok(await read(c.admin, "followUpCoverage", { personId: pia })).items.map((r) => [r.coverage]),
		[["needs_owner"]],
	);
	const plan = ok(await read(c.admin, "planHandoff", { fromAccountId: unlinked.id }));
	assert.deepEqual(
		plan.duties.map((d) => d.owners.map(shape)),
		[[[unlinked.id, false, "no_person"]]],
	);
	assert.equal(list.find((t) => t.id === taskOf[eligible.id]).followUpOwners[0].eligible, true);
});

test("AC:TARGET-TSK-012 task assignment, create and edit refuse a follow-up owner who cannot own one", async () => {
	const c = await church();
	const quinn = await person(c, "Quinn Reed");
	const unlinked = await c.seated("member");
	const ready = await c.seated("member");
	await committed(c, ready);
	const task = await assigned(c, quinn, "Visit Quinn", null);
	const [row] = await rows(sql`SELECT revision::text AS r FROM task WHERE id=${task}`);
	refused(
		await taskWrite(c.owner, "edit", {
			requestKey: key(),
			expectedRevision: row.r,
			input: { taskId: task, patch: { assigneeIds: [unlinked.id] } },
		}),
		"owner_ineligible",
	);
	refused(
		await taskWrite(c.owner, "create", {
			requestKey: key(),
			input: {
				title: "Call Quinn",
				category: "follow_up",
				relation: { kind: "person", id: quinn },
				assigneeIds: [unlinked.id],
			},
		}),
		"owner_ineligible",
	);
	ok(
		await taskWrite(c.owner, "create", {
			requestKey: key(),
			input: { title: "Order chairs", category: "general", assigneeIds: [unlinked.id] },
		}),
	);
	const edited = ok(
		await taskWrite(c.owner, "edit", {
			requestKey: key(),
			expectedRevision: row.r,
			input: { taskId: task, patch: { assigneeIds: [ready.id] } },
		}),
	).task;
	assert.deepEqual([edited.assignees[0].accountId, edited.followUpOwners[0].eligible], [ready.id, true]);
	const names = (r) => ok(r).items.map((i) => i.accountId);
	const all = names(await gatedTransaction(f.db, (tx) => taskReader.eligibleAssignees(tx, c.owner.actor, {})));
	const eligibleOnly = names(
		await gatedTransaction(f.db, (tx) =>
			taskReader.eligibleAssignees(tx, c.owner.actor, { purpose: "committed_follow_up" }),
		),
	);
	assert.ok(all.includes(unlinked.id) && all.includes(ready.id));
	assert.deepEqual(eligibleOnly, [ready.id]);
});

test("AC:TARGET-MTG-022 AC:TARGET-MTG-021 one follow-up state: a done follow-up takes no outcome; one contact finishes the Person's other follow-ups", async () => {
	const c = await church();
	const rae = await person(c, "Rae Kim");
	const origin = { at: "2026-09-10T15:00:00Z", date: "2026-09-10", zone: "America/Chicago" };
	const a = await generated(c, rae, "Vision A", origin);
	const first = ok(
		await record(c.owner, onTask(a.obligation.task), "attempted_no_contact", { occurredAt: "2026-09-10T16:00:00Z" }),
	);
	assert.equal(first.task.status, "not_started");
	const [open] = await rows(sql`SELECT status, revision::text AS r FROM task WHERE id=${a.obligation.task.id}`);
	assert.equal(open.status, "not_started");
	const done = ok(
		await taskWrite(c.owner, "complete", {
			requestKey: key(),
			expectedRevision: open.r,
			input: { taskId: a.obligation.task.id },
		}),
	).task;
	const before = (await rows(sql`SELECT count(*)::int AS n FROM contact_outcome WHERE person_id=${rae}`))[0].n;
	refused(
		await record(c.owner, onTask(done), "contacted", { occurredAt: "2026-09-11T15:00:00Z", completeTask: true }),
		"conflict",
	);
	refused(await record(c.owner, onTask(done), "no_longer_needed"), "conflict");
	assert.equal((await rows(sql`SELECT count(*)::int AS n FROM contact_outcome WHERE person_id=${rae}`))[0].n, before);
	ok(await record(c.owner, { kind: "person", personId: rae }, "contacted", { occurredAt: "2026-09-11T15:00:00Z" }));

	const sol = await person(c, "Sol Ortiz");
	const v1 = await generated(c, sol, "Vision B", {
		at: "2026-09-12T15:00:00Z",
		date: "2026-09-12",
		zone: "America/Chicago",
	});
	const manual = ok(
		await write(c.owner, "createFollowUp", {
			requestKey: key(),
			input: { personId: sol, title: "Send Sol the packet" },
		}),
	).task;
	const finished = ok(
		await record(c.owner, onTask(v1.obligation.task), "contacted", {
			occurredAt: "2026-09-12T20:00:00Z",
			channel: "phone",
			notes: "Left a voicemail and texted.",
			completeTask: true,
		}),
	);
	assert.equal(finished.task.status, "complete");
	assert.deepEqual(
		finished.record.alsoFinished.map((x) => [x.taskId, x.origin.kind]),
		[[manual.id, "added"]],
	);
	const statuses = await rows(sql`SELECT status FROM task WHERE person_id=${sol}`);
	assert.deepEqual(
		statuses.map((x) => x.status),
		["complete", "complete"],
	);
	assert.equal((await rows(sql`SELECT count(*)::int AS n FROM contact_outcome WHERE person_id=${sol}`))[0].n, 1);
	const log = ok(await read(c.owner, "listContactHistory", { personId: sol }));
	assert.deepEqual(
		log.items.map((i) => [i.channel, i.notes, i.alsoFinished.length]),
		[["phone", "Left a voicemail and texted.", 1]],
	);
	const onManual = ok(await read(c.owner, "listContactHistory", { personId: sol, taskId: manual.id }));
	assert.deepEqual(
		onManual.items.map((i) => i.id),
		[finished.record.id],
	);
	const duty = ok(await read(c.owner, "readObligations", { personId: sol, asOf: "2026-09-20T00:00:00Z" })).items[0];
	assert.deepEqual(
		[duty.state, duty.completion.outcomeId === finished.record.id, duty.contacted, duty.measurement.success],
		["complete", true, true, true],
	);
	assert.equal(ok(await read(c.owner, "listFollowUpOwners", { personId: sol })).items.length, 0);
	const activity = ok(
		await gatedTransaction(f.db, (tx) =>
			peopleReader.getActivities(tx, new PeopleReadContext(c.owner.actor), { personId: sol, kinds: ["follow_up"] }),
		),
	);
	assert.deepEqual(
		activity.items.map((i) => [i.outcome, i.channel, i.notes]),
		[["contacted", "phone", "Left a voicemail and texted."]],
	);
});

test("INV-statements an outcome locks its task and reads its Person in one statement, whatever it finishes", async () => {
	const c = await church();
	const lee = await person(c, "Lee Park");
	const origin = { at: "2026-09-14T15:00:00Z", date: "2026-09-14", zone: "America/Chicago" };
	const vision = await generated(c, lee, "Vision C", origin);
	const generatedTask = vision.obligation.task;
	const followUp = async (input) =>
		ok(await write(c.owner, "createFollowUp", { requestKey: key(), input: { personId: lee, ...input } })).task;
	const save = async (target, outcome, extra = {}) => {
		let saved;
		const n = await counted(async () => {
			saved = ok(await record(c.owner, target, outcome, { occurredAt: "2026-09-14T18:00:00Z", ...extra }));
		});
		return { n, saved };
	};

	const plain = await save(onTask(generatedTask), "attempted_no_contact");
	assert.deepEqual(
		[plain.n, plain.saved.task.status, plain.saved.lastConfirmedContactAt, plain.saved.record.meetingId],
		[5, "not_started", null, vision.meetingId],
	);
	const byPerson = await save({ kind: "person", personId: lee }, "contacted");
	assert.deepEqual(
		[byPerson.n, byPerson.saved.task, byPerson.saved.lastConfirmedContactAt],
		[5, null, "2026-09-14T18:00:00.000Z"],
	);
	const dropped = await save(onTask(await followUp({})), "no_longer_needed");
	assert.deepEqual([dropped.n, dropped.saved.task.status], [5, "no_longer_needed"]);
	const other = await followUp({ title: "Send Lee the packet" });
	const finished = await save(onTask(plain.saved.task), "contacted", { completeTask: true });
	assert.deepEqual(
		[finished.n, finished.saved.task.status, finished.saved.record.alsoFinished.map((x) => [x.taskId, x.origin.kind])],
		[5, "complete", [[other.id, "added"]]],
	);

	const holder = await c.seated("member");
	await committed(c, holder, "leader");
	const dated = await followUp({ assigneeIds: [holder.id], due: { kind: "local_date", date: "2099-01-15" } });
	const due = sql`SELECT count(*)::int n FROM notice WHERE source_record_id=${dated.id} AND cancelled_at IS NULL`;
	assert.deepEqual(await rows(due), [{ n: 2 }]);
	const completed = await save(onTask(dated), "attempted_no_contact", { completeTask: true });
	assert.deepEqual([completed.n, completed.saved.task.status], [6, "complete"]);
	assert.deepEqual(await rows(due), [{ n: 0 }]);
});

test("AC:TARGET-MTG-022 a Member's contact finishes only the follow-ups they hold", async () => {
	const c = await church();
	const me = c.member;
	await committed(c, me);
	const other = await c.seated("member");
	await committed(c, other);
	const tia = await person(c, "Tia Marsh");
	const mine = await assigned(c, tia, "Call Tia", me.id);
	const mine2 = await assigned(c, tia, "Text Tia", me.id);
	const theirs = await assigned(c, tia, "Visit Tia", other.id);
	const [r] = await rows(sql`SELECT revision::text AS r FROM task WHERE id=${mine}`);
	const saved = ok(
		await record(me, { kind: "task", taskId: mine, expectedRevision: r.r }, "contacted", {
			occurredAt: "2026-09-12T20:00:00Z",
			completeTask: true,
		}),
	);
	assert.deepEqual(
		saved.record.alsoFinished.map((x) => x.taskId),
		[mine2],
	);
	assert.deepEqual(
		(await rows(sql`SELECT id, status FROM task WHERE person_id=${tia}`))
			.map((t) => [t.id === theirs ? "theirs" : "mine", t.status])
			.sort(),
		[
			["mine", "complete"],
			["mine", "complete"],
			["theirs", "not_started"],
		],
	);
	const left = ok(await read(me, "listFollowUpOwners", { personId: tia })).items;
	const [recorder] = await rows(sql`SELECT display_name FROM seat_identity(${me.id}::uuid)`);
	assert.deepEqual(
		left.map((d) => [d.taskId === theirs, d.contacted?.by ?? "none"]),
		[[true, recorder.display_name]],
	);
	const corrected = ok(
		await write(c.owner, "correctOutcome", {
			requestKey: key(),
			expectedRevision: saved.record.revision,
			input: {
				outcomeId: saved.record.id,
				correction: {
					kind: "replace",
					outcome: "contacted",
					occurredAt: "2026-09-12T20:05:00Z",
					notes: "Spoke briefly",
				},
				reason: "Wrong time",
			},
		}),
	);
	assert.deepEqual(
		corrected.record.alsoFinished.map((x) => x.taskId),
		[mine2],
	);
});

async function sharedBy(c, personId, title, ids) {
	const id = await assigned(c, personId, title, ids[0] ?? null);
	for (const account of ids.slice(1))
		await f.admin.execute(
			sql`INSERT INTO task_assignee(plant_id,task_id,account_id) VALUES(${c.w.id},${id},${account})`,
		);
	return id;
}

test("AC:TARGET-TSK-012 a follow-up is owned while one owner is eligible, and counts once under each", async () => {
	const c = await church();
	const pia = await person(c, "Pia Hart");
	const ready = await c.seated("member");
	await committed(c, ready);
	const second = await c.seated("member");
	await committed(c, second);
	const stuck = await c.seated("member");
	const pair = await sharedBy(c, pia, "Visit Pia", [ready.id, second.id]);
	const mixed = await sharedBy(c, pia, "Call Pia", [ready.id, stuck.id]);
	const only = await sharedBy(c, pia, "Text Pia", [stuck.id]);
	const owners = ok(await read(c.admin, "listFollowUpOwners", { personId: pia }));
	const byTask = (id) => owners.items.find((d) => d.taskId === id);
	assert.deepEqual(
		byTask(pair).owners.map((o) => [o.eligible]),
		[[true], [true]],
	);
	assert.deepEqual(
		byTask(mixed)
			.owners.map((o) => o.eligible)
			.sort(),
		[false, true],
	);
	assert.deepEqual(
		owners.owners.map((o) => [o.accountId, o.open]).sort(),
		[
			[ready.id, 2],
			[second.id, 1],
		].sort(),
	);
	assert.equal(owners.unassigned, 1);
	assert.equal(owners.matched, 3, "matched counts each follow-up once");
	assert.deepEqual(
		ok(await read(c.admin, "listFollowUpOwners", { personId: pia, owner: ready.id }))
			.items.map((d) => d.taskId)
			.sort(),
		[pair, mixed].sort(),
	);
	const coverage = ok(await read(c.admin, "followUpCoverage", { personId: pia }));
	assert.equal(coverage.needsOwner, 1);
	assert.equal(coverage.items[0].coverage, "needs_owner");
	assert.deepEqual(
		coverage.formerOwners.map((o) => [o.accountId, o.open]),
		[[stuck.id, 2]],
	);
	assert.equal(ok(await read(c.admin, "planHandoff", { fromAccountId: stuck.id })).total, 2);
	assert.deepEqual(
		byTask(only).owners.map((o) => [o.accountId, o.eligible]),
		[[stuck.id, false]],
	);
});

test("AC:TARGET-TSK-012 assigning a list refuses the whole write when one account cannot own", async () => {
	const c = await church();
	const pia = await person(c, "Pia Hart");
	const ready = await c.seated("member");
	await committed(c, ready);
	const stuck = await c.seated("member");
	const id = await sharedBy(c, pia, "Visit Pia", []);
	const [r] = await rows(sql`SELECT revision::text AS r FROM task WHERE id=${id}`);
	const held = () => rows(sql`SELECT account_id FROM task_assignee WHERE task_id=${id}`);
	const error = refused(
		await write(c.admin, "assignFollowUp", {
			requestKey: key(),
			expectedRevision: r.r,
			input: { taskId: id, assigneeIds: [ready.id, stuck.id] },
		}),
		"owner_ineligible",
	);
	assert.equal(error.details.accountId, stuck.id);
	assert.deepEqual(await held(), []);
	const two = await c.seated("member");
	await committed(c, two);
	const done = ok(
		await write(c.admin, "assignFollowUp", {
			requestKey: key(),
			expectedRevision: r.r,
			input: { taskId: id, assigneeIds: [ready.id, two.id] },
		}),
	).task;
	assert.equal(done.assignees.length, 2);
	refused(
		await write(c.admin, "createFollowUp", {
			requestKey: key(),
			input: { personId: pia, assigneeIds: [ready.id, stuck.id] },
		}),
		"owner_ineligible",
	);
});

test("AC:TARGET-TSK-013 a handoff swaps only the leaving owner, and a contact finishes only the follow-ups the Member holds", async () => {
	const c = await church();
	const pia = await person(c, "Pia Hart");
	const leaving = await c.seated("member");
	const leavingPerson = await committed(c, leaving);
	const keeper = await c.seated("member");
	await committed(c, keeper);
	const recipient = await c.seated("member");
	await committed(c, recipient);
	const alone = await sharedBy(c, pia, "Visit Pia", [leaving.id]);
	const withKeeper = await sharedBy(c, pia, "Call Pia", [leaving.id, keeper.id]);
	const alreadyThere = await sharedBy(c, pia, "Text Pia", [leaving.id, recipient.id]);
	await f.admin.execute(sql`UPDATE person SET stage='prospect' WHERE id=${leavingPerson}`);
	const plan = ok(await read(c.admin, "planHandoff", { fromAccountId: leaving.id }));
	assert.equal(plan.total, 3);
	ok(
		await write(c.admin, "executeHandoff", {
			requestKey: key(),
			input: {
				fromAccountId: leaving.id,
				toAccountId: recipient.id,
				items: plan.duties.map((d) => ({ taskId: d.taskId, expectedRevision: d.revision })),
			},
		}),
	);
	const held = async (id) =>
		(await rows(sql`SELECT account_id FROM task_assignee WHERE task_id=${id}`)).map((r) => r.account_id).sort();
	assert.deepEqual(await held(alone), [recipient.id]);
	assert.deepEqual(await held(withKeeper), [keeper.id, recipient.id].sort());
	assert.deepEqual(await held(alreadyThere), [recipient.id]);
	const tia = await person(c, "Tia Marsh");
	const mine = await sharedBy(c, tia, "Call Tia", [recipient.id, keeper.id]);
	const theirs = await sharedBy(c, tia, "Visit Tia", [keeper.id]);
	const [r] = await rows(sql`SELECT revision::text AS r FROM task WHERE id=${mine}`);
	ok(
		await record(
			{ ...recipient, actor: await f.actor(recipient.session) },
			{ kind: "task", taskId: mine, expectedRevision: r.r },
			"contacted",
			{ occurredAt: "2026-09-12T20:00:00Z", completeTask: true },
		),
	);
	assert.deepEqual(
		(await rows(sql`SELECT id, status FROM task WHERE id IN (${mine},${theirs}) ORDER BY title`)).map((t) => t.status),
		["complete", "not_started"],
	);
});
