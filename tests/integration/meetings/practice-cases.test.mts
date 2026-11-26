import test, { after, before } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { sql, type SQL } from "../../../packages/db/src/query.ts";
import type { WriteTx } from "../../../packages/domain/src/access/session.ts";
import { frozenClock, instant } from "../../../packages/contracts/src/common/index.ts";
import { CRITERION_KEYS } from "../../../packages/contracts/src/phases/index.ts";
import {
	DERIVED_MILESTONES,
	PRACTICE_MILESTONE,
	PRACTICES_REQUIRED,
	reviewedOf,
	type Milestone,
	type Plan,
} from "../../../packages/contracts/src/launch/index.ts";
import type { MeetingsReply } from "../../../packages/contracts/src/meetings/index.ts";
import {
	authorizeLaunchNotices,
	createLaunchReader,
	createLaunchWriter,
} from "../../../packages/domain/src/launch/index.ts";
import {
	attendanceReader,
	createAttendanceWriter,
	guestsWriter,
	meetingsReader,
	meetingsWriter,
	venuesWriter,
	withMeetingsWrite,
	type MeetingsContext,
} from "../../../packages/domain/src/meetings/index.ts";
import { readCatalog } from "../../../packages/domain/src/phases/index.ts";
import { createTaskWriter, withTaskWrite } from "../../../packages/domain/src/tasks/index.ts";
import { createMailService } from "../../../packages/domain/src/jobs/mail.ts";
import { seatedNotificationService } from "../../../packages/domain/src/jobs/seated-notifications.ts";
import { launchNotices } from "../../../apps/web/src/features/launch/notices.ts";
import { fixture } from "../identity/invitations-support.mts";
import { ok, refused, type Workspace } from "../../support/fixture.mts";
import { NOTHING, recorded } from "../../support/recorded.mts";

type Case = {
	id: string;
	given: Record<string, Record<string, unknown>>;
	clock: { now: string; zone: string };
	action: { operation: string; arguments: Record<string, unknown> };
	expected: { result: Record<string, unknown>; event: null };
};
const root = fileURLToPath(new URL("../../../", import.meta.url));
const { cases } = JSON.parse(readFileSync(join(root, "docs/acceptance/launch.json"), "utf8")) as { cases: Case[] };
const caseOf = (id: string) => cases.find((c) => c.id === id) ?? assert.fail(`no case ${id}`);
const inputs = (c: Case) => c.given["launch-inputs"] ?? assert.fail(`no launch inputs in ${c.id}`);
const NOW = new Date(caseOf("B02-008").clock.now).toISOString();
const CLOCK = frozenClock(instant.parse(NOW));

let f: Awaited<ReturnType<typeof fixture>>;
let launch: ReturnType<typeof createLaunchWriter>;
let plans: ReturnType<typeof createLaunchReader>;
let attendance: ReturnType<typeof createAttendanceWriter>;
let tasks: ReturnType<typeof createTaskWriter>;
type Row = Record<string, unknown>;
const rows = async <R extends Row = Row>(q: SQL) => (await f.admin.execute<R>(q)).rows;
const one = async <R extends Row = Row>(q: SQL) => (await rows<R>(q))[0]!;
const count = async (q: SQL) => (await one<{ n: number }>(q)).n;
const key = () => randomUUID();
type Seated = Awaited<ReturnType<typeof seated>>;
type Church = Awaited<ReturnType<typeof church>>;
type Meeting = { id: string; revision: string };

