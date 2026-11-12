import { testDatabase } from "../../support/test-database.mts";
import { sql } from "../../../packages/db/node_modules/drizzle-orm/index.js";
import test, { before, after } from "node:test";
import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";

import { RequestActor } from "../../../packages/domain/src/access/session.ts";
import {
	authorizeMeetingNotices,
	guestsWriter as guests,
	meetingsReader as reads,
	meetingsWriter as meetings,
	planNotifications,
} from "../../../packages/domain/src/meetings/index.ts";
import { createNotificationProducer } from "../../../packages/domain/src/notifications/index.ts";
import { createMailService } from "../../../apps/web/src/server/jobs/mail.ts";
import { createNotificationWorker } from "../../../apps/web/src/server/jobs/notification-worker.ts";
import { scheduledJobs } from "../../../apps/web/src/server/jobs/scheduled.ts";

// The notification worker (T-229): meeting writes queue one `notification` job per slot, and the scheduled runner
// writes each due slot's notices and email to the plan's current recipients. Time moves by the runner's clock; a slot
// whose time the clock passed is made due in the queue, as the real clock would.

const database = await testDatabase({ prefix: "t229", max: 6 });
const { admin } = database;
const db = database.pools.runtime;

// Plant P: 0 Owner (creates the meetings), 1 seated guest, 2 Core Group member (not a guest), 3 seated guest who is
// removed before the 3-day reminder.
const P = randomUUID();
const actors = Array.from({ length: 4 }, () => ({ id: randomUUID(), user: randomUUID(), session: randomUUID() }));
const [creator, guest, core, leaving] = actors.map((a) => a.id) as [string, string, string, string];
const ctx = { session: actors[0]!.session, selected: { kind: "plant", id: P } };
const ok = (result) => {
	assert.equal(result.status, "ok", JSON.stringify(result));
	return result.value;
};
const run = (op, input) => db.transaction((t) => op(t, ctx, input));
const key = () => randomUUID();
const day = (days: number) => new Date(Date.now() + days * 86_400_000).toISOString().slice(0, 10);
const people: Record<string, string> = {};

async function person(name: string, fields: { account?: string; stage?: string; email?: string } = {}) {
	const id = randomUUID();
	await admin.execute(sql`INSERT INTO person(id,tenant_id,plant_id,display_name,source,stage,adult_classification,commitment_state,
		pipeline_position,state,created_at,linked_account_id,email) VALUES(${id},${P},${P},${name},'other',
		${fields.stage ?? "prospect"},'unknown','unknown',0,'live',clock_timestamp(),${fields.account ?? null},${fields.email ?? null})`);
	return id;
}
const schedule = async (date = day(10)) =>
	ok(
		await run(meetings.schedule, {
			requestKey: key(),
			input: { type: "orientation", date, time: "18:00", guests: [people.guest, people.leaving, people.contact] },
		}),
	).meeting;
const slotTimes = async (meetingId: string) =>
	Object.fromEntries(
		(await planNotifications(db, P, { meetingId, asOf: new Date().toISOString() })).slots.map((s) => [
			s.slot,
			s.eligibleAt,
		]),
	);
const jobs = async (meetingId: string) =>
	(
		await admin.execute(sql`SELECT split_part(producer_key,'/',2) AS slot, state, error_code FROM job
			WHERE kind='notification' AND subject_record_id=${meetingId}
			ORDER BY array_position(ARRAY['announcement','day_7','day_3','day_1'], split_part(producer_key,'/',2))`)
	).rows;
/** The notices of one meeting: [recipient, category, slot], with the state of the email each queued. */
const notices = async (meetingId: string) =>
	(
		await admin.execute(sql`SELECT n.recipient_id AS recipient, split_part(n.logical_key,'/',2) AS category,
			split_part(n.logical_key,'/',5) AS slot, n.title, m.purpose AS mail, m.state AS mail_state
			FROM notice n LEFT JOIN mail m ON m.notice_id=n.id WHERE n.source_record_id=${meetingId}
			ORDER BY n.eligible_at, n.recipient_id`)
	).rows.map((r) => [r.recipient, r.category, r.slot, r.mail, r.mail_state]);
const mailed = (recipients: string[], category: string, slot: string) =>
	[...recipients].sort().map((r) => [r, category, slot, "notification", "pending"]);

