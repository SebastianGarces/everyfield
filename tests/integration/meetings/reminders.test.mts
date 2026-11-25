import test, { after, before } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { frozenClock, instant, owner } from "../../../packages/contracts/src/common/index.ts";
import { sql } from "../../../packages/db/src/query.ts";
import { authorizeNotificationMail } from "../../../packages/domain/src/jobs/notice-mail.ts";
import {
	createMailService,
	MAIL_PASSES,
	runDueMail,
	type MailTransport,
} from "../../../packages/domain/src/jobs/mail.ts";
import { enqueueJob } from "../../../packages/domain/src/jobs/queue.ts";
import {
	guestsWriter,
	meetingsReader,
	meetingsWriter,
	planNotifications,
} from "../../../packages/domain/src/meetings/index.ts";
import { gatedTransaction } from "../../../packages/domain/src/operations/writes.ts";
import { timezoneOperations } from "../../../packages/domain/src/settings/index.ts";
import { taskReader } from "../../../packages/domain/src/tasks/index.ts";
import { createNotificationWorker } from "../../../apps/web/src/features/notifications/worker.ts";
import { ownerLabel } from "../../../apps/web/src/features/tasks/model.ts";
import { ok } from "../../support/fixture.mts";
import { key, meetingsWorld, NOW, type MeetingsWorld } from "./meetings-world.mts";

let w: MeetingsWorld;
let spring: MeetingsWorld;
before(async () => {
	w = await meetingsWorld("mtg_reminders");
	spring = await meetingsWorld("mtg_spring", new Date("2026-02-01T16:00:00Z"));
});
after(async () => {
	await w?.close();
	await spring?.close();
});

const ORDER = sql`array_position(ARRAY['announcement','day_7','day_3','day_1'], split_part(producer_key,'/',2))`;
const jobs = (s: MeetingsWorld, meetingId: string, state = "ready") =>
	s
		.rows<{ slot: string; at: Date | string }>(
			sql`SELECT split_part(producer_key,'/',2) AS slot, eligible_at AS at FROM job
				WHERE kind='notification' AND subject_record_id=${meetingId} AND state=${state} ORDER BY ${ORDER}, id`,
		)
		.then((list) => list.map((j) => [j.slot, new Date(j.at).toISOString()]));
const plan = async (s: MeetingsWorld, meetingId: string, asOf: Date | string = NOW) => {
	const planned = await planNotifications(s.db, s.P.id, { meetingId, asOf: new Date(asOf).toISOString() });
	assert.ok(planned);
	return planned.slots;
};
const recipients = async (meetingId: string, slot: string) =>
	(await plan(w, meetingId)).find((x) => x.slot === slot)!.recipients;
const notices = (s: MeetingsWorld, meetingId: string) =>
	s
		.rows<{ slot: string; recipient: string; state: string }>(
			sql`SELECT split_part(n.logical_key,'/',5) AS slot, n.recipient_id AS recipient, m.state FROM notice n
				LEFT JOIN mail m ON m.notice_id=n.id WHERE n.source_record_id=${meetingId}
				ORDER BY n.eligible_at, n.recipient_id`,
		)
		.then((list) => list.map((n) => [n.slot, n.recipient, n.state]));
const sent: string[] = [];
let answer: (to: string) => Awaited<ReturnType<MailTransport["send"]>> = () => ({ kind: "accepted", id: randomUUID() });
const service = (s: MeetingsWorld, authorize = authorizeNotificationMail) =>
	createMailService({
		db: s.db,
		encryptionKey: Buffer.alloc(32, 3),
		addressKey: Buffer.alloc(32, 4),
		from: "meetings@example.test",
		authorize,
		transport: {
			async send(payload) {
				sent.push(payload.to);
				return answer(payload.to);
			},
			async lookup() {
				return { kind: "unknown" };
			},
		},
	});
async function tick(s: MeetingsWorld, meetingId: string, at: string, authorize = authorizeNotificationMail) {
	await s.admin.execute(sql`UPDATE job SET eligible_at=clock_timestamp()-interval '1 second'
		WHERE kind='notification' AND subject_record_id=${meetingId} AND state='ready' AND eligible_at<=${at}::timestamptz`);
	return createNotificationWorker({ mail: service(s, authorize) }).run(s.db, new Date(at).toISOString());
}
async function deliver(s: MeetingsWorld, meetingId: string) {
	await s.admin.execute(sql`UPDATE job j SET eligible_at=clock_timestamp()-interval '1 second' FROM mail m
		JOIN notice n ON n.id=m.notice_id WHERE j.subject_record_id=m.id AND n.source_record_id=${meetingId} AND j.state='ready'`);
	sent.length = 0;
	await runDueMail(s.db, service(s), MAIL_PASSES.notice, 50, Infinity);
	return [...sent].sort();
}
const removeGuest = async (meetingId: string, personId: string) =>
	ok(
		await w.change(guestsWriter.removeGuest, (await w.guestOf(meetingId, personId)).revision, { meetingId, personId }),
	);

