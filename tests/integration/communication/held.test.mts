import test, { after, before } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { sql } from "../../../packages/db/src/query.ts";
import { fixture } from "../identity/invitations-support.mts";
import { communicationWriter, withCommunicationWrite } from "../../../packages/domain/src/communication/index.ts";
import {
	cancelText,
	deliveryText,
	hubLabel,
	rescheduleText,
	scheduleText,
} from "../../../apps/web/src/features/communication/model.ts";
import { resendRecorder } from "./resend-recorder.mts";

// WP-028: a scheduled message goes to the email service with its send time, and every later screen state (scheduled,
// cancelled, moved, sent, not confirmed) comes only from what the email service answered for each recipient. The
// email service here is the real Messages adapter talking to a recorded fake of the Resend routes.

let f, plant, owner;
const ZONE = "America/Chicago";
const keys = {
	encryptionKey: Buffer.alloc(32, 7),
	addressKey: Buffer.alloc(32, 9),
	from: "news@example.test",
	origin: "https://app.example.test",
};
const DAY = 86_400_000;
const key = () => randomUUID();
const ok = (result) => {
	assert.equal(result.status, "ok", JSON.stringify(result));
	return result.value;
};
const rows = async (query) => (await f.admin.execute(query)).rows;
const read = (op, input, extra) => f.db.transaction((tx) => communicationWriter[op](tx, owner.actor, input, extra));

/** The next `weekday` at `hour`:00 on the plant's clock, at least a day after `from`. */
function plantTime(weekday, hour, from = new Date()) {
	const format = new Intl.DateTimeFormat("en-US", {
		timeZone: ZONE,
		weekday: "short",
		year: "numeric",
		month: "2-digit",
		day: "2-digit",
		hour: "2-digit",
		minute: "2-digit",
		hourCycle: "h23",
	});
	const parts = (d) => Object.fromEntries(format.formatToParts(d).map((p) => [p.type, p.value]));
	for (let i = 1; i <= 8; i++) {
		const p = parts(new Date(from.getTime() + i * DAY));
		if (p.weekday !== weekday) continue;
		const wanted = Date.UTC(+p.year, +p.month - 1, +p.day, hour);
		let guess = wanted;
		for (let k = 0; k < 2; k++) {
			const q = parts(new Date(guess));
			guess += wanted - Date.UTC(+q.year, +q.month - 1, +q.day, +q.hour, +q.minute);
		}
		return new Date(guess).toISOString();
	}
	throw new Error("no such day");
}

async function person(name, email = `${name.toLowerCase()}-${key().slice(0, 8)}@example.test`) {
	const id = randomUUID();
	await f.admin
		.execute(sql`INSERT INTO person(id,tenant_id,plant_id,display_name,email,source,stage,adult_classification,
		commitment_state,pipeline_position,state,created_at)
		VALUES(${id},${plant.id},${plant.id},${name},${email},'other','prospect','unknown','unknown',0,'live',clock_timestamp())`);
	return id;
}
/** A reviewed message for three new people (or the given ones), saved as scheduled for `at`. */
async function reviewed(at, given = null) {
	const people = given ?? [];
	if (!given) for (const name of ["Ana", "Ben", "Cy"]) people.push(await person(name));
	const result = await withCommunicationWrite(f.db, owner.actor, async (tx, ctx) => {
		const saved = await communicationWriter.saveDraft(tx, ctx, {
			requestKey: key(),
			input: {
				subject: "Friday gathering",
				bodyHtml: "<p>Hello {{name}}.</p>",
				audience: { groups: [], teamIds: [], personIds: people },
			},
		});
		if (saved.status !== "ok") return saved;
		return communicationWriter.scheduleReviewed(tx, ctx, {
			requestKey: key(),
			expectedRevision: saved.value.revision,
			input: { communicationId: saved.value.communicationId, scheduledAt: at },
		});
	});
	const value = ok(result);
	return { id: value.communicationId, revision: value.revision, people };
}
const handOff = (message, transport, op = "handOffScheduled") =>
	communicationWriter[op](
		f.db,
		owner.actor,
		{ requestKey: key(), expectedRevision: message.revision, input: { communicationId: message.id } },
		transport,
		keys,
	);
