// T-242: the staff member who scheduled a Messages email is told in the bell at the moment someone on it unsubscribes
// (REQ-NTF-016). The notice is written in the opt-out's own statement, so it exists when the unsubscribe answer
// returns. In-app only (D-680), to the scheduler while they hold a seat in that church (D-681), one per email and per
// person (D-682), none for an email the email service already held before T-241 (D-683), and no link (D-684).
// Every email goes through the real Messages adapter to a recorded fake of the Resend API, and staff read the notice
// through the real feed and bell reads.
import test, { after, before } from "node:test";
import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { sql } from "../../../packages/db/src/query.ts";
import { fixture } from "../identity/invitations-support.mts";
import { ok } from "../../support/fixture.mts";
import { communicationWriter, withCommunicationWrite } from "../../../packages/domain/src/communication/index.ts";
import {
	applyMessagesOptOut,
	messagesOptOutToken,
	undoMessagesOptOut,
} from "../../../packages/domain/src/communication/opt-out.ts";
import { createNotificationProducer } from "../../../packages/domain/src/notifications/index.ts";
import { hubLabel } from "../../../apps/web/src/features/communication/model.ts";
import { resendRecorder } from "./resend-recorder.mts";
import { atSendTime, heldAtProvider } from "./scheduled-support.mts";

let f;
const ring = { current: randomBytes(32), previous: [] };
const keys = {
	encryptionKey: Buffer.alloc(32, 7),
	addressKey: Buffer.alloc(32, 9),
	from: "news@example.test",
	origin: "https://app.example.test",
	optOutKeys: ring,
};
const notifications = createNotificationProducer({ optOutKey: randomBytes(32) });
const PRODUCTION = { VERCEL_ENV: "production" };
const ZONE = "America/Chicago";
const key = () => randomUUID();
const now = () => new Date();
const rows = async (query) => (await f.admin.execute(query)).rows;

/** A church in Chicago time, so the send time in a notice is visibly the church's own. */
async function church() {
	const w = await f.workspace();
	await f.admin.execute(sql`UPDATE plant SET timezone = ${ZONE} WHERE id = ${w.id}::uuid`);
	return w;
}
async function staff(w, role = "owner") {
	const a = await f.account();
	const seatId = await f.seat(a, w, role);
	return { ...a, seatId, actor: await f.actor(a.session) };
}
async function person(w, name) {
	const id = randomUUID();
	const email = `${name.toLowerCase()}-${key().slice(0, 8)}@example.test`;
	await f.admin
		.execute(sql`INSERT INTO person(id,tenant_id,plant_id,display_name,email,source,stage,adult_classification,
		commitment_state,pipeline_position,state,created_at)
		VALUES(${id},${w.id},${w.id},${name},${email},'other','prospect','unknown','unknown',0,'live',clock_timestamp())`);
	return { id, email, name, plantId: w.id };
}

/** Next week at 15:30 UTC, to the minute. */
function nextWeek() {
	const at = new Date(Date.now() + 7 * 86_400_000);
	at.setUTCHours(15, 30, 0, 0);
	return at.toISOString();
}
/** How the notice must write a send time: the church's zone, "Nov 18, 2026, 9:30 AM". */
const churchTime = (iso) =>
	new Intl.DateTimeFormat("en-US", {
		timeZone: ZONE,
		month: "short",
		day: "numeric",
		year: "numeric",
		hour: "numeric",
		minute: "2-digit",
	})
		.format(new Date(iso))
		.replace(/ /g, " ");

const write = (who, op, input) =>
	withCommunicationWrite(f.db, who.actor, (tx, ctx) => communicationWriter[op](tx, ctx, input));