test("AC:B03-012 reminders seven, three and one civil days before a March 10 09:00 Chicago meeting cross the clock change once, and a zone edit leaves the meeting's instant", async () => {
	const m = await spring.schedule({ type: "orientation", date: "2026-03-10", time: "09:00" });
	assert.deepEqual([m.startsAt, m.zone], ["2026-03-10T14:00:00.000Z", "America/Chicago"]);
	const INSTANTS = [
		["day_7", "2026-03-03T15:00:00.000Z"],
		["day_3", "2026-03-07T15:00:00.000Z"],
		["day_1", "2026-03-09T14:00:00.000Z"],
	];
	const reminders = async () => (await jobs(spring, m.id)).filter(([slot]) => slot !== "announcement");
	assert.deepEqual(await reminders(), INSTANTS);
	const planned = async () =>
		(await plan(spring, m.id, "2026-02-01T16:00:00Z")).slice(1).map((s) => [s.slot, s.eligibleAt]);
	assert.deepEqual(await planned(), INSTANTS);

	const selected = owner.parse({ kind: "plant", id: spring.P.id });
	assert.ok(selected.kind === "plant");
	const at = instant.parse("2026-02-01T16:00:00Z");
	const zones = timezoneOperations(
		{
			replan: (tx, i) =>
				enqueueJob(tx, {
					tenant: i.owner.id,
					kind: "digest",
					subject: i.owner.id,
					key: `settings/${i.kind}/${i.operationId}`,
					revision: i.revision,
					eligibleAt: at,
				}),
		},
		undefined,
		frozenClock(at),
	);
	const ctx = { session: spring.actors.admin.session, selected };
	const preview = ok(
		await gatedTransaction(spring.db, (tx) =>
			zones.previewPlantTimezone(tx, ctx, { plant: selected, timeZone: "America/New_York" }),
		),
	);
	const set = {
		requestKey: key(),
		expectedRevision: preview.expectedRevision,
		input: { plant: selected, timeZone: "America/New_York", previewId: preview.previewId },
	};
	const edited = await spring.changes(() => gatedTransaction(spring.db, (tx) => zones.setPlantTimezone(tx, ctx, set)));
	assert.equal(ok(edited.value).status, "changed");
	assert.equal(edited.tables.includes("meeting"), false, "no meeting row is rewritten");
	const shown = await spring.meetingOf(m.id, "member");
	assert.deepEqual(
		[shown.startsAt, shown.localDate, shown.localTime, shown.zone],
		["2026-03-10T14:00:00.000Z", "2026-03-10", "09:00", "America/Chicago"],
	);
	assert.deepEqual([await reminders(), await planned()], [INSTANTS, INSTANTS]);
	const fresh = await spring.schedule({ type: "orientation", date: "2026-03-10", time: "09:00" });
	assert.deepEqual(
		[fresh.startsAt, fresh.zone],
		["2026-03-10T13:00:00.000Z", "America/New_York"],
		"the edited zone holds for a new meeting",
	);

	const admin = spring.actors.admin.id;
	await tick(spring, m.id, "2026-02-01T16:00:00Z");
	assert.deepEqual(await notices(spring, m.id), [], "nobody is in the Core Group to announce it to");
	for (const [slot, when] of INSTANTS as [string, string][]) {
		assert.equal(await tick(spring, m.id, when, async () => Promise.reject(Error("synthetic outage"))), 0);
		const waiting = (await jobs(spring, m.id, "retry_wait")).map(([s]) => s);
		assert.deepEqual(waiting, [slot], "the failed run waits for its retry");
		await spring.admin.execute(
			sql`UPDATE job SET next_attempt_at=clock_timestamp()-interval '1 second' WHERE subject_record_id=${m.id} AND state='retry_wait'`,
		);
		assert.equal(await tick(spring, m.id, when), 1);
		assert.equal((await notices(spring, m.id)).filter(([s]) => s === slot).length, 1, slot);
		assert.equal(await tick(spring, m.id, when), 0);
	}
	assert.deepEqual(
		(await notices(spring, m.id)).map(([slot, who]) => [slot, who]),
		INSTANTS.map(([slot]) => [slot, admin]),
		"each reminder reaches the creator once, a retry included",
	);
});

