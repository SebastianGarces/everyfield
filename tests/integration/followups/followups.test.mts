import test, { after, before } from "node:test";
import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { sql } from "../../../packages/db/src/query.ts";
import { fixture } from "../identity/invitations-support.mts";
import { requestIdentity } from "../../../packages/contracts/src/common/index.ts";
import { followUpDueDate } from "../../../packages/contracts/src/tasks/index.ts";
import { within48Hours } from "../../../packages/contracts/src/followups/index.ts";
import { auditTransaction, finishAudit, prepareWrite } from "../../../packages/domain/src/operations/writes.ts";
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
import { createMailService } from "../../../apps/web/src/server/jobs/mail.ts";
import { createNotificationService } from "../../../apps/web/src/server/jobs/notifications.ts";
import { taskReminders } from "../../../apps/web/src/server/tasks/reminders.ts";

let f, followups, tasks, reminders;
const ok = (r) => {
	assert.equal(r.status, "ok", JSON.stringify(r));
	return r.value;
};
const refused = (r, code) => {
	assert.equal(r.status, "refused", JSON.stringify(r));
	assert.equal(r.error.code, code);
	return r.error;
};
const write = (who, op, input) => withFollowUpWrite(f.db, who.actor, (tx, ctx) => followups[op](tx, ctx, input));
const taskWrite = (who, op, input) => withTaskWrite(f.db, who.actor, (tx, ctx) => tasks[op](tx, ctx, input));
const read = (who, op, input) => f.db.transaction((tx) => followUpReader[op](tx, who.actor, input));
const rows = async (q) => (await f.admin.execute(q)).rows;
const key = () => randomUUID();
const hours = (iso, h) => new Date(Date.parse(iso) + h * 3_600_000).toISOString();

/** A church in Chicago with an Owner, an Admin and a Member. */
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
	const r = await f.db.transaction((tx) =>
		peopleWriter.createPerson(tx, ctx, { requestKey: key(), input: { displayName: name } }),
	);
	const id = ok(r).person.id;
	if (fields.stage) await f.admin.execute(sql`UPDATE person SET stage=${fields.stage} WHERE id=${id}`);
	if (fields.linked) await f.admin.execute(sql`UPDATE person SET linked_account_id=${fields.linked} WHERE id=${id}`);
	return id;
}
/** An account that may own follow-ups: its seat and a committed Person linked to it. */
const committed = (c, who, stage = "core_group") => person(c, "Owner " + who.id.slice(0, 4), { stage, linked: who.id });
async function meeting(c, title, origin) {
	const id = randomUUID();
	await f.admin.execute(
		sql`INSERT INTO meeting(id,plant_id,type,title,local_date,local_time,timezone,starts_at,resolver_version,status,attendance_revision) VALUES(${id},${c.w.id},'vision_meeting',${title},${origin.date},'18:00','America/Chicago',${origin.at},'1','completed',1)`,
	);
	return id;
}
// The meeting domain's reviewed finalize command: its own audit row, the generated work, one write statement.
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
/** A first-time Vision guest's generated follow-up for one meeting. */
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
	// Chicago springs forward on 2026-03-08: 48 elapsed hours end at 10:00 local, not 09:00, on a day that is still due.
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
	// Three meetings with the same origin and local date keep three identities for Alex.
	const same = at(-72);
	// One contact finishes all of a Person's open follow-ups it may (D-c), so each contact case has its own Person.
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
	// A completed checkbox without a typed outcome is not a measured success.
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
	// Every due day is the origin's local date plus two.
	assert.deepEqual(byMeeting.get(m.admin2h.meetingId).dueDate, followUpDueDate(same.date));

	// The waiver survives an edit, a deletion and a replayed finalize; nothing is regenerated.
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
	// An explicit reopen changes the current state; the waiver stays in the task's history.
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

	// A Vision with no attendees and no owner still has its evaluation, shown as Needs owner; a retry adds nothing.
	const empty = await meeting(c, "Empty Vision", at(-30));
	for (let n = 0; n < 2; n++) await finalize(c, empty, at(-30), { followUps: [], evaluation: { assigneeIds: [] } });
	const evaluation = ok(await read(c.owner, "readObligations", { meetingId: empty, asOf })).items;
	assert.deepEqual(
		evaluation.map((o) => [o.kind, o.person, o.owner, o.state, o.measurement]),
		[["meeting_evaluation", null, null, "open", null]],
	);
});