async function draft(who, people, subject = "Next Sunday") {
	return ok(
		await write(who, "saveDraft", {
			requestKey: key(),
			input: {
				subject,
				bodyHtml: "<p>Hello {{name}}.</p>",
				audience: { groups: [], teamIds: [], personIds: people.map((p) => p.id) },
			},
		}),
	);
}
/** Staff schedule a Messages email to `people` for next week through the real writer. */
async function schedule(who, people, { subject = "Next Sunday", at = nextWeek() } = {}) {
	const resend = resendRecorder(PRODUCTION);
	const saved = await draft(who, people, subject);
	const scheduled = ok(
		await write(who, "scheduleReviewed", {
			requestKey: key(),
			expectedRevision: saved.revision,
			input: { communicationId: saved.communicationId, scheduledAt: at },
		}),
	);
	ok(
		await communicationWriter.handOffScheduled(
			f.db,
			who.actor,
			{ requestKey: key(), expectedRevision: scheduled.revision, input: { communicationId: saved.communicationId } },
			resend.transport,
			keys,
		),
	);
	return { id: saved.communicationId, at, resend };
}

/** The person presses Unsubscribe: the token is the one every Messages email to them carries. */
const unsubscribe = (who) =>
	applyMessagesOptOut(f.db, ring, now, {
		token: messagesOptOutToken(ring, { plantId: who.plantId, personId: who.id }),
	});

const feed = async (who) => ok(await notifications.readFeed(f.db, who.actor, {})).items;
const bell = async (who) => ok(await notifications.readUnreadCount(f.db, who.actor, {})).count;
const ours = async (who) => (await feed(who)).filter((item) => item.category === "scheduled_email_unsubscribe");
/** Every notice row this category wrote for an account, whether or not the feed shows it. */
const stored = (who) =>
	rows(sql`SELECT n.source_record_id AS email, n.tenant_id AS church, n.title, n.safe_body AS body
		FROM notice n WHERE n.recipient_id = ${who.id}::uuid AND split_part(n.logical_key, '/', 2) = 'scheduled_email_unsubscribe'
		ORDER BY n.created_at`);

before(async () => {
	f = await fixture();
});
after(() => f?.close());

test("AC:CASE-NTF-016 T-242 Done 1-2: Ana unsubscribes and Sam, who scheduled the email, has one new notice in the bell and the feed as the answer returns", async () => {
	const w = await church();
	const sam = await staff(w);
	const ana = await person(w, "Ana Ruiz");
	const ben = await person(w, "Ben Ode");
	const email = await schedule(sam, [ana, ben]);
	const bellBefore = await bell(sam);
	const jobsBefore = (await rows(sql`SELECT count(*)::int AS n FROM job`))[0].n;

	const answer = ok(await unsubscribe(ana));
	assert.equal(answer.changed, true);

	// Done 2: read straight after the answer, with no runner, job or later minute.
	assert.equal((await rows(sql`SELECT count(*)::int AS n FROM job`))[0].n, jobsBefore, "no job was queued");
	assert.equal(await bell(sam), bellBefore + 1);
	const [newest] = await feed(sam);
	const expected = {
		category: "scheduled_email_unsubscribe",
		title: "Ana Ruiz unsubscribed from a scheduled email",
		body: `Ana Ruiz will not get “Next Sunday”, scheduled for ${churchTime(email.at)}.`,
		read: false,
	};
	assert.deepEqual({ category: newest.category, title: newest.title, body: newest.body, read: newest.read }, expected);
	assert.match(expected.body, /Next Sunday”, scheduled for [A-Z][a-z]{2} \d{1,2}, \d{4}, \d{1,2}:30 (AM|PM)\.$/);
	assert.equal(JSON.stringify(newest).includes(ana.email), false, "the notice never shows Ana's address");
	assert.deepEqual(await stored(sam), [{ email: email.id, church: w.id, title: expected.title, body: expected.body }]);
	assert.equal("href" in newest || "link" in newest, false, "the notice has no link (D-684)");
});

