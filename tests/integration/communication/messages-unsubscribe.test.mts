// Unsubscribe for Messages to CRM people (T-102, REQ-NTF-016, D-284: "Per church and per person, staff can see it but
// can't clear it"). Each send goes through the real Messages adapter (deliveryTransport) to a recorded fake of the
// Resend API. The tokens the tests use are read back from the provider requests, never minted by the test.
import test, { after, before } from "node:test";
import assert from "node:assert/strict";
import { createHash, createHmac, randomBytes, randomUUID } from "node:crypto";
import { sql } from "../../../packages/db/src/query.ts";
import { fixture } from "../identity/invitations-support.mts";
import { communicationWriter, withCommunicationWrite } from "../../../packages/domain/src/communication/index.ts";
import {
	applyMessagesOptOut,
	describeMessagesOptOut,
	messagesOptOutToken,
	undoMessagesOptOut,
} from "../../../packages/domain/src/communication/opt-out.ts";
import { issueMailOptOutToken, openClaim } from "../../../packages/domain/src/notifications/opt-out.ts";
import { peopleMerge, peopleWriter } from "../../../packages/domain/src/people/index.ts";
import { deliveryText, hubLabel, scheduleText } from "../../../apps/web/src/features/communication/model.ts";
import { POST as oneClick } from "../../../apps/web/src/features/communication/unsubscribeOneClick.ts";
import { resendRecorder } from "./resend-recorder.mts";
import { atSendTime } from "./scheduled-support.mts";
import { ok, refused } from "../../support/fixture.mts";

let f, churchA, churchB, ownerA, ownerB, memberA;
const origin = "https://app.example.test";
const ring = { current: randomBytes(32), previous: [] };
const keys = {
	encryptionKey: Buffer.alloc(32, 7),
	addressKey: Buffer.alloc(32, 9),
	from: "news@example.test",
	origin,
	optOutKeys: ring,
};
const PRODUCTION = { VERCEL_ENV: "production" };
const HOUR = 3_600_000;
const key = () => randomUUID();
const now = () => new Date();
const rows = async (query) => (await f.admin.execute(query)).rows;

async function person(church, name, email = `${name.toLowerCase()}-${key().slice(0, 8)}@example.test`) {
	const id = randomUUID();
	await f.admin
		.execute(sql`INSERT INTO person(id,tenant_id,plant_id,display_name,email,source,stage,adult_classification,
		commitment_state,pipeline_position,state,created_at)
		VALUES(${id},${church.id},${church.id},${name},${email},'other','prospect','unknown','unknown',0,'live',clock_timestamp())`);
	return { id, email };
}

/** Save, review and hand off one message through the real adapter. `mode` is send now or a held schedule. */
async function send(who, people, { mode = "now", meetingId = null, body = "<p>Hello {{name}}.</p>" } = {}) {
	const resend = resendRecorder(PRODUCTION);
	const write = (op, input) =>
		withCommunicationWrite(f.db, who.actor, (tx, ctx) => communicationWriter[op](tx, ctx, input));
	const saved = ok(
		await write("saveDraft", {
			requestKey: key(),
			input: {
				subject: "Sunday update",
				bodyHtml: body,
				audience: { groups: [], teamIds: [], personIds: people.map((p) => p.id) },
				...(meetingId ? { meetingId } : {}),
			},
		}),
	);
	const accepted = ok(
		await write("scheduleReviewed", {
			requestKey: key(),
			expectedRevision: saved.revision,
			input: { communicationId: saved.communicationId, scheduledAt: new Date(Date.now() + 2 * HOUR).toISOString() },
		}),
	);
	const handOff = () =>
		communicationWriter[mode === "now" ? "dispatchAttempt" : "handOffScheduled"](
			f.db,
			who.actor,
			{ requestKey: key(), expectedRevision: accepted.revision, input: { communicationId: saved.communicationId } },
			resend.transport,
			keys,
		);
	const result = ok(await handOff());
	// A scheduled email waits in Everyfield; the minute runner hands it off at its send time (T-241).
	if (mode !== "now") await atSendTime(f.admin, f.db, saved.communicationId, resend.transport, keys);
	return { id: saved.communicationId, result, resend, handOff };
}
const batches = (resend) => resend.requests.filter((r) => r.path === "/emails/batch" && r.method === "POST");
const sentTo = (resend) => batches(resend).flatMap((r) => r.body);
const emailFor = (resend, address) => sentTo(resend).find((m) => m.to[0] === address);
const linkOf = (email) => {
	const found = email.html.match(/href="(https:\/\/app\.example\.test\/unsubscribe\/([A-Za-z0-9_-]+))"/);
	assert.ok(found, "the email has an Unsubscribe link");
	return { url: found[1], token: found[2] };
};
const mailOf = (communicationId) =>
	rows(sql`SELECT m.recipient_person_id AS person, m.state, m.refusal FROM mail m
		WHERE m.logical_key LIKE ${"communication/" + communicationId + "/%"} ORDER BY m.recipient_person_id`);