async function seated(w: Workspace, role: "owner" | "admin" | "member") {
	const a = await f.account();
	await f.seat(a, w, role);
	return { ...a, actor: await f.actor(a.session) };
}
async function church(planned: string | null = "2026-11-10") {
	const w = await f.workspace("plant");
	await f.admin.execute(sql`UPDATE plant SET name='Harvest Point', timezone='America/Chicago' WHERE id=${w.id}`);
	const owner = await seated(w, "owner");
	const admin = await seated(w, "admin");
	const member = await seated(w, "member");
	if (planned)
		ok(
			await launch.schedule(f.db, owner.actor, {
				requestKey: key(),
				expectedRevision: "1",
				input: { date: planned, reason: null },
			}),
		);
	return { w, owner, admin, member };
}
async function person(w: { id: string }, name: string) {
	const id = randomUUID();
	await f.admin.execute(sql`INSERT INTO person(id,tenant_id,plant_id,display_name,source,stage,adult_classification,
		commitment_state,pipeline_position,state,created_at)
		VALUES(${id},${w.id},${w.id},${name},'other','prospect','unknown','unknown','1','live',clock_timestamp())`);
	return id;
}
const write = <R,>(
	who: Seated,
	op: (tx: WriteTx, ctx: MeetingsContext, raw: unknown) => Promise<MeetingsReply<R>>,
	input: unknown,
) => withMeetingsWrite(f.db, who.actor, (tx, ctx) => op(tx, ctx, input));
const heldAt = (date: string) => new Date(`${date}T15:00:00.000Z`).toISOString();
async function practice(c: Church, date: string, fields: Row = {}) {
	return ok(
		await write(c.owner, meetingsWriter.schedule, {
			requestKey: key(),
			input: { type: "prelaunch_practice", date, time: "10:00", ...fields },
		}),
	).meeting;
}
const complete = (who: Seated, m: Meeting, date: string, requestKey: string = key()) =>
	write(who, meetingsWriter.completePractice, {
		requestKey,
		expectedRevision: m.revision,
		input: { meetingId: m.id, occurredAt: heldAt(date) },
	});
const correct = (who: Seated, m: Meeting, input: Row) =>
	write(who, meetingsWriter.correctPracticeOccurrence, {
		requestKey: key(),
		expectedRevision: m.revision,
		input: { meetingId: m.id, reason: "Checked the sign-in sheet", ...input },
	});
const voidOccurrence = (who: Seated, m: Meeting, voided = true) =>
	write(who, meetingsWriter.correctOccurrence, {
		requestKey: key(),
		expectedRevision: m.revision,
		input: { meetingId: m.id, voided, reason: "Duplicate entry" },
	});
const counted = async (who: Seated) => ok(await meetingsReader.listCompletedPreLaunchPractices(f.db, who.actor));
const detail = async (who: Seated, meetingId: string) => {
	const r = ok(await meetingsReader.get(f.db, who.actor, { meetingId }));
	assert.ok(r.status === "available");
	return r.meeting;
};
const plan = async (who: Seated) => ok(await plans.readPlan(f.db, who.actor)).plan;
const services = (p: Plan) =>
	p.milestones.find((m) => m.templateKey === PRACTICE_MILESTONE) ?? assert.fail("no milestone");
const tick = (who: Seated, t: { id: string; revision: string }) =>
	withTaskWrite(f.db, who.actor, (tx, ctx) =>
		tasks.complete(tx, ctx, { requestKey: key(), expectedRevision: t.revision, input: { taskId: t.id } }),
	);
const milestoneWrite = (
	who: Seated,
	op: "completeMilestone" | "reopenMilestone",
	m: Milestone,
	requestKey: string = key(),
) =>
	launch[op](f.db, who.actor, {
		requestKey,
		expectedRevision: m.revision,
		input: op === "completeMilestone" ? { milestoneId: m.id, reviewed: reviewedOf(m.tasks) } : { milestoneId: m.id },
	});
const finalize = async (who: Seated, meetingId: string, attendeeIds: string[]) =>
	write(who, attendance.finalizeAttendance, {
		requestKey: key(),
		expectedRevision: (
			await one<{ r: string }>(sql`SELECT attendance_revision::text r FROM meeting WHERE id=${meetingId}`)
		).r,
		input: { meetingId, attendeeIds },
	});
const quiet = async <T,>(body: () => Promise<T>) => {
	const { value, added } = await recorded(f.admin, body);
	assert.deepEqual(added, NOTHING, "a read writes no audit, job, notice or mail");
	return value;
};

before(async () => {
	f = await fixture({ clock: new Date(NOW) });
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
	plans = createLaunchReader(CLOCK);
	launch = createLaunchWriter({ notices: launchNotices(seatedNotificationService(mail)), clock: CLOCK });
	attendance = createAttendanceWriter({ reminders: async () => {} });
	tasks = createTaskWriter({ reminders: async () => {} });
});
after(() => f?.close());