const cancel = async (message, transport) =>
	communicationWriter.cancelScheduledReviewed(
		f.db,
		owner.actor,
		{ requestKey: key(), expectedRevision: await revisionOf(message), input: { communicationId: message.id } },
		transport,
	);
const move = async (message, at, transport) =>
	communicationWriter.rescheduleDispatched(
		f.db,
		owner.actor,
		{
			requestKey: key(),
			expectedRevision: await revisionOf(message),
			input: { communicationId: message.id, scheduledAt: at },
		},
		transport,
	);
const revisionOf = async (message) =>
	(await rows(sql`SELECT revision::text AS revision FROM communication WHERE id = ${message.id}`))[0].revision;
const mailOf = (message) =>
	rows(sql`SELECT m.state, m.provider_message_id AS provider,
		to_char(m.scheduled_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS held,
		m.cancel_confirmed_at IS NOT NULL AS cancel_confirmed, r.provider_key
		FROM mail m JOIN mail_request_member mem ON mem.mail_id = m.id JOIN mail_request r ON r.id = mem.request_id
		WHERE m.logical_key LIKE ${"communication/" + message.id + "/%"} ORDER BY mem.position`);
const auditsOf = async (message) =>
	(await rows(sql`SELECT count(*)::int AS n FROM audit_event WHERE subject_id = ${message.id}`))[0].n;
/** What history and message detail show for the message. */
async function shown(message) {
	const page = ok(await read("listHistory", { limit: 100 }));
	const item = page.items.find((row) => row.id === message.id);
	const detail = ok(await read("getDetail", { id: message.id }, keys));
	const totals = ok(await read("getDeliveryTotals", { communicationId: message.id }));
	return { item, detail, totals };
}

before(async () => {
	f = await fixture();
	plant = await f.workspace();
	await f.admin.execute(sql`UPDATE plant SET timezone = ${ZONE} WHERE id = ${plant.id}`);
	const account = await f.account();
	await f.seat(account, plant, "owner");
	owner = { ...account, actor: await f.actor(account.session) };
});
after(() => f?.close());

test("AC:CASE-COM-012 AC:GAP-COM-012 AC:MAIL51-003 AC:CASE-COM-005 a scheduled message goes to the email service with its send time and stores each recipient's id", async () => {
	const friday = plantTime("Fri", 9);
	const resend = resendRecorder();
	const message = await reviewed(friday);
	const result = ok(await handOff(message, resend.transport));
	assert.deepEqual(
		{ accepted: result.acceptedCount, refused: result.rejectedCount, unknown: result.unknownCount },
		{ accepted: 3, refused: 0, unknown: 0 },
	);
	const stored = await mailOf(message);
	const calls = resend.take();
	assert.equal(calls.length, 1);
	assert.equal(calls[0].method, "POST");
	assert.equal(calls[0].path, "/emails/batch");
	assert.equal(calls[0].idempotencyKey, stored[0].provider_key);
	assert.deepEqual(
		calls[0].body.map((entry) => entry.scheduled_at),
		[friday, friday, friday],
	);
	assert.deepEqual(
		stored.map((row) => ({ state: row.state, provider: row.provider, held: row.held })),
		["re-1", "re-2", "re-3"].map((provider) => ({ state: "accepted", provider, held: friday })),
	);

	const view = await shown(message);
	assert.equal(view.item.state, "scheduled");
	assert.equal(hubLabel[view.item.state], "Scheduled");
	assert.equal(view.item.scheduledAt, friday);
	assert.equal(view.item.sentAt, null);
	assert.equal(view.detail.scheduledAt, friday);
	assert.equal(view.detail.requestedAt, null);
	assert.deepEqual(
		{ accepted: view.totals.accepted, refused: view.totals.failed, unknown: view.totals.unknown },
		{ accepted: 3, refused: 0, unknown: 0 },
	);
	assert.equal(
		scheduleText(result, "Fri 9:00"),
		"Scheduled for Fri 9:00. The email service holds it until then. Accepted 3. Refused 0. No answer 0.",
	);
});