const optOutsOf = (personId) =>
	rows(
		sql`SELECT id, plant_id, person_id, opted_out_at, undone_at FROM person_email_opt_out WHERE person_id = ${personId}`,
	);
/** Unsubscribe the way the person does: with the token their last email carried. */
async function unsubscribe(church, who) {
	const sent = await send(church, [who]);
	return {
		...ok(await applyMessagesOptOut(f.db, ring, now, { token: linkOf(emailFor(sent.resend, who.email)).token })),
		sent,
	};
}

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
	const m = await f.account();
	await f.seat(m, churchA, "member");
	memberA = { ...m, actor: await f.actor(m.session) };
});
after(() => f?.close());

test("AC:CASE-NTF-016 an announcement ends with an Unsubscribe link whose token names the church and the person, and the provider request carries the same token in List-Unsubscribe", async () => {
	const ana = await person(churchA, "Ana");
	const { resend } = await send(ownerA, [ana]);
	const email = emailFor(resend, ana.email);
	const { url, token } = linkOf(email);
	// The visible link is the last thing in both bodies.
	assert.ok(email.html.indexOf("Hello Ana.") < email.html.indexOf(">Unsubscribe</a>"));
	assert.equal(email.html.slice(email.html.indexOf(">Unsubscribe</a>")).includes("<a "), false);
	assert.ok(email.text.endsWith(`\n\n--\nUnsubscribe: ${url}`), email.text);
	assert.deepEqual(email.headers, {
		"List-Unsubscribe": `<${url}/one-click>`,
		"List-Unsubscribe-Post": "List-Unsubscribe=One-Click",
	});
	// The token names this church and this person, and nothing about an account.
	const subkey = createHmac("sha256", ring.current).update("everyfield/messages-opt-out/token").digest();
	assert.deepEqual(openClaim(subkey, token), {
		v: 1,
		kind: "messages",
		purpose: "disable",
		plantId: churchA.id,
		personId: ana.id,
	});
	// The page names the church, never the address.
	const view = ok(await describeMessagesOptOut(f.db, ring, { token }));
	assert.deepEqual(view, {
		churchName: (await rows(sql`SELECT name FROM plant WHERE id = ${churchA.id}`))[0].name,
		unsubscribed: false,
	});
	assert.equal(JSON.stringify(view).includes(ana.email), false);
});

test("AC:CASE-NTF-016 a meeting invitation carries the same Unsubscribe link and headers, and its RSVP link is unchanged", async () => {
	const ben = await person(churchA, "Ben");
	const meetingId = randomUUID();
	const startsAt = new Date(Date.now() + 3 * 24 * HOUR);
	await f.admin
		.execute(sql`INSERT INTO meeting(id,plant_id,type,title,team_id,local_date,local_time,timezone,starts_at,resolver_version,status,attendance_revision)
		VALUES(${meetingId},${churchA.id},'orientation',null,null,${startsAt.toISOString().slice(0, 10)},'18:00','America/Chicago',${startsAt.toISOString()},'1','planning',1)`);
	await f.admin.execute(sql`INSERT INTO participation(id,plant_id,meeting_id,person_id,roster_member,rsvp,presence)
		VALUES(${randomUUID()},${churchA.id},${meetingId},${ben.id},false,'pending','absent')`);
	const { resend } = await send(ownerA, [ben], { meetingId, body: "<p>Hi {{name}},</p><p>{{rsvp_link}}</p>" });
	const email = emailFor(resend, ben.email);
	const rsvp = email.html.match(/href="(https:\/\/app\.example\.test\/rsvp\/([A-Za-z0-9_-]{43}))"/);
	assert.ok(rsvp, "the invitation keeps its RSVP link");
	const [{ rsvp_token_hash }] = await rows(
		sql`SELECT rsvp_token_hash FROM participation WHERE meeting_id = ${meetingId} AND person_id = ${ben.id}`,
	);
	assert.equal(rsvp_token_hash, createHash("sha256").update(rsvp[2]).digest("hex"));
	const { url } = linkOf(email);
	assert.deepEqual(email.headers, {
		"List-Unsubscribe": `<${url}/one-click>`,
		"List-Unsubscribe-Post": "List-Unsubscribe=One-Click",
	});
	assert.ok(email.text.endsWith(`\n\n--\nUnsubscribe: ${url}`));
});

