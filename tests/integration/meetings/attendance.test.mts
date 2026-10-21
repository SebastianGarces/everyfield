import test, { after, before } from "node:test";
import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { sql } from "../../../packages/db/src/query.ts";
import { fixture } from "../identity/invitations-support.mts";
import {
	attendanceReader as reads,
	createAttendanceWriter,
	meetingsReader,
	withMeetingsWrite,
} from "../../../packages/domain/src/meetings/index.ts";
import { authorizeTaskReminders, reminderRecipients } from "../../../packages/domain/src/tasks/index.ts";
import { peopleWriter } from "../../../packages/domain/src/people/index.ts";
import { createMailService } from "../../../apps/web/src/server/jobs/mail.ts";
import { createNotificationService } from "../../../apps/web/src/server/jobs/notifications.ts";
import { taskReminders } from "../../../apps/web/src/server/tasks/reminders.ts";

// WP-022: attendance, finalization and its generated work, the Vision evaluation, reports and attendee notes, through
// the native write boundary (withMeetingsWrite) and the request's verified viewer, on an isolated schema.

let f, writer, plant, other, owner, member, foreign;
const ok = (r) => {
	assert.equal(r.status, "ok", JSON.stringify(r));
	return r.value;
};
const refused = (r, code) => {
	assert.equal(r.status, "refused", JSON.stringify(r));
	assert.equal(r.error.code, code, JSON.stringify(r.error));
	return r.error;
};
const write = (who, op, input) => withMeetingsWrite(f.db, who.actor, (tx, ctx) => writer[op](tx, ctx, input));
const read = (who, op, input) => reads[op](f.db, who.actor, input);
const rows = async (q) => (await f.admin.execute(q)).rows;
const one = async (q) => (await rows(q))[0];
const key = () => randomUUID();

async function person(name, stage = "prospect", w = plant) {
	const id = randomUUID();
	await f.admin.execute(sql`INSERT INTO person(id,tenant_id,plant_id,display_name,source,stage,adult_classification,
		commitment_state,pipeline_position,state,created_at) VALUES(${id},${w.id},${w.id},${name},'other',${stage},'unknown',
		'unknown',0,'live',clock_timestamp())`);
	return id;
}
/** An untitled meeting held at `at` (UTC), in Chicago: screens show its type, as for most Vision meetings. */
async function meeting(type = "vision_meeting", at = "2026-10-01T23:00:00Z", w = plant) {
	const id = randomUUID();
	const date = new Date(new Date(at).getTime() - 5 * 3600_000).toISOString().slice(0, 10);
	await f.admin.execute(sql`INSERT INTO meeting(id,plant_id,type,title,local_date,local_time,timezone,starts_at,
		resolver_version,status,attendance_revision) VALUES(${id},${w.id},${type},NULL,${date},'18:00',
		'America/Chicago',${at},'1','in_progress',1)`);
	return id;
}
const revision = async (meetingId) =>
	(await one(sql`SELECT attendance_revision::text AS r FROM meeting WHERE id=${meetingId}`)).r;
const finalizeRequest = async (meetingId, attendeeIds, extra = {}, requestKey = key()) => ({
	requestKey,
	expectedRevision: await revision(meetingId),
	input: { meetingId, attendeeIds, ...extra },
});
const finalize = async (who, meetingId, attendeeIds, extra = {}, requestKey = key()) =>
	write(who, "finalizeAttendance", await finalizeRequest(meetingId, attendeeIds, extra, requestKey));
const reconcile = async (who, meetingId, attendeeIds) =>
	write(who, "reconcileAttendance", {
		requestKey: key(),
		expectedRevision: await revision(meetingId),
		input: { meetingId, attendeeIds, reason: "Sign-in sheet checked" },
	});
const work = (meetingId) =>
	rows(sql`SELECT b.kind, b.person_id, b.waiver_reason AS waiver, t.status, t.assignee_id
		FROM obligation b LEFT JOIN task t ON t.obligation_id=b.id WHERE b.meeting_id=${meetingId} ORDER BY b.kind, b.person_id`);
const stageOf = async (id) => (await one(sql`SELECT stage FROM person WHERE id=${id}`)).stage;
const classOf = async (meetingId, personId) =>
	one(
		sql`SELECT presence, classification, prior_vision_id FROM participation WHERE meeting_id=${meetingId} AND person_id=${personId}`,
	);