test("AC:TARGET-COM-011 AC:TARGET-MTG-022 AC:ROLE43-008 contact log: only an effective contacted outcome is contact; corrections keep history", async () => {
	const c = await church();
	const alex = await person(c, "Alex Rivera");
	const standalone = { kind: "person", personId: alex };
	const contactAt = async () =>
		ok(await read(c.member, "listContactHistory", { personId: alex })).lastConfirmedContactAt;
	const material = async () => (await rows(sql`SELECT material_revision::int n FROM plant WHERE id=${c.w.id}`))[0].n;

	// Contacted on September 1, entered today: the actual date is kept.
	const first = ok(await record(c.owner, standalone, "contacted", { occurredAt: "2026-09-01T15:00:00Z" }));
	assert.equal(first.lastConfirmedContactAt, "2026-09-01T15:00:00.000Z");
	const attempt = ok(await record(c.owner, standalone, "attempted_no_contact", { occurredAt: "2026-10-10T15:00:00Z" }));
	// A Person-linked administrative task completes with its own label and no contact.
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
	// The Person's Activity still reads: an outcome with no generated duty has no obligation (WP-023/ui found the page
	// failing on it).
	const activity = ok(
		await f.db.transaction((tx) =>
			peopleReader.getActivities(tx, new PeopleReadContext(c.owner.actor), { personId: alex, kinds: ["follow_up"] }),
		),
	);
	assert.deepEqual(
		activity.items.map((i) => [i.outcome, i.obligationId]),
		[
			["contacted", null],
			["attempted_no_contact", null],
			["administrative_completion", null],
		],
	);
	const before = await material();
	const wrong = ok(await record(c.owner, standalone, "contacted", { occurredAt: "2026-10-12T15:00:00Z" }));
	assert.equal(await contactAt(), "2026-10-12T15:00:00.000Z");
	assert.equal(await material(), before + 1);
	// Withdrawing the wrong latest contact shows the earlier one again; the entry stays in the log.
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

	// A correction names the old value, the new value, who and why; the old entry stays.
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
	// A stale correction refuses; a contacted outcome needs its real time, never a future one.
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
	// A lost reply replays the same answer and writes once.
	const request = {
		requestKey: key(),
		input: { target: standalone, outcome: "attempted_no_contact", completeTask: false },
	};
	const once = ok(await write(c.owner, "recordOutcome", request));
	assert.deepEqual(ok(await write(c.owner, "recordOutcome", request)), once);
	assert.deepEqual(await rows(sql`SELECT count(*)::int n FROM contact_outcome WHERE person_id=${alex}`), [{ n: 6 }]);

	// A Member records only on a follow-up they hold, and corrects only their own entry; no lead title is involved.
	await committed(c, c.member);
	refused(await record(c.member, standalone, "attempted_no_contact"), "unavailable");
	const own = ok(
		await write(c.owner, "createFollowUp", { requestKey: key(), input: { personId: alex, assigneeIds: [c.member.id] } }),
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
	// Another church reads nothing.
	const other = await church();
	refused(await read(other.owner, "listContactHistory", { personId: alex }), "unavailable");
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
	// Replaying the finalize repeats no first-Vision consequence.
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
	// Operational selectors leave the retired Person out; a new reference refuses.
	const coverage = ok(await read(c.owner, "followUpCoverage", {}));
	assert.deepEqual(coverage.items.map((i) => i.person.id).sort(), [p1]);
	refused(await record(c.owner, { kind: "person", personId: p2 }, "attempted_no_contact"), "invalid_subject");
	refused(await write(c.owner, "createFollowUp", { requestKey: key(), input: { personId: p2 } }), "invalid_subject");
	// A foreign Person refuses the same way as a missing one and writes nothing.
	const other = await church();
	const foreign = await person(other, "Foreign canary");
	refused(await record(c.owner, { kind: "person", personId: foreign }, "attempted_no_contact"), "invalid_subject");
	assert.deepEqual(await rows(sql`SELECT count(*)::int n FROM contact_outcome WHERE person_id=${foreign}`), [{ n: 0 }]);
});

test("AC:TARGET-TSK-012 AC:TARGET-PPL-022 AC:GAP-PPL-022 only a currently eligible account owns a follow-up; uncovered contacts are not urgent work", async () => {
	const c = await church();
	const casey = await person(c, "Casey", { stage: "prospect" });
	// No explicit duty: uncovered, no invented due date, urgency or contact.
	const none = ok(await read(c.owner, "followUpCoverage", { personId: casey }));
	assert.deepEqual(
		[none.items.map((i) => [i.coverage, i.duties]), none.uncovered, none.needsOwner],
		[[["uncovered", []]], 1, 0],
	);
	assert.equal(ok(await read(c.owner, "listContactHistory", { personId: casey })).total, 0);
	// A stage change creates no follow-up in the background.
	const ctx = { session: c.owner.actor.session, selected: c.w };
	const current = (await rows(sql`SELECT revision::text r FROM person WHERE id=${casey}`))[0].r;
	ok(
		await f.db.transaction((tx) =>
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

	// Who may own one: a seat plus a live committed Person linked to that account.
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
	// A manual follow-up stays undated: no due date, 48-hour lineage or contact is invented.
	const manual = ok(await create(c.admin, { assigneeIds: [eligible.id] })).task;
	assert.deepEqual(
		[manual.title, manual.due, manual.overdue, manual.managed, manual.assignee.accountId],
		["Follow up with Casey", { kind: "undated" }, null, null, eligible.id],
	);
	assert.deepEqual(ok(await read(c.owner, "readObligations", { personId: casey })).items, []);
	assert.equal(ok(await read(c.owner, "listContactHistory", { personId: casey })).total, 0);
	// A chosen date is kept as entered and the owner gets its due and overdue reminders.
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

	// Assignment checks eligibility when it runs; a later demotion shows Needs owner though the stored ID remains.
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
	assert.equal(moved.assignee.accountId, demoted.id);
	await f.admin.execute(sql`UPDATE person SET stage='prospect' WHERE id=${demotedPerson}`);
	const owners = ok(await read(c.member, "listFollowUpOwners", { personId: casey }));
	assert.deepEqual(
		[
			owners.items.map((d) => [
				d.taskId,
				d.owner && [d.owner.accountId, d.owner.eligible, d.owner.reason],
				d.due,
				d.overdue,
			]),
			owners.unassigned,
			owners.matched,
		],
		[[[manual.id, [demoted.id, false, "not_committed"], { kind: "undated" }, null]], 1, 1],
	);
	assert.deepEqual(await rows(sql`SELECT assignee_id FROM task WHERE id=${manual.id}`), [{ assignee_id: demoted.id }]);
	const covered = ok(await read(c.owner, "followUpCoverage", { personId: casey }));
	assert.deepEqual([covered.items[0].coverage, covered.needsOwner, covered.uncovered], ["needs_owner", 1, 0]);
	refused(await read(c.member, "followUpCoverage", {}), "unavailable");
	// Leaving it as Needs owner is an explicit null; an eligible owner shows in the owner tally.
	const back = ok(
		await write(c.owner, "assignFollowUp", {
			requestKey: key(),
			expectedRevision: moved.revision,
			input: { taskId: manual.id, assigneeIds: [eligible.id] },
		}),
	).task;
	const tally = ok(await read(c.owner, "listFollowUpOwners", { owner: eligible.id }));
	assert.deepEqual([tally.matched, tally.owners.map((o) => [o.accountId, o.open])], [2, [[eligible.id, 2]]]);
	assert.equal(back.assignee.accountId, eligible.id);
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
			.execute(sql`INSERT INTO task(id,plant_id,title,category,priority,status,created_at,due_kind,person_id,assignee_id,completed_at)
			SELECT gen_random_uuid(),${c.w.id},'Call Alex '||g,'follow_up','medium',${status},now(),'undated',${alex},${leaving.id},
				CASE WHEN ${status}='complete' THEN now() END FROM generate_series(1,${n}) g`);
	await insert("not_started", 102);
	await insert("complete", 1);
	await insert("no_longer_needed", 1);
	// The planter's ministry role changes: the account keeps its seat but no longer owns follow-ups.
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
		(await rows(sql`SELECT count(*)::int n FROM task WHERE assignee_id=${leaving.id} AND plant_id=${c.w.id}`))[0].n;
	// Refusals change nothing: an ineligible recipient, the protected Owner, a stale selection.
	refused(await handoff(bystander.id, items.slice(0, 100)), "handoff_target_ineligible");
	refused(await handoff(recipient.id, items.slice(0, 1), key(), c.owner.id), "protected_owner");
	const stale = items.slice(0, 100).map((i, n) => (n === 99 ? { ...i, expectedRevision: "7" } : i));
	refused(await handoff(recipient.id, stale), "conflict");
	assert.equal(await held(), 104);

	// The first 100 move together; a lost reply replays the same answer without writing again.
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
	// The recipient loses eligibility after the preview: the rest refuses until a current owner is chosen.
	await f.admin.execute(sql`UPDATE person SET stage='prospect' WHERE id=${recipientPerson}`);
	refused(await handoff(recipient.id, items.slice(100)), "handoff_target_ineligible");
	await f.admin.execute(sql`UPDATE person SET stage='core_group' WHERE id=${recipientPerson}`);
	const rest = ok(await handoff(recipient.id, items.slice(100)));
	assert.deepEqual([rest.moved.length, rest.remaining, rest.remainingTotal], [2, [], 0]);
	// Closed work stays closed and keeps its former owner.
	assert.deepEqual(
		await rows(sql`SELECT status FROM task WHERE assignee_id=${leaving.id} AND plant_id=${c.w.id} ORDER BY status`),
		[{ status: "complete" }, { status: "no_longer_needed" }],
	);

	// A departed account: its seat ended with two open follow-ups. They read as Needs owner and still name it as the
	// former owner, so the Follow-ups page can start its handoff (REQ-TSK-013); the handoff moves them all.
	const departed = await c.seated("member");
	await committed(c, departed);
	await f.admin
		.execute(sql`INSERT INTO task(id,plant_id,title,category,priority,status,created_at,due_kind,person_id,assignee_id)
		SELECT gen_random_uuid(),${c.w.id},'Visit Alex '||g,'follow_up','medium','not_started',now(),'undated',${alex},${departed.id}
		FROM generate_series(1,2) g`);
	await f.admin.execute(sql`UPDATE seat SET ended_at=now() WHERE account_id=${departed.id} AND plant_id=${c.w.id}`);
	const coverage = ok(await read(c.admin, "followUpCoverage", { personId: alex }));
	assert.deepEqual(
		coverage.formerOwners.map((o) => [o.accountId, o.open]),
		[[departed.id, 2]],
	);
	const waiting = ok(await read(c.admin, "listFollowUpOwners", { owner: "needs_owner", personId: alex })).items;
	assert.deepEqual(
		waiting.map((d) => [d.owner?.accountId, d.owner?.eligible, d.owner?.reason]),
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

	// Each page read is BEGIN, one query and COMMIT, with 104 tasks or two. The former owner's name and the "waiting for
	// a handoff" tally are part of the same duty statement, so coverage still costs one query.
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
	// The church's Settings: a warning after 7 days, an alert after 14.
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
			await f.db.transaction((tx) => peopleReader.getPipelineData(tx, new PeopleReadContext(c.member.actor), {})),
		);
		const cards = pipeline.groups.flatMap((g) => g.cards);
		return Object.fromEntries(
			Object.entries(people).map(([name, id]) => [name, cards.find((k) => k.person.id === id).inactivity.level]),
		);
	};
	assert.deepEqual(await levels(), { recent: "none", quiet: "warning", silent: "alert" });
	// A contact two days ago is activity; a withdrawn one is not.
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

/** An open follow-up the way an old demotion or an unlinked account leaves it: assigned straight in the table. */
async function assigned(c, personId, title, assigneeId) {
	const id = randomUUID();
	await f.admin
		.execute(sql`INSERT INTO task(id,plant_id,title,category,priority,status,created_at,due_kind,person_id,assignee_id,creator_id)
		VALUES(${id},${c.w.id},${title},'follow_up','medium','not_started',now(),'undated',${personId},${assigneeId},${c.owner.id})`);
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
	// The Follow-ups page, the person's Follow-ups, the Tasks list, the handoff preview and coverage all read one view.
	const owners = ok(await read(c.member, "listFollowUpOwners", { personId: pia })).items;
	const coverage = ok(await read(c.admin, "followUpCoverage", { personId: pia })).items[0].duties;
	const list = ok(await f.db.transaction((tx) => taskReader.list(tx, c.admin.actor, {}))).items;
	for (const [account, [ok_, reason]] of Object.entries(expected)) {
		const id = taskOf[account];
		const views = [
			owners.find((d) => d.taskId === id).owner,
			coverage.find((d) => d.taskId === id).owner,
			list.find((t) => t.id === id).followUpOwner,
		];
		assert.deepEqual(
			views.map(shape),
			views.map(() => [account, ok_, reason]),
		);
		assert.deepEqual(new Set(views.map((v) => v.displayName)).size, 1);
	}
	// An ineligible assignee still counts as Needs owner everywhere (REQ-TSK-012) and stays a handoff source.
	assert.equal(ok(await read(c.member, "listFollowUpOwners", { personId: pia, owner: "needs_owner" })).matched, 3);
	assert.deepEqual(
		ok(await read(c.admin, "followUpCoverage", { personId: pia })).items.map((r) => [r.coverage]),
		[["needs_owner"]],
	);
	const plan = ok(await read(c.admin, "planHandoff", { fromAccountId: unlinked.id }));
	assert.deepEqual(
		plan.duties.map((d) => shape(d.owner)),
		[[unlinked.id, false, "no_person"]],
	);
	// A Member sees no assignment controls but the same view.
	assert.equal(list.find((t) => t.id === taskOf[eligible.id]).followUpOwner.eligible, true);
});

test("AC:TARGET-TSK-012 task assignment, create and edit refuse a follow-up owner who cannot own one", async () => {
	const c = await church();
	const quinn = await person(c, "Quinn Reed");
	const unlinked = await c.seated("member");
	const ready = await c.seated("member");
	await committed(c, ready);
	const task = await assigned(c, quinn, "Visit Quinn", null);
	const [row] = await rows(sql`SELECT revision::text AS r FROM task WHERE id=${task}`);
	// Task edit on a follow-up with a Person: only an eligible owner.
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
	// A general task keeps the seated rule, and an eligible owner is accepted on the follow-up.
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
	assert.deepEqual([edited.assignee.accountId, edited.followUpOwner.eligible], [ready.id, true]);
	// The picker's list: purpose committed_follow_up offers only eligible owners.
	const names = (r) => ok(r).items.map((i) => i.accountId);
	const all = names(await f.db.transaction((tx) => taskReader.eligibleAssignees(tx, c.owner.actor, {})));
	const eligibleOnly = names(
		await f.db.transaction((tx) => taskReader.eligibleAssignees(tx, c.owner.actor, { purpose: "committed_follow_up" })),
	);
	assert.ok(all.includes(unlinked.id) && all.includes(ready.id));
	assert.deepEqual(eligibleOnly, [ready.id]);
});

test("AC:TARGET-MTG-022 AC:TARGET-MTG-021 one follow-up state: a done follow-up takes no outcome; one contact finishes the Person's other follow-ups", async () => {
	const c = await church();
	const rae = await person(c, "Rae Kim");
	const origin = { at: "2026-09-10T15:00:00Z", date: "2026-09-10", zone: "America/Chicago" };
	// Record then complete, and complete then record.
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
	// Record after the task is done: refused, nothing written.
	const before = (await rows(sql`SELECT count(*)::int AS n FROM contact_outcome WHERE person_id=${rae}`))[0].n;
	refused(
		await record(c.owner, onTask(done), "contacted", { occurredAt: "2026-09-11T15:00:00Z", completeTask: true }),
		"conflict",
	);
	refused(await record(c.owner, onTask(done), "no_longer_needed"), "conflict");
	assert.equal((await rows(sql`SELECT count(*)::int AS n FROM contact_outcome WHERE person_id=${rae}`))[0].n, before);
	// A Person-level contact stays possible for an Owner or Admin.
	ok(await record(c.owner, { kind: "person", personId: rae }, "contacted", { occurredAt: "2026-09-11T15:00:00Z" }));

	// One contact finishes both of a Person's open follow-ups, with one log entry that names both.
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
	// The log shows one entry that names the other follow-up, and each task panel read finds it.
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
	// The Vision duty is measured by that same contact; the manual follow-up has no meeting duty.
	const duty = ok(await read(c.owner, "readObligations", { personId: sol, asOf: "2026-09-20T00:00:00Z" })).items[0];
	assert.deepEqual(
		[duty.state, duty.completion.outcomeId === finished.record.id, duty.contacted, duty.measurement.success],
		["complete", true, true, true],
	);
	// Nothing open is left on the Person's Follow-ups.
	assert.equal(ok(await read(c.owner, "listFollowUpOwners", { personId: sol })).items.length, 0);
	// The contact shows in the Person's activity with how it happened and its note.
	const activity = ok(
		await f.db.transaction((tx) =>
			peopleReader.getActivities(tx, new PeopleReadContext(c.owner.actor), { personId: sol, kinds: ["follow_up"] }),
		),
	);
	assert.deepEqual(
		activity.items.map((i) => [i.outcome, i.channel, i.notes]),
		[["contacted", "phone", "Left a voicemail and texted."]],
	);
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
	// The follow-up they could not finish shows the contact: when and by whom.
	const left = ok(await read(me, "listFollowUpOwners", { personId: tia })).items;
	const [recorder] = await rows(sql`SELECT display_name FROM seat_identity(${me.id}::uuid)`);
	assert.deepEqual(
		left.map((d) => [d.taskId === theirs, d.contacted?.by ?? "none"]),
		[[true, recorder.display_name]],
	);
	// A correction keeps who the contact also finished.
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