test("AC:B02-007 a practice is its own type in create, filter and detail, and a team rehearsal and a Vision Meeting keep theirs", async () => {
	const c = caseOf("B02-007");
	const ch = await church(null);
	const team = randomUUID();
	await f.admin.execute(
		sql`INSERT INTO team(id,plant_id,name,state,sort_order) VALUES(${team},${ch.w.id},'Worship','active',1)`,
	);
	const shapes: Record<string, Row> = {
		prelaunch_practice: { type: "prelaunch_practice" },
		team_rehearsal: { type: "team_meeting", teamId: team, subtype: "rehearsal" },
		vision: { type: "vision_meeting" },
	};
	const made: Record<string, Meeting> = {};
	for (const label of inputs(c).types as string[])
		made[label] = ok(
			await write(ch.owner, meetingsWriter.schedule, {
				requestKey: key(),
				input: { ...shapes[label], date: "2026-10-20", time: "18:30" },
			}),
		).meeting;
	const stored = () => rows(sql`SELECT id,type,subtype,team_id FROM meeting WHERE plant_id=${ch.w.id} ORDER BY id`);
	const before = await stored();
	assert.deepEqual(before.map((r) => [r.type, r.subtype]).sort(), [
		["prelaunch_practice", null],
		["team_meeting", "rehearsal"],
		["vision_meeting", null],
	]);
	const list = (types: string[]) =>
		quiet(async () => ok(await meetingsReader.list(f.db, ch.member.actor, { types, limit: 100 })).items);
	const filtered = await list(["prelaunch_practice"]);
	assert.deepEqual(
		filtered.map((m) => m.id),
		[made.prelaunch_practice!.id],
	);
	assert.deepEqual([...new Set(filtered.map((m) => m.type))], c.expected.result.practice_filter);
	const all = await list(["prelaunch_practice", "team_meeting", "vision_meeting"]);
	assert.deepEqual(
		new Map(all.map((m) => [m.id, m.type])),
		new Map([
			[made.prelaunch_practice!.id, "prelaunch_practice"],
			[made.team_rehearsal!.id, "team_meeting"],
			[made.vision!.id, "vision_meeting"],
		]),
	);
	assert.deepEqual(
		(await list(["vision_meeting"])).map((m) => m.id),
		[made.vision!.id],
	);
	const shown = await quiet(() => detail(ch.member, made.prelaunch_practice!.id));
	assert.deepEqual(
		[shown.type, shown.subtype, shown.displayTitle, shown.visionNumber],
		["prelaunch_practice", null, "Pre-launch Practice", null],
	);
	const rehearsal = await detail(ch.member, made.team_rehearsal!.id);
	assert.deepEqual([rehearsal.type, rehearsal.subtype], ["team_meeting", "rehearsal"]);
	assert.equal((await detail(ch.member, made.vision!.id)).visionNumber, 1);
	refused(
		await write(ch.owner, meetingsWriter.edit, {
			requestKey: key(),
			expectedRevision: made.prelaunch_practice!.revision,
			input: { meetingId: made.prelaunch_practice!.id, patch: { type: "vision_meeting" } },
		}),
		"invalid_input",
	);
	const after = await stored();
	assert.equal(
		before.filter((r, i) => JSON.stringify(r) !== JSON.stringify(after[i])).length,
		c.expected.result.other_types_changed,
	);
	assert.equal(c.expected.event, null);
});

test("AC:B02-008 four distinct held practices count once each, and a repeated receipt for the third adds nothing", async () => {
	const c = caseOf("B02-008");
	const { practice_ids, actual_dates } = inputs(c) as { practice_ids: string[]; actual_dates: string[] };
	const ch = await church(null);
	const made = new Map<string, { m: Meeting; requestKey: string }>();
	const receipts = new Map<string, string[]>();
	for (const [i, label] of practice_ids.entries()) {
		const date = actual_dates[i]!;
		if (!made.has(label)) made.set(label, { m: await practice(ch, date), requestKey: key() });
		const { m, requestKey } = made.get(label)!;
		const done = ok(await complete(ch.owner, m, date, requestKey));
		receipts.set(label, [...(receipts.get(label) ?? []), done.receiptId]);
	}
	const repeated = receipts.get("PR3")!;
	assert.equal(repeated.length, 2);
	assert.equal(repeated[0], repeated[1], "the duplicate receipt replays the first");
	const pr3 = made.get("PR3")!.m;
	assert.equal(
		await count(sql`SELECT count(*)::int n FROM audit_event WHERE subject_id=${pr3.id} AND kind='complete'`),
		1,
	);
	const again = ok(await complete(ch.owner, await detail(ch.owner, pr3.id), "2026-10-08"));
	assert.equal(again.outcome, "noop", "a fresh request for the same held time changes nothing");
	const result = await quiet(() => counted(ch.member));
	assert.deepEqual({ distinct_completed_practices: result.count, criterion: result.criterion }, c.expected.result);
	assert.deepEqual(new Set(result.meetingIds), new Set([...made.values()].map((x) => x.m.id)));
	for (const [label, { m }] of made)
		assert.equal((await detail(ch.owner, m.id)).occurrence.heldAt, heldAt(actual_dates[practice_ids.indexOf(label)]!));
	assert.equal(c.expected.event, null);
});

