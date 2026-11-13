// T-241: unsubscribing stops Messages email that is already scheduled (REQ-NTF-016, D-284: "Per church and per person,
// staff can see it but can't clear it"). A scheduled email waits in Everyfield and the minute runner hands it to the
// email service at its send time, so an opt-out before then always wins, even when the email service cannot be
// reached. An email the email service already holds (scheduled before T-241) is cancelled there by the runner.
// Every email goes through the real Messages adapter to a recorded fake of the Resend API.
import test, { after, before } from "node:test";
import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { sql } from "../../../packages/db/src/query.ts";
import { fixture } from "../identity/invitations-support.mts";
import { communicationWriter, withCommunicationWrite } from "../../../packages/domain/src/communication/index.ts";
import { applyMessagesOptOut, undoMessagesOptOut } from "../../../packages/domain/src/communication/opt-out.ts";
import { hubLabel } from "../../../apps/web/src/features/communication/model.ts";
import { resendRecorder } from "./resend-recorder.mts";
import { atSendTime, heldAtProvider, minuteRunner } from "./scheduled-support.mts";
import { ok } from "../../support/fixture.mts";

let f, churchA, churchB, ownerA, ownerB;
const ring = { current: randomBytes(32), previous: [] };
const keys = {
	encryptionKey: Buffer.alloc(32, 7),
	addressKey: Buffer.alloc(32, 9),
	from: "news@example.test",
	origin: "https://app.example.test",
	optOutKeys: ring,
};
const PRODUCTION = { VERCEL_ENV: "production" };
const DAY = 86_400_000;
const key = () => randomUUID();
const now = () => new Date();
const rows = async (query) => (await f.admin.execute(query)).rows;

async function person(church, name, email = `${name.toLowerCase()}-${key().slice(0, 8)}@example.test`) {
	const id = randomUUID();
	await f.admin
		.execute(sql`INSERT INTO person(id,tenant_id,plant_id,display_name,email,source,stage,adult_classification,
		commitment_state,pipeline_position,state,created_at)
		VALUES(${id},${church.id},${church.id},${name},${email},'other','prospect','unknown','unknown',0,'live',clock_timestamp())`);
	return { id, email, name };
}

/** Staff schedule a Messages email to `people` for `at` (next week by default) through the real writer. */
async function schedule(who, people, resend, at = new Date(Date.now() + 7 * DAY).toISOString()) {
	const write = (op, input) =>
		withCommunicationWrite(f.db, who.actor, (tx, ctx) => communicationWriter[op](tx, ctx, input));
	const saved = ok(
		await write("saveDraft", {
			requestKey: key(),
			input: {
				subject: "Next Sunday",
				bodyHtml: "<p>Hello {{name}}.</p>",
				audience: { groups: [], teamIds: [], personIds: people.map((p) => p.id) },
			},
		}),
	);
	const scheduled = ok(
		await write("scheduleReviewed", {
			requestKey: key(),
			expectedRevision: saved.revision,
			input: { communicationId: saved.communicationId, scheduledAt: at },
		}),
	);
	const report = ok(
		await communicationWriter.handOffScheduled(
			f.db,
			who.actor,
			{ requestKey: key(), expectedRevision: scheduled.revision, input: { communicationId: saved.communicationId } },
			resend.transport,
			keys,
		),
	);
	return { id: saved.communicationId, report };
}

const sentTo = (resend) =>
	resend.requests
		.filter((r) => r.path === "/emails/batch" && r.method === "POST")
		.flatMap((r) => r.body.map((m) => m.to[0]));