test("AC:CASE-NTF-016 a retried handoff sends the same body and headers under the same idempotency key", async () => {
	const cy = await person(churchA, "Cy");
	const dee = await person(churchA, "Dee");
	const first = await send(ownerA, [cy, dee]);
	const [one] = batches(first.resend);
	// A handoff whose ledger was lost renders again from the same reviewed message. Every byte the email service
	// compares under the key comes out the same, so it can answer the retry instead of refusing it as a conflict.
	await f.admin
		.execute(sql`WITH m AS (SELECT id FROM mail WHERE logical_key LIKE ${"communication/" + first.id + "/%"}),
		r AS (SELECT DISTINCT request_id AS id FROM mail_request_member WHERE mail_id IN (SELECT id FROM m)),
		a AS (DELETE FROM mail_attempt WHERE request_id IN (SELECT id FROM r)),
		mem AS (DELETE FROM mail_request_member WHERE request_id IN (SELECT id FROM r) RETURNING request_id)
		SELECT 1`);
	await f.admin.execute(sql`DELETE FROM mail_request WHERE id NOT IN (SELECT request_id FROM mail_request_member)
		AND provider_key = ${one.idempotencyKey}`);
	await f.admin.execute(sql`DELETE FROM mail WHERE logical_key LIKE ${"communication/" + first.id + "/%"}`);
	ok(await first.handOff());
	const [, two] = batches(first.resend);
	assert.ok(two, "the retry reached the email service");
	assert.equal(two.idempotencyKey, one.idempotencyKey);
	assert.deepEqual(two.body, one.body);
	assert.ok(one.body.every((m) => m.headers["List-Unsubscribe"]));
});

test("AC:CASE-NTF-016 an unsubscribed person is refused like a blocked address on a send and a schedule; the rest of the audience is sent; an address change does not lift it", async () => {
	const eve = await person(churchA, "Eve");
	const fay = await person(churchA, "Fay");
	const done = await unsubscribe(ownerA, eve);
	assert.equal(done.changed, true);
	assert.ok(done.undoToken);
	// The church changes Eve's address on her record. The opt-out is hers, not the address's.
	const [{ revision }] = await rows(sql`SELECT revision::text AS revision FROM person WHERE id = ${eve.id}`);
	const moved = `eve-new-${key().slice(0, 8)}@example.test`;
	ok(
		await f.db.transaction((t) =>
			peopleWriter.updatePerson(
				t,
				{ session: ownerA.session, selected: { kind: "plant", id: churchA.id } },
				{
					requestKey: key(),
					expectedRevision: revision,
					input: { personId: eve.id, patch: { email: moved } },
				},
			),
		),
	);
	for (const mode of ["now", "scheduled"]) {
		const sent = await send(ownerA, [eve, fay], { mode });
		assert.deepEqual(
			sentTo(sent.resend).map((m) => m.to[0]),
			[fay.email],
			`${mode}: only Fay reaches the email service`,
		);
		assert.deepEqual(
			[sent.result.acceptedCount, sent.result.rejectedCount, sent.result.unknownCount, sent.result.unsubscribedCount],
			[1, 0, 0, 1],
		);
		const stored = await mailOf(sent.id);
		assert.deepEqual(
			stored.find((r) => r.person === eve.id),
			{ person: eve.id, state: "refused", refusal: "unsubscribed" },
		);
		assert.equal(stored.find((r) => r.person === fay.id).refusal, null);
	}
	const shown = deliveryText({
		status: "partial",
		acceptedCount: 1,
		rejectedCount: 0,
		unknownCount: 0,
		unsubscribedCount: 1,
	});
	assert.equal(
		shown,
		"The email service accepted it and sends it now. Accepted 1. Refused 0. No answer 0. Unsubscribed 1.",
	);
});