test("AC:B02-009 only a completed practice held before now counts; scheduled, cancelled, not held and future ones do not", async () => {
	const c = caseOf("B02-009");
	const ch = await church(null);
	const ids: Record<string, string> = {};
	ids.scheduled = (await practice(ch, "2026-10-12")).id;

	const cancel = await practice(ch, "2026-10-11");
	const cancelled = ok(
		await write(ch.owner, meetingsWriter.changeStatus, {
			requestKey: key(),
			expectedRevision: cancel.revision,
			input: { meetingId: cancel.id, to: "cancelled" },
		}),
	).meeting;
	refused(await complete(ch.owner, cancelled, "2026-10-11"), "status_transition");
	refused(
		await correct(ch.owner, cancelled, { state: "completed", occurredAt: heldAt("2026-10-11") }),
		"practice_cancelled",
	);
	ids.cancelled = cancel.id;

	const notHeld = await practice(ch, "2026-10-10");
	const held = ok(await complete(ch.owner, notHeld, "2026-10-10")).meeting;
	ok(await correct(ch.owner, held, { state: "not_completed" }));
	ids.not_held = notHeld.id;

	const future = await practice(ch, "2026-10-14");
	const early = refused(await complete(ch.owner, future, "2026-10-14"), "invalid_input");
	assert.deepEqual(early.details.issues, [{ path: "occurredAt", problem: "in_the_future" }]);
	ids.completed_future = future.id;

	const past = await practice(ch, "2026-10-09");
	const done = ok(await complete(ch.owner, past, "2026-10-09")).meeting;
	refused(await correct(ch.owner, done, { state: "completed", occurredAt: heldAt("2026-10-14") }), "invalid_input");
	const corrected = ok(await correct(ch.owner, done, { state: "completed", occurredAt: heldAt("2026-10-08") })).meeting;
	assert.equal(corrected.occurrence.heldAt, heldAt("2026-10-08"), "a nonfuture correction is kept");
	ids.completed_past = past.id;

	const states = inputs(c).states as string[];
	const result = await quiet(() => counted(ch.member));
	assert.deepEqual(
		states.map((s) => (result.meetingIds as string[]).includes(ids[s]!)),
		c.expected.result.counts_as_evidence,
	);
	const listed = ok(
		await meetingsReader.list(f.db, ch.member.actor, { types: ["prelaunch_practice"], limit: 100 }),
	).items;
	assert.deepEqual(
		states.map((s) => listed.find((m) => m.id === ids[s])!.status),
		["planning", "cancelled", "planning", "planning", "completed"],
	);
	assert.equal(result.criterion, "not_met");
	assert.equal(c.expected.event, null);
});

test("AC:B02-010 finalized attendance, four guests and ticked tasks never complete a scheduled practice", async () => {
	const c = caseOf("B02-010");
	const given = inputs(c);
	const ch = await church();
	const guests = [];
	for (let i = 0; i < Number(given.guest_count); i++) guests.push(await person(ch.w, `Guest ${i + 1}`));
	const m = await practice(ch, "2026-10-12", { guests: guests.slice(0, -1) });
	ok(
		await write(ch.owner, guestsWriter.inviteGuest, {
			requestKey: key(),
			input: { meetingId: m.id, personId: guests.at(-1) },
		}),
	);
	assert.equal((await detail(ch.owner, m.id)).guestCount, given.guest_count);
	assert.equal(given.attendance_finalized, true);
	ok(await finalize(ch.owner, m.id, guests));
	assert.equal(given.tasks_complete, true);
	for (const t of services(await plan(ch.owner)).tasks) ok(await tick(ch.owner, t));
	const after = await detail(ch.owner, m.id);
	assert.equal(given.practice_status, "scheduled");
	assert.deepEqual([after.status, after.occurrence.heldAt], ["planning", null]);
	assert.equal((await counted(ch.member)).count, c.expected.result.completed_practices);
	const shown = services(await plan(ch.owner));
	assert.equal(shown.practices!.held, c.expected.result.completed_practices);
	assert.ok(shown.tasks.every((t) => t.status === "complete"));
	assert.equal(
		await count(sql`SELECT count(*)::int n FROM audit_event WHERE subject_id=${m.id} AND kind='complete'`),
		0,
	);
	assert.equal(c.expected.event, null);
});

