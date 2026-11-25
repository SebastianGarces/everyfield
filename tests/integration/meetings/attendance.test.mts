import test, { after, before } from "node:test";
import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import type { MeetingsReply } from "../../../packages/contracts/src/meetings/index.ts";
import type { Database } from "../../../packages/db/src/client.ts";
import { sql, type SQL } from "../../../packages/db/src/query.ts";
import type { RequestActor, WriteTx } from "../../../packages/domain/src/access/session.ts";
import { fixture, type Fixture } from "../identity/invitations-support.mts";
import {
	attendanceReader as reads,
	createAttendanceWriter,
	guestsWriter,
	describeRsvpToken,
	meetingsReader,
	previewMeetingsWrite,
	withMeetingsWrite,
	type AttendanceWriter,
	type MeetingsContext,
} from "../../../packages/domain/src/meetings/index.ts";
import {
	authorizeTaskReminders,
	createTaskWriter,
	reminderRecipients,
	withTaskWrite,
} from "../../../packages/domain/src/tasks/index.ts";
import { createFollowUpWriter, withFollowUpWrite } from "../../../packages/domain/src/followups/index.ts";
import { getPlant } from "../../../packages/domain/src/oversight/index.ts";
import { PeopleReadContext, peopleReader, peopleWriter } from "../../../packages/domain/src/people/index.ts";
import { gatedTransaction } from "../../../packages/domain/src/operations/writes.ts";
import { teamsWriter, withTeamsWrite } from "../../../packages/domain/src/teams/index.ts";
import { activityRequest } from "../../../packages/contracts/src/people/index.ts";
import { owner as ownerValue } from "../../../packages/contracts/src/common/index.ts";
import { ownerLabel } from "../../../apps/web/src/features/tasks/model.ts";
import { failingWrite, recorded, touched, untouched } from "../../support/recorded.mts";
import { issueRsvpToken } from "./rsvp-token.mts";
import { createMailService } from "../../../packages/domain/src/jobs/mail.ts";
import { createNotificationService } from "../../../packages/domain/src/jobs/notifications.ts";
import { taskReminders } from "../../../apps/web/src/features/tasks/reminders.ts";
import { ok, raced, refused } from "../../support/fixture.mts";

let f: Fixture;
let writer: AttendanceWriter;
let reminders: ReturnType<typeof taskReminders>;
let plant: Workspace;
let other: Workspace;
let owner: Seated;
let member: Seated;
let foreign: Seated;
type Workspace = Awaited<ReturnType<Fixture["workspace"]>>;
type Account = Awaited<ReturnType<Fixture["account"]>>;
type Seated = Account & { actor: RequestActor };
type Scores = Record<string, number>;
const write = <R,>(
	who: Seated,
	op: (tx: WriteTx, ctx: MeetingsContext, raw: unknown) => Promise<MeetingsReply<R>>,
	input: unknown,
) => withMeetingsWrite(f.db, who.actor, (tx, ctx) => op(tx, ctx, input));
const read = <R,>(
	who: Seated,
	op: (db: Database, actor: RequestActor, raw: unknown) => Promise<MeetingsReply<R>>,
	input: unknown,
) => op(f.db, who.actor, input);
async function shownEvaluation(who: Seated, meetingId: string) {
	const shown = ok(await read(who, reads.getEvaluation, { meetingId }));
	assert.ok(shown.status === "available");
	return shown.evaluation;
}
const rows = async <T extends Record<string, unknown>>(q: SQL) => (await f.admin.execute<T>(q)).rows;
const one = async <T extends Record<string, unknown>>(q: SQL) => (await rows<T>(q))[0]!;
const key = () => randomUUID();

async function person(name: string, stage = "prospect", w = plant) {
	const id = randomUUID();
	await f.admin.execute(sql`INSERT INTO person(id,tenant_id,plant_id,display_name,source,stage,adult_classification,
		commitment_state,pipeline_position,state,created_at) VALUES(${id},${w.id},${w.id},${name},'other',${stage},'unknown',
		'unknown',0,'live',clock_timestamp())`);
	return id;
}
async function meeting(type = "vision_meeting", at = "2026-10-01T23:00:00Z", w = plant) {
	const id = randomUUID();
	const date = new Date(new Date(at).getTime() - 5 * 3600_000).toISOString().slice(0, 10);
	await f.admin.execute(sql`INSERT INTO meeting(id,plant_id,type,title,local_date,local_time,timezone,starts_at,
		resolver_version,status,attendance_revision) VALUES(${id},${w.id},${type},NULL,${date},'18:00',
		'America/Chicago',${at},'1','in_progress',1)`);
	return id;
}
const revision = async (meetingId: string) =>
	(await one<{ r: string }>(sql`SELECT attendance_revision::text AS r FROM meeting WHERE id=${meetingId}`)).r;
type Extra = { followUpAssigneeIds?: string[]; evaluationAssigneeIds?: string[] };
const finalizeRequest = async (
	meetingId: string,
	attendeeIds: string[],
	extra: Extra = {},
	requestKey: string = key(),
) => ({
	requestKey,
	expectedRevision: await revision(meetingId),
	input: { meetingId, attendeeIds, ...extra },
});
const finalize = async (
	who: Seated,
	meetingId: string,
	attendeeIds: string[],
	extra: Extra = {},
	requestKey: string = key(),
) => write(who, writer.finalizeAttendance, await finalizeRequest(meetingId, attendeeIds, extra, requestKey));
const reconcile = async (who: Seated, meetingId: string, attendeeIds: string[]) =>
	write(who, writer.reconcileAttendance, {
		requestKey: key(),
		expectedRevision: await revision(meetingId),
		input: { meetingId, attendeeIds, reason: "Sign-in sheet checked" },
	});
const work = (meetingId: string) =>
	rows<{
		kind: string;
		person_id: string | null;
		waiver: string | null;
		status: string;
		assignee_ids: string[];
	}>(sql`SELECT b.kind, b.person_id, b.waiver_reason AS waiver, t.status, (SELECT coalesce(array_agg(a.account_id),'{}') FROM task_assignee a WHERE a.task_id=t.id) AS assignee_ids
		FROM obligation b LEFT JOIN task t ON t.obligation_id=b.id WHERE b.meeting_id=${meetingId} ORDER BY b.kind, b.person_id`);
async function storedAttendee(meetingId: string, personId: string) {
	const g = await one<{
		id: string;
		revision: string;
		presence: string;
		rsvp: string;
		has_card: boolean;
		classification: string | null;
		classification_stage: string | null;
		prior_vision_id: string | null;
		display_name: string;
		state: string;
	}>(sql`SELECT g.id, g.revision::text AS revision, g.presence, coalesce(g.rsvp, 'pending') AS rsvp,
		g.card_response IS NOT NULL AS has_card, g.classification, g.classification_stage, g.prior_vision_id, p.display_name,
		p.state FROM participation g JOIN person p ON p.id = g.person_id WHERE g.meeting_id=${meetingId} AND g.person_id=${personId}`);
	return {
		guestId: g.id,
		revision: g.revision,
		person: { personId, displayName: g.display_name, state: g.state },
		presence: g.presence,
		rsvp: g.rsvp,
		hasCard: g.has_card,
		classification: g.classification,
		classificationStage: g.classification_stage,
		priorVisionId: g.prior_vision_id,
	};
}
const stageOf = async (id: string) => (await one(sql`SELECT stage FROM person WHERE id=${id}`)).stage;
const classOf = async (meetingId: string, personId: string) =>
	one(
		sql`SELECT presence, classification, prior_vision_id FROM participation WHERE meeting_id=${meetingId} AND person_id=${personId}`,
	);

let statements = 0;
const sent: { text: string; values: unknown[] }[] = [];
async function counted<T>(body: () => Promise<T>) {
	const start = statements;
	const value = await body();
	return { value, statements: statements - start };
}

before(async () => {
	f = await fixture();
	f.db.$client.on("connect", (client) => {
		const query = client.query;
		client.query = function (this: unknown, ...args: unknown[]) {
			statements++;
			const [query0, values] = args;
			if (query0 && typeof query0 === "object" && "text" in query0 && typeof query0.text === "string")
				sent.push({ text: query0.text, values: Array.isArray(values) ? values : [] });
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
			return inputs.map((i) => (found.has(i.recipient) ? { address: found.get(i.recipient)! } : null));
		},
	});
	reminders = taskReminders(notifications);
	writer = createAttendanceWriter({ reminders });
	plant = await f.workspace();
	other = await f.workspace();
	await f.admin.execute(sql`UPDATE plant SET timezone='America/Chicago' WHERE id IN (${plant.id},${other.id})`);
	const seated = async (w: Workspace, role: "owner" | "member") => {
		const a = await f.account();
		await f.seat(a, w, role);
		return { ...a, actor: await f.actor(a.session) };
	};
	owner = await seated(plant, "owner");
	member = await seated(plant, "member");
	foreign = await seated(other, "owner");
});

async function eligibleAccount() {
	const a = await f.account();
	await f.seat(a, plant, "member");
	await f.admin.execute(
		sql`UPDATE person SET linked_account_id=${a.id} WHERE id=${await person("Owner " + a.id.slice(0, 4), "core_group")}`,
	);
	return a;
}
after(() => f?.close());

test("INV-statements: finalizing 500 attendees sends the same statements as finalizing one", async () => {
	const finalized = async (meetingId: string, attendeeIds: string[]) =>
		(await counted(async () => ok(await finalize(owner, meetingId, attendeeIds)))).statements;
	const many = await rows<{
		id: string;
	}>(sql`INSERT INTO person(tenant_id,plant_id,display_name,source,stage,adult_classification,
		commitment_state,pipeline_position,state,created_at) SELECT ${plant.id},${plant.id},'Guest '||n,'other','prospect',
		'unknown','unknown',0,'live',clock_timestamp() FROM generate_series(1,500) n RETURNING id`);
	const one = await finalized(await meeting("vision_meeting", "2026-09-10T23:00:00Z"), [await person("Solo")]);
	const fiveHundred = await finalized(
		await meeting("vision_meeting", "2026-09-17T23:00:00Z"),
		many.map((r) => r.id),
	);
	assert.equal(one, 5);
	assert.equal(fiveHundred, one);
});

test("AC:TARGET-MTG-001 AC:TARGET-MTG-010 AC:B02-010 AC:PERSONREF-MEETING-INVITATION-RSVP-ATTENDANCE-CARD-RETIRE draft attendance is all or nothing and keeps RSVP and card", async () => {
	const m = await meeting();
	const [alex, casey, retired] = [await person("Alex"), await person("Casey"), await person("Retired")];
	await f.admin.execute(sql`UPDATE person SET state='retired' WHERE id=${retired}`);
	const batch = (entries: { personId: string; presence: string }[], who = owner) =>
		write(who, writer.captureAttendanceBatch, { requestKey: key(), input: { meetingId: m, entries } });

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
	ok(await write(owner, writer.clearAttendance, { requestKey: key(), input: { meetingId: m, personId: casey } }));
	assert.deepEqual(await one(sql`SELECT presence, rsvp, card_response FROM participation WHERE person_id=${casey}`), {
		presence: "absent",
		rsvp: "confirmed",
		card_response: "interested",
	});
	const again = ok(
		await write(owner, writer.setAttendance, {
			requestKey: key(),
			input: { meetingId: m, personId: alex, presence: "attended" },
		}),
	);
	assert.equal(again.outcome, "noop");
	refused(
		await write(owner, writer.setAttendance, {
			requestKey: key(),
			input: { meetingId: m, personId: await person("Stranger"), presence: "excused" },
		}),
		"unavailable",
	);
	refused(
		await write(member, writer.checkIn, { requestKey: key(), input: { meetingId: m, personId: casey } }),
		"unavailable",
	);
	refused(
		await write(foreign, writer.checkIn, { requestKey: key(), input: { meetingId: m, personId: casey } }),
		"unavailable",
	);
	const may = async (who: Seated, meetingId: string) =>
		ok(await read(who, reads.listAttendance, { meetingId })).viewerCanMarkAttendance;
	assert.equal(await may(owner, m), true);
	assert.equal(await may(member, m), false);
	const leader = await person("Lee");
	await f.admin.execute(sql`UPDATE person SET linked_account_id=${member.actor.actor.accountId} WHERE id=${leader}`);
	const team = randomUUID();
	await f.admin.execute(sql`INSERT INTO team(id,plant_id,name,state,sort_order,leader_person_id,leader_source)
		VALUES(${team},${plant.id},'Hosts','active',1,${leader},'explicit')`);
	const teamMeeting = await meeting("orientation");
	await f.admin.execute(sql`UPDATE meeting SET type='team_meeting', team_id=${team} WHERE id=${teamMeeting}`);
	assert.equal(await may(member, teamMeeting), true);
	assert.equal(await may(member, m), false);
	ok(await write(member, writer.checkIn, { requestKey: key(), input: { meetingId: teamMeeting, personId: casey } }));
	await f.admin.execute(sql`UPDATE team SET archived_at=clock_timestamp() WHERE id=${team}`);
	assert.equal(await may(member, teamMeeting), false);

	const checked = ok(
		await write(owner, writer.checkIn, { requestKey: key(), input: { meetingId: m, personId: casey } }),
	);
	assert.equal(checked.attendees[0]!.presence, "attended");
	const summary = ok(await read(owner, reads.attendanceSummary, { meetingId: m }));
	assert.equal(summary.attended, 2);
	assert.equal(summary.finalized, null);
	const ready = await meeting("vision_meeting", "2026-10-03T23:00:00Z");
	await f.admin.execute(sql`UPDATE meeting SET status='ready' WHERE id=${ready}`);
	const early = ok(
		await write(owner, writer.checkIn, { requestKey: key(), input: { meetingId: ready, personId: alex } }),
	);
	assert.deepEqual(
		early.attendees.map((a) => a.presence),
		["attended"],
	);
	const readySummary = ok(await read(owner, reads.attendanceSummary, { meetingId: ready }));
	assert.deepEqual([readySummary.attended, readySummary.finalized], [1, null]);
	assert.equal((await one(sql`SELECT status FROM meeting WHERE id=${ready}`)).status, "ready");

	const practice = await meeting("prelaunch_practice", "2026-10-02T23:00:00Z");
	ok(await finalize(owner, practice, [alex]));
	const held = ok(await meetingsReader.listCompletedPreLaunchPractices(f.db, owner.actor));
	assert.equal(held.count, 0);
	assert.equal((await one(sql`SELECT status FROM meeting WHERE id=${practice}`)).status, "in_progress");
	refused(
		await write(owner, writer.setAttendance, {
			requestKey: key(),
			input: { meetingId: practice, personId: alex, presence: "absent" },
		}),
		"status_transition",
	);
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
	const held = await one(
		sql`SELECT actual_occurrence_at = ${at}::timestamptz AS same FROM participation WHERE meeting_id=${v} AND person_id=${alex}`,
	);
	assert.equal(held.same, true);
	ok(await reconcile(owner, v, [alex]));
	const cancelled = await meeting("vision_meeting", at);
	await f.admin.execute(sql`UPDATE meeting SET status='cancelled' WHERE id=${cancelled}`);
	refused(await finalize(owner, cancelled, [alex]), "status_transition");
});