test("AC:CASE-NTF-016 T-242 Done 2: a refused opt-out, from a forged or tampered token, writes no notice", async () => {
	const w = await church();
	const sam = await staff(w);
	const ana = await person(w, "Ana");
	const email = await schedule(sam, [ana]);
	const real = messagesOptOutToken(ring, { plantId: w.id, personId: ana.id });
	const tampered = real.slice(0, -2) + (real.endsWith("A") ? "BB" : "AA");
	const forged = messagesOptOutToken({ current: randomBytes(32), previous: [] }, { plantId: w.id, personId: ana.id });
	for (const token of [tampered, forged]) {
		const outcome = await applyMessagesOptOut(f.db, ring, now, { token });
		assert.equal(outcome.status, "refused");
	}
	assert.deepEqual(await stored(sam), []);
	assert.deepEqual(await ours(sam), []);
	assert.equal(
		(
			await rows(sql`SELECT count(*)::int AS n FROM mail WHERE logical_key LIKE ${"communication/" + email.id + "/%"}
			AND state = 'scheduled'`)
		)[0].n,
		1,
		"the email still waits for Ana",
	);
});

test("AC:CASE-NTF-016 T-242 Done 3: when Ana was the only recipient the notice says the email will not go out, as its Not sent: unsubscribed state says", async () => {
	const w = await church();
	const sam = await staff(w);
	const ana = await person(w, "Ana Ruiz");
	const email = await schedule(sam, [ana], { subject: "Picnic" });
	ok(await unsubscribe(ana));
	const [newest] = await ours(sam);
	assert.deepEqual(
		{ title: newest.title, body: newest.body },
		{
			title: "Not sent: Ana Ruiz unsubscribed",
			body: `“Picnic”, scheduled for ${churchTime(email.at)}, will not go out because its only recipient unsubscribed from this church's email.`,
		},
	);
	const history = ok(await f.db.transaction((tx) => communicationWriter.listHistory(tx, sam.actor, { limit: 100 })));
	const state = history.items.find((row) => row.id === email.id).state;
	assert.equal(hubLabel[state], "Not sent: unsubscribed", "the email itself reads the same");
});

test("AC:CASE-NTF-016 T-242 Done 3: an email whose other recipient already unsubscribed counts as all-unsubscribed", async () => {
	const w = await church();
	const sam = await staff(w);
	const ana = await person(w, "Ana");
	const ben = await person(w, "Ben");
	await schedule(sam, [ana, ben], { subject: "Picnic" });
	ok(await unsubscribe(ben));
	ok(await unsubscribe(ana));
	const titles = (await ours(sam)).map((item) => item.title);
	assert.deepEqual(titles, ["Not sent: Ana unsubscribed", "Ben unsubscribed from a scheduled email"]);
});

test("AC:CASE-NTF-016 T-242 Done 4: Ana is on Sam's and Lee's scheduled emails; each scheduler gets one notice, for their own email only", async () => {
	const w = await church();
	const sam = await staff(w);
	const lee = await staff(w, "admin");
	const ana = await person(w, "Ana");
	const ben = await person(w, "Ben");
	const bySam = await schedule(sam, [ana, ben], { subject: "From Sam" });
	const byLee = await schedule(lee, [ana, ben], { subject: "From Lee" });
	ok(await unsubscribe(ana));
	assert.deepEqual(
		(await stored(sam)).map((row) => row.email),
		[bySam.id],
	);
	assert.deepEqual(
		(await stored(lee)).map((row) => row.email),
		[byLee.id],
	);
	assert.deepEqual(
		(await ours(sam)).map((item) => item.body),
		[`Ana will not get “From Sam”, scheduled for ${churchTime(bySam.at)}.`],
	);
	assert.deepEqual(
		(await ours(lee)).map((item) => item.body),
		[`Ana will not get “From Lee”, scheduled for ${churchTime(byLee.at)}.`],
	);
});