test("AC:B02-011 a corrected date and a refused type change keep the count; voiding the duplicate drops it to two and the earlier receipt still says three", async () => {
	const c = caseOf("B02-011");
	const given = inputs(c) as { practice_ids: string[]; void: string; snapshot_count: number };
	const ch = await church();
	const dates = ["2026-10-01", "2026-10-04", "2026-10-08"];
	const made = new Map<string, Meeting>();
	for (const [i, label] of given.practice_ids.entries()) {
		const m = await practice(ch, dates[i]!);
		made.set(label, ok(await complete(ch.owner, m, dates[i]!)).meeting);
	}
	const open = services(await plan(ch.owner));
	assert.equal(open.practices!.held, given.snapshot_count);
	const snapshotKey = key();
	const completed = ok(await milestoneWrite(ch.owner, "completeMilestone", open, snapshotKey)).milestone;
	assert.equal(completed.practices!.held, given.snapshot_count);

	const pr1 = made.get("PR1")!;
	const moved = ok(await correct(ch.owner, pr1, { state: "completed", occurredAt: heldAt("2026-10-02") })).meeting;
	assert.equal(moved.occurrence.heldAt, heldAt("2026-10-02"));
	refused(
		await write(ch.owner, meetingsWriter.edit, {
			requestKey: key(),
			expectedRevision: moved.revision,
			input: { meetingId: pr1.id, patch: { type: "vision_meeting" } },
		}),
		"invalid_input",
	);
	assert.equal((await detail(ch.owner, pr1.id)).type, "prelaunch_practice");
	assert.equal((await counted(ch.owner)).count, given.snapshot_count, "a date correction keeps the practice");

	const duplicate = made.get(given.void)!;
	const voided = ok(await voidOccurrence(ch.owner, duplicate)).meeting;
	assert.ok(voided.occurrence.voidedAt);
	const reopened = ok(await milestoneWrite(ch.owner, "reopenMilestone", services(await plan(ch.owner)))).milestone;
	assert.deepEqual([reopened.completion, reopened.practices!.held], [null, 2]);

	const now = await quiet(() => counted(ch.member));
	const replay = ok(await milestoneWrite(ch.owner, "completeMilestone", open, snapshotKey)).milestone;
	const stored = await one<{ held: number }>(
		sql`SELECT (result->>'practices')::int held FROM audit_event WHERE request_key=${snapshotKey}`,
	);
	assert.deepEqual(
		{ current_count: now.count, snapshot_count: replay.practices!.held, criterion: now.criterion },
		c.expected.result,
	);
	assert.equal(stored.held, given.snapshot_count);
	assert.equal(services(await plan(ch.owner)).practices!.held, now.count);
	assert.deepEqual(
		(
			await rows(
				sql`SELECT kind, before_value->>'voidedAt' AS was FROM audit_event WHERE subject_id=${duplicate.id} ORDER BY occurred_at`,
			)
		).map((r) => r.kind),
		["create", "complete", "correct"],
	);
	assert.equal(c.expected.event, null);
});

test("AC:B02-012 an archived genuine practice still counts and a voided invalid one does not", async () => {
	const c = caseOf("B02-012");
	const given = inputs(c) as Record<string, { completed: boolean; archived?: boolean; voided?: boolean }>;
	const ch = await church(null);
	const made = new Map<string, string>();
	for (const [i, label] of ["PR1", "PR2"].entries()) {
		const date = `2026-10-0${i + 4}`;
		const m = await practice(ch, date);
		let held = given[label]!.completed ? ok(await complete(ch.owner, m, date)).meeting : m;
		if (given[label]!.archived)
			ok(
				await write(ch.owner, meetingsWriter.delete, {
					requestKey: key(),
					expectedRevision: held.revision,
					input: { meetingId: m.id, reason: "Tidy the list" },
				}),
			);
		if (given[label]!.voided) held = ok(await voidOccurrence(ch.owner, held)).meeting;
		made.set(m.id, label);
	}
	const result = await quiet(() => counted(ch.member));
	assert.deepEqual({ counted_ids: result.meetingIds.map((id) => made.get(id)) }, c.expected.result);
	const archived = [...made].find(([, l]) => l === "PR1")![0];
	assert.deepEqual(ok(await meetingsReader.get(f.db, ch.owner.actor, { meetingId: archived })), {
		status: "unavailable",
	});
	assert.deepEqual(
		await one(
			sql`SELECT status, retired_at IS NOT NULL retired, occurrence_voided_at IS NULL kept FROM meeting WHERE id=${archived}`,
		),
		{ status: "completed", retired: true, kept: true },
		"the archived practice is hidden, not voided",
	);
	assert.equal(c.expected.event, null);
});