test("AC:CASE-COM-012 a schedule the email service holds for nobody shows Not scheduled with the counts and stays saved", async () => {
	const friday = plantTime("Fri", 9);
	for (const [mode, counts] of [
		["refuse", { accepted: 0, refused: 3, unknown: 0 }],
		["error", { accepted: 0, refused: 0, unknown: 3 }],
	]) {
		const resend = resendRecorder();
		resend.batch(mode);
		const message = await reviewed(friday);
		const result = ok(await handOff(message, resend.transport));
		assert.deepEqual(
			{ accepted: result.acceptedCount, refused: result.rejectedCount, unknown: result.unknownCount },
			counts,
		);
		const view = await shown(message);
		assert.equal(view.item.state, "not_scheduled");
		assert.equal(hubLabel[view.item.state], "Not scheduled");
		assert.equal(view.detail.state, "scheduled");
		assert.equal(view.detail.subject, "Friday gathering");
		assert.deepEqual(
			{ accepted: view.totals.accepted, refused: view.totals.failed, unknown: view.totals.unknown },
			counts,
		);
		assert.match(scheduleText(result, "Fri 9:00"), /^Not scheduled\. The email service holds no recipient\./);
	}

	// One recipient without an answer: the other two are held, so the message is Scheduled with exact counts.
	const resend = resendRecorder();
	resend.batch((index) => index !== 1);
	const partial = await reviewed(friday);
	const result = ok(await handOff(partial, resend.transport));
	assert.deepEqual([result.acceptedCount, result.rejectedCount, result.unknownCount], [2, 0, 1]);
	const view = await shown(partial);
	assert.equal(view.item.state, "scheduled");
	assert.deepEqual([view.totals.accepted, view.totals.failed, view.totals.unknown], [2, 0, 1]);
});

test("AC:MAIL51-005 AC:MAIL51-007 a cancel is Cancelled only after the email service confirms every recipient, each by its own id", async () => {
	const resend = resendRecorder();
	const message = await reviewed(plantTime("Fri", 9));
	ok(await handOff(message, resend.transport));
	const stored = await mailOf(message);
	resend.take();

	const result = ok(await cancel(message, resend.transport));
	const calls = resend.take();
	assert.deepEqual(calls.map((call) => `${call.method} ${call.path}`).sort(), [
		"POST /emails/re-1/cancel",
		"POST /emails/re-2/cancel",
		"POST /emails/re-3/cancel",
	]);
	assert.ok(calls.every((call) => !call.path.includes(stored[0].provider_key) && call.idempotencyKey === null));
	assert.deepEqual(
		{
			status: result.scheduledCancel,
			confirmed: result.confirmedCount,
			open: result.openCount,
			sent: result.sentCount,
		},
		{ status: "confirmed", confirmed: 3, open: 0, sent: 0 },
	);
	assert.equal(cancelText(result), "Cancelled. The email service confirmed the cancel for 3.");
	assert.deepEqual(
		(await mailOf(message)).map((row) => [row.state, row.cancel_confirmed]),
		[
			["cancelled", true],
			["cancelled", true],
			["cancelled", true],
		],
	);
	const view = await shown(message);
	assert.equal(view.item.state, "cancelled");
	assert.equal(view.totals.cancelled, 3);
	assert.equal(view.totals.cancelOpen, 0);
	assert.equal([...resend.emails.values()].filter((email) => email.lastEvent === "canceled").length, 3);
});