/** Moves the runner's clock a minute past `at` and makes every slot job of the meeting due by then. */
const clock = { at: new Date() };
async function advance(meetingId: string, at: string) {
	clock.at = new Date(Date.parse(at) + 60_000);
	await admin.execute(sql`UPDATE job SET eligible_at=clock_timestamp()-interval '1 second'
		WHERE kind='notification' AND subject_record_id=${meetingId} AND state='ready'
		AND eligible_at<=${clock.at.toISOString()}::timestamptz`);
}
function service(authorize = authorizeMeetingNotices) {
	return createMailService({
		db,
		encryptionKey: randomBytes(32),
		addressKey: randomBytes(32),
		from: "meetings@example.test",
		authorize,
		transport: {
			async send() {
				return { kind: "refused", retryable: true };
			},
			async lookup() {
				return { kind: "unknown" };
			},
		},
	});
}
const secret = "cron-" + randomUUID();
const request = () => new Request("http://localhost/api/cron/jobs", { headers: { authorization: `Bearer ${secret}` } });
const tick = scheduledJobs({
	secret,
	db,
	storage: null,
	cleanup: null,
	reminders: null,
	digests: null,
	mail: null,
	notifications: createNotificationWorker({ mail: service() }),
	now: () => clock.at,
});
async function runTick() {
	const response = await tick(request());
	const body = await response.json();
	assert.equal(response.status, 200, JSON.stringify(body));
	return body;
}
const feed = createNotificationProducer({ optOutKey: randomBytes(32), now: () => new Date() });
/** The recipient's bell entries about this meeting, as [category, title]. */
async function bell(who: number, meetingId: string) {
	// A notice shows from its time on the database clock, which may trail the host's by a few milliseconds.
	await new Promise((resolve) => setTimeout(resolve, 200));
	const reader = await RequestActor.resolve(db, actors[who]!.session);
	return ok(await feed.readFeed(db, reader, {}))
		.items.filter((i) => i.subject?.kind === "meeting" && i.subject.id === meetingId)
		.map((i) => [i.category, i.title])
		.reverse();
}

before(async () => {
	for (const a of actors) {
		await admin.execute(
			sql`INSERT INTO auth_user(id,email,email_verified,name) VALUES(${a.user},${a.id + "@example.test"},true,'Synthetic')`,
		);
		await admin.execute(
			sql`INSERT INTO account(id,auth_user_id,registration_state,registration_kind) VALUES(${a.id},${a.user},'active','planter')`,
		);
		await admin.execute(
			sql`INSERT INTO auth_session(id,user_id,token,expires_at) VALUES(${a.session},${a.user},${randomUUID()},clock_timestamp()+interval '1 day')`,
		);
	}
	await admin.execute(
		sql`INSERT INTO plant(id,name,timezone,warning_days,alert_days,digest_weekday,digest_hour,phase,material_revision) VALUES(${P},'Synthetic','America/Chicago',7,14,1,8,1,1)`,
	);
	for (const [account, role] of [
		[creator, "owner"],
		[guest, "member"],
		[core, "member"],
		[leaving, "member"],
	])
		await admin.execute(
			sql`INSERT INTO seat(account_id,plant_id,role,accepted_at) VALUES(${account},${P},${role},clock_timestamp()-interval '1 minute')`,
		);
	people.guest = await person("Seated guest", { account: guest });
	people.core = await person("Core Group member", { account: core, stage: "core_group" });
	people.leaving = await person("Leaving guest", { account: leaving });
	people.contact = await person("Contact only", { email: "contact@example.test" });
});
after(async () => {
	await database.close();
});