test("AC:CASE-NTF-016 T-242 Done 5: a second click, a retried one-click POST, and an undo then a new unsubscribe still leave one notice per email", async () => {
	const w = await church();
	const sam = await staff(w);
	const ana = await person(w, "Ana");
	const ben = await person(w, "Ben");
	const first = await schedule(sam, [ana, ben], { subject: "One" });
	const second = await schedule(sam, [ana, ben], { subject: "Two" });
	const done = ok(await unsubscribe(ana));
	const again = await Promise.all([unsubscribe(ana), unsubscribe(ana)]);
	assert.deepEqual(
		again.map((r) => ok(r).changed),
		[false, false],
	);
	assert.deepEqual(ok(await undoMessagesOptOut(f.db, ring, now, { token: done.undoToken })).changed, true);
	assert.equal(ok(await unsubscribe(ana)).changed, true, "a new opt-out is recorded");
	assert.deepEqual((await stored(sam)).map((row) => row.email).sort(), [first.id, second.id].sort());
	assert.equal((await ours(sam)).length, 2);
});

test("AC:CASE-NTF-016 T-242 Done 6: Ana's opt-out from church A tells no one in church B, and church A's notice never shows in a church B seat", async () => {
	const a = await church();
	const b = await church();
	const sam = await staff(a);
	const bea = await staff(b);
	// The same human is a Person in each church.
	const inA = await person(a, "Ana");
	const inB = await person(b, "Ana");
	const ben = await person(a, "Ben");
	const benB = await person(b, "Ben");
	const fromA = await schedule(sam, [inA, ben]);
	const fromB = await schedule(bea, [inB, benB]);
	ok(await unsubscribe(inA));

	assert.deepEqual(
		(await stored(sam)).map((row) => [row.email, row.church]),
		[[fromA.id, a.id]],
	);
	assert.deepEqual(await stored(bea), [], "church B's scheduler is told nothing");
	assert.deepEqual(await ours(bea), []);
	assert.equal((await feed(bea)).length, 0, "church B's seat shows no church A entry");
	// Church B's email to its own Ana still waits for her.
	assert.equal(
		(await rows(sql`SELECT state FROM mail WHERE logical_key = ${"communication/" + fromB.id + "/" + inB.id}`))[0]
			.state,
		"scheduled",
	);
	// A church A notice moved onto a church B account would still not show: the feed needs a seat in its church.
	await f.admin.execute(sql`UPDATE notice SET recipient_id = ${bea.id}::uuid
		WHERE recipient_id = ${sam.id}::uuid AND split_part(logical_key, '/', 2) = 'scheduled_email_unsubscribe'`);
	assert.deepEqual(await ours(bea), []);
});

test("AC:CASE-NTF-016 T-242 Done 7: no notice when Ana is on no waiting scheduled email", async () => {
	const w = await church();
	const sam = await staff(w);
	const ana = await person(w, "Ana");
	const ben = await person(w, "Ben");
	// Already went out.
	const went = await schedule(sam, [ana, ben]);
	await atSendTime(f.admin, f.db, went.id, went.resend.transport, keys);
	// Still a draft.
	await draft(sam, [ana, ben]);
	// Cancelled by staff.
	const cancelled = await schedule(sam, [ana, ben]);
	const [{ revision }] = await rows(
		sql`SELECT revision::text AS revision FROM communication WHERE id = ${cancelled.id}::uuid`,
	);
	ok(
		await communicationWriter.cancelScheduledReviewed(
			f.db,
			sam.actor,
			{ requestKey: key(), expectedRevision: revision, input: { communicationId: cancelled.id } },
			cancelled.resend.transport,
		),
	);
	// Not to Ana.
	await schedule(sam, [ben]);
	// Handed to the email service before T-241 (D-683).
	const held = await schedule(sam, [ana, ben]);
	await heldAtProvider(f.admin, held.id, held.resend.transport, keys);

	assert.equal(ok(await unsubscribe(ana)).changed, true);
	assert.deepEqual(await stored(sam), []);
	assert.deepEqual(await ours(sam), []);
});