before(async () => {
	f = await fixture();
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
	writer = createAttendanceWriter({ reminders: taskReminders(notifications) });
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
	foreign = await seated(other, "owner");
});
after(() => f?.close());

test("AC:TARGET-MTG-010 AC:B02-010 AC:PERSONREF-MEETING-INVITATION-RSVP-ATTENDANCE-CARD-RETIRE draft attendance is all or nothing and keeps RSVP and card", async () => {
	const m = await meeting();
	const [alex, casey, retired] = [await person("Alex"), await person("Casey"), await person("Retired")];
	await f.admin.execute(sql`UPDATE person SET state='retired' WHERE id=${retired}`);
	const batch = (entries, who = owner) =>
		write(who, "captureAttendanceBatch", { requestKey: key(), input: { meetingId: m, entries } });

	// An unknown Person in the middle of a batch refuses the whole batch and names it.
	const unknown = randomUUID();
	const refusal = refused(
		await batch([
			{ personId: alex, presence: "attended" },
			{ personId: unknown, presence: "attended" },
			{ personId: retired, presence: "attended" },
		]),
		"invalid_subject",
	);
	assert.deepEqual(refusal.details.personIds.sort(), [unknown, retired].sort());
	assert.equal((await one(sql`SELECT count(*)::int n FROM participation WHERE meeting_id=${m}`)).n, 0);

	// Walk-ins join attended; a guest row's RSVP and card survive a presence clear.
	const saved = ok(
		await batch([
			{ personId: alex, presence: "attended" },
			{ personId: casey, presence: "attended" },
		]),
	);
	assert.deepEqual(
		saved.attendees.map((a) => a.presence),
		["attended", "attended"],
	);
	await f.admin.execute(sql`UPDATE participation SET rsvp='confirmed', card_response='interested',
		card_recorded_at=clock_timestamp() WHERE meeting_id=${m} AND person_id=${casey}`);
	ok(await write(owner, "clearAttendance", { requestKey: key(), input: { meetingId: m, personId: casey } }));
	assert.deepEqual(await one(sql`SELECT presence, rsvp, card_response FROM participation WHERE person_id=${casey}`), {
		presence: "absent",
		rsvp: "confirmed",
		card_response: "interested",
	});
	// Setting the same presence again changes nothing; a Person who is not a guest refuses instead of a false success.
	const again = ok(
		await write(owner, "setAttendance", {
			requestKey: key(),
			input: { meetingId: m, personId: alex, presence: "attended" },
		}),
	);
	assert.equal(again.outcome, "noop");
	refused(
		await write(owner, "setAttendance", {
			requestKey: key(),
			input: { meetingId: m, personId: await person("Stranger"), presence: "excused" },
		}),
		"unavailable",
	);
	// Members and other churches record nothing; a member who leads no team has no attendance authority.
	refused(
		await write(member, "checkIn", { requestKey: key(), input: { meetingId: m, personId: casey } }),
		"unavailable",
	);
	refused(
		await write(foreign, "checkIn", { requestKey: key(), input: { meetingId: m, personId: casey } }),
		"unavailable",
	);
	const checked = ok(await write(owner, "checkIn", { requestKey: key(), input: { meetingId: m, personId: casey } }));
	assert.equal(checked.attendees[0].presence, "attended");
	const summary = ok(await read(owner, "attendanceSummary", { meetingId: m }));
	assert.equal(summary.attended, 2);
	assert.equal(summary.finalized, null);

	// Finalizing a practice records attendance only: the practice is not completed by it (REQ-KNOW-043).
	const practice = await meeting("prelaunch_practice", "2026-10-02T23:00:00Z");
	ok(await finalize(owner, practice, [alex]));
	const held = ok(await meetingsReader.listCompletedPreLaunchPractices(f.db, owner.actor));
	assert.equal(held.count, 0);
	assert.equal((await one(sql`SELECT status FROM meeting WHERE id=${practice}`)).status, "in_progress");
	// After finalization, draft edits refuse; only reconcile changes it.
	refused(
		await write(owner, "setAttendance", {
			requestKey: key(),
			input: { meetingId: practice, personId: alex, presence: "absent" },
		}),
		"status_transition",
	);
	// A retired Person cannot be finalized as a new attendee.
	refused(await finalize(owner, m, [alex, casey, retired]), "invalid_subject");
});