test("AC:TARGET-MTG-020 AC:TARGET-MTG-012 AC:TARGET-TSK-017 AC:GAP-PPL-020 AC:CASE-OPS-004 finalize commits attendance, progression and generated work together", async () => {
	const v = await meeting("vision_meeting", "2026-10-08T23:00:00Z");
	const alex = await person("Alex"),
		casey = await person("Casey", "leader");
	const orientation = await meeting("orientation", "2026-09-30T23:00:00Z");
	ok(await finalize(owner, orientation, [alex]));
	assert.equal(await stageOf(alex), "prospect");

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

	const request = await finalizeRequest(v, [alex, casey]);
	const [a, b] = await Promise.all([
		write(owner, writer.finalizeAttendance, request),
		finalize(owner, v, [alex, casey]),
	]);
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
	assert.deepEqual(
		(await work(v)).map((w) => [w.kind, w.status, w.assignee_ids]),
		[
			["evaluation", "not_started", []],
			["follow_up", "not_started", []],
			["follow_up", "not_started", []],
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
	const replay = ok(await write(owner, writer.finalizeAttendance, request));
	assert.equal(replay.receiptId, ok(a).receiptId);
	assert.equal((await work(v)).length, 3);
	assert.equal(
		(await one(sql`SELECT count(*)::int n FROM audit_event WHERE subject_id=${alex} AND action='people.stage_changed'`))
			.n,
		1,
	);
	refused(await finalize(owner, v, [alex]), "status_transition");

	const empty = await meeting("vision_meeting", "2026-10-09T23:00:00Z");
	refused(await finalize(owner, empty, [], { evaluationAssigneeIds: [foreign.id] }), "invalid_subject");
	const none = ok(await finalize(owner, empty, [], { evaluationAssigneeIds: [owner.id] }));
	assert.deepEqual(
		none.work.map((w) => [w.kind, w.needsOwner]),
		[["meeting_evaluation", false]],
	);

	const jamie = await person("Jamie");
	const followUp = (id: string) =>
		one<{
			id: string;
			revision: string;
		}>(sql`SELECT t.id, t.revision::text AS revision FROM task t JOIN obligation b ON b.id=t.obligation_id
			WHERE b.meeting_id=${v} AND b.person_id=${id}`);
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
	ok(await reconcile(owner, v, []));
	assert.deepEqual(
		(await work(v)).map((w) => w.status).sort(),
		["complete", "no_longer_needed", "no_longer_needed", "not_started"].sort(),
	);
	ok(await reconcile(owner, v, [casey]));
	assert.equal(
		(await work(v))
			.filter((w) => w.person_id === casey)
			.map((w) => w.status)
			.join(),
		"no_longer_needed",
	);
	assert.equal(await stageOf(alex), "attendee");

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
	assert.equal((await work(v)).find((w) => w.person_id === jamie)!.status, "no_longer_needed");
	assert.equal((await work(earlier)).filter((w) => w.kind === "follow_up").length, 1);
	const list = ok(await read(member, reads.listAttendance, { meetingId: v }));
	assert.equal(list.items.find((i) => i.person.personId === jamie)!.priorVisionId, earlier);

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
		(await work(later)).filter((w) => w.kind === "follow_up").map((w) => [w.person_id, w.status, w.assignee_ids]),
		[[riley, "not_started", []]],
	);
	assert.ok(corrected.work.some((w) => w.meetingId === later && w.personId === riley && w.outcome === "created"));
	assert.equal((await work(early)).find((w) => w.person_id === riley)!.status, "no_longer_needed");

	const sam = await person("Sam");
	const samLater = await meeting("vision_meeting", "2026-09-13T23:00:00Z"),
		samEarly = await meeting("vision_meeting", "2026-09-06T23:00:00Z");
	const samOwner = await eligibleAccount();
	ok(await finalize(owner, samLater, [sam], { followUpAssigneeIds: [samOwner.id] }));
	ok(await finalize(owner, samEarly, [sam]));
	const undone = ok(await reconcile(owner, samEarly, []));
	assert.deepEqual(
		undone.work
			.filter((w) => w.meetingId === samLater)
			.map((w) => [w.personId, w.outcome, w.assigneeIds, w.needsOwner]),
		[[sam, "existing", [samOwner.id], false]],
	);
	assert.deepEqual(
		undone.work.filter((w) => w.meetingId === samLater).flatMap((w) => w.owners.map((o) => o.accountId)),
		[samOwner.id],
	);
	assert.deepEqual(
		(await work(samLater)).filter((w) => w.kind === "follow_up").map((w) => [w.status, w.assignee_ids]),
		[["no_longer_needed", [samOwner.id]]],
	);
});

test("AC:TARGET-MTG-014 AC:GAP-MTG-015 AC:TARGET-MTG-015 one evaluation, computed average, reviewed corrections", async () => {
	const v = await meeting("vision_meeting", "2026-10-10T23:00:00Z");
	const alex = await person("Alex");
	const scores = (n: number): Scores => ({
		attendanceScore: n,
		locationScore: n,
		logisticsScore: n,
		agendaScore: n,
		vibeScore: n,
		messageScore: n,
		closeScore: n,
		nextStepsScore: n,
	});
	const record = (who: Seated, meetingId: string, input: Record<string, unknown> = {}) =>
		write(who, writer.recordEvaluation, { requestKey: key(), input: { meetingId, scores: scores(1), ...input } });
	refused(await record(owner, await meeting("orientation", "2026-10-10T23:00:00Z")), "wrong_meeting_type");
	refused(await record(owner, v), "status_transition");
	ok(await finalize(owner, v, [alex]));
	refused(await record(owner, v, { scores: { ...scores(1), attendanceScore: 6 } }), "invalid_input");
	refused(await record(owner, v, { average: 5 }), "invalid_input");

	const [a, b] = await Promise.all([
		record(owner, v, { notes: "Room was cold" }),
		record(owner, v, { scores: scores(5), notes: "Room was cold" }),
	]);
	const kept = [ok(a), ok(b)].find((r) => r.outcome === "changed")!;
	const seen = [ok(a), ok(b)].find((r) => r.outcome === "noop")!;
	assert.deepEqual(seen.evaluation, kept.evaluation);
	assert.equal(kept.taskCompleted, true);
	const evaluationTask = async () =>
		one(sql`SELECT t.status, (SELECT count(*)::int FROM audit_event a WHERE a.subject_id=t.id AND a.action='tasks.completed') AS completions
			FROM task t JOIN obligation b ON b.id=t.obligation_id WHERE b.meeting_id=${v} AND b.kind='evaluation'`);
	assert.deepEqual(await evaluationTask(), { status: "complete", completions: 1 });
	ok(
		await write(owner, writer.correctEvaluation, {
			requestKey: key(),
			expectedRevision: kept.evaluation.revision,
			input: { meetingId: v, changes: scores(3), reason: "Re-entered" },
		}),
	);

	const shown = await shownEvaluation(owner, v);
	const corrected = ok(
		await write(owner, writer.correctEvaluation, {
			requestKey: key(),
			expectedRevision: shown.revision,
			input: { meetingId: v, changes: { attendanceScore: 4 }, reason: "Correct entered rating" },
		}),
	);
	assert.equal(corrected.evaluation.scores.attendanceScore, 4);
	assert.equal(corrected.evaluation.average, 3.1);
	assert.equal(corrected.taskCompleted, false);
	assert.deepEqual(await evaluationTask(), { status: "complete", completions: 1 });
	const history = async () => ok(await read(owner, reads.evaluationHistory, { meetingId: v })).entries;
	const entries = (await history()).length;
	refused(
		await write(owner, writer.correctEvaluation, {
			requestKey: key(),
			expectedRevision: shown.revision,
			input: { meetingId: v, changes: { attendanceScore: 5 }, reason: "Second tab" },
		}),
		"conflict",
	);
	refused(
		await write(foreign, writer.correctEvaluation, {
			requestKey: key(),
			expectedRevision: corrected.evaluation.revision,
			input: { meetingId: v, changes: { attendanceScore: 5 }, reason: "Foreign" },
		}),
		"unavailable",
	);
	const last = (await history()).at(-1)!;
	assert.equal((await history()).length, entries);
	assert.deepEqual(
		[last.kind, last.before, last.after, last.average, last.reason],
		["corrected", { attendanceScore: 3 }, { attendanceScore: 4 }, { before: 3, after: 3.1 }, "Correct entered rating"],
	);
	const { actor } = (await history())[0]!;
	assert.equal(actor.kind === "current_account" && actor.accountId, owner.id);
	const memberView = await shownEvaluation(member, v);
	assert.equal(memberView.notes, null);
	assert.deepEqual(memberView.corrections.count, 2);
	refused(await read(member, reads.evaluationHistory, { meetingId: v }), "unavailable");
	assert.equal((await shownEvaluation(owner, v)).notes, "Room was cold");
	const a2 = await f.account();
	const seat = await f.seat(a2, plant, "admin");
	const admin2 = { ...a2, actor: await f.actor(a2.session) };
	assert.equal((await shownEvaluation(admin2, v)).notes, "Room was cold");
	await f.admin.execute(sql`UPDATE seat SET role='member' WHERE id=${seat}`);
	assert.equal((await shownEvaluation(admin2, v)).notes, null);
});

test("BUG-01aca6707 AC:TARGET-MTG-014: the evaluation modal's payload saves for a finalized Vision meeting dated after today", async () => {
	const all = (n: number): Scores => ({
		attendanceScore: n,
		locationScore: n,
		logisticsScore: n,
		agendaScore: n,
		vibeScore: n,
		messageScore: n,
		closeScore: n,
		nextStepsScore: n,
	});
	const record = (meetingId: string, input: Record<string, unknown>) =>
		write(owner, writer.recordEvaluation, { requestKey: key(), input: { meetingId, ...input } });
	const correct = async (meetingId: string, input: Record<string, unknown>) =>
		write(owner, writer.correctEvaluation, {
			requestKey: key(),
			expectedRevision: (await shownEvaluation(owner, meetingId)).revision,
			input: { meetingId, ...input },
		});
	const evaluated = async (at: string, input: Record<string, unknown>) => {
		const id = await meeting("vision_meeting", at);
		ok(await finalize(owner, id, [await person("Guest")]));
		return { id, result: await record(id, { scores: { ...all(4), agendaScore: 5 }, ...input }) };
	};

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

	const bare = await evaluated("2099-01-02T23:00:00Z", { notes: null });
	assert.equal(ok(bare.result).evaluation.notes, null);
	const blank = await meeting("vision_meeting", "2099-01-03T23:00:00Z");
	ok(await finalize(owner, blank, []));
	const refusedNote = refused(await record(blank, { scores: all(3), notes: "   " }), "invalid_input");
	assert.ok(
		refusedNote.details.issues.some((x: { path: string }) => x.path === "input.notes"),
		JSON.stringify(refusedNote),
	);

	const noteOnly = ok(await correct(future.id, { changes: {}, notes: "Room was warm", reason: "Fixed the note" }));
	assert.equal(noteOnly.outcome, "changed");
	assert.equal(noteOnly.evaluation.notes, "Room was warm");
	const oneScore = ok(await correct(future.id, { changes: { vibeScore: 2 }, reason: "Mis-keyed" }));
	assert.equal(oneScore.evaluation.scores.vibeScore, 2);

	for (const reason of [undefined, "   "]) {
		const e = refused(await correct(future.id, { changes: { vibeScore: 3 }, reason }), "invalid_input");
		assert.ok(
			e.details.issues.some((x: { path: string }) => x.path === "input.reason"),
			JSON.stringify(e),
		);
	}
	const early = await meeting("vision_meeting", "2099-02-01T23:00:00Z");
	ok(await finalize(owner, early, []));
	for (const evaluatedOn of ["2099-01-31", "2099-03-01"]) {
		const e = refused(await record(early, { scores: all(3), evaluatedOn }), "invalid_input");
		assert.ok(
			e.details.issues.some((x: { path: string }) => x.path === "input.evaluatedOn"),
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
	ok(
		await write(admin, writer.captureAttendanceBatch, {
			requestKey: key(),
			input: { meetingId: v, entries: [{ personId: p3, presence: "attended" }] },
		}),
	);
	ok(
		await write(admin, writer.setAttendance, {
			requestKey: key(),
			input: { meetingId: v, personId: p3, presence: "absent" },
		}),
	);
	ok(await finalize(admin, v, [p1, p2]));
	const analytics = ok(await read(admin, reads.readAnalytics, { meetingId: v }));
	assert.deepEqual(analytics.attended, { status: "known", value: 2 });
	assert.deepEqual(analytics.growth, { status: "unavailable", difference: 2 });
	assert.deepEqual(analytics.evaluation!.baseline, { status: "unknown" });
	assert.equal(analytics.tasks.followUps.total, 2);
	assert.deepEqual(ok(await read(admin, reads.readAnalytics, { meetingId: zero })).growth, { status: "unknown" });
	const unfinalized = await meeting("vision_meeting", "2026-09-15T23:00:00Z", w);
	const open = ok(await read(admin, reads.readAnalytics, { meetingId: unfinalized }));
	assert.deepEqual(
		[open.attended, open.growth, open.classifications],
		[{ status: "unknown" }, { status: "unknown" }, null],
	);
	assert.deepEqual([open.evaluation!.current, open.evaluation!.delta], [{ status: "unknown" }, { status: "unknown" }]);
	assert.deepEqual(ok(await read(admin, reads.readAnalytics, { meetingId: zero })).attended, {
		status: "known",
		value: 0,
	});
	const unmeasured = ok(await read(admin, reads.summaryStats, { from: "2026-09-15", to: "2026-09-15" }));
	assert.deepEqual(
		[unmeasured.held, unmeasured.finalized, unmeasured.averageAttendance, unmeasured.averageEvaluation],
		[1, 0, { status: "unknown" }, { status: "unknown" }],
	);
	const nobody = ok(await read(admin, reads.summaryStats, { from: "2026-09-01", to: "2026-09-01" }));
	assert.deepEqual(nobody.averageAttendance, { status: "known", value: 0 });

	const evaluated = async (at: string, n: number) => {
		const id = await meeting("vision_meeting", at, w);
		await f.admin.execute(sql`UPDATE meeting SET evaluation_scores=${sql.param(Array(8).fill(n))}::int[],
			evaluated_on=local_date, evaluated_at=clock_timestamp(), evaluation_revision=1 WHERE id=${id}`);
		return id;
	};
	const early = await evaluated("2024-12-01T23:00:00Z", 2);
	for (let i = 0; i < 51; i++) await evaluated(new Date(Date.UTC(2025, 0, 2 + i, 23)).toISOString(), i === 0 ? 1 : 4);
	await evaluated("2025-03-23T23:00:00Z", 1);
	const latest = await evaluated("2025-03-23T23:00:00Z", 5);
	assert.deepEqual(ok(await read(admin, reads.compareEvaluation, { meetingId: early })).baseline, {
		status: "unknown",
	});
	const compared = ok(await read(admin, reads.compareEvaluation, { meetingId: latest }));
	assert.deepEqual(compared.baseline, { status: "known", value: 4, count: 50 });
	assert.deepEqual(compared.delta, { status: "known", value: 1 });

	const trend = ok(await read(admin, reads.attendanceTrend, { from: "2026-09-01", to: "2026-09-30" }));
	assert.deepEqual(
		trend.points.map((p) => [p.attended, p.growth.status]),
		[
			[0, "unknown"],
			[2, "unavailable"],
		],
	);
	const stats = ok(await read(admin, reads.summaryStats, { from: "2026-09-01", to: "2026-09-30" }));
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
		ok(await read(admin, reads.evaluationTrend, { from: "2025-01-01", to: "2025-12-31", limit: 3 })).points.length,
		3,
	);

	await f.admin.execute(sql`UPDATE seat SET ended_at=clock_timestamp() WHERE id=${seat}`);
	refused(await read(admin, reads.summaryStats, {}), "unavailable");
	refused(await read(admin, reads.listAttendance, { meetingId: v }), "unavailable");
});

test("AC:TARGET-MTG-016 no report counts a cancelled or a voided meeting", async () => {
	const w = await f.workspace();
	await f.admin.execute(sql`UPDATE plant SET timezone='America/Chicago' WHERE id=${w.id}`);
	const a = await f.account();
	await f.seat(a, w, "owner");
	const admin = { ...a, actor: await f.actor(a.session) };
	const [p1, p2, p3] = [
		await person("Q1", "prospect", w),
		await person("Q2", "prospect", w),
		await person("Q3", "prospect", w),
	];
	const held = async (at: string, attendees: string[], score: number) => {
		const id = await meeting("vision_meeting", at, w);
		ok(await finalize(admin, id, attendees));
		await f.admin.execute(sql`UPDATE meeting SET evaluation_scores=${sql.param(Array(8).fill(score))}::int[],
			evaluated_on=local_date, evaluated_at=clock_timestamp(), evaluation_revision=1 WHERE id=${id}`);
		return id;
	};
	const first = await held("2026-08-04T23:00:00Z", [p1], 3);
	const cancelled = await held("2026-08-11T23:00:00Z", [p1, p2, p3], 1);
	await f.admin.execute(sql`UPDATE meeting SET status='cancelled' WHERE id=${cancelled}`);
	const voided = await held("2026-08-18T23:00:00Z", [p1, p2, p3], 1);
	await f.admin.execute(sql`UPDATE meeting SET occurrence_voided_at=clock_timestamp() WHERE id=${voided}`);
	const last = await held("2026-08-25T23:00:00Z", [p1, p2], 5);
	const window = { from: "2026-08-01", to: "2026-08-31" };

	const stats = ok(await read(admin, reads.summaryStats, window));
	assert.deepEqual([stats.held, stats.finalized, stats.attendances], [2, 2, 3]);
	assert.deepEqual(
		ok(await read(admin, reads.attendanceTrend, window)).points.map((p) => p.meetingId),
		[first, last],
	);
	assert.deepEqual(
		ok(await read(admin, reads.evaluationTrend, window)).points.map((p) => p.meetingId),
		[first, last],
	);
	const analytics = ok(await read(admin, reads.readAnalytics, { meetingId: last }));
	assert.deepEqual(analytics.growth, { status: "known", difference: 1, percent: 100 });
	assert.deepEqual(ok(await read(admin, reads.compareEvaluation, { meetingId: last })).baseline, {
		status: "known",
		value: 3,
		count: 1,
	});
});

test("AC:GAP-MTG-017 AC:TARGET-MTG-017 an attendee note names its attended meeting and author", async () => {
	const v = await meeting("vision_meeting", "2026-10-11T23:00:00Z");
	const alex = await person("Alex"),
		casey = await person("Casey");
	ok(await finalize(owner, v, [alex]));
	const requestKey = key();
	const note = (who: Seated, input: Record<string, unknown>, k: string = requestKey) =>
		write(who, writer.addAttendeeNote, { requestKey: k, input });
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
	refused(await note(owner, { meetingId: v, personId: casey, text: "x" }, key()), "unavailable");
	refused(await note(foreign, { meetingId: v, personId: alex, text: "x" }, key()), "unavailable");
	refused(await note(member, { meetingId: v, personId: alex, text: "x" }, key()), "unavailable");
	refused(await note(owner, { meetingId: v, personId: alex, text: "   " }, key()), "invalid_input");
	refused(await note(owner, { meetingId: v, personId: alex, text: "x".repeat(5001) }, key()), "invalid_input");
	assert.equal((await one(sql`SELECT count(*)::int n FROM person_note`)).n, 1);
	const progress = ok(await read(owner, reads.linkedTaskProgress, { meetingId: v }));
	assert.deepEqual(progress.followUps, { total: 1, open: 1, complete: 0, closed: 0, needsOwner: 1 });
});

test("AC:TARGET-TSK-012 a meeting counts a follow-up whose stored owner is no longer committed as Needs owner", async () => {
	const v = await meeting("vision_meeting", "2026-10-11T23:00:00Z");
	ok(await finalize(owner, v, [await person("Alex")]));
	const needsOwner = async () => ok(await read(owner, reads.linkedTaskProgress, { meetingId: v })).followUps.needsOwner;
	const caller = await eligibleAccount();
	await f.admin.execute(sql`INSERT INTO task_assignee(plant_id,task_id,account_id)
		SELECT t.plant_id,t.id,${caller.id} FROM task t JOIN obligation o ON o.id=t.obligation_id
		WHERE o.meeting_id=${v} AND o.kind='follow_up'`);
	assert.equal(await needsOwner(), 0);
	await f.admin.execute(sql`UPDATE person SET stage='attendee' WHERE linked_account_id=${caller.id}`);
	assert.equal(await needsOwner(), 1);
});

test("INV-attendance: guest list writes that change the attended set move its revision and wait for Correct attendance once finalized", async () => {
	const m = await meeting();
	const [alex, casey, dana] = [await person("Alex"), await person("Casey"), await person("Dana")];
	const guestRevision = async (personId: string) =>
		ok(await meetingsReader.listGuests(f.db, owner.actor, { meetingId: m })).guests.find(
			(g) => g.person.personId === personId,
		)!.revision;
	const remove = async (personId: string) =>
		write(owner, guestsWriter.removeGuest, {
			requestKey: key(),
			expectedRevision: await guestRevision(personId),
			input: { meetingId: m, personId },
		});
	const invite = (personId: string) =>
		write(owner, guestsWriter.inviteGuest, { requestKey: key(), input: { meetingId: m, personId } });
	const walkIn = (displayName: string) =>
		write(owner, guestsWriter.createWalkInContact, { requestKey: key(), input: { meetingId: m, displayName } });
	const contact = (displayName: string, attendance: string) =>
		write(owner, guestsWriter.createGuestContact, {
			requestKey: key(),
			input: { meetingId: m, displayName, attendance },
		});
	const attended = async () =>
		ok(await read(owner, reads.listAttendance, { meetingId: m }))
			.items.filter((a) => a.presence === "attended")
			.map((a) => a.person.displayName)
			.sort();
	ok(await invite(dana));
	for (const personId of [alex, casey])
		ok(await write(owner, writer.checkIn, { requestKey: key(), input: { meetingId: m, personId } }));

	const reviewed = await finalizeRequest(m, [alex, casey]);
	const door = ok(await walkIn("Door")).guest.person.personId;
	refused(await write(owner, writer.finalizeAttendance, reviewed), "conflict");
	const beforeRemoval = await finalizeRequest(m, [alex, casey, door]);
	ok(await remove(casey));
	refused(await write(owner, writer.finalizeAttendance, beforeRemoval), "conflict");
	ok(await finalize(owner, m, [alex, door]));
	const finalized = await revision(m);

	refused(await remove(alex), "status_transition");
	refused(await walkIn("Late"), "status_transition");
	refused(await contact("Late", "attended"), "status_transition");
	refused(await invite(casey), "status_transition");
	assert.deepEqual(await attended(), ["Alex", "Door"]);
	assert.equal(await revision(m), finalized);
	ok(await remove(dana));
	ok(await invite(dana));
	ok(await contact("Later guest", "not_recorded"));
	assert.equal(await revision(m), finalized);
	ok(await reconcile(owner, m, [alex]));
	assert.deepEqual(await attended(), ["Alex"]);
});

test("BUG-ce8e6b7f7: guest, walk-in, finalize and reconcile results carry the revisions they wrote, so the next save goes through", async () => {
	const m = await meeting();
	const [alex, casey, dana, newcomer] = [
		await person("Alex"),
		await person("Casey"),
		await person("Dana"),
		await person("Newcomer"),
	];
	const guestRevision = async (personId: string) => (await storedAttendee(m, personId)).revision;
	const invite = (personId: string) =>
		write(owner, guestsWriter.inviteGuest, { requestKey: key(), input: { meetingId: m, personId } });
	const steps: string[] = [];
	const step = async <R extends { attendanceRevision: string }>(what: string, result: Promise<MeetingsReply<R>>) => {
		const value = ok(await result);
		assert.equal(value.attendanceRevision, await revision(m), what);
		steps.push(value.attendanceRevision);
		return value;
	};
	await step("invite", invite(alex));
	await step("invite", invite(casey));
	await step("invite", invite(dana));
	for (const personId of [alex, casey])
		ok(await write(owner, writer.checkIn, { requestKey: key(), input: { meetingId: m, personId } }));
	const before = await revision(m);
	const door = (
		await step(
			"walk-in",
			write(owner, guestsWriter.createWalkInContact, {
				requestKey: key(),
				input: { meetingId: m, displayName: "Door" },
			}),
		)
	).guest.person.personId;
	const sam = (
		await step(
			"attended contact",
			write(owner, guestsWriter.createGuestContact, {
				requestKey: key(),
				input: { meetingId: m, displayName: "Sam", attendance: "attended" },
			}),
		)
	).guest.person.personId;
	await step(
		"absent contact",
		write(owner, guestsWriter.createGuestContact, {
			requestKey: key(),
			input: { meetingId: m, displayName: "Later", attendance: "not_recorded" },
		}),
	);
	const removed = await step(
		"remove an attended guest",
		write(owner, guestsWriter.removeGuest, {
			requestKey: key(),
			expectedRevision: await guestRevision(casey),
			input: { meetingId: m, personId: casey },
		}),
	);
	assert.equal(BigInt(removed.attendanceRevision) - BigInt(before), 3n, "a walk-in, an attended contact, a removal");

	const final = ok(
		await write(owner, writer.finalizeAttendance, {
			requestKey: key(),
			expectedRevision: removed.attendanceRevision,
			input: { meetingId: m, attendeeIds: [alex, door, newcomer] },
		}),
	);
	assert.equal(final.attendanceRevision, await revision(m));
	assert.deepEqual(final.attendees, await Promise.all([alex, door, sam, newcomer].map((id) => storedAttendee(m, id))));
	assert.deepEqual(
		final.attendees.map((a) => [a.person.displayName, a.presence]),
		[
			["Alex", "attended"],
			["Door", "attended"],
			["Sam", "absent"],
			["Newcomer", "attended"],
		],
	);
	const alexRow = final.attendees.find((a) => a.person.personId === alex)!;
	ok(
		await write(owner, guestsWriter.recordCard, {
			requestKey: key(),
			expectedRevision: alexRow.revision,
			input: { meetingId: m, personId: alex, response: "interested" },
		}),
	);

	const corrected = ok(
		await write(owner, writer.reconcileAttendance, {
			requestKey: key(),
			expectedRevision: final.attendanceRevision,
			input: { meetingId: m, attendeeIds: [alex, newcomer, casey], reason: "Sign-in sheet checked" },
		}),
	);
	assert.deepEqual(corrected.attendees, await Promise.all([casey, door].map((id) => storedAttendee(m, id))));
	assert.equal(corrected.attendanceRevision, await revision(m));
	const again = ok(await finalize(owner, m, [alex, newcomer, casey]));
	assert.deepEqual([again.outcome, again.attendees], ["noop", []]);
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
	assert.equal(preview.statements, 6);
	assert.deepEqual(
		ok(await write(owner, writer.finalizeAttendance, request)).classifications,
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
	const followUp = done.work.find((w) => w.kind === "first_vision_follow_up")!;
	assert.deepEqual(
		[
			followUp.owners[0]!.accountId,
			followUp.owners[0]!.eligible,
			followUp.owners[0]!.reason,
			typeof followUp.owners[0]!.displayName,
		],
		[member.id, true, null, "string"],
	);
	const request = (extra: Extra) => async () => ({
		requestKey: key(),
		expectedRevision: await revision(v),
		input: { meetingId: v, attendeeIds: [ivy, jo], reason: "Sign-in sheet checked", ...extra },
	});
	refused(
		await write(owner, writer.reconcileAttendance, await request({ followUpAssigneeIds: [unlinked.id] })()),
		"owner_ineligible",
	);
	const corrected = ok(
		await write(owner, writer.reconcileAttendance, await request({ followUpAssigneeIds: [member.id] })()),
	);
	const added = corrected.work.find((w) => w.personId === jo && w.outcome === "created")!;
	assert.deepEqual([added.owners[0]!.accountId, added.owners[0]!.eligible], [member.id, true]);
	await f.admin
		.execute(sql`WITH d AS (DELETE FROM task_assignee WHERE task_id IN (SELECT id FROM task WHERE obligation_id=${followUp.obligationId}))
		INSERT INTO task_assignee(plant_id,task_id,account_id) SELECT plant_id,id,${unlinked.id} FROM task WHERE obligation_id=${followUp.obligationId}`);
	const again = ok(
		await write(owner, writer.reconcileAttendance, await request({ followUpAssigneeIds: [member.id] })()),
	);
	const kept = again.work.find((w) => w.obligationId === followUp.obligationId)!;
	assert.deepEqual(
		[kept.owners[0]!.accountId, kept.owners[0]!.eligible, kept.owners[0]!.reason],
		[unlinked.id, false, "no_person"],
	);
	const empty = await meeting("vision_meeting", "2026-10-13T23:00:00Z");
	const evaluation = ok(await finalize(owner, empty, [], { evaluationAssigneeIds: [unlinked.id] })).work[0]!;
	assert.deepEqual([evaluation.owners[0]!.accountId, evaluation.owners[0]!.eligible], [unlinked.id, true]);
});

let crowdNumber = 0;
async function crowd(size: number) {
	const day = ++crowdNumber;
	const made = await rows<{
		id: string;
		display_name: string;
	}>(sql`INSERT INTO person(tenant_id,plant_id,display_name,source,stage,adult_classification,
		commitment_state,pipeline_position,state,created_at) SELECT ${plant.id},${plant.id},'Crowd ${sql.raw(String(day))} Person '||n,
		'other',CASE WHEN n % 10 = 0 THEN 'core_group' ELSE 'prospect' END,'unknown','unknown',0,'live',clock_timestamp()
		FROM generate_series(0,${size - 1}) n RETURNING id, display_name`);
	const ids = made
		.sort((a, b) => Number(a.display_name.split(" ").pop()) - Number(b.display_name.split(" ").pop()))
		.map((r) => r.id);
	const extra = await person(`Crowd ${day} Extra`);
	const leaver = ids[2]!;
	const at = (days: number) =>
		new Date(Date.UTC(2026, 0, 1) + (day * 10 + days) * 86400_000 + 23 * 3600_000).toISOString();
	const earlier = await meeting("vision_meeting", at(0));
	ok(
		await finalize(
			owner,
			earlier,
			ids.filter((_, i) => i % 5 === 1),
		),
	);
	const v = await meeting("vision_meeting", at(5));
	const first = ok(await finalize(owner, v, ids));
	return { ids, extra, leaver, earlier, v, first };
}
const swap = async (c: Awaited<ReturnType<typeof crowd>>, extra = [c.extra], gone = [c.leaver]) => ({
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
	const statementsFor = async (size: number) => {
		const c = await crowd(size);
		const request = await swap(c);
		const done = await counted(async () => ok(await write(owner, writer.reconcileAttendance, request)));
		assert.deepEqual(done.value.added, [c.extra]);
		assert.deepEqual(done.value.removed, [c.leaver]);
		assert.deepEqual(done.value.stageChanges, [{ personId: c.extra, from: "prospect", to: "attendee" }]);
		assert.ok(done.value.work.some((w) => w.outcome === "created" && w.personId === c.extra));
		assert.ok(done.value.work.some((w) => w.outcome === "closed" && w.personId === c.leaver));
		return done.statements;
	};
	const three = await statementsFor(3);
	const fifty = await statementsFor(50);
	assert.equal(three, 5);
	assert.equal(fifty, three);
});

test("AC:TARGET-MTG-020 AC:TARGET-MTG-012 a 50-attendee reconcile returns the exact result and writes the exact audit rows", async () => {
	const c = await crowd(50);
	const duty = await rows<{
		obligation_id: string;
		person_id: string | null;
		kind: string;
		task_id: string;
	}>(sql`SELECT b.id AS obligation_id, b.person_id, b.kind, t.id AS task_id, (SELECT coalesce(array_agg(a.account_id),'{}') FROM task_assignee a WHERE a.task_id=t.id) AS assignee_ids
		FROM obligation b JOIN task t ON t.obligation_id=b.id WHERE b.meeting_id=${c.v}`);
	const dutyOf = (personId: string) => duty.find((d) => d.person_id === personId)!;
	const evaluation = duty.find((d) => d.kind === "evaluation")!;
	assert.equal(duty.length, 50 - 10 + 1, "a follow-up for each attendee without an earlier Vision, and the evaluation");
	const seen = new Set((await rows(sql`SELECT id FROM audit_event WHERE tenant_id=${plant.id}`)).map((r) => r.id));
	const finalizedAt = new Date(
		(await one<{ finalized_at: string }>(sql`SELECT finalized_at FROM meeting WHERE id=${c.v}`)).finalized_at,
	).toISOString();
	const request = await swap(c);
	const result = ok(await write(owner, writer.reconcileAttendance, request));

	const attendeeIds = request.input.attendeeIds;
	const priorOf = (id: string) => (c.ids.indexOf(id) % 5 === 1 ? c.earlier : null);
	const stageOfIndex = (id: string) => (c.ids.indexOf(id) % 10 === 0 ? "core_group" : "prospect");
	const created = result.work.find((w) => w.outcome === "created");
	assert.ok(created, "the added prospect owes a follow-up");
	const expectedWork = [
		...attendeeIds
			.filter((id) => !priorOf(id))
			.map((id) =>
				id === c.extra
					? {
							meetingId: c.v,
							kind: "first_vision_follow_up",
							personId: id,
							obligationId: created.obligationId,
							taskId: created.taskId,
							outcome: "created",
							assigneeIds: [],
							needsOwner: true,
							owners: [],
						}
					: {
							meetingId: c.v,
							kind: "first_vision_follow_up",
							personId: id,
							obligationId: dutyOf(id).obligation_id,
							taskId: dutyOf(id).task_id,
							outcome: "existing",
							assigneeIds: [],
							needsOwner: true,
							owners: [],
						},
			),
		{
			meetingId: c.v,
			kind: "meeting_evaluation",
			personId: null,
			obligationId: evaluation.obligation_id,
			taskId: evaluation.task_id,
			outcome: "existing",
			assigneeIds: [],
			needsOwner: true,
			owners: [],
		},
		{
			meetingId: c.v,
			kind: "first_vision_follow_up",
			personId: c.leaver,
			obligationId: dutyOf(c.leaver).obligation_id,
			taskId: dutyOf(c.leaver).task_id,
			outcome: "closed",
			assigneeIds: [],
			needsOwner: false,
			owners: [],
		},
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
					classification:
						id !== c.extra && stageOfIndex(id) === "core_group" ? "core_group" : prior ? "returning" : "first_time",
					firstVision: prior === null,
					priorVisionId: prior,
				};
			}),
			stageChanges: [{ personId: c.extra, from: "prospect", to: "attendee" }],
			work: expectedWork,
			attendees: await Promise.all([c.leaver, c.extra].map((id) => storedAttendee(c.v, id))),
		},
	);

	const written = (
		await rows<{
			id: string;
			subject_type: string;
			subject_id: string;
			action: string;
			kind: string;
			after_value: { status?: string };
			reason: string | null;
			metadata: { source?: string };
		}>(sql`SELECT id, subject_type, subject_id, action, kind, before_value, after_value,
		before_revision, after_revision, reason, metadata FROM audit_event WHERE tenant_id=${plant.id}`)
	).filter((r) => !seen.has(r.id));
	const byAction = (action: string) => written.filter((r) => r.action === action);
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
	assert.equal(byAction("meetings.finalized")[0]!.id, result.receiptId);
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
	assert.deepEqual(
		byAction("tasks.changed").map((r) => [r.subject_id, r.kind, r.subject_type, r.metadata.source]),
		[[created.taskId, "create", "task", "generated"]],
	);
	assert.deepEqual(
		byAction("tasks.waived").map((r) => [r.subject_id, r.kind, r.subject_type, r.reason, r.metadata.source]),
		[[dutyOf(c.leaver).task_id, "waive", "task", "Sign-in sheet checked", "generated"]],
	);
	assert.equal(written.length, 1 + 1 + 1 + 1, "no other audit row");
	const closed = byAction("tasks.waived")[0]!;
	assert.equal(closed.after_value.status, "no_longer_needed");
	assert.equal(await stageOf(c.extra), "attendee");
	assert.equal((await classOf(c.v, c.leaver)).presence, "absent");
	assert.equal(
		(await one(sql`SELECT status FROM task WHERE id=${dutyOf(c.leaver).task_id}`)).status,
		"no_longer_needed",
	);
});