test("AC:B02-013 a practice keeps its agenda, venue and guests, and has no Vision number, kit, card, evaluation, first-timer task or training credit", async () => {
	const c = caseOf("B02-013");
	const given = inputs(c) as { type: string; agenda: string[]; venue: string; guests: string[] };
	const ch = await church(null);
	const venue = ok(
		await write(ch.owner, venuesWriter.create, {
			requestKey: key(),
			input: { name: given.venue, address: "100 Main St", capacity: 80 },
		}),
	).venue;
	const alex = await person(ch.w, given.guests[0]!);
	const m = await practice(ch, "2026-10-12", { venue: { kind: "existing", venueId: venue.id }, guests: [alex] });
	const agenda = ok(
		await write(ch.owner, meetingsWriter.replaceAgenda, {
			requestKey: key(),
			expectedRevision: m.revision,
			input: { meetingId: m.id, sections: given.agenda.map((title, i) => ({ id: `s${i}`, title, minutes: 30 })) },
		}),
	).agenda;
	refused(
		await write(ch.owner, meetingsWriter.populateKit, {
			requestKey: key(),
			expectedRevision: agenda.revision,
			input: { meetingId: m.id },
		}),
		"wrong_meeting_type",
	);
	const guest = ok(await meetingsReader.listGuests(f.db, ch.owner.actor, { meetingId: m.id })).guests[0]!;
	refused(
		await write(ch.owner, guestsWriter.recordCard, {
			requestKey: key(),
			expectedRevision: guest.revision,
			input: { meetingId: m.id, personId: alex, response: "interested" },
		}),
		"wrong_meeting_type",
	);
	ok(await complete(ch.owner, { id: m.id, revision: agenda.revision }, "2026-10-12"));
	ok(await finalize(ch.owner, m.id, [alex]));
	const scores = Object.fromEntries(
		["attendance", "location", "logistics", "agenda", "vibe", "message", "close", "nextSteps"].map((k) => [
			`${k}Score`,
			4,
		]),
	);
	refused(
		await write(ch.owner, attendance.recordEvaluation, { requestKey: key(), input: { meetingId: m.id, scores } }),
		"wrong_meeting_type",
	);
	const shown = await detail(ch.member, m.id);
	assert.deepEqual(
		[shown.type, shown.agenda.sections.map((s) => s.title), shown.venue?.name, shown.guestCount],
		[given.type, given.agenda, given.venue, given.guests.length],
	);
	const effects = await one(sql`SELECT
		(SELECT count(*)::int FROM meeting_kit_item WHERE meeting_id=${m.id}) kit_items,
		(SELECT evaluation_scores IS NOT NULL FROM meeting WHERE id=${m.id}) scored,
		(SELECT count(*)::int FROM training_credit WHERE plant_id=${ch.w.id}) credits,
		(SELECT count(*)::int FROM obligation WHERE meeting_id=${m.id}) obligations,
		(SELECT count(*)::int FROM participation WHERE meeting_id=${m.id} AND card_response IS NOT NULL) cards`);
	assert.deepEqual(effects, { kit_items: 0, scored: false, credits: 0, obligations: 0, cards: 0 });
	assert.deepEqual(
		{
			vision_number: shown.visionNumber,
			vision_kit: shown.kit,
			evaluations: Number(effects.scored),
			training_credit: effects.credits,
		},
		c.expected.result,
	);
	assert.equal(c.expected.event, null);
});