test("AC:MAIL51-005 AC:MAIL51-007 a cancel without every answer is Cancel not confirmed; Check again asks only the open recipients and a later check writes nothing", async () => {
	const resend = resendRecorder();
	const message = await reviewed(plantTime("Fri", 9));
	ok(await handOff(message, resend.transport));
	resend.take();
	resend.fault("re-2", "fail");
	resend.fault("re-3", "drop");

	const first = ok(await cancel(message, resend.transport));
	assert.deepEqual(
		{ status: first.scheduledCancel, confirmed: first.confirmedCount, open: first.openCount },
		{ status: "reconcile", confirmed: 1, open: 2 },
	);
	assert.equal(
		cancelText(first),
		"Cancel not confirmed. Confirmed 1. Not confirmed 2. Check again to ask the email service.",
	);
	let view = await shown(message);
	assert.equal(view.item.state, "cancel_unconfirmed");
	assert.equal(hubLabel[view.item.state], "Cancel not confirmed");
	assert.deepEqual([view.totals.cancelled, view.totals.cancelOpen], [1, 2]);
	const blocked = ok(
		await communicationWriter.replaceScheduledReviewed(f.db, owner.actor, {
			requestKey: key(),
			expectedRevision: await revisionOf(message),
			input: { communicationId: message.id },
		}),
	);
	assert.equal(blocked.replacementAllowed, false);

	resend.take();
	resend.fault("re-3", null);
	const second = ok(await cancel(message, resend.transport));
	assert.deepEqual(
		resend
			.take()
			.filter((call) => call.method === "POST")
			.map((call) => call.path)
			.sort(),
		["/emails/re-2/cancel", "/emails/re-3/cancel"],
	);
	assert.deepEqual([second.scheduledCancel, second.confirmedCount, second.openCount], ["reconcile", 2, 1]);

	resend.fault("re-2", null);
	const third = ok(await cancel(message, resend.transport));
	assert.deepEqual(
		resend.take().map((call) => `${call.method} ${call.path}`),
		["POST /emails/re-2/cancel"],
	);
	assert.deepEqual([third.scheduledCancel, third.confirmedCount, third.openCount], ["confirmed", 3, 0]);
	view = await shown(message);
	assert.equal(view.item.state, "cancelled");
	const allowed = ok(
		await communicationWriter.replaceScheduledReviewed(f.db, owner.actor, {
			requestKey: key(),
			expectedRevision: await revisionOf(message),
			input: { communicationId: message.id },
		}),
	);
	assert.equal(allowed.replacementAllowed, true);

	// A check after the cancel is confirmed asks nobody and writes no audit row.
	const audits = await auditsOf(message);
	const again = ok(await cancel(message, resend.transport));
	assert.deepEqual(resend.take(), []);
	assert.equal(await auditsOf(message), audits);
	assert.deepEqual([again.scheduledCancel, again.confirmedCount, again.openCount], ["confirmed", 3, 0]);
});

test("AC:MAIL51-004 a time change shows the new time only after every recipient holds it, and the old time appears nowhere", async () => {
	const friday = plantTime("Fri", 9);
	const saturday = plantTime("Sat", 9, new Date(friday));
	const resend = resendRecorder();
	const message = await reviewed(friday);
	ok(await handOff(message, resend.transport));
	resend.take();

	const result = ok(await move(message, saturday, resend.transport));
	const calls = resend.take();
	assert.deepEqual(
		calls.map((call) => `${call.method} ${call.path} ${call.body.scheduled_at}`).sort(),
		["re-1", "re-2", "re-3"].map((id) => `PATCH /emails/${id} ${saturday}`),
	);
	assert.deepEqual(
		{ status: result.rescheduleStatus, at: result.scheduledAt, held: result.heldAt, confirmed: result.confirmedCount },
		{ status: "accepted", at: saturday, held: null, confirmed: 3 },
	);
	assert.deepEqual(
		(await mailOf(message)).map((row) => row.held),
		[saturday, saturday, saturday],
	);
	const view = await shown(message);
	assert.equal(view.item.state, "scheduled");
	assert.equal(view.item.scheduledAt, saturday);
	assert.equal(view.detail.scheduledAt, saturday);
	assert.equal(view.detail.requestedAt, null);
	assert.ok(!JSON.stringify(view).includes(friday), "Friday still shows on the message");
});