test("AC:CASE-NTF-016 one church's opt-out never stops another church's email to the same address", async () => {
	const shared = `gil-${key().slice(0, 8)}@example.test`;
	const inA = await person(churchA, "Gil", shared);
	const inB = await person(churchB, "Gil", shared);
	await unsubscribe(ownerA, inA);
	const fromA = await send(ownerA, [inA]);
	assert.equal(sentTo(fromA.resend).length, 0);
	assert.equal(fromA.result.unsubscribedCount, 1);
	const fromB = await send(ownerB, [inB]);
	assert.deepEqual(
		sentTo(fromB.resend).map((m) => m.to[0]),
		[shared],
	);
	assert.deepEqual([fromB.result.acceptedCount, fromB.result.unsubscribedCount], [1, 0]);
	// Church B's own link names church B and its own person.
	const viewB = ok(await describeMessagesOptOut(f.db, ring, { token: linkOf(emailFor(fromB.resend, shared)).token }));
	assert.equal(viewB.unsubscribed, false);
});

test("AC:CASE-NTF-016 history counts Unsubscribed apart from refused and blocked; everyone refused is Not sent and never delivered", async () => {
	const hal = await person(churchA, "Hal");
	const ivy = await person(churchA, "Ivy");
	await unsubscribe(ownerA, hal);
	const mixed = await send(ownerA, [hal, ivy]);
	const totals = ok(
		await f.db.transaction((t) =>
			communicationWriter.getDeliveryTotals(t, ownerA.actor, { communicationId: mixed.id }),
		),
	);
	assert.deepEqual(
		[totals.accepted, totals.failed, totals.unsubscribed, totals.suppressed, totals.reachable],
		[1, 0, 1, 0, 1],
	);

	await unsubscribe(ownerA, ivy);
	const none = await send(ownerA, [hal, ivy]);
	assert.equal(sentTo(none.resend).length, 0, "no email goes to the email service");
	assert.deepEqual(
		[none.result.status, none.result.acceptedCount, none.result.rejectedCount, none.result.unsubscribedCount],
		["failed", 0, 0, 2],
	);
	const all = ok(
		await f.db.transaction((t) => communicationWriter.getDeliveryTotals(t, ownerA.actor, { communicationId: none.id })),
	);
	// Nobody got it because everyone unsubscribed: its own state, not an error or a cancel (T-241).
	assert.equal(all.state, "unsubscribed");
	assert.equal(hubLabel[all.state], "Not sent: unsubscribed");
	assert.deepEqual([all.failed, all.unsubscribed, all.delivered], [0, 2, 0]);
	const text = deliveryText(none.result);
	assert.equal(
		text,
		"Not sent. Every recipient unsubscribed from this church's email. Accepted 0. Refused 0. No answer 0. Unsubscribed 2. The message stays saved in Messages.",
	);
	assert.equal(/deliver/i.test(text), false);
	assert.equal(/deliver/i.test(scheduleText(none.result, "Fri 9:00")), false);
	// Per recipient, the history names the reason.
	const recipients = ok(
		await f.db.transaction((t) =>
			communicationWriter.listHistoryRecipients(t, ownerA.actor, { communicationId: none.id, limit: 10 }),
		),
	);
	assert.deepEqual(
		recipients.items.map((r) => r.deliveryStatus),
		["unsubscribed", "unsubscribed"],
	);
});