test("AC:TARGET-MTG-020 a reconcile that is stale, foreign, too early or not allowed writes nothing, and a replay writes nothing", async () => {
	const c = await crowd(3);
	const snapshot = async () => ({
		audit: (await one(sql`SELECT count(*)::int n FROM audit_event WHERE tenant_id=${plant.id}`)).n,
		revision: await revision(c.v),
		guests: await rows(
			sql`SELECT person_id, presence, revision::text FROM participation WHERE meeting_id=${c.v} ORDER BY person_id`,
		),
		tasks: await one(
			sql`SELECT count(*)::int n, string_agg(status, ',' ORDER BY id) s FROM task WHERE plant_id=${plant.id}`,
		),
	});
	const nothing = async <T,>(body: () => Promise<T>) => {
		const before = await snapshot();
		const result = await body();
		assert.deepEqual(await snapshot(), before);
		return result;
	};
	const stale = await swap(c);
	await nothing(async () =>
		refused(
			await write(owner, writer.reconcileAttendance, {
				...stale,
				expectedRevision: String(BigInt(stale.expectedRevision) - 1n),
			}),
			"conflict",
		),
	);
	const retired = await person("Retired Rae");
	await f.admin.execute(sql`UPDATE person SET state='retired' WHERE id=${retired}`);
	const outsider = await person("Outsider", "prospect", other);
	const named = await nothing(async () =>
		refused(
			await write(owner, writer.reconcileAttendance, await swap(c, [c.extra, retired, outsider])),
			"invalid_subject",
		),
	);
	assert.deepEqual(named.details.personIds.sort(), [retired, outsider].sort());
	const draft = await meeting("vision_meeting", "2026-11-20T23:00:00Z");
	await nothing(async () =>
		refused(
			await write(owner, writer.reconcileAttendance, {
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
				await write(owner, writer.reconcileAttendance, {
					requestKey: key(),
					expectedRevision: await revision(id),
					input: { meetingId: id, attendeeIds: [], followUpAssigneeIds: [], reason: "Not allowed" },
				}),
				"status_transition",
			),
		);
	await nothing(async () => refused(await write(member, writer.reconcileAttendance, await swap(c)), "unavailable"));

	const first = await swap(c);
	const done = ok(await write(owner, writer.reconcileAttendance, first));
	const after = await snapshot();
	const again = ok(await write(owner, writer.reconcileAttendance, first));
	assert.deepEqual(again, done);
	assert.deepEqual(await snapshot(), after);
});

test("INV-locking: two concurrent reconciles at one revision apply once and never deadlock; two concurrent finalizes settle once", async () => {
	const c = await crowd(50);
	const other2 = await person("Second extra");
	const a = await swap(c, [c.extra], [c.leaver]);
	const b = { ...(await swap(c, [other2], [c.ids[7]!])), expectedRevision: a.expectedRevision };
	const settled = await Promise.all([
		write(owner, writer.reconcileAttendance, a),
		write(owner, writer.reconcileAttendance, b),
	]);
	assert.deepEqual(settled.map((r) => (r.status === "ok" ? "applied" : r.error.code)).sort(), ["applied", "conflict"]);
	const winner = settled.find((r) => r.status === "ok")!.value;
	assert.equal(winner.attendanceRevision, String(BigInt(a.expectedRevision) + 1n));
	assert.equal(await revision(c.v), winner.attendanceRevision);

	const people = await rows<{
		id: string;
	}>(sql`INSERT INTO person(tenant_id,plant_id,display_name,source,stage,adult_classification,
		commitment_state,pipeline_position,state,created_at) SELECT ${plant.id},${plant.id},'Twin '||n,'other','prospect',
		'unknown','unknown',0,'live',clock_timestamp() FROM generate_series(1,50) n RETURNING id`);
	const ids = people.map((r) => r.id);
	const m = await meeting("vision_meeting", "2026-12-05T23:00:00Z");
	const request = await finalizeRequest(m, ids);
	const [first, second] = await Promise.all([
		write(owner, writer.finalizeAttendance, request),
		finalize(owner, m, ids),
	]);
	assert.deepEqual([ok(first).outcome, ok(second).outcome].sort(), ["changed", "noop"]);
	assert.equal((await work(m)).length, 51);
});

test("INV-planning: the locked fact read of a settle plans below the JIT threshold", async () => {
	const c = await crowd(50);
	const request = await swap(c);
	ok(await write(owner, writer.reconcileAttendance, request));
	const lock = sent.findLast(
		(q) => q.text.startsWith("SELECT m.id, m.type, m.status") && q.text.includes("obligation_facts"),
	);
	assert.ok(lock, "the settle's locked fact read was not captured");
	const literal = (v: unknown) =>
		v === null ? "NULL" : Array.isArray(v) ? `'{${v.join(",")}}'` : `'${String(v).replaceAll("'", "''")}'`;
	const text = lock.text.replace(/\$(\d+)/g, (_, n) => literal(lock.values[Number(n) - 1]));
	const plan = await f.admin.$client.query(`EXPLAIN (FORMAT JSON) ${text}`);
	const cost = plan.rows[0]["QUERY PLAN"][0].Plan["Total Cost"];
	const threshold = Number((await f.admin.$client.query("SHOW jit_above_cost")).rows[0].jit_above_cost);
	assert.ok(cost < threshold, `planned cost ${cost} passes jit_above_cost ${threshold}`);
});

test("AC:TARGET-MTG-010 a team meeting's leader, an Owner and an Admin settle attendance; another Member cannot", async () => {
	const seated = async (role: "admin" | "member") => {
		const a = await f.account();
		await f.seat(a, plant, role);
		return { ...a, actor: await f.actor(a.session) };
	};
	const [leader, bystander, adminSeat] = [await seated("member"), await seated("member"), await seated("admin")];
	const leaderPerson = await person("Lead Host");
	await f.admin.execute(sql`UPDATE person SET linked_account_id=${leader.id} WHERE id=${leaderPerson}`);
	const team = randomUUID();
	await f.admin.execute(sql`INSERT INTO team(id,plant_id,name,state,sort_order,leader_person_id,leader_source)
		VALUES(${team},${plant.id},'Greeters','active',1,${leaderPerson},'explicit')`);
	const teamMeeting = async (at: string) => {
		const id = await meeting("orientation", at);
		await f.admin.execute(sql`UPDATE meeting SET type='team_meeting', team_id=${team} WHERE id=${id}`);
		return id;
	};
	const guest = await person("Team Guest");

	const led = await teamMeeting("2026-09-03T23:00:00Z");
	refused(await finalize(bystander, led, [guest]), "unavailable");
	ok(await finalize(leader, led, [guest]));
	refused(await reconcile(bystander, led, []), "unavailable");
	ok(await reconcile(leader, led, []));

	for (const [who, at] of [
		[owner, "2026-09-04T23:00:00Z"],
		[adminSeat, "2026-09-05T23:00:00Z"],
	] as const) {
		const m = await teamMeeting(at);
		ok(await finalize(who, m, [guest]));
		ok(await reconcile(who, m, []));
	}
	refused(await finalize(leader, await meeting("orientation", "2026-09-06T23:00:00Z"), [guest]), "unavailable");
});

const NOTHING = { audits: [], jobs: [], notices: 0, mail: 0 };
const only = (...audits: string[]) => ({ ...NOTHING, audits: audits.sort() });
const refusedUntouched = async (body: () => Promise<unknown>, code?: string) =>
	refused(await untouched(f.admin, body), code);
const deniedUntouched = async (body: () => Promise<unknown>) => {
	const { correlationId: _, ...error } = await refusedUntouched(body);
	assert.deepEqual(error, { code: "unavailable", details: {}, retry: "never" });
};

type Church = Awaited<ReturnType<typeof church>>;
async function church() {
	const w = await f.workspace("plant", { timezone: "America/Chicago" });
	const q = await f.workspace("plant", { timezone: "America/New_York" });
	const seated = async (place: Workspace, role: "owner" | "admin" | "member") => {
		const a = await f.account();
		await f.seat(a, place, role);
		return { ...a, actor: await f.actor(a.session) };
	};
	return {
		w,
		q,
		selected: ownerValue.parse(w),
		owner: await seated(w, "owner"),
		admin: await seated(w, "admin"),
		member: await seated(w, "member"),
		strangerMember: await seated(q, "member"),
		strangerAdmin: await seated(q, "admin"),
		seated: (role: "owner" | "admin" | "member") => seated(w, role),
	};
}
const failing = <T,>(event: "INSERT" | "UPDATE", table: string, when: string, body: () => Promise<T>) =>
	failingWrite(f.admin, { on: table, event, when }, body);
const queued = <T extends readonly unknown[]>(
	meetingId: string,
	bodies: { [K in keyof T]: () => Promise<T[K]> },
): Promise<T> => raced<T>(f.admin, f.db, sql`SELECT FROM meeting WHERE id=${meetingId} FOR UPDATE`, bodies);
const note = (who: Seated, input: Record<string, unknown>, k: string = key()) =>
	write(who, writer.addAttendeeNote, { requestKey: k, input });
const invited = (who: Seated, meetingId: string, personId: string) =>
	write(who, guestsWriter.inviteGuest, { requestKey: key(), input: { meetingId, personId } });
const guestOf = async (who: Seated, meetingId: string, personId: string) =>
	ok(await meetingsReader.listGuests(f.db, who.actor, { meetingId })).guests.find(
		(g) => g.person.personId === personId,
	)!;
const rsvp = async (who: Seated, meetingId: string, personId: string) =>
	write(who, guestsWriter.correctRsvp, {
		requestKey: key(),
		expectedRevision: (await guestOf(who, meetingId, personId)).revision,
		input: { meetingId, personId, rsvp: "confirmed" },
	});
const card = async (who: Seated, meetingId: string, personId: string, input: Record<string, unknown>) =>
	write(who, guestsWriter.recordCard, {
		requestKey: key(),
		expectedRevision: (await guestOf(who, meetingId, personId)).revision,
		input: { meetingId, personId, ...input },
	});
const activities = async (c: Church, personId: string) =>
	ok(
		await gatedTransaction(f.db, (tx) =>
			peopleReader.getActivities(tx, new PeopleReadContext(c.admin.actor), activityRequest.parse({ personId })),
		),
	).items;
const stageEvents = async (personId: string) =>
	(
		await rows<{ move: string }>(sql`SELECT (before_value->>'stage')||' to '||(after_value->>'stage') AS move
			FROM audit_event WHERE subject_id=${personId} AND action='people.stage_changed' AND kind<>'noop'
			ORDER BY occurred_at,id`)
	).map((r) => r.move);
async function priorAssessment(w: Workspace) {
	const id = randomUUID();
	await f.admin
		.execute(sql`INSERT INTO assessment_run(id,plant_id,as_of,phase,source_revision,formula_version,rubric_version,
		rubric_sha256,model,outcome,grounding,facts,model_input,drafts,result,attempts,input_tokens,output_tokens,demand,demand_key,
		captured_at,deadline_at,settled_at,available_at) VALUES(${id},${w.id},'2026-10-12T16:00:00Z',1,'rev-1','1','v1','0','model',
		'published','grounded','{"today":"2026-10-12"}','{}','[]','{"draft":{}}',1,1,1,'manual','manual/1','2026-10-12T16:00:00Z',
		'2026-10-12T17:00:00Z','2026-10-12T16:01:00Z','2026-10-12T16:01:00Z')`);
	return () => one(sql`SELECT to_jsonb(r) AS run FROM assessment_run r WHERE id=${id}`);
}
const factors = [
	"attendanceScore",
	"locationScore",
	"logisticsScore",
	"agendaScore",
	"vibeScore",
	"messageScore",
	"closeScore",
	"nextStepsScore",
] as const;
const every = (n: number): Scores => Object.fromEntries(factors.map((k) => [k, n]));
const evaluate = (who: Seated, meetingId: string, scores: Scores, extra: Record<string, unknown> = {}) =>
	write(who, writer.recordEvaluation, { requestKey: key(), input: { meetingId, scores, ...extra } });
const correctTo = (who: Seated, meetingId: string, expectedRevision: string, changes: Scores) =>
	write(who, writer.correctEvaluation, {
		requestKey: key(),
		expectedRevision,
		input: { meetingId, changes, reason: "Correct entered rating" },
	});
const evaluationState = async (meetingId: string) =>
	one(sql`SELECT (SELECT count(*)::int FROM meeting x WHERE x.id=m.id AND x.evaluated_at IS NOT NULL) AS evaluations,
		t.status, (SELECT count(*)::int FROM audit_event a WHERE a.subject_id=t.id AND a.action='tasks.completed') AS completions,
		(SELECT count(*)::int FROM audit_event a WHERE a.subject_id=m.id AND a.metadata->>'event'='evaluation_corrected'
			AND a.kind<>'noop') AS corrections
		FROM meeting m JOIN obligation b ON b.meeting_id=m.id AND b.kind='evaluation' JOIN task t ON t.obligation_id=b.id
		WHERE m.id=${meetingId}`);
const finalizations = async (meetingId: string) =>
	(
		await one<{ n: number }>(
			sql`SELECT count(*)::int n FROM audit_event WHERE subject_id=${meetingId} AND action='meetings.finalized' AND kind<>'noop'`,
		)
	).n;

test("AC:GAP-PPL-020 an actual Vision attendance moves a prospect to attendee once; an invitation, a team meeting and an advanced stage move nobody", async () => {
	const c = await church();
	const alex = await person("Alex", "prospect", c.w),
		casey = await person("Casey", "leader", c.w);
	const uninvolved = await meeting("vision_meeting", "2026-10-03T15:00:00Z", c.w);
	ok(await invited(c.admin, uninvolved, alex));
	const invitedOnly = await recorded(f.admin, () => finalize(c.admin, uninvolved, []));
	assert.deepEqual(ok(invitedOnly.value).stageChanges, []);
	assert.deepEqual(invitedOnly.added, only("meetings.finalized", "tasks.changed"));
	assert.deepEqual([await stageOf(alex), await stageEvents(alex)], ["prospect", []]);

	const m = await meeting("vision_meeting", "2026-10-10T15:00:00Z", c.w);
	await f.admin.execute(sql`UPDATE meeting SET status='completed' WHERE id=${m}`);
	ok(await invited(c.admin, m, alex));
	const request = await finalizeRequest(m, [alex, casey], {}, key());
	for (const who of [c.strangerMember, c.strangerAdmin, c.member]) {
		await deniedUntouched(() => write(who, writer.finalizeAttendance, request));
	}
	await failing("INSERT", "audit_event", `NEW.action = 'people.stage_changed'`, () =>
		refusedUntouched(() => write(c.admin, writer.finalizeAttendance, request), "required_write_failed"),
	);
	assert.deepEqual([await stageOf(alex), await finalizations(uninvolved)], ["prospect", 1]);

	const saved = await recorded(f.admin, () => write(c.admin, writer.finalizeAttendance, request));
	assert.deepEqual(ok(saved.value).stageChanges, [{ personId: alex, from: "prospect", to: "attendee" }]);
	assert.deepEqual(
		saved.added,
		only("meetings.finalized", "people.stage_changed", "tasks.changed", "tasks.changed", "tasks.changed"),
	);
	assert.deepEqual(
		[await stageOf(alex), await stageEvents(alex), await stageOf(casey), await stageEvents(casey)],
		["attendee", ["prospect to attendee"], "leader", []],
	);
	assert.deepEqual(
		(await activities(c, alex)).map((i) => (i.kind === "stage_changed" ? [i.from, i.to] : [i.kind])),
		[["prospect", "attendee"]],
	);
	const replay = await untouched(f.admin, () => write(c.admin, writer.finalizeAttendance, request));
	assert.deepEqual(ok(replay), ok(saved.value));
	const again = await recorded(f.admin, () => finalize(c.admin, m, [alex, casey]));
	assert.deepEqual([ok(again.value).outcome, ok(again.value).stageChanges], ["noop", []]);
	assert.deepEqual(again.added, only("meetings.finalized"));
	const second = await meeting("vision_meeting", "2026-10-11T15:00:00Z", c.w);
	assert.deepEqual(ok(await finalize(c.admin, second, [alex])).stageChanges, []);
	ok(await reconcile(c.admin, second, []));
	ok(await reconcile(c.admin, m, [casey]));
	assert.deepEqual([await stageOf(alex), await stageEvents(alex)], ["attendee", ["prospect to attendee"]]);

	const [pat, dana, lee] = [
		await person("Pat", "prospect", c.w),
		await person("Dana", "core_group", c.w),
		await person("Lee", "launch_team", c.w),
	];
	const onTeam = async <R,>(op: "create" | "createRole" | "assignRole" | "removeRole" | "appointLeader", raw: object) =>
		ok(
			await withTeamsWrite(
				f.db,
				c.admin.actor,
				(tx, ctx) =>
					teamsWriter[op](tx, ctx, { requestKey: key(), ...raw }) as Promise<{ status: "ok"; value: R } | never>,
			),
		);
	const { team } = await onTeam<{ team: { id: string } }>("create", { input: { name: "Hosts", description: null } });
	const { role } = await onTeam<{ role: { id: string } }>("createRole", {
		input: { teamId: team.id, name: "Greeter", leadership: false },
	});
	const rev = async (table: string, id: string) =>
		(await one<{ r: string }>(sql`SELECT revision::text r FROM ${sql.raw(table)} WHERE id=${id}`)).r;
	const assign = async (personId: string) =>
		onTeam("assignRole", {
			expectedRevision: await rev("team", team.id),
			input: { teamId: team.id, roleId: role.id, personId },
		});
	const leave = async (personId: string) =>
		onTeam("removeRole", {
			expectedRevision: await rev("team_role", role.id),
			input: { roleId: role.id, personId },
		});
	for (const id of [dana, dana, casey, pat]) {
		await assign(id);
		await leave(id);
	}
	await onTeam("appointLeader", {
		expectedRevision: await rev("team", team.id),
		input: { teamId: team.id, personId: lee },
	});
	assert.deepEqual(
		await Promise.all([dana, casey, pat, lee].map(async (id) => [await stageOf(id), await stageEvents(id)])),
		[
			["launch_team", ["core_group to launch_team"]],
			["leader", []],
			["prospect", []],
			["leader", ["launch_team to leader"]],
		],
	);
	const teamMeeting = await meeting("orientation", "2026-10-05T15:00:00Z", c.w);
	await f.admin.execute(sql`UPDATE meeting SET type='team_meeting', team_id=${team.id} WHERE id=${teamMeeting}`);
	assert.deepEqual(ok(await finalize(c.admin, teamMeeting, [pat])).stageChanges, []);
	assert.deepEqual([await stageOf(pat), await stageEvents(pat)], ["prospect", []]);
	ok(await finalize(c.admin, await meeting("vision_meeting", "2026-10-12T15:00:00Z", c.w), [pat]));
	assert.deepEqual([await stageOf(pat), await stageEvents(pat)], ["attendee", ["prospect to attendee"]]);
});

test("AC:TARGET-MTG-010 only an earlier actual Vision makes a guest returning, a committed stage keeps its category, and a bad batch or another team's leader changes nothing", async () => {
	const c = await church();
	const [alex, pat] = [await person("Alex", "leader", c.w), await person("Pat", "prospect", c.w)];
	const lee = await person("Lee", "core_group", c.w);
	await f.admin.execute(sql`UPDATE person SET linked_account_id=${c.member.id} WHERE id=${lee}`);
	const team = async (leader: string | null) => {
		const id = randomUUID();
		await f.admin.execute(sql`INSERT INTO team(id,plant_id,name,state,sort_order,leader_person_id,leader_source)
			VALUES(${id},${c.w.id},${id},'active',1,${leader},${leader ? "explicit" : null})`);
		return id;
	};
	const teamMeeting = async (teamId: string, at: string) => {
		const id = await meeting("orientation", at, c.w);
		await f.admin.execute(sql`UPDATE meeting SET type='team_meeting', team_id=${teamId} WHERE id=${id}`);
		return id;
	};
	const own = await teamMeeting(await team(lee), "2026-09-20T15:00:00Z");
	const others = await teamMeeting(await team(null), "2026-09-21T15:00:00Z");
	ok(await finalize(c.member, own, [alex, pat]));

	const m = await meeting("vision_meeting", "2026-10-10T15:00:00Z", c.w);
	const first = ok(await finalize(c.admin, m, [alex, pat]));
	assert.deepEqual(
		first.classifications.map((x) => [x.personId, x.classification, x.firstVision, x.priorVisionId]),
		[
			[alex, "core_group", true, null],
			[pat, "first_time", true, null],
		],
	);
	const backdated = await meeting("vision_meeting", "2026-10-01T15:00:00Z", c.w);
	const earlier = ok(await finalize(c.admin, backdated, [alex, pat]));
	assert.deepEqual(
		earlier.classifications.map((x) => [x.personId, x.classification, x.firstVision, x.priorVisionId]),
		[
			[alex, "core_group", true, null],
			[pat, "first_time", true, null],
		],
	);
	const listed = async () =>
		ok(await read(c.admin, reads.listAttendance, { meetingId: m })).items.map((i) => [
			i.person.personId,
			i.classification,
			i.classificationStage,
			i.priorVisionId,
		]);
	const shown = [
		[alex, "core_group", "leader", backdated],
		[pat, "returning", "prospect", backdated],
	];
	assert.deepEqual(await listed(), shown);
	assert.deepEqual(
		await rows(sql`SELECT o.local_date::text AS earliest, p.stage FROM participation g JOIN meeting o ON o.id=g.prior_vision_id
			JOIN person p ON p.id=g.person_id WHERE g.meeting_id=${m} AND g.person_id=${alex}`),
		[{ earliest: "2026-10-01", stage: "leader" }],
	);
	const { r: patRevision } = await one<{ r: string }>(sql`SELECT revision::text r FROM person WHERE id=${pat}`);
	ok(
		await gatedTransaction(f.db, (tx) =>
			peopleWriter.changeStatus(
				tx,
				{ session: c.admin.actor.session, selected: c.selected },
				{
					requestKey: key(),
					expectedRevision: patRevision,
					input: { personId: pat, stage: "core_group", reason: "Committed later", handoffs: [] },
				},
				reminders,
			),
		),
	);
	assert.deepEqual([await stageOf(pat), await listed()], ["core_group", shown]);

	const draft = await meeting("vision_meeting", "2026-10-12T15:00:00Z", c.w);
	const [casey, dana] = [await person("Casey", "prospect", c.w), await person("Dana", "prospect", c.w)];
	const batch = (ids: string[]) =>
		write(c.admin, writer.captureAttendanceBatch, {
			requestKey: key(),
			input: { meetingId: draft, entries: ids.map((personId) => ({ personId, presence: "attended" })) },
		});
	for (const [bad, code] of [
		[randomUUID(), "invalid_subject"],
		[await person("Foreign", "prospect", c.q), "invalid_subject"],
		["not-an-id", "invalid_input"],
	] as const)
		await refusedUntouched(() => batch([casey, bad, dana]), code);
	const both = await recorded(f.admin, () => batch([casey, dana]));
	assert.deepEqual(
		ok(both.value).attendees.map((a) => [a.person.personId, a.presence]),
		[
			[casey, "attended"],
			[dana, "attended"],
		],
	);
	assert.deepEqual(both.added, only("meetings.changed"));
	await refusedUntouched(() =>
		write(c.admin, writer.clearAttendance, { requestKey: key(), input: { meetingId: draft, personId: alex } }),
	);

	const cleared = (who: Seated, meetingId: string, personId: string) =>
		write(who, writer.clearAttendance, { requestKey: key(), input: { meetingId, personId } });
	ok(await rsvp(c.admin, draft, casey));
	ok(await card(c.admin, draft, casey, { response: "interested", notes: "Call me" }));
	const facts = (meetingId: string, personId: string) =>
		rows(sql`SELECT id, presence, rsvp, card_response, card_notes, removed_at FROM participation
			WHERE meeting_id=${meetingId} AND person_id=${personId}`);
	const [kept] = await facts(draft, casey);
	assert.equal(ok(await cleared(c.admin, draft, casey)).outcome, "changed");
	assert.deepEqual(await facts(draft, casey), [{ ...kept, presence: "absent" }]);
	assert.deepEqual([kept!.rsvp, kept!.card_response, kept!.card_notes], ["confirmed", "interested", "Call me"]);

	const ownDraft = await teamMeeting(
		(await one<{ t: string }>(sql`SELECT team_id t FROM meeting WHERE id=${own}`)).t,
		"2026-10-13T15:00:00Z",
	);
	ok(await invited(c.admin, ownDraft, casey));
	ok(await rsvp(c.admin, ownDraft, casey));
	ok(await write(c.member, writer.checkIn, { requestKey: key(), input: { meetingId: ownDraft, personId: casey } }));
	await f.admin.execute(
		sql`UPDATE participation SET card_response='interested', card_notes='Call me', card_recorded_at=clock_timestamp()
			WHERE meeting_id=${ownDraft} AND person_id=${casey}`,
	);
	const [onTeam] = await facts(ownDraft, casey);
	assert.deepEqual([onTeam!.presence, onTeam!.rsvp], ["attended", "confirmed"]);
	const byLeader = await recorded(f.admin, () => cleared(c.member, ownDraft, casey));
	assert.equal(ok(byLeader.value).outcome, "changed");
	assert.deepEqual(byLeader.added, only("meetings.changed"));
	assert.deepEqual(await facts(ownDraft, casey), [{ ...onTeam, presence: "absent" }]);
	ok(await invited(c.admin, others, casey));
	ok(await write(c.admin, writer.checkIn, { requestKey: key(), input: { meetingId: others, personId: casey } }));
	for (const meetingId of [others, draft]) await refusedUntouched(() => cleared(c.member, meetingId, dana));
	await refusedUntouched(() => cleared(c.member, others, casey));
	await refusedUntouched(() => cleared(c.strangerAdmin, ownDraft, casey));
});

test("AC:TARGET-MTG-012 an empty Vision owes one evaluation nobody owns; a repeat, a race and a failed write add nothing; corrections follow identity and keep performed contact", async () => {
	const c = await church();
	const empty = await meeting("vision_meeting", "2026-10-10T15:00:00Z", c.w);
	const request = await finalizeRequest(empty, []);
	const first = await recorded(f.admin, () => write(c.admin, writer.finalizeAttendance, request));
	const value = ok(first.value);
	assert.deepEqual(first.added, only("meetings.finalized", "tasks.changed"));
	assert.deepEqual(
		[value.attendeeIds, value.work.map((x) => [x.kind, x.outcome, x.personId, x.needsOwner, x.owners])],
		[[], [["meeting_evaluation", "created", null, true, []]]],
	);
	assert.equal(ownerLabel(value.work[0]!.owners[0] ?? null), "Needs owner");
	assert.deepEqual(await work(empty), [
		{ kind: "evaluation", person_id: null, waiver: null, status: "not_started", assignee_ids: [] },
	]);
	assert.deepEqual(ok(await untouched(f.admin, () => write(c.admin, writer.finalizeAttendance, request))), value);
	const repeated = await recorded(f.admin, () => finalize(c.admin, empty, []));
	assert.deepEqual([ok(repeated.value).outcome, repeated.added], ["noop", only("meetings.finalized")]);
	assert.equal((await work(empty)).length, 1);
	assert.equal((await one(sql`SELECT status FROM meeting WHERE id=${empty}`)).status, "in_progress");

	const [alex, jamie, casey] = [
		await person("Alex", "prospect", c.w),
		await person("Jamie", "prospect", c.w),
		await person("Casey", "leader", c.w),
	];
	const v = await meeting("vision_meeting", "2026-10-11T15:00:00Z", c.w);
	const reviewed = await finalizeRequest(v, [alex]);
	for (const [table, when] of [
		["task", "true"],
		["obligation", "NEW.kind = 'follow_up'"],
		["audit_event", "NEW.action = 'meetings.finalized'"],
	] as const)
		await failing("INSERT", table, when, () =>
			refusedUntouched(() => write(c.admin, writer.finalizeAttendance, reviewed), "required_write_failed"),
		);
	assert.deepEqual(await work(v), []);
	assert.deepEqual(await one(sql`SELECT finalized_at, finalized_revision FROM meeting WHERE id=${v}`), {
		finalized_at: null,
		finalized_revision: null,
	});
	const raced = await recorded(f.admin, () =>
		queued<MeetingsReply<{ outcome: string; receiptId: string }>[]>(v, [
			() => write(c.admin, writer.finalizeAttendance, reviewed),
			() => write(c.admin, writer.finalizeAttendance, reviewed),
			() => write(c.owner, writer.finalizeAttendance, { ...reviewed, requestKey: key() }),
		]),
	);
	const [a, b, other] = raced.value.map((r) => ok(r));
	assert.deepEqual([a, b!.outcome, other!.outcome], [b, "changed", "noop"]);
	assert.deepEqual(
		raced.added,
		only("meetings.finalized", "meetings.finalized", "people.stage_changed", "tasks.changed", "tasks.changed"),
	);
	assert.deepEqual(
		(await work(v)).map((x) => [x.kind, x.person_id]),
		[
			["evaluation", null],
			["follow_up", alex],
		],
	);
	assert.equal(await finalizations(v), 1);

	const followUp = await one<{ id: string; r: string }>(sql`SELECT t.id, t.revision::text r FROM task t
		JOIN obligation o ON o.id=t.obligation_id WHERE o.meeting_id=${v} AND o.person_id=${alex}`);
	ok(
		await withFollowUpWrite(f.db, c.admin.actor, (tx, ctx) =>
			createFollowUpWriter({ reminders }).recordOutcome(tx, ctx, {
				requestKey: key(),
				input: {
					target: { kind: "task", taskId: followUp.id, expectedRevision: followUp.r },
					outcome: "contacted",
					occurredAt: "2026-10-12T15:00:00Z",
					completeTask: true,
				},
			}),
		),
	);
	const performed = () =>
		rows(sql`SELECT to_jsonb(x) AS outcome, to_jsonb(t) AS task, to_jsonb(o) AS duty FROM contact_outcome x
			JOIN task t ON t.id=x.task_id JOIN obligation o ON o.id=t.obligation_id WHERE x.plant_id=${c.w.id}`);
	const history = await performed();
	assert.equal(history.length, 1);
	const replaced = await recorded(f.admin, () => reconcile(c.admin, v, [jamie]));
	assert.deepEqual(
		[ok(replaced.value).attendeeIds, ok(replaced.value).added, ok(replaced.value).removed],
		[[jamie], [jamie], [alex]],
	);
	assert.deepEqual(replaced.added, only("meetings.finalized", "people.stage_changed", "tasks.changed"));
	assert.deepEqual(await performed(), history);
	const none = await recorded(f.admin, () => reconcile(c.admin, v, []));
	assert.deepEqual(
		[ok(none.value).attendeeIds, ok(none.value).removed, none.added],
		[[], [jamie], only("meetings.finalized", "tasks.waived")],
	);
	assert.deepEqual(await performed(), history);
	assert.deepEqual(
		(await work(v)).map((x) => [x.kind, x.person_id, x.status]).sort(),
		[
			["evaluation", null, "not_started"],
			["follow_up", alex, "complete"],
			["follow_up", jamie, "no_longer_needed"],
		].sort(),
	);
	assert.deepEqual(
		ok(await read(c.admin, reads.listAttendance, { meetingId: v })).items.map((i) => i.presence),
		["absent", "absent"],
	);
	const back = ok(await reconcile(c.admin, v, [casey]));
	assert.deepEqual([back.attendeeIds, back.added], [[casey], [casey]]);
	assert.deepEqual(await performed(), history);
});

test("AC:TARGET-TSK-017 finalizing owes one follow-up per first-time attendee and one evaluation for each origin meeting; a repeat, a waiver, a deletion or a failure never adds another", async () => {
	const c = await church();
	const [alex, casey] = [await person("Alex", "prospect", c.w), await person("Casey", "prospect", c.w)];
	const at = "2026-10-13T23:00:00Z";
	const [m1, m2] = [await meeting("vision_meeting", at, c.w), await meeting("vision_meeting", at, c.w)];
	const request = await finalizeRequest(m1, [alex, casey], { evaluationAssigneeIds: [c.admin.id] });
	await failing("INSERT", "audit_event", `NEW.action = 'meetings.finalized'`, () =>
		refusedUntouched(() => write(c.admin, writer.finalizeAttendance, request), "required_write_failed"),
	);
	assert.deepEqual(
		await one(sql`SELECT (SELECT count(*)::int FROM task WHERE plant_id=${c.w.id}) AS tasks,
			(SELECT count(*)::int FROM obligation WHERE plant_id=${c.w.id}) AS obligations,
			(SELECT count(*)::int FROM meeting WHERE plant_id=${c.w.id} AND finalized_at IS NOT NULL) AS markers`),
		{ tasks: 0, obligations: 0, markers: 0 },
	);
	const saved = await recorded(f.admin, () => write(c.admin, writer.finalizeAttendance, request));
	assert.deepEqual(
		ok(saved.value)
			.work.map((x) => [x.kind, x.personId, x.outcome, x.assigneeIds, x.needsOwner])
			.sort(),
		[
			["first_vision_follow_up", alex, "created", [], true],
			["first_vision_follow_up", casey, "created", [], true],
			["meeting_evaluation", null, "created", [c.admin.id], false],
		].sort(),
	);
	assert.deepEqual(
		{ ...saved.added, notices: 0, mail: 0 },
		only(
			"meetings.finalized",
			"people.stage_changed",
			"people.stage_changed",
			"tasks.changed",
			"tasks.changed",
			"tasks.changed",
		),
	);
	await untouched(f.admin, () => write(c.admin, writer.finalizeAttendance, request));
	const origin = (meetingId: string) =>
		rows<{ id: string; person_id: string }>(sql`SELECT id, person_id, origin_date::text, due_date::text, timezone,
			origin_at='2026-10-13T23:00:00Z' AS at FROM obligation WHERE meeting_id=${meetingId} AND kind='follow_up' ORDER BY person_id`);
	const same = { origin_date: "2026-10-13", due_date: "2026-10-15", timezone: "America/Chicago", at: true };
	ok(await finalize(c.admin, m2, [alex, casey]));
	const [one_, two] = [await origin(m1), await origin(m2)];
	assert.deepEqual(
		[...one_, ...two],
		[
			...one_.map((x) => ({ id: x.id, person_id: x.person_id, ...same })),
			...two.map((x) => ({ id: x.id, person_id: x.person_id, ...same })),
		],
	);
	assert.deepEqual(new Set([...one_, ...two].map((x) => x.id)).size, 4);

	const tasks = createTaskWriter({ reminders });
	const duty = (personId: string) =>
		one<{
			id: string;
			r: string;
		}>(sql`SELECT t.id, t.revision::text r FROM task t JOIN obligation o ON o.id=t.obligation_id
			WHERE o.meeting_id=${m1} AND o.person_id=${personId}`);
	const onTask = async (personId: string, op: "waive" | "delete" | "edit", input: object = {}) => {
		const t = await duty(personId);
		return ok(
			await withTaskWrite(
				f.db,
				c.admin.actor,
				(tx, ctx) =>
					tasks[op](tx, ctx, {
						requestKey: key(),
						expectedRevision: t.r,
						input: { taskId: t.id, ...input },
					}) as Promise<{
						status: "ok";
						value: unknown;
					}>,
			),
		);
	};
	await onTask(alex, "waive", { reason: "Moved away" });
	await onTask(alex, "edit", { patch: { title: "Renamed" } });
	await onTask(casey, "delete");
	const stored = () =>
		rows(sql`SELECT o.id, o.waiver_reason, t.id AS task, t.status, t.title, t.deleted_at IS NOT NULL AS deleted
			FROM obligation o JOIN task t ON t.obligation_id=o.id WHERE o.meeting_id=${m1} ORDER BY t.id`);
	const settled = await stored();
	assert.deepEqual(
		settled.map((x) => [x.status, x.deleted, x.waiver_reason]).sort(),
		[
			["no_longer_needed", false, "Moved away"],
			["not_started", false, null],
			["not_started", true, null],
		].sort(),
	);
	ok(await finalize(c.admin, m1, [alex, casey]));
	ok(await reconcile(c.admin, m1, [alex, casey]));
	assert.deepEqual(await stored(), settled);
	const dana = await person("Dana", "prospect", c.w);
	const added = ok(await reconcile(c.admin, m1, [alex, casey, dana]));
	assert.deepEqual(
		added.work.filter((x) => x.outcome === "created").map((x) => [x.kind, x.personId]),
		[["first_vision_follow_up", dana]],
	);
	assert.deepEqual(
		(await stored()).filter((x) => settled.some((s) => s.task === x.task)),
		settled,
	);
});

test("AC:TARGET-MTG-013 a card belongs to its own guest, no card is unknown, and prayer notes reach no Member, public link or organization", async () => {
	const c = await church();
	const org = await f.workspace("sending_network");
	const director = await f.account();
	await f.seat(director, org, "owner");
	const watcher = { ...director, actor: await f.actor(director.session) };
	await f.admin.execute(sql`INSERT INTO affiliation(plant_id,organization_id,accepted_at,share_people,share_meetings,
		share_tasks,share_ministry_teams,share_wiki,share_activity,shared_findings)
		VALUES(${c.w.id},${org.id},clock_timestamp(),true,true,true,true,true,true,true)`);
	const m = await meeting("vision_meeting", "2099-10-10T15:00:00Z", c.w);
	const [alex, casey] = [await person("Alex", "prospect", c.w), await person("Casey", "prospect", c.w)];
	ok(await write(c.admin, writer.checkIn, { requestKey: key(), input: { meetingId: m, personId: alex } }));
	ok(await invited(c.admin, m, casey));
	const breakdown = async (who = c.admin) => ok(await meetingsReader.cardBreakdown(f.db, who.actor, { meetingId: m }));
	const counted = async () => {
		const x = await breakdown();
		return [
			x.attended.total,
			x.attended.withCard,
			x.attended.unknown,
			x.attended.responses.not_interested,
			x.absentWithCard.total,
			x.absentWithCard.responses.not_interested,
		];
	};
	assert.deepEqual(await counted(), [1, 0, 1, 0, 0, 0]);
	const saved = await recorded(f.admin, () =>
		card(c.admin, m, casey, { response: "not_interested", notes: "PRAYER-CANARY", occurredAt: "2026-10-10T16:00:00Z" }),
	);
	assert.equal(ok(saved.value).outcome, "changed");
	assert.deepEqual(saved.added, only("meetings.response_recorded"));
	assert.deepEqual(await counted(), [1, 0, 1, 0, 1, 1]);
	const cards = async (who: Seated) =>
		ok(await meetingsReader.listCards(f.db, who.actor, { meetingId: m })).cards.map((x) => [
			x.personId,
			x.response,
			x.notes,
			x.occurredAt,
		]);
	const at = "2026-10-10T16:00:00.000Z";
	assert.deepEqual(await cards(c.admin), [[casey, "not_interested", "PRAYER-CANARY", at]]);
	assert.deepEqual(await cards(c.member), [[casey, "not_interested", null, at]]);
	for (const [who, notes] of [
		[c.admin, "PRAYER-CANARY"],
		[c.member, null],
	] as const)
		assert.deepEqual(
			ok(await meetingsReader.pageGuests(f.db, who.actor, { meetingId: m })).cards.cards.map((x) => x.notes),
			[notes],
		);
	assert.equal((await guestOf(c.admin, m, alex)).hasCard, false);
	assert.deepEqual([await stageOf(alex), await stageOf(casey)], ["prospect", "prospect"]);

	const token = await issueRsvpToken(f.admin as never, c.w.id, m, casey);
	const link = await describeRsvpToken(f.db, { token });
	assert.equal(link.state, "pending");
	const held = await meeting("vision_meeting", "2026-09-01T15:00:00Z", c.w);
	ok(await finalize(c.admin, held, [await person("Guest", "prospect", c.w)]));
	const seen = await getPlant(f.db, watcher.actor, c.w.id);
	assert.equal(seen?.sections.meetings.status, "shared");
	for (const shown of [link, seen, await activities(c, casey), await breakdown(c.member)])
		assert.equal(JSON.stringify(shown).includes("PRAYER-CANARY"), false);
	for (const who of [watcher, c.strangerAdmin]) {
		refused(await meetingsReader.listCards(f.db, who.actor, { meetingId: m }), "unavailable");
		refused(await meetingsReader.cardBreakdown(f.db, who.actor, { meetingId: m }), "unavailable");
	}
	const { revision: current } = await guestOf(c.admin, m, casey);
	const raw = (who: Seated, input: Record<string, unknown>) =>
		write(who, guestsWriter.recordCard, {
			requestKey: key(),
			expectedRevision: current,
			input: { meetingId: m, personId: casey, response: "interested", ...input },
		});
	for (const bad of [
		{ personId: "not-an-id" },
		{ response: "maybe" },
		{ response: "   " },
		{ name: "   " },
		{ notes: "x".repeat(2001) },
		{ occurredAt: "2099-01-01T00:00:00Z" },
	])
		await refusedUntouched(() => raw(c.admin, bad), "invalid_input");
	for (const who of [c.member, watcher, c.strangerAdmin]) await refusedUntouched(() => raw(who, {}));
	const stranger = await person("Stranger", "prospect", c.w);
	await refusedUntouched(() => raw(c.admin, { personId: stranger }));
	for (const type of ["orientation", "prelaunch_practice"]) {
		const other_ = await meeting(type, "2026-10-09T15:00:00Z", c.w);
		ok(await invited(c.admin, other_, casey));
		await refusedUntouched(async () => card(c.admin, other_, casey, { response: "interested" }), "wrong_meeting_type");
	}

	const corrected = await recorded(f.admin, () =>
		raw(c.admin, { notes: "CORRECTED-CANARY", occurredAt: "2026-10-10T17:00:00Z" }),
	);
	assert.equal(ok(corrected.value).card!.response, "interested");
	assert.deepEqual(corrected.added, only("meetings.response_recorded"));
	await refusedUntouched(() => raw(c.admin, {}), "conflict");
	assert.deepEqual(await cards(c.admin), [[casey, "interested", "CORRECTED-CANARY", "2026-10-10T17:00:00.000Z"]]);
	const clearing = {
		requestKey: key(),
		expectedRevision: (await guestOf(c.admin, m, casey)).revision,
		input: { meetingId: m, personId: casey, reason: "Wrong guest" },
	};
	const cleared = await recorded(f.admin, () => write(c.admin, guestsWriter.clearCard, clearing));
	assert.equal(ok(cleared.value).card, null);
	assert.deepEqual(cleared.added, only("meetings.response_recorded"));
	assert.deepEqual(
		ok(await untouched(f.admin, () => write(c.admin, guestsWriter.clearCard, clearing))),
		ok(cleared.value),
	);
	assert.deepEqual([await counted(), await cards(c.admin)], [[1, 0, 1, 0, 0, 0], []]);
	assert.deepEqual(
		await rows(sql`SELECT kind, before_value->>'response' AS before, after_value->>'response' AS after, reason, actor_id
			FROM audit_event WHERE action='meetings.response_recorded' AND metadata->>'meetingId'=${m} ORDER BY occurred_at, id`),
		[
			{ kind: "create", before: null, after: "not_interested", reason: null, actor_id: c.admin.id },
			{ kind: "correct", before: "not_interested", after: "interested", reason: null, actor_id: c.admin.id },
			{ kind: "correct", before: "interested", after: null, reason: "Wrong guest", actor_id: c.admin.id },
		],
	);
	ok(await card(c.admin, m, alex, { response: "not_interested" }));
	assert.deepEqual(await counted(), [1, 1, 0, 1, 0, 0]);
});

test("AC:TARGET-MTG-014 one Vision keeps one human evaluation with its computed average; a forged average, a rival, another meeting type and a failed task settlement add nothing", async () => {
	const c = await church();
	const m = await meeting("vision_meeting", "2026-10-10T15:00:00Z", c.w);
	ok(await finalize(c.admin, m, [await person("Alex", "prospect", c.w)]));
	const open = { evaluations: 0, status: "not_started", completions: 0, corrections: 0 };
	assert.deepEqual(await evaluationState(m), open);
	for (const forged of [{ average: 5 }, { submittedAverage: 5 }, { scores: { ...every(1), average: 5 } }])
		await refusedUntouched(() => evaluate(c.admin, m, every(1), forged), "invalid_input");
	for (const score of [0, 6, 1.5, "5", null])
		await refusedUntouched(() => evaluate(c.admin, m, { ...every(1), closeScore: score as number }), "invalid_input");
	const { closeScore: _, ...seven } = every(1);
	await refusedUntouched(() => evaluate(c.admin, m, seven as Scores), "invalid_input");
	for (const who of [c.member, c.strangerAdmin, c.strangerMember])
		await refusedUntouched(() => evaluate(who, m, every(1)));
	for (const type of ["orientation", "prelaunch_practice", "team_meeting"]) {
		const id = await meeting("orientation", "2026-10-09T15:00:00Z", c.w);
		const team = randomUUID();
		await f.admin.execute(
			sql`INSERT INTO team(id,plant_id,name,state,sort_order) VALUES(${team},${c.w.id},${team},'active',1)`,
		);
		await f.admin.execute(
			sql`UPDATE meeting SET type=${type}, team_id=${type === "team_meeting" ? team : null} WHERE id=${id}`,
		);
		ok(await finalize(c.admin, id, []));
		await refusedUntouched(() => evaluate(c.admin, id, every(1)), "wrong_meeting_type");
	}
	await failing("UPDATE", "task", "NEW.status = 'complete'", () =>
		refusedUntouched(() => evaluate(c.admin, m, every(1)), "required_write_failed"),
	);
	assert.deepEqual(await evaluationState(m), open);

	const raced = await touched(f.admin, () =>
		recorded(f.admin, () =>
			queued<
				MeetingsReply<{
					outcome: string;
					taskCompleted: boolean;
					evaluation: { average: number; evaluator: unknown; scores: unknown };
				}>[]
			>(m, [() => evaluate(c.admin, m, every(1)), () => evaluate(c.owner, m, every(5))]),
		),
	);
	const [kept, seen] = raced.value.value.map((r) => ok(r));
	assert.deepEqual(
		[kept!.outcome, kept!.taskCompleted, kept!.evaluation.average, kept!.evaluation.scores, kept!.evaluation.evaluator],
		["changed", true, 1, every(1), { kind: "current_account", accountId: c.admin.id }],
	);
	assert.deepEqual([seen!.outcome, seen!.taskCompleted, seen!.evaluation], ["noop", false, kept!.evaluation]);
	assert.deepEqual(raced.value.added, only("meetings.changed", "meetings.changed", "tasks.completed"));
	assert.deepEqual(raced.tables, ["audit_event", "meeting", "plant", "record", "task"]);
	assert.deepEqual(await evaluationState(m), { ...open, evaluations: 1, status: "complete", completions: 1 });
	assert.deepEqual(await shownEvaluation(c.owner, m), kept!.evaluation);
	assert.deepEqual(
		ok(await read(c.admin, reads.evaluationTrend, { from: "2026-10-01", to: "2026-10-31" })).points.map((p) => [
			p.meetingId,
			p.average,
		]),
		[[m, 1]],
	);
	const best = await meeting("vision_meeting", "2026-10-11T15:00:00Z", c.w);
	ok(await finalize(c.admin, best, []));
	const one_ = await recorded(f.admin, () => evaluate(c.admin, best, every(5)));
	assert.equal(ok(one_.value).evaluation.average, 5);
	assert.deepEqual(one_.added, only("meetings.changed", "tasks.completed"));
});

test("AC:GAP-MTG-015 AC:TARGET-MTG-015 a reviewed correction keeps the old rating once; a stale tab, a rival, another church and a failed write change nothing", async () => {
	const c = await church();
	const m = await meeting("vision_meeting", "2026-10-20T15:00:00Z", c.w);
	ok(await finalize(c.admin, m, [await person("Alex", "prospect", c.w)]));
	const { evaluation } = ok(await evaluate(c.admin, m, every(3)));
	assert.deepEqual([evaluation.revision, evaluation.average], ["1", 3]);
	const assessment = await priorAssessment(c.w);
	const before = await assessment();
	const source = async () =>
		(await one<{ r: string }>(sql`SELECT material_revision::text r FROM plant WHERE id=${c.w.id}`)).r;
	const done = { evaluations: 1, status: "complete", completions: 1 };
	assert.deepEqual(await evaluationState(m), { ...done, corrections: 0 });
	const request = {
		requestKey: key(),
		expectedRevision: "1",
		input: { meetingId: m, changes: { attendanceScore: 4 }, reason: "Correct entered rating" },
	};
	for (const who of [c.strangerMember, c.strangerAdmin, c.member]) {
		await deniedUntouched(() => write(who, writer.correctEvaluation, request));
	}
	for (const [event, table, when] of [
		["UPDATE", "meeting", "NEW.evaluation_corrected_at IS NOT NULL"],
		["INSERT", "audit_event", "NEW.action = 'meetings.corrected'"],
	] as const)
		await failing(event, table, when, () =>
			refusedUntouched(() => write(c.admin, writer.correctEvaluation, request), "required_write_failed"),
		);
	await f.admin.execute(sql.raw("ALTER TABLE obligation RENAME TO obligation_away"));
	try {
		refused(await write(c.admin, writer.correctEvaluation, request), "required_write_failed");
	} finally {
		await f.admin.execute(sql.raw("ALTER TABLE obligation_away RENAME TO obligation"));
	}
	assert.deepEqual(await shownEvaluation(c.admin, m), evaluation);

	const sourceBefore = await source();
	const saved = await recorded(f.admin, () => write(c.admin, writer.correctEvaluation, request));
	const { evaluation: corrected, taskCompleted } = ok(saved.value);
	assert.deepEqual(
		[corrected.scores, corrected.average, corrected.revision, taskCompleted],
		[{ ...every(3), attendanceScore: 4 }, 3.1, "2", false],
	);
	assert.deepEqual(saved.added, only("meetings.corrected"));
	assert.equal(BigInt(await source()) - BigInt(sourceBefore), 1n);
	assert.deepEqual(await untouched(f.admin, () => write(c.admin, writer.correctEvaluation, request)), saved.value);
	const history = async () => ok(await read(c.admin, reads.evaluationHistory, { meetingId: m })).entries;
	assert.deepEqual(
		(await history()).map((e) => [e.kind, e.before, e.after, e.average, e.reason, e.actor]),
		[
			[
				"recorded",
				null,
				every(3),
				{ before: null, after: 3 },
				null,
				{ kind: "current_account", accountId: c.admin.id },
			],
			[
				"corrected",
				{ attendanceScore: 3 },
				{ attendanceScore: 4 },
				{ before: 3, after: 3.1 },
				"Correct entered rating",
				{ kind: "current_account", accountId: c.admin.id },
			],
		],
	);
	assert.deepEqual([await evaluationState(m), await assessment()], [{ ...done, corrections: 1 }, before]);

	for (const stale of ["1", "3"])
		await refusedUntouched(() => correctTo(c.owner, m, stale, { attendanceScore: 5 }), "conflict");
	await refusedUntouched(() => correctTo(c.strangerAdmin, m, "2", { attendanceScore: 5 }));
	const other_ = await meeting("vision_meeting", "2026-10-21T15:00:00Z", c.q);
	await refusedUntouched(() => correctTo(c.admin, other_, "2", { attendanceScore: 5 }));
	const task = await one<{ id: string; r: string }>(sql`SELECT t.id, t.revision::text r FROM task t
		JOIN obligation o ON o.id=t.obligation_id WHERE o.meeting_id=${m} AND o.kind='evaluation'`);
	ok(
		await withTaskWrite(f.db, c.admin.actor, (tx, ctx) =>
			createTaskWriter({ reminders }).reopen(tx, ctx, {
				requestKey: key(),
				expectedRevision: task.r,
				input: { taskId: task.id },
			}),
		),
	);
	const tabs = await recorded(f.admin, () =>
		queued<MeetingsReply<{ outcome: string }>[]>(m, [
			() => correctTo(c.admin, m, "2", { vibeScore: 5 }),
			() => correctTo(c.owner, m, "2", { vibeScore: 1 }),
		]),
	);
	assert.equal(ok(tabs.value[0]!).outcome, "changed");
	refused(tabs.value[1], "conflict");
	assert.deepEqual(tabs.added, only("meetings.corrected"));
	assert.deepEqual((await shownEvaluation(c.admin, m)).scores, { ...every(3), attendanceScore: 4, vibeScore: 5 });
	assert.deepEqual(await evaluationState(m), { evaluations: 1, status: "not_started", completions: 1, corrections: 2 });
	assert.deepEqual([(await history()).length, await assessment()], [3, before]);
});

test("AC:TARGET-MTG-016 a report reads corrected scores without rewriting history, counts only attended Persons and calls no evidence unknown", async () => {
	const c = await church();
	const [alex, casey, dana] = [
		await person("Alex", "prospect", c.w),
		await person("Casey", "prospect", c.w),
		await person("Dana", "core_group", c.w),
	];
	const m = await meeting("vision_meeting", "2026-10-10T15:00:00Z", c.w);
	ok(await invited(c.admin, m, alex));
	const analytics = async (meetingId: string) => ok(await read(c.admin, reads.readAnalytics, { meetingId }));
	const unknown = { status: "unknown" };
	const unmeasured = await untouched(f.admin, () => analytics(m));
	assert.deepEqual(
		[unmeasured.attended, unmeasured.growth, unmeasured.classifications, unmeasured.evaluation],
		[unknown, unknown, null, { meetingId: m, current: unknown, baseline: unknown, delta: unknown, corrected: false }],
	);
	ok(await finalize(c.admin, m, []));
	const none = await analytics(m);
	assert.deepEqual(
		[none.attended, none.growth, none.evaluation!.baseline],
		[{ status: "known", value: 0 }, unknown, unknown],
	);

	const score = async (at: string, attendees: string[], n: number) => {
		const id = await meeting("vision_meeting", at, c.w);
		ok(await finalize(c.admin, id, attendees));
		return { id, revision: ok(await evaluate(c.admin, id, every(n))).evaluation.revision };
	};
	const first = await score("2026-10-11T15:00:00Z", [alex], 2);
	const last = await score("2026-10-12T15:00:00Z", [alex, casey, dana], 4);
	const compared = async (id: string) => {
		const x = ok(await read(c.admin, reads.compareEvaluation, { meetingId: id }));
		return [x.current, x.baseline, x.delta, x.corrected];
	};
	const known = (value: number) => ({ status: "known", value });
	assert.deepEqual(await compared(first.id), [known(2), unknown, unknown, false]);
	assert.deepEqual(await compared(last.id), [known(4), { ...known(2), count: 1 }, known(2), false]);
	const shown = await analytics(last.id);
	assert.deepEqual(
		[shown.attended, shown.growth, shown.classifications],
		[known(3), { status: "known", difference: 2, percent: 200 }, { first_time: 1, returning: 1, core_group: 1 }],
	);
	const twin = await score("2026-10-12T15:00:00Z", [], 1);
	assert.deepEqual(await compared(last.id), [known(4), { ...known(2), count: 1 }, known(2), false]);
	assert.deepEqual(await compared(twin.id), [known(1), { ...known(2), count: 1 }, known(-1), false]);
	const grown = await analytics(first.id);
	assert.deepEqual([grown.attended, grown.growth], [known(1), { status: "unavailable", difference: 1 }]);

	ok(await correctTo(c.admin, first.id, first.revision, every(3)));
	ok(await correctTo(c.admin, last.id, last.revision, { attendanceScore: 5 }));
	assert.deepEqual(await compared(last.id), [known(4.1), { ...known(3), count: 1 }, known(1.1), true]);
	await untouched(f.admin, async () => {
		ok(await read(c.admin, reads.summaryStats, {}));
		ok(await read(c.admin, reads.attendanceTrend, {}));
		ok(await read(c.admin, reads.evaluationTrend, {}));
		await analytics(last.id);
		await compared(last.id);
	});
	assert.deepEqual(
		ok(await read(c.admin, reads.evaluationHistory, { meetingId: last.id })).entries.map((e) => [e.kind, e.average]),
		[
			["recorded", { before: null, after: 4 }],
			["corrected", { before: 4, after: 4.1 }],
		],
	);
	for (const who of [c.member, c.strangerAdmin])
		refused(await read(who, reads.compareEvaluation, { meetingId: last.id }), "unavailable");
});

test("AC:GAP-MTG-017 AC:TARGET-MTG-017 a note reaches only the attended guest it names, once, and a forged link, a blank, an over-long text or a failed write adds nothing", async () => {
	const c = await church();
	const [alex, casey] = [await person("Alex", "prospect", c.w), await person("Casey", "leader", c.w)];
	const m = await meeting("vision_meeting", "2026-10-20T15:00:00Z", c.w);
	const elsewhere = await meeting("vision_meeting", "2026-10-21T15:00:00Z", c.w);
	const foreignMeeting = await meeting("vision_meeting", "2026-10-21T15:00:00Z", c.q);
	const foreignPerson = await person("Foreign", "prospect", c.q);
	ok(await finalize(c.strangerAdmin, foreignMeeting, [foreignPerson]));
	ok(await invited(c.admin, m, casey));
	const request = await finalizeRequest(m, [alex], {}, key());
	ok(await write(c.admin, writer.finalizeAttendance, request));
	ok(await untouched(f.admin, () => write(c.admin, writer.finalizeAttendance, request)));
	ok(await finalize(c.admin, elsewhere, [casey]));
	const assessment = await priorAssessment(c.w);
	const before = await assessment();
	const text = "Called today; prefers evening interview";
	const requestKey = key();
	const input = { meetingId: m, personId: alex, text };
	for (const who of [c.member, c.strangerMember, c.strangerAdmin]) {
		await deniedUntouched(() => note(who, input, requestKey));
	}
	for (const [table, when] of [
		["person_note", "true"],
		["audit_event", "NEW.action = 'people.updated'"],
	] as const)
		await failing("INSERT", table, when, () =>
			refusedUntouched(() => note(c.admin, input, requestKey), "required_write_failed"),
		);
	const saved = await recorded(f.admin, () => note(c.admin, input, requestKey));
	const value = ok(saved.value);
	assert.deepEqual(saved.added, only("people.updated"));
	assert.deepEqual(
		[value.authorId, value.personId, value.meetingId, value.meetingType, value.text],
		[c.admin.id, alex, m, "vision_meeting", text],
	);
	assert.deepEqual(ok(await untouched(f.admin, () => note(c.admin, input, requestKey))), value);
	const stored = () =>
		rows(sql`SELECT n.body, n.author_id, g.meeting_id, n.person_id, n.occurred_at=n.recorded_at AS instant FROM person_note n
			JOIN participation g ON g.id=n.participation_id WHERE n.plant_id=${c.w.id}`);
	assert.deepEqual(await stored(), [
		{ body: text, author_id: c.admin.id, meeting_id: m, person_id: alex, instant: true },
	]);
	assert.deepEqual(
		(await activities(c, alex)).filter((i) => i.kind === "note").map((i) => i.kind === "note" && i.body),
		[text],
	);
	for (const forged of [
		{ personId: casey },
		{ meetingId: elsewhere },
		{ meetingId: foreignMeeting },
		{ personId: foreignPerson },
		{ meetingId: foreignMeeting, personId: foreignPerson },
		{ meetingId: randomUUID() },
		{ personId: randomUUID() },
	])
		await refusedUntouched(() => note(c.admin, { ...input, ...forged }));
	for (const bad of [
		{ meetingType: "orientation" },
		{ authorId: c.owner.id },
		{ text: "" },
		{ text: " \n\t " },
		{ text: "x".repeat(5001) },
	])
		await refusedUntouched(() => note(c.admin, { ...input, ...bad }), "invalid_input");
	assert.equal(ok(await note(c.owner, { ...input, text: ` ${"x".repeat(5000)} ` })).text.length, 5000);
	assert.deepEqual([(await stored()).length, await finalizations(m), await assessment()], [2, 1, before]);
});