test("AC:B02-014 the third held practice meets the criterion but completes no milestone or task, moves no phase and grants no authority", async () => {
	const c = caseOf("B02-014");
	const given = inputs(c) as { complete_practices: string[]; phase: string; open_tasks: string[] };
	const ch = await church();
	const phase = Number(given.phase.replace("Phase", ""));
	await f.admin.execute(sql`UPDATE plant SET phase=${phase} WHERE id=${ch.w.id}`);
	const start = services(await plan(ch.owner));
	const [open, ...rest] = start.tasks;
	assert.equal(given.open_tasks.length, 1);
	for (const t of rest) ok(await tick(ch.owner, t));
	const footprint = () =>
		one(sql`SELECT (SELECT phase FROM plant WHERE id=${ch.w.id}) phase,
			(SELECT count(*)::int FROM phase_transition WHERE plant_id=${ch.w.id}) transitions,
			(SELECT coalesce(array_agg(role||':'||account_id ORDER BY account_id),'{}') FROM seat WHERE plant_id=${ch.w.id}) seats,
			(SELECT count(*)::int FROM launch_milestone WHERE plant_id=${ch.w.id} AND completed_at IS NOT NULL) completed,
			(SELECT count(*)::int FROM task WHERE plant_id=${ch.w.id} AND status='complete') done`);
	const before = await footprint();
	for (const [i] of given.complete_practices.entries()) {
		const date = `2026-10-0${i + 1}`;
		ok(await complete(ch.owner, await practice(ch, date), date));
	}
	const p = await quiet(() => plan(ch.owner));
	const shown = services(p);
	assert.ok(shown.practices!.held >= PRACTICES_REQUIRED);
	const task = shown.tasks.find((t) => t.id === open!.id)!;
	assert.deepEqual(
		{
			criterion: shown.practices!.held >= shown.practices!.required ? "met" : "not_met",
			phase: `Phase${(await one<{ phase: number }>(sql`SELECT phase FROM plant WHERE id=${ch.w.id}`)).phase}`,
			task_status: task.status === "not_started" ? "pending" : task.status,
			milestone_completion_count: p.milestones.filter((m) => m.completion !== null).length,
		},
		c.expected.result,
	);
	assert.deepEqual(await footprint(), before);
	assert.equal((await counted(ch.member)).criterion, "met");
	refused(await milestoneWrite(ch.member, "completeMilestone", shown), "access_denied");
	refused(await complete(ch.member, await practice(ch, "2026-10-05"), "2026-10-05"));
	assert.equal(c.expected.event, null);
});

test("AC:B02-015 an Owner and an Admin write practices; a Member, a team leader and another church's Admin cannot", async () => {
	const c = caseOf("B02-015");
	const ch = await church(null);
	const other = await church(null);
	const leader = await seated(ch.w, "member");
	const lead = await person(ch.w, "Lee Leader");
	await f.admin.execute(sql`UPDATE person SET linked_account_id=${leader.id} WHERE id=${lead}`);
	const team = randomUUID();
	await f.admin.execute(sql`INSERT INTO team(id,plant_id,name,state,sort_order,leader_person_id,leader_source)
		VALUES(${team},${ch.w.id},'Hosts','active',1,${lead},'explicit')`);
	const teamMeeting = ok(
		await write(ch.owner, meetingsWriter.schedule, {
			requestKey: key(),
			input: { type: "team_meeting", teamId: team, date: "2026-10-12", time: "09:00" },
		}),
	).meeting;
	const marks = ok(await attendanceReader.listAttendance(f.db, leader.actor, { meetingId: teamMeeting.id }));
	assert.equal(marks.viewerCanMarkAttendance, true, "the team leader exception is real for the team's own meeting");
	const who: Record<string, Seated> = {
		Owner: ch.owner,
		Admin: ch.admin,
		Member: ch.member,
		team_leader: leader,
		foreign_Admin: other.admin,
	};
	const footprint = () =>
		one(sql`SELECT (SELECT count(*)::int FROM meeting WHERE plant_id=${ch.w.id}) meetings,
			(SELECT count(*)::int FROM audit_event WHERE tenant_id=${ch.w.id}) audits,
			(SELECT coalesce(array_agg(status||':'||coalesce(actual_occurrence_at::text,'') ORDER BY id),'{}') FROM meeting WHERE plant_id=${ch.w.id}) states`);
	const allowed: boolean[] = [];
	for (const role of inputs(c).roles as string[]) {
		const target = await practice(ch, "2026-10-11");
		const before = await footprint();
		const scheduled = await write(who[role]!, meetingsWriter.schedule, {
			requestKey: key(),
			input: { type: "prelaunch_practice", date: "2026-10-12", time: "10:00" },
		});
		const completed = await complete(who[role]!, target, "2026-10-11");
		const corrected = await correct(who[role]!, completed.status === "ok" ? completed.value.meeting : target, {
			state: "not_completed",
		});
		const foreign = role.startsWith("foreign");
		if (foreign) {
			const own = ok(scheduled).meeting.id;
			assert.equal(
				(await one(sql`SELECT plant_id FROM meeting WHERE id=${own}`)).plant_id,
				other.w.id,
				"another church's Admin schedules only in their own church",
			);
		}
		const attempts = foreign ? [completed, corrected] : [scheduled, completed, corrected];
		const results = attempts.map((r) => r.status === "ok");
		assert.ok(
			results.every((x) => x === results[0]),
			`${role}: ${JSON.stringify(attempts)}`,
		);
		if (!results[0]) {
			for (const r of attempts) refused(r);
			assert.deepEqual(await footprint(), before, `${role} wrote nothing in this church`);
		}
		allowed.push(results[0]!);
	}
	assert.deepEqual({ practice_write_allowed: allowed }, c.expected.result);
	assert.equal(c.expected.event, null);
});