test("AC:CASE-NTF-016 the page changes nothing until the button; one-click needs its form body; undo works for one hour and is refused after it", async () => {
	const jo = await person(churchA, "Jo");
	const sent = await send(ownerA, [jo]);
	const { token } = linkOf(emailFor(sent.resend, jo.email));
	ok(await describeMessagesOptOut(f.db, ring, { token }));
	ok(await describeMessagesOptOut(f.db, ring, { token }));
	assert.equal((await optOutsOf(jo.id)).length, 0, "opening the page changes nothing");
	// A GET-like or empty one-click post is refused before anything is read.
	const bare = await oneClick(new Request(`${origin}/unsubscribe/${token}/one-click`, { method: "POST", body: "" }), {
		params: Promise.resolve({ token }),
	});
	assert.equal(bare.status, 400);
	assert.equal((await optOutsOf(jo.id)).length, 0);

	const first = ok(await applyMessagesOptOut(f.db, ring, now, { token }));
	assert.equal(first.changed, true);
	const again = ok(await applyMessagesOptOut(f.db, ring, now, { token }));
	assert.equal(again.changed, false, "a second unsubscribe changes nothing");
	assert.equal((await optOutsOf(jo.id)).length, 1);
	assert.equal(ok(await describeMessagesOptOut(f.db, ring, { token })).unsubscribed, true);

	// After the hour the undo is refused and nothing changes.
	const late = ok(
		await undoMessagesOptOut(f.db, ring, () => new Date(Date.now() + HOUR + 60_000), { token: first.undoToken }),
	);
	assert.deepEqual([late.changed, late.expired], [false, true]);
	assert.equal((await optOutsOf(jo.id))[0].undone_at, null);
	// Inside the hour it lifts the opt-out, once.
	const undone = ok(await undoMessagesOptOut(f.db, ring, now, { token: first.undoToken }));
	assert.deepEqual([undone.changed, undone.expired], [true, false]);
	assert.notEqual((await optOutsOf(jo.id))[0].undone_at, null);
	assert.equal(ok(await undoMessagesOptOut(f.db, ring, now, { token: again.undoToken })).changed, false);
	const resent = await send(ownerA, [jo]);
	assert.deepEqual(
		sentTo(resent.resend).map((m) => m.to[0]),
		[jo.email],
	);
	// An opt-out older than an hour gets no undo at all.
	ok(await applyMessagesOptOut(f.db, ring, now, { token }));
	const stale = ok(await applyMessagesOptOut(f.db, ring, () => new Date(Date.now() + 2 * HOUR), { token }));
	assert.equal(stale.undoToken, null);
});

test("AC:CASE-NTF-016 a forged, tampered, other-key or wrong-purpose token fails closed and changes nothing", async () => {
	const kai = await person(churchA, "Kai");
	const sent = await send(ownerA, [kai]);
	const { token } = linkOf(emailFor(sent.resend, kai.email));
	const flip = (t, at) => t.slice(0, at) + (t[at] === "A" ? "B" : "A") + t.slice(at + 1);
	const accountToken = issueMailOptOutToken(ring, {
		accountId: randomUUID(),
		category: "task_due",
		unsubscribeRevision: "0",
		iat: new Date().toISOString(),
	});
	const otherRing = { current: randomBytes(32), previous: [] };
	const bad = [randomBytes(60).toString("base64url"), flip(token, 20), flip(token, token.length - 2), accountToken];
	for (const t of bad) {
		refused(await describeMessagesOptOut(f.db, ring, { token: t }), "access_denied");
		refused(await applyMessagesOptOut(f.db, ring, now, { token: t }), "access_denied");
		refused(await undoMessagesOptOut(f.db, ring, now, { token: t }), "access_denied");
	}
	refused(await applyMessagesOptOut(f.db, otherRing, now, { token }), "access_denied");
	// The disable token cannot undo, and the undo token cannot unsubscribe or open the page.
	refused(await undoMessagesOptOut(f.db, ring, now, { token }), "access_denied");
	const applied = ok(await applyMessagesOptOut(f.db, ring, now, { token }));
	refused(await applyMessagesOptOut(f.db, ring, now, { token: applied.undoToken }), "access_denied");
	refused(await describeMessagesOptOut(f.db, ring, { token: applied.undoToken }), "access_denied");
	refused(await describeMessagesOptOut(f.db, ring, { token: "" }), "invalid_input");
	assert.equal((await optOutsOf(kai.id)).length, 1);
	assert.equal((await optOutsOf(kai.id))[0].undone_at, null);
	// A key rotation keeps old links working: the old key is still on the ring.
	const rotated = { current: randomBytes(32), previous: [ring.current] };
	assert.equal(ok(await describeMessagesOptOut(f.db, rotated, { token })).unsubscribed, true);
});