test("AC:MAIL51-004 a time change without confirmation names the requested and held times; Check again finishes it", async () => {
	const friday = plantTime("Fri", 9);
	const saturday = plantTime("Sat", 9, new Date(friday));
	const resend = resendRecorder();
	const message = await reviewed(friday);
	ok(await handOff(message, resend.transport));
	resend.take();
	resend.fault("re-1", "drop");

	const result = ok(await move(message, saturday, resend.transport));
	assert.deepEqual(
		{ status: result.rescheduleStatus, at: result.scheduledAt, held: result.heldAt, open: result.openCount },
		{ status: "unknown", at: saturday, held: friday, open: 1 },
	);
	const when = (iso) => (iso === friday ? "Friday 9:00" : iso === saturday ? "Saturday 9:00" : iso);
	assert.equal(
		rescheduleText(result, when),
		"Time change not confirmed. You asked for Saturday 9:00. The email service still holds Friday 9:00 for 1. Check again to ask the email service.",
	);
	let view = await shown(message);
	assert.equal(view.item.state, "time_unconfirmed");
	assert.equal(hubLabel[view.item.state], "Time change not confirmed");
	assert.equal(view.item.scheduledAt, friday, "history shows the held time, not the new one");
	assert.equal(view.detail.scheduledAt, friday);
	assert.equal(view.detail.requestedAt, saturday);

	resend.take();
	resend.fault("re-1", null);
	const again = ok(await move(message, saturday, resend.transport));
	assert.deepEqual(
		resend.take().map((call) => `${call.method} ${call.path}`),
		["PATCH /emails/re-1"],
	);
	assert.equal(again.rescheduleStatus, "accepted");
	view = await shown(message);
	assert.equal(view.item.state, "scheduled");
	assert.equal(view.detail.scheduledAt, saturday);
	assert.ok(!JSON.stringify(view).includes(friday));

	const audits = await auditsOf(message);
	ok(await move(message, saturday, resend.transport));
	assert.deepEqual(resend.take(), []);
	assert.equal(await auditsOf(message), audits);
});

test("AC:MAIL51-005 AC:MAIL51-007 an email the service already sent shows as sent, never Cancelled or moved, with the count", async () => {
	const friday = plantTime("Fri", 9);
	const resend = resendRecorder();
	const message = await reviewed(friday);
	ok(await handOff(message, resend.transport));
	resend.wentOut("re-2");
	const result = ok(await cancel(message, resend.transport));
	assert.deepEqual(
		{
			status: result.scheduledCancel,
			confirmed: result.confirmedCount,
			sent: result.sentCount,
			open: result.openCount,
		},
		{ status: "confirmed", confirmed: 2, sent: 1, open: 0 },
	);
	assert.equal(
		cancelText(result),
		"Cancelled. The email service confirmed the cancel for 2. 1 already went out and cannot be recalled.",
	);
	const view = await shown(message);
	assert.equal(view.item.state, "sent");
	assert.notEqual(view.item.state, "cancelled");
	assert.equal(view.totals.sent, 1);
	assert.equal(view.totals.cancelled, 2);

	const moving = await reviewed(friday);
	ok(await handOff(moving, resend.transport));
	resend.wentOut("re-4");
	resend.wentOut("re-5");
	resend.wentOut("re-6");
	const moved = ok(await move(moving, plantTime("Sat", 9, new Date(friday)), resend.transport));
	assert.deepEqual([moved.confirmedCount, moved.sentCount, moved.openCount], [0, 3, 0]);
	const after = await shown(moving);
	assert.equal(after.item.state, "sent");
	assert.equal(after.totals.sent, 3);
});