test("AC:TARGET-MTG-007 AC:TARGET-MTG-018 reminders keep the 09:00 wall clock over the November change and follow each guest, time and status change before they go out", async () => {
	const own = await w.person("Creator as guest", { account: w.actors.admin.id, stage: "core_group" });
	const leaving = await w.actor(w.P, "member");
	const joining = await w.actor(w.P, "member");
	const [leaver, joiner] = [
		await w.person("Leaving guest", { account: leaving.id }),
		await w.person("Joining guest", { account: joining.id }),
	];
	const contact = await w.person("Contact only", { email: "contact@example.test" });
	const input = { date: "2026-11-05", time: "09:00", guests: [own, leaver, contact] };
	const m = await w.schedule(input);
	assert.equal(m.startsAt, "2026-11-05T15:00:00.000Z");
	assert.deepEqual((await jobs(w, m.id)).slice(1), [
		["day_7", "2026-10-29T14:00:00.000Z"],
		["day_3", "2026-11-02T15:00:00.000Z"],
		["day_1", "2026-11-04T15:00:00.000Z"],
	]);
	assert.deepEqual(await recipients(m.id, "announcement"), [w.actors.admin.id], "linked Core Group accounts only");
	const audience = (...ids: string[]) => ids.sort();
	assert.deepEqual(await recipients(m.id, "day_7"), audience(w.actors.admin.id, leaving.id), "creator and guest once");
	await w.invite(m.id, joiner);
	await removeGuest(m.id, leaver);
	assert.deepEqual(await recipients(m.id, "day_7"), audience(w.actors.admin.id, joining.id));

	const moved = ok(
		await w.change(meetingsWriter.edit, m.revision, {
			meetingId: m.id,
			patch: { date: "2026-11-06", time: "09:00" },
		}),
	).meeting;
	assert.deepEqual((await jobs(w, m.id)).slice(1), [
		["day_7", "2026-10-30T14:00:00.000Z"],
		["day_3", "2026-11-03T15:00:00.000Z"],
		["day_1", "2026-11-05T15:00:00.000Z"],
	]);
	assert.deepEqual(
		(await jobs(w, m.id, "superseded")).map(([slot]) => slot),
		["day_7", "day_3", "day_1"],
	);
	assert.equal(await tick(w, m.id, "2026-10-29T14:00:00Z"), 1, "only the announcement is due at the old time");
	assert.deepEqual(await notices(w, m.id), [["announcement", w.actors.admin.id, "pending"]]);
	assert.equal(await tick(w, m.id, "2026-10-30T14:00:00Z"), 1);
	const reminded = async () => (await notices(w, m.id)).filter(([slot]) => slot === "day_7");
	assert.deepEqual(
		await reminded(),
		audience(w.actors.admin.id, joining.id).map((id) => ["day_7", id, "pending"]),
	);
	assert.equal(await tick(w, m.id, "2026-10-30T14:00:00Z"), 0, "a second run sends nothing more");

	await removeGuest(m.id, joiner);
	assert.deepEqual(
		await deliver(w, m.id),
		[w.actors.admin.email, w.actors.admin.email],
		"a guest removed before dispatch is not emailed",
	);
	assert.deepEqual(
		new Set((await reminded()).map(([, who, state]) => `${who} ${state}`)),
		new Set([`${w.actors.admin.id} accepted`, `${joining.id} cancelled`]),
	);

	assert.deepEqual(
		(await jobs(w, m.id)).map(([slot]) => slot),
		["day_3", "day_1"],
	);
	await w.status(m.id, "in_progress", "completed");
	assert.deepEqual(await jobs(w, m.id), []);
	assert.deepEqual(
		(await plan(w, m.id)).map((s) => [s.state, s.recipients.length]),
		Array(4).fill(["suppressed", 0]),
	);
	const before = await notices(w, m.id);
	assert.equal(await tick(w, m.id, "2026-11-03T15:00:00Z"), 0);
	assert.deepEqual([await notices(w, m.id), await deliver(w, m.id)], [before, []]);
	assert.equal((await w.meetingOf(m.id)).revision > moved.revision, true);
});