test("AC:CASE-NTF-016 an Owner sees the opt-out and when on the person's record; staff cannot clear or rewrite it", async () => {
	const lee = await person(churchA, "Lee");
	await unsubscribe(ownerA, lee);
	const [row] = await optOutsOf(lee.id);
	const history = (who) =>
		f.db.transaction((t) => communicationWriter.listForPerson(t, who.actor, { personId: lee.id, limit: 10 }));
	assert.equal(ok(await history(ownerA)).emailOptOutAt, new Date(row.opted_out_at).toISOString());
	assert.equal(ok(await history(memberA)).emailOptOutAt, null);
	// The people writer has no opt-out field, so a staff edit that names one is refused.
	const [{ revision }] = await rows(sql`SELECT revision::text AS revision FROM person WHERE id = ${lee.id}`);
	refused(
		await f.db.transaction((t) =>
			peopleWriter.updatePerson(
				t,
				{ session: ownerA.session, selected: { kind: "plant", id: churchA.id } },
				{
					requestKey: key(),
					expectedRevision: revision,
					input: { personId: lee.id, patch: { emailOptOut: null } },
				},
			),
		),
		"invalid_input",
	);
	// The runtime login every staff session uses cannot delete it or rewrite who, which church or when.
	const attempt = (query) =>
		f.db.execute(query).then(
			() => "changed",
			(error) => (error.cause ?? error).code,
		);
	assert.equal(await attempt(sql`DELETE FROM person_email_opt_out WHERE id = ${row.id}`), "42501");
	assert.equal(
		await attempt(sql`UPDATE person_email_opt_out SET opted_out_at = clock_timestamp() WHERE id = ${row.id}`),
		"42501",
	);
	assert.equal(
		await attempt(sql`UPDATE person_email_opt_out SET person_id = ${randomUUID()} WHERE id = ${row.id}`),
		"42501",
	);
	assert.deepEqual(await optOutsOf(lee.id), [row]);
	// Once undone, the undo stays: nobody can set it back or move it.
	await f.admin.execute(sql`UPDATE person_email_opt_out SET undone_at = clock_timestamp() WHERE id = ${row.id}`);
	assert.equal(await attempt(sql`UPDATE person_email_opt_out SET undone_at = NULL WHERE id = ${row.id}`), "23514");
});

test("AC:CASE-NTF-016 a merge keeps the survivor unsubscribed when either person had unsubscribed", async () => {
	const ctx = { session: ownerA.session, selected: { kind: "plant", id: churchA.id } };
	const merge = async (sourceId, survivorId) => {
		const review = ok(await f.db.transaction((t) => peopleMerge.getMergeReview(t, ctx, { sourceId, survivorId })));
		return ok(
			await f.db.transaction((t) =>
				peopleMerge.mergePeople(t, ctx, {
					requestKey: key(),
					input: { sourceId, survivorId, reviewDigest: review.reviewDigest, fieldChoices: {} },
				}),
			),
		);
	};
	// Before any Messages email, so neither Person holds a mail row; the opt-out comes from the person's own token.
	const pair = async (name) => [await person(churchA, `${name} One`), await person(churchA, `${name} Two`)];
	const optOut = async (who) =>
		ok(
			await applyMessagesOptOut(f.db, ring, now, {
				token: messagesOptOutToken(ring, { plantId: churchA.id, personId: who.id }),
			}),
		);
	for (const unsubscribed of ["source", "survivor"]) {
		const [source, survivor] = await pair(unsubscribed === "source" ? "Mo" : "Ned");
		await optOut(unsubscribed === "source" ? source : survivor);
		await merge(source.id, survivor.id);
		const sent = await send(ownerA, [survivor]);
		assert.equal(sentTo(sent.resend).length, 0, `${unsubscribed}: the survivor gets no email`);
		assert.equal(sent.result.unsubscribedCount, 1);
		const record = ok(
			await f.db.transaction((t) =>
				communicationWriter.listForPerson(t, ownerA.actor, { personId: survivor.id, limit: 10 }),
			),
		);
		assert.notEqual(record.emailOptOutAt, null);
	}
});

test("AC:CASE-NTF-016 unsubscribing changes no account preference, consent, stage, group or other CRM field", async () => {
	const ora = await person(churchA, "Ora");
	const snapshot = async () => ({
		person: await rows(sql`SELECT * FROM person WHERE id = ${ora.id}`),
		tags: await rows(sql`SELECT * FROM person_tag WHERE person_id = ${ora.id}`),
		preferences: await rows(sql`SELECT * FROM notification_preference ORDER BY account_id, category, channel`),
		residency: await rows(sql`SELECT * FROM residency_link WHERE person_id = ${ora.id}`),
		audits: await rows(sql`SELECT count(*)::int AS n FROM audit_event WHERE subject_id = ${ora.id}`),
	});
	const sent = await send(ownerA, [ora]);
	const before = await snapshot();
	const done = ok(
		await applyMessagesOptOut(f.db, ring, now, { token: linkOf(emailFor(sent.resend, ora.email)).token }),
	);
	assert.equal(done.changed, true);
	assert.deepEqual(await snapshot(), before);
	ok(await undoMessagesOptOut(f.db, ring, now, { token: done.undoToken }));
	assert.deepEqual(await snapshot(), before);
});