test("AC:TARGET-MTG-020 AC:TARGET-MTG-012 AC:TARGET-TSK-017 AC:GAP-PPL-020 AC:CASE-OPS-004 finalize commits attendance, progression and generated work together", async () => {
	const v = await meeting("vision_meeting", "2026-10-08T23:00:00Z");
	const alex = await person("Alex"),
		casey = await person("Casey", "leader");
	// A finalized orientation the week before does not count as a prior Vision.
	const orientation = await meeting("orientation", "2026-09-30T23:00:00Z");
	ok(await finalize(owner, orientation, [alex]));
	assert.equal(await stageOf(alex), "prospect");

	// A failing audit insert rolls back every part: no attendance, stage, obligation or task.
	await f.admin.execute(
		sql.raw(`CREATE FUNCTION fail_finalize() RETURNS trigger LANGUAGE plpgsql AS
		$$BEGIN RAISE EXCEPTION 'attendance_audit_insert'; END$$`),
	);
	await f.admin.execute(
		sql.raw(`CREATE TRIGGER fail_finalize BEFORE INSERT ON audit_event FOR EACH ROW
		WHEN (NEW.action = 'meetings.finalized' AND NEW.subject_id = '${v}') EXECUTE FUNCTION fail_finalize()`),
	);
	refused(await finalize(owner, v, [alex, casey]), "required_write_failed");
	await f.admin.execute(sql.raw(`DROP TRIGGER fail_finalize ON audit_event; DROP FUNCTION fail_finalize()`));
	assert.deepEqual(await work(v), []);
	assert.equal(await stageOf(alex), "prospect");
	assert.equal((await one(sql`SELECT count(*)::int n FROM participation WHERE meeting_id=${v}`)).n, 0);

	// Two concurrent finalizes with different request keys produce one finalization; the second sees the first.
	const request = await finalizeRequest(v, [alex, casey]);
	const [a, b] = await Promise.all([write(owner, "finalizeAttendance", request), finalize(owner, v, [alex, casey])]);
	const outcomes = [ok(a).outcome, ok(b).outcome].sort();
	assert.deepEqual(outcomes, ["changed", "noop"]);
	const first = ok(a).outcome === "changed" ? ok(a) : ok(b);
	assert.deepEqual(
		first.classifications.map((c) => [c.personId === alex ? "alex" : "casey", c.classification, c.firstVision]).sort(),
		[
			["alex", "first_time", true],
			["casey", "core_group", true],
		],
	);
	assert.deepEqual(first.stageChanges, [{ personId: alex, from: "prospect", to: "attendee" }]);
	// The saved rows carry the same snapshot as the reply, also for People who had no guest row before.
	assert.deepEqual(
		await rows(sql`SELECT person_id, classification, classification_stage, prior_vision_id,
			actual_occurrence_at IS NOT NULL AS held FROM participation WHERE meeting_id=${v} ORDER BY classification`),
		[
			{
				person_id: casey,
				classification: "core_group",
				classification_stage: "leader",
				prior_vision_id: null,
				held: true,
			},
			{
				person_id: alex,
				classification: "first_time",
				classification_stage: "prospect",
				prior_vision_id: null,
				held: true,
			},
		],
	);
	assert.equal(await stageOf(alex), "attendee");
	assert.equal(await stageOf(casey), "leader");
	// One follow-up each (a Leader's first Vision too) and one evaluation task, all Needs owner.
	assert.deepEqual(
		(await work(v)).map((w) => [w.kind, w.status, w.assignee_id]),
		[
			["evaluation", "not_started", null],
			["follow_up", "not_started", null],
			["follow_up", "not_started", null],
		],
	);
	assert.ok(first.work.every((w) => w.needsOwner));
	assert.equal(
		(
			await one(
				sql`SELECT t.title FROM task t JOIN obligation b ON b.id=t.obligation_id WHERE b.meeting_id=${v} AND b.kind='evaluation'`,
			)
		).title,
		"Evaluate Vision Meeting",
	);
	// A retry with the same key returns the first answer; one stage event, no new work.
	const replay = ok(await write(owner, "finalizeAttendance", request));
	assert.equal(replay.receiptId, ok(a).receiptId);
	assert.equal((await work(v)).length, 3);
	assert.equal(
		(await one(sql`SELECT count(*)::int n FROM audit_event WHERE subject_id=${alex} AND action='people.stage_changed'`))
			.n,
		1,
	);
	// Finalizing again with a different set refuses: changes go through reconcile.
	refused(await finalize(owner, v, [alex]), "status_transition");

	// A zero-attendee Vision still owes its evaluation; an assignee needs a current seat.
	const empty = await meeting("vision_meeting", "2026-10-09T23:00:00Z");
	refused(await finalize(owner, empty, [], { evaluationAssigneeId: foreign.id }), "invalid_subject");
	const none = ok(await finalize(owner, empty, [], { evaluationAssigneeId: owner.id }));
	assert.deepEqual(
		none.work.map((w) => [w.kind, w.needsOwner]),
		[["meeting_evaluation", false]],
	);

	// Same-count replacement: Casey's open follow-up closes as no longer needed, Jamie gets one; nothing is deleted.
	const jamie = await person("Jamie");
	const followUp = (id) =>
		one(sql`SELECT t.id, t.revision::text AS revision FROM task t JOIN obligation b ON b.id=t.obligation_id
			WHERE b.meeting_id=${v} AND b.person_id=${id}`);
	// Alex's follow-up was performed: it stays complete when Alex is later removed.
	await f.admin.execute(sql`UPDATE task SET status='complete', completed_at=clock_timestamp()
		WHERE id=${(await followUp(alex)).id}`);
	const swapped = ok(await reconcile(owner, v, [alex, jamie]));
	assert.deepEqual(swapped.added, [jamie]);
	assert.deepEqual(swapped.removed, [casey]);
	const after = await work(v);
	assert.deepEqual(
		after
			.filter((w) => w.kind === "follow_up")
			.map((w) => [w.person_id, w.status, w.waiver])
			.sort(),
		[
			[alex, "complete", null],
			[casey, "no_longer_needed", "Sign-in sheet checked"],
			[jamie, "not_started", null],
		].sort(),
	);
	assert.equal((await classOf(v, casey)).presence, "absent");
	// Removing everyone keeps performed work and the evaluation duty.
	ok(await reconcile(owner, v, []));
	assert.deepEqual(
		(await work(v)).map((w) => w.status).sort(),
		["complete", "no_longer_needed", "no_longer_needed", "not_started"].sort(),
	);
	// Re-adding Casey keeps the closed follow-up closed (REQ-TSK-017).
	ok(await reconcile(owner, v, [casey]));
	assert.equal(
		(await work(v))
			.filter((w) => w.person_id === casey)
			.map((w) => w.status)
			.join(),
		"no_longer_needed",
	);
	assert.equal(await stageOf(alex), "attendee");

	// A backdated earlier Vision: Jamie's later row turns returning and loses its open first-Vision follow-up.
	ok(await reconcile(owner, v, [casey, jamie]));
	const earlier = await meeting("vision_meeting", "2026-10-01T23:00:00Z");
	const backdated = ok(await finalize(owner, earlier, [jamie]));
	assert.deepEqual(backdated.classifications, [
		{ personId: jamie, classification: "first_time", firstVision: true, priorVisionId: null },
	]);
	assert.deepEqual(await classOf(v, jamie), {
		presence: "attended",
		classification: "returning",
		prior_vision_id: earlier,
	});
	assert.equal((await work(v)).find((w) => w.person_id === jamie).status, "no_longer_needed");
	assert.equal((await work(earlier)).filter((w) => w.kind === "follow_up").length, 1);
	const list = ok(await read(member, "listAttendance", { meetingId: v }));
	assert.equal(list.items.find((i) => i.person.personId === jamie).priorVisionId, earlier);

	// Removing Riley from an earlier Vision makes the later one Riley's first: it now owes Riley's follow-up.
	const riley = await person("Riley");
	const early = await meeting("vision_meeting", "2026-09-20T23:00:00Z"),
		later = await meeting("vision_meeting", "2026-09-27T23:00:00Z");
	ok(await finalize(owner, early, [riley]));
	ok(await finalize(owner, later, [riley]));
	assert.deepEqual(
		(await work(later)).filter((w) => w.kind === "follow_up"),
		[],
	);
	const corrected = ok(await reconcile(owner, early, []));
	assert.deepEqual(await classOf(later, riley), {
		presence: "attended",
		classification: "first_time",
		prior_vision_id: null,
	});
	assert.deepEqual(
		(await work(later)).filter((w) => w.kind === "follow_up").map((w) => [w.person_id, w.status, w.assignee_id]),
		[[riley, "not_started", null]],
	);
	assert.ok(corrected.work.some((w) => w.meetingId === later && w.personId === riley && w.outcome === "created"));
	// The earlier meeting's open follow-up closes as no longer needed; it is not deleted or completed.
	assert.equal((await work(early)).find((w) => w.person_id === riley).status, "no_longer_needed");

	// A correction names the real owner of an existing later duty: Sam's owned later follow-up, closed by a backdated
	// Vision, stays closed and owned when that Vision is reconciled away.
	const sam = await person("Sam");
	const samLater = await meeting("vision_meeting", "2026-09-13T23:00:00Z"),
		samEarly = await meeting("vision_meeting", "2026-09-06T23:00:00Z");
	ok(await finalize(owner, samLater, [sam], { followUpAssigneeId: member.id }));
	ok(await finalize(owner, samEarly, [sam]));
	const undone = ok(await reconcile(owner, samEarly, []));
	assert.deepEqual(
		undone.work.filter((w) => w.meetingId === samLater).map((w) => [w.personId, w.outcome, w.assigneeId, w.needsOwner]),
		[[sam, "existing", member.id, false]],
	);
	assert.deepEqual(
		(await work(samLater)).filter((w) => w.kind === "follow_up").map((w) => [w.status, w.assignee_id]),
		[["no_longer_needed", member.id]],
	);
});