test("AC:CASE-COM-005 Send now that the email service refuses is Not sent, stays saved and repeats the same result", async () => {
	const resend = resendRecorder();
	resend.batch("refuse");
	const message = await reviewed(plantTime("Fri", 9));
	const result = ok(await handOff(message, resend.transport, "sendReviewed"));
	assert.deepEqual(
		{
			status: result.status,
			accepted: result.acceptedCount,
			refused: result.rejectedCount,
			unknown: result.unknownCount,
		},
		{ status: "failed", accepted: 0, refused: 3, unknown: 0 },
	);
	assert.equal(
		deliveryText(result),
		"Not sent. The email service refused all 3. Accepted 0. Refused 3. No answer 0. The message stays saved in Messages.",
	);
	assert.equal(resend.take().length, 1);
	const view = await shown(message);
	assert.equal(view.item.state, "failed");
	assert.equal(hubLabel[view.item.state], "Not sent");
	assert.equal(view.detail.subject, "Friday gathering");

	// Send now again from history: the same answer, and the email service is not asked again.
	const again = ok(
		await handOff({ ...message, revision: await revisionOf(message) }, resend.transport, "sendReviewed"),
	);
	assert.deepEqual([again.status, again.acceptedCount, again.rejectedCount, again.unknownCount], ["failed", 0, 3, 0]);
	assert.equal(deliveryText(again), deliveryText(result));
	assert.deepEqual(resend.take(), []);
});

test("AC:CASE-COM-005 a mixed result shows exact counts, an all-unknown result is Not confirmed, and no result says delivered", async () => {
	const resend = resendRecorder();
	// The batch holds only the two addresses that are not blocked; the second of them gets no answer.
	resend.batch((index) => index !== 1);
	// One recipient's address is blocked after an earlier bounce, so it is refused before the email service is asked.
	const blocked = `blocked-${key().slice(0, 8)}@example.test`;
	await blockAddress(blocked);
	const mixed = await reviewed(plantTime("Fri", 9), [
		await person("Dee", blocked),
		await person("Eli"),
		await person("Fay"),
	]);
	const result = ok(await handOff(mixed, resend.transport, "sendReviewed"));
	assert.deepEqual(
		{ accepted: result.acceptedCount, refused: result.rejectedCount, unknown: result.unknownCount },
		{ accepted: 1, refused: 1, unknown: 1 },
	);
	assert.equal(
		deliveryText(result),
		"The email service accepted it and sends it now. Accepted 1. Refused 1. No answer 1.",
	);
	const totals = (await shown(mixed)).totals;
	assert.deepEqual([totals.accepted, totals.failed, totals.unknown], [1, 1, 1]);

	const silent = resendRecorder();
	silent.batch("error");
	const lost = await reviewed(plantTime("Fri", 9));
	const unknown = ok(await handOff(lost, silent.transport, "sendReviewed"));
	assert.deepEqual([unknown.acceptedCount, unknown.rejectedCount, unknown.unknownCount], [0, 0, 3]);
	assert.match(deliveryText(unknown), /^Not confirmed\./);
	const view = await shown(lost);
	assert.equal(view.item.state, "unknown");
	assert.equal(hubLabel[view.item.state], "Not confirmed");

	const tally = { confirmedCount: 1, sentCount: 1, openCount: 1 };
	const texts = [
		...[result, unknown, { status: "failed", acceptedCount: 0, rejectedCount: 2, unknownCount: 0 }].flatMap(
			(report) => [deliveryText(report), scheduleText(report, "Friday")],
		),
		...["confirmed", "reconcile", "none"].map((scheduledCancel) => cancelText({ ...tally, scheduledCancel })),
		...["accepted", "unknown"].map((rescheduleStatus) =>
			rescheduleText({ ...tally, rescheduleStatus, scheduledAt: "2026-11-07T15:00:00.000Z", heldAt: null }, String),
		),
	];
	for (const text of texts) assert.doesNotMatch(text, /deliver/i, text);
});

