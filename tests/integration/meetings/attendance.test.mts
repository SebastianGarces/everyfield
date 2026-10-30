import test, { after, before } from "node:test";
import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { sql } from "../../../packages/db/src/query.ts";
import { fixture } from "../identity/invitations-support.mts";
import {
	attendanceReader as reads,
	createAttendanceWriter,
	guestsWriter,
	meetingsReader,
	previewMeetingsWrite,
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
const guestWrite = (who, op, input) =>
	withMeetingsWrite(f.db, who.actor, (tx, ctx) => guestsWriter[op](tx, ctx, input));
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

let statements = 0;
/** The text and parameters of every statement sent through the request pool, newest last (planning checks read it). */
const sent = [];
async function counted(body) {
	const start = statements;
	const value = await body();
	return { value, statements: statements - start };
}

before(async () => {
	f = await fixture();
	f.db.$client.on("connect", (client) => {
		const query = client.query;
		client.query = function (...args) {
			statements++;
			if (typeof args[0] === "object" && typeof args[0]?.text === "string") sent.push({ text: args[0].text, values: args[1] ?? [] });
			if (sent.length > 400) sent.shift();
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

/** An account that may own follow-ups: a seat and a committed Person linked to it (REQ-TSK-012). */
async function eligibleAccount() {
	const a = await f.account();
	await f.seat(a, plant, "member");
	await f.admin.execute(
		sql`UPDATE person SET linked_account_id=${a.id} WHERE id=${await person("Owner " + a.id.slice(0, 4), "core_group")}`,
	);
	return a;
}
after(() => f?.close());

// D69 (R3-6): finalize writes attendance, progression and generated work with set-based statements, so 500 attendees
// send exactly the statements one attendee does. The census holds that number to its budget in limits.json.
test("INV-statements: finalizing 500 attendees sends the same statements as finalizing one", async () => {
	const finalized = async (meetingId, attendeeIds) =>
		(await counted(async () => ok(await finalize(owner, meetingId, attendeeIds)))).statements;
	const many = await rows(sql`INSERT INTO person(tenant_id,plant_id,display_name,source,stage,adult_classification,
		commitment_state,pipeline_position,state,created_at) SELECT ${plant.id},${plant.id},'Guest '||n,'other','prospect',
		'unknown','unknown',0,'live',clock_timestamp() FROM generate_series(1,500) n RETURNING id`);
	const one = await finalized(await meeting("vision_meeting", "2026-09-10T23:00:00Z"), [await person("Solo")]);
	const fiveHundred = await finalized(
		await meeting("vision_meeting", "2026-09-17T23:00:00Z"),
		many.map((r) => r.id),
	);
	assert.ok(one > 0, "no statements counted");
	assert.equal(fiveHundred, one);
});

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
	// The attendance read says who may mark attendance, by the write's rule (C74, C79): an Owner yes, a Member who leads
	// no team no; the current leader of a team meeting's team yes, and that leader's write then succeeds.
	const may = async (who, meetingId) => ok(await read(who, "listAttendance", { meetingId })).viewerCanMarkAttendance;
	assert.equal(await may(owner, m), true);
	assert.equal(await may(member, m), false);
	const leader = await person("Lee");
	await f.admin.execute(sql`UPDATE person SET linked_account_id=${member.actor.actor.accountId} WHERE id=${leader}`);
	const team = randomUUID();
	await f.admin.execute(sql`INSERT INTO team(id,plant_id,name,state,sort_order,leader_person_id,leader_source)
		VALUES(${team},${plant.id},'Hosts','active',1,${leader},'explicit')`);
	// A team meeting needs its team in the same row, so the plain meeting becomes one in a single update.
	const teamMeeting = await meeting("orientation");
	await f.admin.execute(sql`UPDATE meeting SET type='team_meeting', team_id=${team} WHERE id=${teamMeeting}`);
	assert.equal(await may(member, teamMeeting), true);
	assert.equal(await may(member, m), false);
	ok(await write(member, "checkIn", { requestKey: key(), input: { meetingId: teamMeeting, personId: casey } }));
	await f.admin.execute(sql`UPDATE team SET archived_at=clock_timestamp() WHERE id=${team}`);
	assert.equal(await may(member, teamMeeting), false);

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

test("AC:TARGET-MTG-020 AC:TARGET-MTG-012 an Owner can finalize a Vision meeting that starts tomorrow, but not a cancelled one", async () => {
	const at = new Date(Date.now() + 24 * 3600_000).toISOString();
	const v = await meeting("vision_meeting", at);
	const alex = await person("Early Alex");
	const done = ok(await finalize(owner, v, [alex]));
	assert.equal(done.outcome, "changed");
	assert.equal(await stageOf(alex), "attendee");
	assert.deepEqual(
		(await work(v)).map((w) => w.kind),
		["evaluation", "follow_up"],
	);
	assert.equal(
		(await one(sql`SELECT count(*)::int n FROM audit_event WHERE subject_id=${v} AND action='meetings.finalized'`)).n,
		1,
	);
	// The actual occurrence time is the scheduled start.
	const held = await one(
		sql`SELECT actual_occurrence_at = ${at}::timestamptz AS same FROM participation WHERE meeting_id=${v} AND person_id=${alex}`,
	);
	assert.equal(held.same, true);
	// Reconcile also accepts the future meeting.
	ok(await reconcile(owner, v, [alex]));
	const cancelled = await meeting("vision_meeting", at);
	await f.admin.execute(sql`UPDATE meeting SET status='cancelled' WHERE id=${cancelled}`);
	refused(await finalize(owner, cancelled, [alex]), "status_transition");
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
	refused(await finalize(owner, empty, [], { evaluationAssigneeIds: [foreign.id] }), "invalid_subject");
	const none = ok(await finalize(owner, empty, [], { evaluationAssigneeIds: [owner.id] }));
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
	const samOwner = await eligibleAccount();
	ok(await finalize(owner, samLater, [sam], { followUpAssigneeIds: [samOwner.id] }));
	ok(await finalize(owner, samEarly, [sam]));
	const undone = ok(await reconcile(owner, samEarly, []));
	assert.deepEqual(
		undone.work.filter((w) => w.meetingId === samLater).map((w) => [w.personId, w.outcome, w.assigneeId, w.needsOwner]),
		[[sam, "existing", samOwner.id, false]],
	);
	// The answer names the closed later duty's owner view from the assignee, not null.
	assert.deepEqual(
		undone.work.filter((w) => w.meetingId === samLater).map((w) => w.owner?.accountId),
		[samOwner.id],
	);
	assert.deepEqual(
		(await work(samLater)).filter((w) => w.kind === "follow_up").map((w) => [w.status, w.assignee_id]),
		[["no_longer_needed", samOwner.id]],
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

// S2 batch 2 F06: the modal never sends `evaluatedOn`, so the server's own default date must always be accepted.
// Finalize has no date check, so a meeting dated after today in its timezone can be finalized and then evaluated.
test("BUG-S2-F06 AC:TARGET-MTG-014: the evaluation modal's payload saves for a finalized Vision meeting dated after today", async () => {
	const all = (n) => ({
		attendanceScore: n,
		locationScore: n,
		logisticsScore: n,
		agendaScore: n,
		vibeScore: n,
		messageScore: n,
		closeScore: n,
		nextStepsScore: n,
	});
	const record = (meetingId, input) =>
		write(owner, "recordEvaluation", { requestKey: key(), input: { meetingId, ...input } });
	const correct = async (meetingId, input) =>
		write(owner, "correctEvaluation", {
			requestKey: key(),
			expectedRevision: ok(await read(owner, "getEvaluation", { meetingId })).evaluation.revision,
			input: { meetingId, ...input },
		});
	const evaluated = async (at, input) => {
		const id = await meeting("vision_meeting", at);
		ok(await finalize(owner, id, [await person("Guest")]));
		return { id, result: await record(id, { scores: { ...all(4), agendaScore: 5 }, ...input }) };
	};

	// The reproduced case: dated far after today, no evaluatedOn, a note.
	const future = await evaluated("2099-01-01T23:00:00Z", { notes: "Optional really?" });
	assert.ok(future.result.status === "ok", JSON.stringify(future.result));
	const saved = ok(future.result);
	assert.equal(saved.outcome, "changed");
	assert.equal(saved.taskCompleted, true);
	assert.deepEqual(saved.evaluation.scores, { ...all(4), agendaScore: 5 });
	assert.equal(saved.evaluation.average, 4.1);
	assert.equal(saved.evaluation.notes, "Optional really?");
	assert.equal(
		saved.evaluation.evaluatedOn,
		(await one(sql`SELECT (clock_timestamp() AT TIME ZONE 'America/Chicago')::date::text AS d`)).d,
	);

	// A first evaluation with `notes: null` saves, and a whitespace-only note is refused on input.notes.
	const bare = await evaluated("2099-01-02T23:00:00Z", { notes: null });
	assert.equal(ok(bare.result).evaluation.notes, null);
	const blank = await meeting("vision_meeting", "2099-01-03T23:00:00Z");
	ok(await finalize(owner, blank, []));
	const refusedNote = refused(await record(blank, { scores: all(3), notes: "   " }), "invalid_input");
	assert.ok(
		refusedNote.details.issues.some((x) => x.path === "input.notes"),
		JSON.stringify(refusedNote),
	);

	// A correction with `changes: {}` and a changed note saves; one score change with a reason saves.
	const noteOnly = ok(await correct(future.id, { changes: {}, notes: "Room was warm", reason: "Fixed the note" }));
	assert.equal(noteOnly.outcome, "changed");
	assert.equal(noteOnly.evaluation.notes, "Room was warm");
	const oneScore = ok(await correct(future.id, { changes: { vibeScore: 2 }, reason: "Mis-keyed" }));
	assert.equal(oneScore.evaluation.scores.vibeScore, 2);

	// A missing or blank reason is refused on input.reason; an explicit date outside the window is refused.
	for (const reason of [undefined, "   "]) {
		const e = refused(await correct(future.id, { changes: { vibeScore: 3 }, reason }), "invalid_input");
		assert.ok(
			e.details.issues.some((x) => x.path === "input.reason"),
			JSON.stringify(e),
		);
	}
	const early = await meeting("vision_meeting", "2099-02-01T23:00:00Z");
	ok(await finalize(owner, early, []));
	for (const evaluatedOn of ["2099-01-31", "2099-03-01"]) {
		const e = refused(await record(early, { scores: all(3), evaluatedOn }), "invalid_input");
		assert.ok(
			e.details.issues.some((x) => x.path === "input.evaluatedOn"),
			JSON.stringify(e),
		);
	}
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

test("INV-attendance: guest list writes that change the attended set move its revision and wait for Correct attendance once finalized", async () => {
	const m = await meeting();
	const [alex, casey, dana] = [await person("Alex"), await person("Casey"), await person("Dana")];
	const guestRevision = async (personId) =>
		ok(await meetingsReader.listGuests(f.db, owner.actor, { meetingId: m })).guests.find(
			(g) => g.person.personId === personId,
		).revision;
	const remove = async (personId) =>
		guestWrite(owner, "removeGuest", {
			requestKey: key(),
			expectedRevision: await guestRevision(personId),
			input: { meetingId: m, personId },
		});
	const invite = (personId) =>
		guestWrite(owner, "inviteGuest", { requestKey: key(), input: { meetingId: m, personId } });
	const walkIn = (displayName) =>
		guestWrite(owner, "createWalkInContact", { requestKey: key(), input: { meetingId: m, displayName } });
	const contact = (displayName, attendance) =>
		guestWrite(owner, "createGuestContact", { requestKey: key(), input: { meetingId: m, displayName, attendance } });
	const attended = async () =>
		ok(await read(owner, "listAttendance", { meetingId: m }))
			.items.filter((a) => a.presence === "attended")
			.map((a) => a.person.displayName)
			.sort();
	ok(await invite(dana));
	for (const personId of [alex, casey])
		ok(await write(owner, "checkIn", { requestKey: key(), input: { meetingId: m, personId } }));

	// Before finalization: a walk-in and the removal of an attended guest each move the attendance revision, so a
	// finalize reviewed before them conflicts instead of settling a set nobody reviewed.
	const reviewed = await finalizeRequest(m, [alex, casey]);
	const door = ok(await walkIn("Door")).guest.person.personId;
	refused(await write(owner, "finalizeAttendance", reviewed), "conflict");
	const beforeRemoval = await finalizeRequest(m, [alex, casey, door]);
	ok(await remove(casey));
	refused(await write(owner, "finalizeAttendance", beforeRemoval), "conflict");
	ok(await finalize(owner, m, [alex, door]));
	const finalized = await revision(m);

	// After finalization, each guest write that would change who attended refuses; only the reconcile changes the set.
	refused(await remove(alex), "status_transition");
	refused(await walkIn("Late"), "status_transition");
	refused(await contact("Late", "attended"), "status_transition");
	// Casey was removed while attended: restoring them would put an attendee back without classification.
	refused(await invite(casey), "status_transition");
	assert.deepEqual(await attended(), ["Alex", "Door"]);
	assert.equal(await revision(m), finalized);
	// Writes that leave the attended set alone still work after finalization.
	ok(await remove(dana));
	ok(await invite(dana));
	ok(await contact("Later guest", "not_recorded"));
	assert.equal(await revision(m), finalized);
	ok(await reconcile(owner, m, [alex]));
	assert.deepEqual(await attended(), ["Alex"]);
});

test("INV-statements: a finalize preview runs the command once and saves nothing", async () => {
	const m = await meeting();
	const [alex, casey] = [await person("Alex"), await person("Casey")];
	const request = await finalizeRequest(m, [alex, casey]);
	const preview = await counted(() =>
		previewMeetingsWrite(f.db, owner.actor, (tx, ctx) => writer.finalizeAttendance(tx, ctx, request)),
	);
	assert.deepEqual(
		ok(preview.value)
			.classifications.map((c) => [c.personId, c.classification])
			.sort(),
		[
			[alex, "first_time"],
			[casey, "first_time"],
		].sort(),
	);
	assert.equal((await one(sql`SELECT finalized_at FROM meeting WHERE id=${m}`)).finalized_at, null);
	assert.deepEqual(await work(m), []);
	assert.equal(await revision(m), request.expectedRevision);
	// One run: BEGIN, the write gate, the request-key read, the locked fact read, the write statement and ROLLBACK.
	assert.equal(preview.statements, 6);
	// The real finalize then does exactly what the preview showed.
	assert.deepEqual(
		ok(await write(owner, "finalizeAttendance", request)).classifications,
		ok(preview.value).classifications,
	);
});

test("AC:TARGET-TSK-012 finalize and Correct attendance refuse a follow-up owner who cannot own one; the result names the owner the same way", async () => {
	const unlinked = await f.account();
	await f.seat(unlinked, plant, "member");
	const member = await eligibleAccount();
	const ivy = await person("Ivy"),
		jo = await person("Jo");
	const v = await meeting("vision_meeting", "2026-10-12T23:00:00Z");
	refused(await finalize(owner, v, [ivy], { followUpAssigneeIds: [unlinked.id] }), "owner_ineligible");
	const done = ok(await finalize(owner, v, [ivy], { followUpAssigneeIds: [member.id] }));
	const followUp = done.work.find((w) => w.kind === "first_vision_follow_up");
	assert.deepEqual(
		[followUp.owner.accountId, followUp.owner.eligible, followUp.owner.reason, typeof followUp.owner.displayName],
		[member.id, true, null, "string"],
	);
	const request = (extra) => async () => ({
		requestKey: key(),
		expectedRevision: await revision(v),
		input: { meetingId: v, attendeeIds: [ivy, jo], reason: "Sign-in sheet checked", ...extra },
	});
	refused(
		await write(owner, "reconcileAttendance", await request({ followUpAssigneeIds: [unlinked.id] })()),
		"owner_ineligible",
	);
	const corrected = ok(await write(owner, "reconcileAttendance", await request({ followUpAssigneeIds: [member.id] })()));
	const added = corrected.work.find((w) => w.personId === jo && w.outcome === "created");
	assert.deepEqual([added.owner.accountId, added.owner.eligible], [member.id, true]);
	// An ineligible assignee already on an existing duty reads with the reason, not as a different person.
	await f.admin.execute(sql`UPDATE task SET assignee_id=${unlinked.id} WHERE obligation_id=${followUp.obligationId}`);
	const again = ok(await write(owner, "reconcileAttendance", await request({ followUpAssigneeIds: [member.id] })()));
	const kept = again.work.find((w) => w.obligationId === followUp.obligationId);
	assert.deepEqual([kept.owner.accountId, kept.owner.eligible, kept.owner.reason], [unlinked.id, false, "no_person"]);
	// The evaluation owner keeps the seated rule: a seat is enough.
	const empty = await meeting("vision_meeting", "2026-10-13T23:00:00Z");
	const evaluation = ok(await finalize(owner, empty, [], { evaluationAssigneeIds: [unlinked.id] })).work[0];
	assert.deepEqual([evaluation.owner.accountId, evaluation.owner.eligible], [unlinked.id, true]);
});

// WP-022/api F11: the Correct attendance save is one bulk write. A reconcile sends the same statements for any size,
// and each statement is cheap to plan: the locked fact read once cost 1.7 s of JIT because the task columns' planned
// cost reached millions (seat_identity's default of 1000 rows, multiplied by a lateral join).
let crowdNumber = 0;
/**
 * A finalized Vision meeting of `size` attended People (every tenth in the core group, the rest prospects), an earlier
 * Vision that every fifth of them (index 1, 6, 11, ...) attended, and one prospect who is not a guest. Returns the
 * People by index, the meeting and what a reconcile would add (`extra`) and remove (`leaver`, a prospect with a
 * first-Vision follow-up).
 */
async function crowd(size) {
	const day = ++crowdNumber;
	const made = await rows(sql`INSERT INTO person(tenant_id,plant_id,display_name,source,stage,adult_classification,
		commitment_state,pipeline_position,state,created_at) SELECT ${plant.id},${plant.id},'Crowd ${sql.raw(String(day))} Person '||n,
		'other',CASE WHEN n % 10 = 0 THEN 'core_group' ELSE 'prospect' END,'unknown','unknown',0,'live',clock_timestamp()
		FROM generate_series(0,${size - 1}) n RETURNING id, display_name`);
	const ids = made.sort((a, b) => Number(a.display_name.split(" ").pop()) - Number(b.display_name.split(" ").pop())).map((r) => r.id);
	const extra = await person(`Crowd ${day} Extra`);
	const leaver = ids[2];
	const at = (days) => new Date(Date.UTC(2026, 0, 1) + (day * 10 + days) * 86400_000 + 23 * 3600_000).toISOString();
	const earlier = await meeting("vision_meeting", at(0));
	ok(await finalize(owner, earlier, ids.filter((_, i) => i % 5 === 1)));
	const v = await meeting("vision_meeting", at(5));
	const first = ok(await finalize(owner, v, ids));
	return { ids, extra, leaver, earlier, v, first };
}
const swap = async (c, extra = [c.extra], gone = [c.leaver]) => ({
	requestKey: key(),
	expectedRevision: await revision(c.v),
	input: {
		meetingId: c.v,
		attendeeIds: [...c.ids.filter((id) => !gone.includes(id)), ...extra],
		followUpAssigneeIds: [],
		reason: "Sign-in sheet checked",
	},
});

test("INV-statements: a reconcile that adds, removes, advances and closes sends the same statements at 3 and 50 attendees", async () => {
	const statementsFor = async (size) => {
		const c = await crowd(size);
		const request = await swap(c);
		const done = await counted(async () => ok(await write(owner, "reconcileAttendance", request)));
		assert.deepEqual(done.value.added, [c.extra]);
		assert.deepEqual(done.value.removed, [c.leaver]);
		assert.deepEqual(done.value.stageChanges, [{ personId: c.extra, from: "prospect", to: "attendee" }]);
		assert.ok(done.value.work.some((w) => w.outcome === "created" && w.personId === c.extra));
		assert.ok(done.value.work.some((w) => w.outcome === "closed" && w.personId === c.leaver));
		return done.statements;
	};
	const three = await statementsFor(3);
	const fifty = await statementsFor(50);
	assert.ok(three > 0, "no statements counted");
	assert.equal(fifty, three);
});

test("AC:TARGET-MTG-020 AC:TARGET-MTG-012 a 50-attendee reconcile returns the exact result and writes the exact audit rows", async () => {
	const c = await crowd(50);
	const duty = await rows(sql`SELECT b.id AS obligation_id, b.person_id, b.kind, t.id AS task_id, t.assignee_id
		FROM obligation b JOIN task t ON t.obligation_id=b.id WHERE b.meeting_id=${c.v}`);
	const dutyOf = (personId) => duty.find((d) => d.person_id === personId);
	const evaluation = duty.find((d) => d.kind === "evaluation");
	assert.equal(duty.length, 50 - 10 + 1, "a follow-up for each attendee without an earlier Vision, and the evaluation");
	const seen = new Set((await rows(sql`SELECT id FROM audit_event WHERE tenant_id=${plant.id}`)).map((r) => r.id));
	const finalizedAt = new Date((await one(sql`SELECT finalized_at FROM meeting WHERE id=${c.v}`)).finalized_at).toISOString();
	const request = await swap(c);
	const result = ok(await write(owner, "reconcileAttendance", request));

	const attendeeIds = request.input.attendeeIds;
	const priorOf = (id) => (c.ids.indexOf(id) % 5 === 1 ? c.earlier : null);
	const stageOfIndex = (id) => (c.ids.indexOf(id) % 10 === 0 ? "core_group" : "prospect");
	const created = result.work.find((w) => w.outcome === "created");
	assert.ok(created, "the added prospect owes a follow-up");
	const expectedWork = [
		...attendeeIds
			.filter((id) => !priorOf(id))
			.map((id) =>
				id === c.extra
					? { meetingId: c.v, kind: "first_vision_follow_up", personId: id, obligationId: created.obligationId, taskId: created.taskId, outcome: "created", assigneeIds: [], needsOwner: true, owner: null }
					: { meetingId: c.v, kind: "first_vision_follow_up", personId: id, obligationId: dutyOf(id).obligation_id, taskId: dutyOf(id).task_id, outcome: "existing", assigneeIds: [], needsOwner: true, owner: null },
			),
		{ meetingId: c.v, kind: "meeting_evaluation", personId: null, obligationId: evaluation.obligation_id, taskId: evaluation.task_id, outcome: "existing", assigneeIds: [], needsOwner: true, owner: null },
		{ meetingId: c.v, kind: "first_vision_follow_up", personId: c.leaver, obligationId: dutyOf(c.leaver).obligation_id, taskId: dutyOf(c.leaver).task_id, outcome: "closed", assigneeIds: [], needsOwner: false, owner: null },
	];
	assert.deepEqual(
		{ ...result, receiptId: undefined },
		{
			receiptId: undefined,
			outcome: "changed",
			meetingId: c.v,
			attendanceRevision: String(BigInt(request.expectedRevision) + 1n),
			finalizedAt,
			attendeeIds,
			added: [c.extra],
			removed: [c.leaver],
			classifications: attendeeIds.map((id) => {
				const prior = id === c.extra ? null : priorOf(id);
				return {
					personId: id,
					classification: id !== c.extra && stageOfIndex(id) === "core_group" ? "core_group" : prior ? "returning" : "first_time",
					firstVision: prior === null,
					priorVisionId: prior,
				};
			}),
			stageChanges: [{ personId: c.extra, from: "prospect", to: "attendee" }],
			work: expectedWork,
		},
	);

	// The audit rows of this one command: the reconcile, the one advance and one row for each created or closed task.
	const written = (await rows(sql`SELECT id, subject_type, subject_id, action, kind, before_value, after_value,
		before_revision, after_revision, reason, metadata FROM audit_event WHERE tenant_id=${plant.id}`)).filter(
		(r) => !seen.has(r.id),
	);
	const byAction = (action) => written.filter((r) => r.action === action);
	const current = c.ids.slice().sort();
	assert.deepEqual(
		byAction("meetings.finalized").map(({ id, ...r }) => r),
		[
			{
				subject_type: "meeting",
				subject_id: c.v,
				action: "meetings.finalized",
				kind: "reconcile",
				before_value: { attendeeIds: current },
				after_value: { attendeeIds: attendeeIds.slice().sort() },
				before_revision: null,
				after_revision: null,
				reason: "Sign-in sheet checked",
				metadata: { meetingId: c.v, event: "attendance_reconciled" },
			},
		],
	);
	assert.equal(byAction("meetings.finalized")[0].id, result.receiptId);
	assert.deepEqual(
		byAction("people.stage_changed").map(({ id, ...r }) => r),
		[
			{
				subject_type: "person",
				subject_id: c.extra,
				action: "people.stage_changed",
				kind: "stage_change",
				before_value: { stage: "prospect" },
				after_value: { stage: "attendee" },
				before_revision: "1",
				after_revision: "2",
				reason: null,
				metadata: { cause: "first_actual_vision_attendance", meetingId: c.v },
			},
		],
	);
	// A created follow-up writes tasks.changed (create); a closed one writes tasks.waived (waive), as on main.
	assert.deepEqual(
		byAction("tasks.changed").map((r) => [r.subject_id, r.kind, r.subject_type, r.metadata.source]),
		[[created.taskId, "create", "task", "generated"]],
	);
	assert.deepEqual(
		byAction("tasks.waived").map((r) => [r.subject_id, r.kind, r.subject_type, r.reason, r.metadata.source]),
		[[dutyOf(c.leaver).task_id, "waive", "task", "Sign-in sheet checked", "generated"]],
	);
	assert.equal(written.length, 1 + 1 + 1 + 1, "no other audit row");
	const closed = byAction("tasks.waived")[0];
	assert.equal(closed.after_value.status, "no_longer_needed");
	// The saved state is the reply's: the added Person attends and advanced, the leaver is absent and their task closed.
	assert.equal(await stageOf(c.extra), "attendee");
	assert.equal((await classOf(c.v, c.leaver)).presence, "absent");
	assert.equal((await one(sql`SELECT status FROM task WHERE id=${dutyOf(c.leaver).task_id}`)).status, "no_longer_needed");
});

test("AC:TARGET-MTG-020 a reconcile that is stale, foreign, too early or not allowed writes nothing, and a replay writes nothing", async () => {
	const c = await crowd(3);
	const snapshot = async () => ({
		audit: (await one(sql`SELECT count(*)::int n FROM audit_event WHERE tenant_id=${plant.id}`)).n,
		revision: await revision(c.v),
		guests: await rows(sql`SELECT person_id, presence, revision::text FROM participation WHERE meeting_id=${c.v} ORDER BY person_id`),
		tasks: (await one(sql`SELECT count(*)::int n, string_agg(status, ',' ORDER BY id) s FROM task WHERE plant_id=${plant.id}`)),
	});
	const nothing = async (body) => {
		const before = await snapshot();
		const result = await body();
		assert.deepEqual(await snapshot(), before);
		return result;
	};
	// A stale expectedRevision.
	const stale = await swap(c);
	await nothing(async () =>
		refused(await write(owner, "reconcileAttendance", { ...stale, expectedRevision: String(BigInt(stale.expectedRevision) - 1n) }), "conflict"),
	);
	// A retired Person and a Person of another church cannot be added; both are named.
	const retired = await person("Retired Rae");
	await f.admin.execute(sql`UPDATE person SET state='retired' WHERE id=${retired}`);
	const outsider = await person("Outsider", "prospect", other);
	const named = await nothing(async () =>
		refused(await write(owner, "reconcileAttendance", await swap(c, [c.extra, retired, outsider])), "invalid_subject"),
	);
	assert.deepEqual(named.details.personIds.sort(), [retired, outsider].sort());
	// A meeting that is not final, one that is cancelled and one that is voided.
	const draft = await meeting("vision_meeting", "2026-11-20T23:00:00Z");
	await nothing(async () =>
		refused(
			await write(owner, "reconcileAttendance", {
				requestKey: key(),
				expectedRevision: await revision(draft),
				input: { meetingId: draft, attendeeIds: [c.extra], followUpAssigneeIds: [], reason: "Too early" },
			}),
			"status_transition",
		),
	);
	const cancelled = await meeting("vision_meeting", "2026-11-21T23:00:00Z");
	ok(await finalize(owner, cancelled, [c.extra]));
	await f.admin.execute(sql`UPDATE meeting SET status='cancelled' WHERE id=${cancelled}`);
	const voided = await meeting("vision_meeting", "2026-11-22T23:00:00Z");
	ok(await finalize(owner, voided, [c.leaver]));
	await f.admin.execute(sql`UPDATE meeting SET occurrence_voided_at=clock_timestamp() WHERE id=${voided}`);
	for (const id of [cancelled, voided])
		await nothing(async () =>
			refused(
				await write(owner, "reconcileAttendance", {
					requestKey: key(),
					expectedRevision: await revision(id),
					input: { meetingId: id, attendeeIds: [], followUpAssigneeIds: [], reason: "Not allowed" },
				}),
				"status_transition",
			),
		);
	// A Member who does not lead the team meeting.
	await nothing(async () => refused(await write(member, "reconcileAttendance", await swap(c)), "unavailable"));

	// The same request key replays the first answer and writes nothing more.
	const first = await swap(c);
	const done = ok(await write(owner, "reconcileAttendance", first));
	const after = await snapshot();
	const again = ok(await write(owner, "reconcileAttendance", first));
	assert.deepEqual(again, done);
	assert.deepEqual(await snapshot(), after);
});

test("INV-locking: two concurrent reconciles at one revision apply once and never deadlock; two concurrent finalizes settle once", async () => {
	const c = await crowd(50);
	const other2 = await person("Second extra");
	const a = await swap(c, [c.extra], [c.leaver]);
	const b = { ...(await swap(c, [other2], [c.ids[7]])), expectedRevision: a.expectedRevision };
	const settled = await Promise.all([write(owner, "reconcileAttendance", a), write(owner, "reconcileAttendance", b)]);
	// A deadlock would surface as required_write_failed, not as the revision conflict of the second lock holder.
	assert.deepEqual(settled.map((r) => (r.status === "ok" ? "applied" : r.error.code)).sort(), ["applied", "conflict"]);
	const winner = settled.find((r) => r.status === "ok").value;
	assert.equal(winner.attendanceRevision, String(BigInt(a.expectedRevision) + 1n));
	assert.equal(await revision(c.v), winner.attendanceRevision);

	// Fifty attendees finalized twice at once with the same set: one change, then a noop that shows the first result.
	const people = await rows(sql`INSERT INTO person(tenant_id,plant_id,display_name,source,stage,adult_classification,
		commitment_state,pipeline_position,state,created_at) SELECT ${plant.id},${plant.id},'Twin '||n,'other','prospect',
		'unknown','unknown',0,'live',clock_timestamp() FROM generate_series(1,50) n RETURNING id`);
	const ids = people.map((r) => r.id);
	const m = await meeting("vision_meeting", "2026-12-05T23:00:00Z");
	const request = await finalizeRequest(m, ids);
	const [first, second] = await Promise.all([
		write(owner, "finalizeAttendance", request),
		finalize(owner, m, ids),
	]);
	assert.deepEqual([ok(first).outcome, ok(second).outcome].sort(), ["changed", "noop"]);
	assert.equal((await work(m)).length, 51);
});

test("INV-planning: the locked fact read of a settle plans below the JIT threshold", async () => {
	// Postgres compiles a statement whose planned cost passes jit_above_cost. The settle's fact read once planned at 8.3
	// million (every task row multiplied by seat_identity's default 1000 rows) and spent 1.7 s compiling 455 functions.
	const c = await crowd(50);
	const request = await swap(c);
	ok(await write(owner, "reconcileAttendance", request));
	const lock = sent.findLast((q) => q.text.startsWith("SELECT m.id, m.type, m.status") && q.text.includes("obligation_facts"));
	assert.ok(lock, "the settle's locked fact read was not captured");
	// EXPLAIN takes no bind parameters: write each one into the text as a literal.
	const literal = (v) =>
		v === null ? "NULL" : Array.isArray(v) ? `'{${v.join(",")}}'` : `'${String(v).replaceAll("'", "''")}'`;
	const text = lock.text.replace(/\$(\d+)/g, (_, n) => literal(lock.values[Number(n) - 1]));
	const plan = await f.admin.$client.query(`EXPLAIN (FORMAT JSON) ${text}`);
	const cost = plan.rows[0]["QUERY PLAN"][0].Plan["Total Cost"];
	const threshold = Number((await f.admin.$client.query("SHOW jit_above_cost")).rows[0].jit_above_cost);
	assert.ok(cost < threshold, `planned cost ${cost} passes jit_above_cost ${threshold}`);
});