test("AC:TARGET-MTG-014 AC:GAP-MTG-015 AC:TARGET-MTG-015 one evaluation, computed average, reviewed corrections", async () => {
	const v = await meeting("vision_meeting", "2026-10-10T23:00:00Z");
	const alex = await person("Alex");
	const scores = (n) => ({
		attendanceScore: n,
		locationScore: n,
		logisticsScore: n,
		agendaScore: n,
		vibeScore: n,
		messageScore: n,
		closeScore: n,
		nextStepsScore: n,
	});
	const record = (who, meetingId, input = {}) =>
		write(who, "recordEvaluation", { requestKey: key(), input: { meetingId, scores: scores(1), ...input } });
	refused(await record(owner, await meeting("orientation", "2026-10-10T23:00:00Z")), "wrong_meeting_type");
	refused(await record(owner, v), "status_transition");
	ok(await finalize(owner, v, [alex]));
	refused(await record(owner, v, { scores: { ...scores(1), attendanceScore: 6 } }), "invalid_input");

	// Two people submit at once: one evaluation, the second sees the first. A forged average is ignored.
	const [a, b] = await Promise.all([
		record(owner, v, { average: 5, notes: "Room was cold" }),
		record(owner, v, { scores: scores(5), notes: "Room was cold" }),
	]);
	const kept = [ok(a), ok(b)].find((r) => r.outcome === "changed");
	const seen = [ok(a), ok(b)].find((r) => r.outcome === "noop");
	assert.deepEqual(seen.evaluation, kept.evaluation);
	assert.equal(kept.taskCompleted, true);
	const evaluationTask = async () =>
		one(sql`SELECT t.status, (SELECT count(*)::int FROM audit_event a WHERE a.subject_id=t.id AND a.action='tasks.completed') AS completions
			FROM task t JOIN obligation b ON b.id=t.obligation_id WHERE b.meeting_id=${v} AND b.kind='evaluation'`);
	assert.deepEqual(await evaluationTask(), { status: "complete", completions: 1 });
	ok(
		await write(owner, "correctEvaluation", {
			requestKey: key(),
			expectedRevision: kept.evaluation.revision,
			input: { meetingId: v, changes: scores(3), reason: "Re-entered" },
		}),
	);

	// GAP-MTG-015: 3s everywhere, attendance corrected to 4: average 3.1, one correction, no task change.
	const shown = ok(await read(owner, "getEvaluation", { meetingId: v })).evaluation;
	const corrected = ok(
		await write(owner, "correctEvaluation", {
			requestKey: key(),
			expectedRevision: shown.revision,
			input: { meetingId: v, changes: { attendanceScore: 4 }, reason: "Correct entered rating" },
		}),
	);
	assert.equal(corrected.evaluation.scores.attendanceScore, 4);
	assert.equal(corrected.evaluation.average, 3.1);
	assert.equal(corrected.taskCompleted, false);
	assert.deepEqual(await evaluationTask(), { status: "complete", completions: 1 });
	// A stale tab's correction refuses and adds no history; another church cannot see it.
	const history = async () => ok(await read(owner, "evaluationHistory", { meetingId: v })).entries;
	const entries = (await history()).length;
	refused(
		await write(owner, "correctEvaluation", {
			requestKey: key(),
			expectedRevision: shown.revision,
			input: { meetingId: v, changes: { attendanceScore: 5 }, reason: "Second tab" },
		}),
		"conflict",
	);
	refused(
		await write(foreign, "correctEvaluation", {
			requestKey: key(),
			expectedRevision: corrected.evaluation.revision,
			input: { meetingId: v, changes: { attendanceScore: 5 }, reason: "Foreign" },
		}),
		"unavailable",
	);
	const last = (await history()).at(-1);
	assert.equal((await history()).length, entries);
	assert.deepEqual(
		[last.kind, last.before, last.after, last.average, last.reason],
		["corrected", { attendanceScore: 3 }, { attendanceScore: 4 }, { before: 3, after: 3.1 }, "Correct entered rating"],
	);
	assert.equal((await history())[0].actor.accountId, owner.id);
	// Members read the evaluation without its notes; an Owner sees who evaluated and the correction count.
	const memberView = ok(await read(member, "getEvaluation", { meetingId: v })).evaluation;
	assert.equal(memberView.notes, null);
	assert.deepEqual(memberView.corrections.count, 2);
	refused(await read(member, "evaluationHistory", { meetingId: v }), "unavailable");
	assert.equal(ok(await read(owner, "getEvaluation", { meetingId: v })).evaluation.notes, "Room was cold");
	// C13: an Admin demoted to Member after the viewer lookup no longer sees the notes.
	const a2 = await f.account();
	const seat = await f.seat(a2, plant, "admin");
	const admin2 = { ...a2, actor: await f.actor(a2.session) };
	assert.equal(ok(await read(admin2, "getEvaluation", { meetingId: v })).evaluation.notes, "Room was cold");
	await f.admin.execute(sql`UPDATE seat SET role='member' WHERE id=${seat}`);
	assert.equal(ok(await read(admin2, "getEvaluation", { meetingId: v })).evaluation.notes, null);
});