test("AC:TARGET-MTG-018 a queued announcement or reminder email stops for whoever left the audience and still reaches the rest", async () => {
	const stays = await w.actor(w.P, "member");
	const leaves = await w.actor(w.P, "member");
	const guest = {
		stays: await w.person("Stays", { account: stays.id }),
		leaves: await w.person("Leaves", { account: leaves.id }),
	};
	const queue = async () => {
		const m = await w.schedule({ type: "orientation", date: "2026-11-12", guests: [guest.stays, guest.leaves] });
		await tick(w, m.id, "2026-11-05T16:00:00Z");
		return m;
	};
	const core = async (stage: string) =>
		w.admin.execute(sql`UPDATE person SET stage=${stage} WHERE id IN (${guest.stays},${guest.leaves})`);
	await core("core_group");
	const all = await queue();
	const everyone = await deliver(w, all.id);
	assert.equal(everyone.filter((to) => to === leaves.email).length, 2, "announcement and reminder reach both");
	assert.equal(everyone.filter((to) => to === stays.email).length, 2);

	const left = await queue();
	await removeGuest(left.id, guest.leaves);
	await w.admin.execute(sql`UPDATE person SET stage='attendee' WHERE id=${guest.leaves}`);
	const reached = await deliver(w, left.id);
	assert.deepEqual(
		[reached.filter((to) => to === leaves.email), reached.filter((to) => to === stays.email).length],
		[[], 2],
	);
	assert.deepEqual(
		(await notices(w, left.id)).filter(([, who]) => who === leaves.id).map(([slot, , state]) => [slot, state]),
		[
			["announcement", "cancelled"],
			["day_7", "cancelled"],
		],
	);
});

test("AC:TARGET-MTG-018 an unknown provider answer is kept as unknown, claims no attendance, and never holds back the work a finished meeting needs", async () => {
	const guest = await w.person("Grace Guest", { account: w.actors.member.id });
	const m = await w.schedule({ date: "2026-10-23", guests: [guest] });
	assert.equal((await tick(w, m.id, "2026-10-20T15:00:00Z")) > 0, true);
	const facts = () =>
		w.rows(sql`SELECT presence, rsvp, card_response, revision::text FROM participation WHERE meeting_id=${m.id}`);
	const start = await facts();
	answer = (to) => (to === w.actors.member.email ? { kind: "unknown" } : { kind: "accepted", id: randomUUID() });
	try {
		assert.ok((await deliver(w, m.id)).includes(w.actors.member.email));
	} finally {
		answer = () => ({ kind: "accepted", id: randomUUID() });
	}
	const states = (await notices(w, m.id)).filter(([slot]) => slot === "day_3");
	assert.deepEqual(
		new Set(states.map(([, who, state]) => `${who} ${state}`)),
		new Set([`${w.actors.member.id} unknown`, `${w.actors.admin.id} accepted`]),
	);
	assert.deepEqual(await facts(), start);
	assert.deepEqual(
		ok(await w.read(meetingsReader.listGuests, { meetingId: m.id })).guests.map((g) => [g.presence, g.rsvp, g.hasCard]),
		[["absent", "pending", false]],
	);
	assert.equal(await w.count(sql`SELECT count(*)::int AS n FROM contact_outcome`), 0);

	const revision = async () =>
		(await w.one<{ r: string }>(sql`SELECT attendance_revision::text AS r FROM meeting WHERE id=${m.id}`)).r;
	const finalize = {
		requestKey: key(),
		expectedRevision: await revision(),
		input: { meetingId: m.id, attendeeIds: [guest] },
	};
	const { value, added } = await w.recorded(() => w.write(w.attendance.finalizeAttendance, finalize));
	const done = ok(value);
	assert.deepEqual(done.work.map((x) => [x.kind, x.outcome, x.assigneeIds, x.needsOwner]).sort(), [
		["first_vision_follow_up", "created", [], true],
		["meeting_evaluation", "created", [], true],
	]);
	assert.deepEqual([added.notices, added.mail, added.jobs], [0, 0, []]);
	assert.deepEqual(added.audits, ["meetings.finalized", "people.stage_changed", "tasks.changed", "tasks.changed"]);
	const tasks = await w.rows<{ id: string }>(
		sql`SELECT t.id FROM task t JOIN obligation o ON o.id=t.obligation_id WHERE o.meeting_id=${m.id} ORDER BY t.id`,
	);
	assert.equal(tasks.length, 2);
	for (const { id } of tasks) {
		const reader = await w.authority("admin");
		const shown = ok(await gatedTransaction(w.db, (tx) => taskReader.get(tx, reader, { taskId: id })));
		assert.ok(shown.status === "available");
		assert.deepEqual([shown.task.status, ownerLabel(shown.task.assignees[0] ?? null)], ["not_started", "Needs owner"]);
	}
	assert.deepEqual(await w.unchanged(() => w.write(w.attendance.finalizeAttendance, finalize)), value);
});