/** Unsubscribe the way the person does: with the Unsubscribe token from an email this church sent them. */
async function unsubscribe(church, who) {
	const resend = resendRecorder(PRODUCTION);
	const sent = await schedule(church, [who], resend);
	await atSendTime(f.admin, f.db, sent.id, resend.transport, keys);
	const email = resend.requests.find((r) => r.path === "/emails/batch").body.find((m) => m.to[0] === who.email);
	const token = email.html.match(/\/unsubscribe\/([A-Za-z0-9_-]+)"/)[1];
	return ok(await applyMessagesOptOut(f.db, ring, now, { token }));
}

const read = (who, op, input, extra) => f.db.transaction((tx) => communicationWriter[op](tx, who.actor, input, extra));
async function shown(who, id) {
	const page = ok(await read(who, "listHistory", { limit: 100 }));
	return {
		item: page.items.find((row) => row.id === id),
		detail: ok(await read(who, "getDetail", { id }, keys)),
		totals: ok(await read(who, "getDeliveryTotals", { communicationId: id })),
		recipients: ok(await read(who, "listHistoryRecipients", { communicationId: id, limit: 100 })).items,
	};
}
const statusOf = (view, who) => view.recipients.find((row) => row.personId === who.id)?.deliveryStatus;

before(async () => {
	f = await fixture();
	churchA = await f.workspace();
	churchB = await f.workspace();
	const a = await f.account();
	await f.seat(a, churchA, "owner");
	ownerA = { ...a, actor: await f.actor(a.session) };
	const b = await f.account();
	await f.seat(b, churchB, "owner");
	ownerB = { ...b, actor: await f.actor(b.session) };
});
after(() => f?.close());

test("AC:CASE-NTF-016 Ana unsubscribes after the email is scheduled; at the send time she gets nothing, everyone else does, and staff see her skipped before and after", async () => {
	const ana = await person(churchA, "Ana");
	const ben = await person(churchA, "Ben");
	const cy = await person(churchA, "Cy");
	const resend = resendRecorder(PRODUCTION);
	const message = await schedule(ownerA, [ana, ben, cy], resend);
	assert.deepEqual(resend.take(), [], "scheduling hands nothing to the email service");

	await unsubscribe(ownerA, ana);

	// Done 2: before it goes out, Ana is marked and the recipient count leaves her out.
	const before = await shown(ownerA, message.id);
	assert.equal(before.item.state, "scheduled");
	assert.equal(statusOf(before, ana), "unsubscribed");
	assert.deepEqual(
		[ben, cy].map((p) => statusOf(before, p)),
		["scheduled", "scheduled"],
	);
	assert.equal(before.totals.selected, 3);
	assert.equal(before.totals.reachable, 2);
	assert.equal(before.item.reachable, 2);
	assert.equal(before.totals.unsubscribed, 1);
	// Nothing was handed to the email service yet, and a skip is not an answer from it.
	assert.equal(before.totals.attempted, 0);
	assert.deepEqual(before.totals.outcomes, []);

	// Done 1: at the send time Ben and Cy get it, Ana gets nothing.
	await atSendTime(f.admin, f.db, message.id, resend.transport, keys);
	assert.deepEqual(sentTo(resend).sort(), [ben.email, cy.email].sort());
	assert.equal(sentTo(resend).includes(ana.email), false);

	// Done 3: after it went out, Ana is skipped because she unsubscribed, and no failure or bounce counts her.
	const after_ = await shown(ownerA, message.id);
	assert.equal(after_.item.state, "sending");
	assert.equal(statusOf(after_, ana), "unsubscribed");
	assert.deepEqual(
		[ben, cy].map((p) => statusOf(after_, p)),
		["accepted", "accepted"],
	);
	assert.deepEqual(
		{
			failed: after_.totals.failed,
			bounced: after_.totals.bounced,
			suppressed: after_.totals.suppressed,
			unsubscribed: after_.totals.unsubscribed,
			accepted: after_.totals.accepted,
			cancelled: after_.totals.cancelled,
		},
		{ failed: 0, bounced: 0, suppressed: 0, unsubscribed: 1, accepted: 2, cancelled: 0 },
	);
});

test("AC:CASE-NTF-016 an email the email service already held before this change is cancelled there for Ana, retried until the email service answers", async () => {
	const ana = await person(churchA, "Ana");
	const ben = await person(churchA, "Ben");
	const resend = resendRecorder(PRODUCTION);
	const message = await schedule(ownerA, [ana, ben], resend);
	await heldAtProvider(f.admin, message.id, resend.transport, keys);
	const [held] = resend.take();
	const anaId = held.body.findIndex((m) => m.to[0] === ana.email);
	const ids = (await rows(sql`SELECT m.recipient_person_id AS person, m.provider_message_id AS id FROM mail m
		WHERE m.logical_key LIKE ${"communication/" + message.id + "/%"}`)) as { person: string; id: string }[];
	const anaEmail = ids.find((r) => r.person === ana.id).id;
	const benEmail = ids.find((r) => r.person === ben.id).id;
	assert.ok(anaId >= 0);

	await unsubscribe(ownerA, ana);
	resend.take();
	// The email service cannot be reached the first minute: nothing changes and the next minute asks again.
	resend.fault(anaEmail, "fail");
	await minuteRunner(f.db, resend.transport, keys);
	assert.deepEqual(
		resend
			.take()
			.filter((r) => r.path.endsWith("/cancel"))
			.map((r) => r.path),
		[`/emails/${anaEmail}/cancel`],
	);
	assert.equal(resend.emails.get(anaEmail).lastEvent, "scheduled");
	resend.fault(anaEmail, null);
	await minuteRunner(f.db, resend.transport, keys);
	assert.equal(resend.emails.get(anaEmail).lastEvent, "canceled", "Ana's held email is cancelled");
	assert.equal(resend.emails.get(benEmail).lastEvent, "scheduled", "Ben's held email still goes out");
	const view = await shown(ownerA, message.id);
	assert.equal(statusOf(view, ana), "unsubscribed");
	assert.equal(view.item.state, "scheduled");
	assert.deepEqual([view.totals.failed, view.totals.unsubscribed, view.totals.reachable], [0, 1, 1]);
	// A later minute asks nothing more.
	resend.take();
	await minuteRunner(f.db, resend.transport, keys);
	assert.deepEqual(
		resend.take().filter((r) => r.path.endsWith("/cancel")),
		[],
	);
});

test("AC:CASE-NTF-016 when the only recipient unsubscribes the email does not go out, and staff see why, not an error or a cancel", async () => {
	const ana = await person(churchA, "Ana");
	const resend = resendRecorder(PRODUCTION);
	const message = await schedule(ownerA, [ana], resend);
	await unsubscribe(ownerA, ana);
	resend.take();
	let view = await shown(ownerA, message.id);
	assert.equal(view.item.state, "unsubscribed");
	assert.equal(hubLabel[view.item.state], "Not sent: unsubscribed");
	await atSendTime(f.admin, f.db, message.id, resend.transport, keys);
	assert.deepEqual(resend.take(), [], "nothing reaches the email service");
	view = await shown(ownerA, message.id);
	assert.equal(view.item.state, "unsubscribed");
	assert.equal(view.detail.state, "scheduled");
	assert.notEqual(view.item.state, "failed");
	assert.notEqual(view.item.state, "cancelled");
	assert.deepEqual(
		[view.totals.failed, view.totals.cancelled, view.totals.unsubscribed, view.totals.unknown],
		[0, 0, 1, 0],
	);
	assert.equal(statusOf(view, ana), "unsubscribed");
});

test("AC:CASE-NTF-016 Ana's opt-out from church A leaves church B's scheduled email to her, and church B sees no opt-out", async () => {
	const shared = `ana-${key().slice(0, 8)}@example.test`;
	const inA = await person(churchA, "Ana", shared);
	const inB = await person(churchB, "Ana", shared);
	const resend = resendRecorder(PRODUCTION);
	const fromA = await schedule(ownerA, [inA], resend);
	const fromB = await schedule(ownerB, [inB], resend);
	await unsubscribe(ownerA, inA);
	resend.take();
	await atSendTime(f.admin, f.db, fromA.id, resend.transport, keys);
	assert.deepEqual(sentTo(resend), []);
	await atSendTime(f.admin, f.db, fromB.id, resend.transport, keys);
	assert.deepEqual(sentTo(resend), [shared], "church B's email still goes out");
	const viewB = await shown(ownerB, fromB.id);
	assert.equal(statusOf(viewB, inB), "accepted");
	assert.equal(viewB.totals.unsubscribed, 0);
	const searchB = ok(await read(ownerB, "readRecipients", { query: "Ana" })).people;
	assert.equal(searchB.find((p) => p.id === inB.id).unsubscribedAt, null);
	const audienceB = ok(await read(ownerB, "readAudience", { groups: [], teamIds: [], personIds: [inB.id] }));
	assert.deepEqual([audienceB.eligibleRecipients, audienceB.unsubscribedExclusions], [1, []]);
	const personB = ok(await read(ownerB, "listForPerson", { personId: inB.id }));
	assert.equal(personB.emailOptOutAt, null);
});

test("AC:CASE-NTF-016 after Ana unsubscribes, compose shows her as unsubscribed with the date, the count leaves her out, and forcing her in sends her nothing", async () => {
	const ana = await person(churchA, "Anabel");
	const ben = await person(churchA, "Benno");
	const done = await unsubscribe(ownerA, ana);
	assert.equal(done.changed, true);
	const [{ at }] = await rows(sql`SELECT to_char(opted_out_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS at
		FROM person_email_opt_out WHERE person_id = ${ana.id} AND undone_at IS NULL`);

	const found = ok(await read(ownerA, "readRecipients", { query: "Anabel" })).people;
	assert.deepEqual(found, [{ id: ana.id, displayName: "Anabel", email: ana.email, unsubscribedAt: at }]);
	const audience = ok(await read(ownerA, "readAudience", { groups: [], teamIds: [], personIds: [ana.id, ben.id] }));
	assert.equal(audience.resolvedDistinctPeople, 2);
	assert.equal(audience.eligibleRecipients, 1, "Will get this email leaves her out");
	assert.deepEqual(audience.unsubscribedExclusions, [{ id: ana.id, displayName: "Anabel", unsubscribedAt: at }]);
	assert.deepEqual(
		audience.recipients.map((r) => r.id),
		[ben.id],
	);
	// In a group too: everyone in the church.
	const everyone = ok(await read(ownerA, "readAudience", { groups: ["all"], teamIds: [], personIds: [] }));
	assert.ok(everyone.unsubscribedExclusions.some((p) => p.id === ana.id));
	assert.equal(
		everyone.recipients.some((p) => p.id === ana.id),
		false,
	);

	// Forced in by id, the schedule and the send refuse her and send Ben.
	const resend = resendRecorder(PRODUCTION);
	const forced = await schedule(ownerA, [ana, ben], resend);
	assert.deepEqual([forced.report.acceptedCount, forced.report.unsubscribedCount], [1, 1]);
	await atSendTime(f.admin, f.db, forced.id, resend.transport, keys);
	assert.deepEqual(sentTo(resend), [ben.email]);
	assert.deepEqual(
		await rows(sql`SELECT state, refusal FROM mail WHERE logical_key = ${"communication/" + forced.id + "/" + ana.id}`),
		[{ state: "refused", refusal: "unsubscribed" }],
	);
	// No staff path clears it: the opt-out is still current after all of this.
	assert.equal(ok(await read(ownerA, "listForPerson", { personId: ana.id })).emailOptOutAt, at);
});

test("AC:CASE-NTF-016 Ana unsubscribes one minute before the send while the email service refuses every cancel; she still gets nothing, and her undo does not bring it back", async () => {
	const ana = await person(churchA, "Ana");
	const ben = await person(churchA, "Ben");
	const resend = resendRecorder(PRODUCTION);
	const message = await schedule(ownerA, [ana, ben], resend);
	// The send time is one minute away.
	await f.admin.execute(sql`UPDATE mail SET scheduled_at = clock_timestamp() + interval '1 minute'
		WHERE logical_key LIKE ${"communication/" + message.id + "/%"} AND state = 'scheduled'`);
	// The email service can't be reached for a cancel or a time change: every such call fails or is rate limited.
	const cancels = [];
	const down = {
		...resend.transport,
		async cancel(ids) {
			cancels.push(...ids);
			throw new Error("429 rate limited");
		},
		async reschedule() {
			throw new Error("unreachable");
		},
	};
	const optOut = await unsubscribe(ownerA, ana);
	resend.take();
	await atSendTime(f.admin, f.db, message.id, down, keys);
	assert.deepEqual(sentTo(resend), [ben.email]);
	assert.deepEqual(cancels, [], "no cancel was needed: the email service never had Ana's email");

	// Her own undo inside the hour does not bring the skipped email back.
	const undone = ok(await undoMessagesOptOut(f.db, ring, now, { token: optOut.undoToken }));
	assert.equal(undone.changed, true);
	await minuteRunner(f.db, down, keys);
	assert.deepEqual(sentTo(resend), [ben.email]);
	assert.deepEqual(
		await rows(
			sql`SELECT state, refusal FROM mail WHERE logical_key = ${"communication/" + message.id + "/" + ana.id}`,
		),
		[{ state: "refused", refusal: "unsubscribed" }],
	);
});

test("AC:CASE-NTF-016 the runner checks the opt-out itself at the send time, including a person merged into the recipient", async () => {
	const ana = await person(churchA, "Ana");
	const old = await person(churchA, "Ana old");
	const ben = await person(churchA, "Ben");
	const resend = resendRecorder(PRODUCTION);
	const message = await schedule(ownerA, [ana, ben], resend);
	// The opt-out reaches the runner without the opt-out writer's mark: a person who unsubscribed earlier is merged
	// into Ana after the email was scheduled.
	await f.admin.execute(sql`INSERT INTO person_email_opt_out (plant_id, person_id) VALUES (${churchA.id}, ${old.id})`);
	await f.admin.execute(
		sql`UPDATE person SET merged_into_person_id = ${ana.id}, state = 'merged' WHERE id = ${old.id}`,
	);
	assert.equal(statusOf(await shown(ownerA, message.id), ana), "scheduled");
	await atSendTime(f.admin, f.db, message.id, resend.transport, keys);
	assert.deepEqual(sentTo(resend), [ben.email]);
	assert.equal(statusOf(await shown(ownerA, message.id), ana), "unsubscribed");
});

test("AC:CASE-NTF-016 the every-minute cron call hands a due scheduled email off and skips the person who unsubscribed", async () => {
	const { scheduledJobs, scheduledMessages } = await import("../../../apps/web/src/server/jobs/scheduled.ts");
	const ana = await person(churchA, "Ana");
	const ben = await person(churchA, "Ben");
	const resend = resendRecorder(PRODUCTION);
	const message = await schedule(ownerA, [ana, ben], resend);
	await unsubscribe(ownerA, ana);
	resend.take();
	await f.admin.execute(sql`UPDATE mail SET scheduled_at = clock_timestamp() - interval '1 second'
		WHERE logical_key LIKE ${"communication/" + message.id + "/%"} AND state = 'scheduled'`);
	const secret = "cron-" + key();
	const tick = scheduledJobs({
		secret,
		db: f.db,
		storage: null,
		cleanup: null,
		effects: null,
		digests: null,
		mail: null,
		messages: scheduledMessages(f.db, resend.transport, keys),
	});
	const response = await tick(
		new Request("http://localhost/api/cron/jobs", { headers: { authorization: `Bearer ${secret}` } }),
	);
	assert.equal(response.status, 200);
	assert.equal((await response.json()).messages, 1);
	assert.deepEqual(sentTo(resend), [ben.email]);
});