test("AC:TARGET-MTG-016 reports count attended Persons and never show unknown as zero", async () => {
	const w = await f.workspace();
	await f.admin.execute(sql`UPDATE plant SET timezone='America/Chicago' WHERE id=${w.id}`);
	const a = await f.account();
	const seat = await f.seat(a, w, "owner");
	const admin = { ...a, actor: await f.actor(a.session) };
	const [p1, p2, p3] = [
		await person("P1", "prospect", w),
		await person("P2", "prospect", w),
		await person("P3", "prospect", w),
	];
	const zero = await meeting("vision_meeting", "2026-09-01T23:00:00Z", w);
	const v = await meeting("vision_meeting", "2026-09-08T23:00:00Z", w);
	ok(await finalize(admin, zero, []));
	// An absent guest is not an attendee.
	ok(
		await write(admin, "captureAttendanceBatch", {
			requestKey: key(),
			input: { meetingId: v, entries: [{ personId: p3, presence: "attended" }] },
		}),
	);
	ok(
		await write(admin, "setAttendance", {
			requestKey: key(),
			input: { meetingId: v, personId: p3, presence: "absent" },
		}),
	);
	ok(await finalize(admin, v, [p1, p2]));
	const analytics = ok(await read(admin, "readAnalytics", { meetingId: v }));
	assert.deepEqual(analytics.attended, { status: "known", value: 2 });
	assert.deepEqual(analytics.growth, { status: "unavailable", difference: 2 });
	assert.deepEqual(analytics.evaluation.baseline, { status: "unknown" });
	assert.equal(analytics.tasks.followUps.total, 2);
	assert.deepEqual(ok(await read(admin, "readAnalytics", { meetingId: zero })).growth, { status: "unknown" });
	const unfinalized = await meeting("vision_meeting", "2026-09-15T23:00:00Z", w);
	assert.deepEqual(ok(await read(admin, "readAnalytics", { meetingId: unfinalized })).attended, { status: "unknown" });

	// Baseline: the 50 most recent earlier evaluations only; same instant and later ones never count.
	const evaluated = async (at, n) => {
		const id = await meeting("vision_meeting", at, w);
		await f.admin.execute(sql`UPDATE meeting SET evaluation_scores=${sql.param(Array(8).fill(n))}::int[],
			evaluated_on=local_date, evaluated_at=clock_timestamp(), evaluation_revision=1 WHERE id=${id}`);
		return id;
	};
	const early = await evaluated("2024-12-01T23:00:00Z", 2);
	for (let i = 0; i < 51; i++) await evaluated(new Date(Date.UTC(2025, 0, 2 + i, 23)).toISOString(), i === 0 ? 1 : 4);
	await evaluated("2025-03-23T23:00:00Z", 1);
	const latest = await evaluated("2025-03-23T23:00:00Z", 5);
	assert.deepEqual(ok(await read(admin, "compareEvaluation", { meetingId: early })).baseline, { status: "unknown" });
	const compared = ok(await read(admin, "compareEvaluation", { meetingId: latest }));
	// The 50 most recent of the 51 earlier meetings, all 4s (the oldest, a 1, falls outside), not the same-instant 1.
	assert.deepEqual(compared.baseline, { status: "known", value: 4, count: 50 });
	assert.deepEqual(compared.delta, { status: "known", value: 1 });

	const trend = ok(await read(admin, "attendanceTrend", { from: "2026-09-01", to: "2026-09-30" }));
	assert.deepEqual(
		trend.points.map((p) => [p.attended, p.growth.status]),
		[
			[0, "unknown"],
			[2, "unavailable"],
		],
	);
	const stats = ok(await read(admin, "summaryStats", { from: "2026-09-01", to: "2026-09-30" }));
	assert.deepEqual(
		[
			stats.held,
			stats.finalized,
			stats.attendances,
			stats.uniqueAttendees,
			stats.averageAttendance,
			stats.averageEvaluation,
		],
		[3, 2, 2, 2, { status: "known", value: 1 }, { status: "unknown" }],
	);
	assert.equal(
		ok(await read(admin, "evaluationTrend", { from: "2025-01-01", to: "2025-12-31", limit: 3 })).points.length,
		3,
	);

	// C13: a seat that ends after the viewer lookup reads nothing.
	await f.admin.execute(sql`UPDATE seat SET ended_at=clock_timestamp() WHERE id=${seat}`);
	refused(await read(admin, "summaryStats", {}), "unavailable");
	refused(await read(admin, "listAttendance", { meetingId: v }), "unavailable");
});