const check = (catalog: string) =>
	new Promise<{ code: number; stdout: string }>((resolve) =>
		execFile(
			"python3",
			[join(root, "docs/catalog/check-operation-references.py"), "--root", catalog],
			(error, stdout) => resolve({ code: error ? Number(error.code) : 0, stdout }),
		),
	);

test("AC:B02-032 the target catalog names the native practice and debrief commands, the criterion keys stay, and the catalog guard refuses a catalog without them", async () => {
	const c = caseOf("B02-032");
	const { catalog, case_scope, criterion_contract } = c.action.arguments as Record<
		"catalog" | "case_scope" | "criterion_contract",
		string
	>;
	const { operations } = JSON.parse(readFileSync(join(root, catalog), "utf8")) as {
		operations: { id: string; kind: string; durable_write: boolean; case_ids?: string[] }[];
	};
	const expected = c.expected.result as { operation_ids: string[]; guest_key: string; debrief_key: string };
	const scoped = operations.filter((o) => o.case_ids?.includes(case_scope));
	for (const id of expected.operation_ids) {
		const op = scoped.find((o) => o.id === id) ?? assert.fail(`${id} is not in the ${case_scope} scope`);
		assert.deepEqual([op.kind, op.durable_write], ["command", true]);
	}
	const contract = JSON.parse(readFileSync(join(root, criterion_contract), "utf8")) as {
		requirements: { id: string; text: string; case_ids: string[] }[];
	};
	assert.ok(contract.requirements.some((r) => r.id === "REQ-KNOW-065" && r.case_ids.includes(case_scope)));
	const keyed = contract.requirements.map((r) => r.text).join("\n");
	for (const k of [expected.guest_key, expected.debrief_key]) assert.match(keyed, new RegExp(`\\b${k}\\b`));
	assert.deepEqual([...DERIVED_MILESTONES], [expected.guest_key, expected.debrief_key]);
	const phases = await readCatalog();
	const launchSunday = phases.phases.find((p) => p.criteria.some((x) => x.key === expected.guest_key))!;
	assert.deepEqual(
		launchSunday.criteria.map((x) => x.key).filter((k) => DERIVED_MILESTONES.includes(k as never)),
		[expected.guest_key, expected.debrief_key],
	);
	assert.ok(
		CRITERION_KEYS.includes(expected.guest_key as never) && CRITERION_KEYS.includes(expected.debrief_key as never),
	);

	const dir = mkdtempSync(join(tmpdir(), "b02-032-"));
	try {
		mkdirSync(join(dir, "docs/catalog"), { recursive: true });
		const served = readFileSync(join(root, "docs/catalog/evry-tools.json"), "utf8");
		writeFileSync(join(dir, "docs/catalog/evry-tools.json"), served);
		const inventory = (ids: string[]) =>
			writeFileSync(
				join(dir, "docs/catalog/operations.json"),
				JSON.stringify({ operations: ids.map((id) => ({ id })) }),
			);
		inventory(operations.map((o) => o.id));
		assert.equal((await check(dir)).code, 0);
		inventory(operations.map((o) => o.id).filter((id) => !expected.operation_ids.includes(id)));
		const planted = await check(dir);
		assert.equal(planted.code, 1);
		for (const id of expected.operation_ids) assert.match(planted.stdout, new RegExp(`unknown operation ${id}\\b`));
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}

	const ch = await church();
	for (const derived of DERIVED_MILESTONES)
		refused(
			await launch.completeMilestone(f.db, ch.owner.actor, {
				requestKey: key(),
				expectedRevision: "1",
				input: { milestoneId: derived, reviewed: "" },
			}),
			"derived_evidence_only",
		);
	assert.equal(c.expected.event, null);
});