test("AC:CASE-NTF-016 T-242 Done 8: Sam's seat in the church has ended, so Sam sees nothing and nobody gets the notice instead", async () => {
	const w = await church();
	const sam = await staff(w);
	const lee = await staff(w, "admin");
	const ana = await person(w, "Ana");
	const ben = await person(w, "Ben");
	await schedule(sam, [ana, ben]);
	await f.admin.execute(sql`UPDATE seat SET ended_at = clock_timestamp() WHERE id = ${sam.seatId}::uuid`);
	ok(await unsubscribe(ana));
	assert.deepEqual(await stored(sam), []);
	assert.deepEqual(await ours(sam), []);
	assert.deepEqual(await stored(lee), [], "no other Owner or Admin is told instead");
	assert.equal((await rows(sql`SELECT count(*)::int AS n FROM notice WHERE tenant_id = ${w.id}::uuid`))[0].n, 0);
});

test("AC:CASE-NTF-016 T-242 Done 9: the category is in-app only and on by default; turning it off hides these notices and on shows them again", async () => {
	const w = await church();
	const sam = await staff(w);
	const prefs = ok(await notifications.getPreferences(f.db, sam.actor));
	assert.deepEqual(
		prefs.choices.filter((choice) => choice.category === "scheduled_email_unsubscribe"),
		[{ category: "scheduled_email_unsubscribe", channel: "in_app", enabled: true }],
	);
	const emailChoice = await notifications.setPreference(f.db, sam.actor, {
		requestKey: key(),
		expectedRevision: prefs.revision,
		input: { choice: { category: "scheduled_email_unsubscribe", channel: "email", enabled: true } },
	});
	assert.equal(emailChoice.status, "refused");
	assert.equal(emailChoice.error.code, "invalid_input");
	await assert.rejects(
		f.admin
			.execute(sql`INSERT INTO notification_preference (account_id, category, channel, enabled, unsubscribe_revision)
			VALUES (${sam.id}::uuid, 'scheduled_email_unsubscribe', 'email', true, 1)`),
		(error) => /notification_preference_ck_6/.test(String(error.cause ?? error)),
	);

	const set = async (enabled) => {
		const current = ok(await notifications.getPreferences(f.db, sam.actor));
		ok(
			await notifications.setPreference(f.db, sam.actor, {
				requestKey: key(),
				expectedRevision: current.revision,
				input: { choice: { category: "scheduled_email_unsubscribe", channel: "in_app", enabled } },
			}),
		);
	};
	const ana = await person(w, "Ana");
	const ben = await person(w, "Ben");
	await schedule(sam, [ana, ben]);
	await set(false);
	const bellBefore = await bell(sam);
	ok(await unsubscribe(ana));
	assert.equal(await bell(sam), bellBefore);
	assert.deepEqual(await ours(sam), []);
	await set(true);
	assert.deepEqual(
		(await ours(sam)).map((item) => item.title),
		["Ana unsubscribed from a scheduled email"],
	);
	assert.equal(await bell(sam), bellBefore + 1);
});

test("AC:CASE-NTF-016 T-242 Done 10: filtering the feed by the category shows only these notices", async () => {
	const w = await church();
	const sam = await staff(w);
	const ana = await person(w, "Ana");
	const ben = await person(w, "Ben");
	await schedule(sam, [ana, ben]);
	ok(await unsubscribe(ana));
	await f.admin
		.execute(sql`INSERT INTO notice (tenant_id, recipient_id, category, purpose, logical_key, source_record_id,
		source_revision, title, eligible_at, created_at)
		VALUES (${w.id}::uuid, ${sam.id}::uuid, 'task', 'task_due', ${w.id + "/task_due/" + key() + "/1/due"}, ${w.id}::uuid, 1,
			'A task is due', clock_timestamp(), clock_timestamp())`);
	assert.deepEqual((await feed(sam)).map((item) => item.category).sort(), ["scheduled_email_unsubscribe", "task_due"]);
	const filtered = ok(await notifications.readFeed(f.db, sam.actor, { category: "scheduled_email_unsubscribe" })).items;
	assert.deepEqual(
		filtered.map((item) => item.title),
		["Ana unsubscribed from a scheduled email"],
	);
});