test("AC:GAP-MTG-017 AC:TARGET-MTG-017 an attendee note names its attended meeting and author", async () => {
	const v = await meeting("vision_meeting", "2026-10-11T23:00:00Z");
	const alex = await person("Alex"),
		casey = await person("Casey");
	ok(await finalize(owner, v, [alex]));
	const requestKey = key();
	const note = (who, input, k = requestKey) => write(who, "addAttendeeNote", { requestKey: k, input });
	const text = "  Called today; prefers evening interview  ";
	const first = ok(await note(owner, { meetingId: v, personId: alex, text }));
	assert.deepEqual(ok(await note(owner, { meetingId: v, personId: alex, text })), first);
	assert.deepEqual(
		[first.text, first.meetingType, first.authorId, first.meetingId],
		["Called today; prefers evening interview", "vision_meeting", owner.id, v],
	);
	assert.deepEqual(
		await rows(sql`SELECT n.body, n.author_id, g.meeting_id FROM person_note n JOIN participation g ON g.id=n.participation_id
			WHERE n.person_id=${alex}`),
		[{ body: "Called today; prefers evening interview", author_id: owner.id, meeting_id: v }],
	);
	// A Person who did not attend, another church and bad text write nothing.
	refused(await note(owner, { meetingId: v, personId: casey, text: "x" }, key()), "unavailable");
	refused(await note(foreign, { meetingId: v, personId: alex, text: "x" }, key()), "unavailable");
	refused(await note(member, { meetingId: v, personId: alex, text: "x" }, key()), "unavailable");
	refused(await note(owner, { meetingId: v, personId: alex, text: "   " }, key()), "invalid_input");
	refused(await note(owner, { meetingId: v, personId: alex, text: "x".repeat(5001) }, key()), "invalid_input");
	assert.equal((await one(sql`SELECT count(*)::int n FROM person_note`)).n, 1);
	// The generated follow-up and its task are the meeting's linked work.
	const progress = ok(await read(owner, "linkedTaskProgress", { meetingId: v }));
	assert.deepEqual(progress.followUps, { total: 1, open: 1, complete: 0, closed: 0, needsOwner: 1 });
});