test("AC:CASE-NTF-006 AC:TARGET-MTG-018 the scheduled tick sends each slot to its current recipients in the bell and by email, and a cancelled meeting's reminder never", async () => {
	const m = await schedule();
	const at = await slotTimes(m.id);

	// The announcement is due when the meeting is planned: only the linked Core Group gets it.
	clock.at = new Date();
	const first = await runTick();
	assert.deepEqual([first.steps.notification, first.notified], [{ status: "ok", count: 1 }, 1]);
	assert.deepEqual(await notices(m.id), mailed([core], "meeting_announcement", "announcement"));
	assert.deepEqual(await bell(2, m.id), [["meeting_announcement", "New meeting: Orientation"]]);

	// Seven days before: the creator and both seated guests. The contact without a seat gets nothing.
	await advance(m.id, at.day_7);
	assert.equal((await runTick()).notified, 1);
	assert.deepEqual((await notices(m.id)).slice(1), mailed([creator, guest, leaving], "meeting_reminder", "day_7"));

	// A guest removed before the 3-day reminder is not sent it.
	const removed = ok(
		await reads.listGuests(db, await RequestActor.resolve(db, actors[0]!.session), { meetingId: m.id }),
	).guests.find((g) => g.person.personId === people.leaving);
	ok(
		await run(guests.removeGuest, {
			requestKey: key(),
			expectedRevision: removed.revision,
			input: { meetingId: m.id, personId: people.leaving },
		}),
	);
	await advance(m.id, at.day_3);
	assert.equal((await runTick()).notified, 1);
	assert.deepEqual((await notices(m.id)).slice(4), mailed([creator, guest], "meeting_reminder", "day_3"));
	assert.deepEqual(await bell(1, m.id), [
		["meeting_reminder", "In 7 days: Orientation"],
		["meeting_reminder", "In 3 days: Orientation"],
	]);
	assert.deepEqual(await bell(3, m.id), [["meeting_reminder", "In 7 days: Orientation"]]);
	assert.deepEqual(await bell(0, m.id), [
		["meeting_reminder", "In 7 days: Orientation"],
		["meeting_reminder", "In 3 days: Orientation"],
	]);

	// Cancelled before the last reminder: its job is superseded in the same write, and the tick sends nothing.
	// Guest changes leave the meeting's revision as it was planned.
	ok(
		await run(meetings.changeStatus, {
			requestKey: key(),
			expectedRevision: m.revision,
			input: { meetingId: m.id, to: "cancelled" },
		}),
	);
	await advance(m.id, at.day_1);
	assert.equal((await runTick()).notified, 0);
	assert.equal((await notices(m.id)).length, 6);
	assert.deepEqual(
		(await jobs(m.id)).map((j) => [j.slot, j.state]),
		[
			["announcement", "succeeded"],
			["day_7", "succeeded"],
			["day_3", "succeeded"],
			["day_1", "superseded"],
		],
	);
	// The contact without a seat appears in no notice and no email.
	assert.ok((await notices(m.id)).every(([recipient]) => [creator, guest, leaving, core].includes(recipient)));
});

test("INV-notification-worker: a passed, suppressed or stale slot finishes without a notice, and a failure waits for its retry", async () => {
	const worker = createNotificationWorker({ mail: service() });
	// Late: by the time the worker runs, the 3-day reminder is also due, so the 7-day one has passed.
	const late = await schedule();
	const at = await slotTimes(late.id);
	await worker.run(db, new Date().toISOString());
	await advance(late.id, at.day_3);
	assert.equal(await worker.run(db, clock.at.toISOString()), 1);
	assert.deepEqual(
		(await jobs(late.id)).map((j) => [j.slot, j.state, j.error_code]),
		[
			["announcement", "succeeded", null],
			["day_7", "cancelled", "passed"],
			["day_3", "succeeded", null],
			["day_1", "ready", null],
		],
	);
	assert.deepEqual(
		(await notices(late.id)).map(([, , slot]) => slot),
		["announcement", "day_3", "day_3", "day_3"],
		"the creator and both seated guests get the latest owed reminder only",
	);

	// Suppressed: the meeting stopped without a write reaching its jobs. Stale: the meeting moved past the job's revision.
	const stopped = await schedule(),
		moved = await schedule();
	await admin.execute(sql`UPDATE meeting SET status='cancelled' WHERE id=${stopped.id}`);
	await admin.execute(sql`UPDATE meeting SET revision=revision+1 WHERE id=${moved.id}`);
	await worker.run(db, new Date().toISOString());
	assert.deepEqual((await jobs(stopped.id)).map((j) => [j.slot, j.state, j.error_code]).slice(0, 1), [
		["announcement", "cancelled", "suppressed"],
	]);
	assert.deepEqual((await jobs(moved.id)).map((j) => [j.slot, j.state, j.error_code]).slice(0, 1), [
		["announcement", "superseded", "stale"],
	]);
	assert.deepEqual([await notices(stopped.id), await notices(moved.id)], [[], []]);

	// A failure while writing rolls the notices back and leaves the job to the queue's retry.
	const failing = createNotificationWorker({
		mail: service(async () => {
			throw Error("synthetic mail outage");
		}),
	});
	const retried = await schedule();
	const error = console.error;
	console.error = () => {};
	try {
		assert.equal(await failing.run(db, new Date().toISOString()), 0);
	} finally {
		console.error = error;
	}
	const [announcement] = (
		await admin.execute(sql`SELECT state, error_code, attempt_count, next_attempt_at > clock_timestamp() AS later
			FROM job WHERE kind='notification' AND subject_record_id=${retried.id} AND producer_key='meeting/announcement'`)
	).rows;
	assert.deepEqual(announcement, {
		state: "retry_wait",
		error_code: "notification_failed",
		attempt_count: 1,
		later: true,
	});
	assert.deepEqual(await notices(retried.id), []);
});