/** A hard bounce for this address, as the email service reports it, leaves it blocked. */
async function blockAddress(address) {
	const { createHmac } = await import("node:crypto");
	const hash = createHmac("sha256", keys.addressKey).update(address).digest("hex");
	const eventId = randomUUID();
	await f.admin
		.execute(sql`INSERT INTO provider_event(id,event_key,message_id,kind,occurred_at,received_at,payload_hash,safe_payload)
		VALUES(${eventId},${"seed-" + eventId},${"seed-" + eventId},'bounced',clock_timestamp(),clock_timestamp(),'x','{"hard_bounce":true}'::jsonb)`);
	await f.admin.execute(sql`INSERT INTO suppression(address_hash,reason,source_event_id,suppressed_at)
		VALUES(${hash},'hard_bounce',${eventId},clock_timestamp())`);
}

test("AC:CASE-COM-012 in dev capture mode schedule, cancel, time change and Check again work against the outbox", async () => {
	const { mkdtemp, rm, writeFile } = await import("node:fs/promises");
	const { tmpdir } = await import("node:os");
	const { join } = await import("node:path");
	const { deliveryTransport } = await import("../../../apps/web/src/features/communication/mail.ts");
	const { NO_ANSWER_FILE } = await import("../../../apps/web/src/features/communication/capture.ts");
	const outbox = await mkdtemp(join(tmpdir(), "wp028-outbox-"));
	const saved = process.env.EVERYFIELD_DEV_OUTBOX;
	process.env.EVERYFIELD_DEV_OUTBOX = outbox;
	try {
		const capture = deliveryTransport(
			{ keys: { ...keys, from: "church@example.test" }, apiKey: null },
			() => Promise.reject(new Error("provider called")),
			() => {},
		);
		const friday = plantTime("Fri", 9);
		const saturday = plantTime("Sat", 9, new Date(friday));
		const held = await reviewed(friday);
		assert.equal(ok(await handOff(held, capture)).acceptedCount, 3);
		assert.equal((await shown(held)).item.state, "scheduled");
		assert.equal(ok(await move(held, saturday, capture)).rescheduleStatus, "accepted");
		assert.equal((await shown(held)).detail.scheduledAt, saturday);
		assert.equal(ok(await cancel(held, capture)).scheduledCancel, "confirmed");
		assert.equal((await shown(held)).item.state, "cancelled");

		const quiet = await reviewed(friday);
		ok(await handOff(quiet, capture));
		await writeFile(join(outbox, NO_ANSWER_FILE), "");
		assert.equal(ok(await move(quiet, saturday, capture)).rescheduleStatus, "unknown");
		assert.equal((await shown(quiet)).item.state, "time_unconfirmed");
		await rm(join(outbox, NO_ANSWER_FILE));
		assert.equal(ok(await move(quiet, saturday, capture)).rescheduleStatus, "accepted");
		await writeFile(join(outbox, NO_ANSWER_FILE), "");
		assert.equal(ok(await cancel(quiet, capture)).scheduledCancel, "reconcile");
		assert.equal((await shown(quiet)).item.state, "cancel_unconfirmed");
		await rm(join(outbox, NO_ANSWER_FILE));
		assert.equal(ok(await cancel(quiet, capture)).scheduledCancel, "confirmed");
		assert.equal((await shown(quiet)).item.state, "cancelled");
	} finally {
		if (saved === undefined) delete process.env.EVERYFIELD_DEV_OUTBOX;
		else process.env.EVERYFIELD_DEV_OUTBOX = saved;
		await rm(outbox, { recursive: true, force: true });
	}
});
