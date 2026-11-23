import test, { after, before } from "node:test";
import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { sql } from "../../../packages/db/src/query.ts";
import { fixture } from "../identity/invitations-support.mts";
import { communicationWriter, withCommunicationWrite } from "../../../packages/domain/src/communication/index.ts";
import { hubLabel } from "../../../apps/web/src/features/communication/model.ts";
import { resendRecorder } from "./resend-recorder.mts";
import { atSendTime, minuteRunner } from "./scheduled-support.mts";
import { MAILING, MAILING_LINE } from "./church-address.mts";
import { ok, refused } from "../../support/fixture.mts";

let f, plant, owner;
const keys = {
	encryptionKey: Buffer.alloc(32, 7),
	addressKey: Buffer.alloc(32, 9),
	from: "news@example.test",
	origin: "https://app.example.test",
	optOutKeys: { current: randomBytes(32), previous: [] },
};
const PRODUCTION = { VERCEL_ENV: "production" };
const FOOTER_LINE = `Synthetic plant · ${MAILING_LINE}`;
const MISSING = "Mailing address missing. Add it in Church profile before this email can go out.";
const key = () => randomUUID();
const soon = () => new Date(Date.now() + 5 * 60_000).toISOString();
const rows = async (query) => (await f.admin.execute(query)).rows;
const read = (op, input) => f.db.transaction((tx) => communicationWriter[op](tx, owner.actor, input));
const setAddress = (street) => f.admin.execute(sql`UPDATE plant SET street = ${street} WHERE id = ${plant.id}`);

async function person(name) {
	const id = randomUUID();
	await f.admin
		.execute(sql`INSERT INTO person(id,tenant_id,plant_id,display_name,email,source,stage,adult_classification,
		commitment_state,pipeline_position,state,created_at)
		VALUES(${id},${plant.id},${plant.id},${name},${`${name.toLowerCase()}-${key().slice(0, 8)}@example.test`},'other',
		'prospect','unknown','unknown',0,'live',clock_timestamp())`);
	return id;
}

async function draft() {
	const people = [await person("Ana"), await person("Ben")];
	const saved = ok(
		await withCommunicationWrite(f.db, owner.actor, (tx, ctx) =>
			communicationWriter.saveDraft(tx, ctx, {
				requestKey: key(),
				input: {
					subject: "Friday gathering",
					bodyHtml: "<p>Hello {{name}}.</p>",
					audience: { groups: [], teamIds: [], personIds: people },
				},
			}),
		),
	);
	return { id: saved.communicationId, revision: saved.revision };
}
const schedule = (message, at = soon()) =>
	withCommunicationWrite(f.db, owner.actor, (tx, ctx) =>
		communicationWriter.scheduleReviewed(tx, ctx, {
			requestKey: key(),
			expectedRevision: message.revision,
			input: { communicationId: message.id, scheduledAt: at },
		}),
	);
const handOff = (message, transport, op) =>
	communicationWriter[op](
		f.db,
		owner.actor,
		{ requestKey: key(), expectedRevision: message.revision, input: { communicationId: message.id } },
		transport,
		keys,
	);
const sentEmails = (resend) =>
	resend
		.take()
		.filter((call) => call.path === "/emails/batch")
		.flatMap((call) => call.body);
const mailCount = async (message) =>
	(
		await rows(sql`SELECT count(*)::int AS n FROM mail WHERE logical_key LIKE ${"communication/" + message.id + "/%"}`)
	)[0].n;
const stateOf = async (message) => (await rows(sql`SELECT state FROM communication WHERE id = ${message.id}`))[0].state;

function assertChurchFooter(email) {
	assert.ok(email.html.includes(`<span data-mailing-address>${FOOTER_LINE}</span>`), email.html);
	assert.ok(email.html.includes("You get this email because you are part of Synthetic plant."));
	assert.ok(email.html.includes(">Unsubscribe</a>"));
	assert.match(
		email.text,
		new RegExp(
			`\\n--\\nYou get this email because you are part of Synthetic plant\\.\\n${FOOTER_LINE}\\nUnsubscribe: `,
		),
	);
	assert.equal(/everyfield/i.test(email.html.replaceAll(keys.origin, "")), false);
	assert.equal(/everyfield/i.test(email.text.replaceAll(keys.origin, "")), false);
}

before(async () => {
	f = await fixture();
	plant = await f.workspace("plant", MAILING);
	const account = await f.account();
	await f.seat(account, plant, "owner");
	owner = { ...account, actor: await f.actor(account.session) };
});
after(() => f?.close());

test("a church email sent now carries the church's mailing address in the footer with the Unsubscribe link", async () => {
	const resend = resendRecorder(PRODUCTION);
	const message = await draft();
	const scheduled = ok(await schedule(message));
	ok(await handOff({ id: message.id, revision: scheduled.revision }, resend.transport, "sendReviewed"));
	const emails = sentEmails(resend);
	assert.equal(emails.length, 2);
	for (const email of emails) assertChurchFooter(email);
	assert.deepEqual(ok(await read("readChurchName")), { churchName: "Synthetic plant", mailingAddress: MAILING_LINE });
});

test("with no mailing address, sending now and scheduling are held and nothing is scheduled or sent", async (t) => {
	t.after(() => setAddress(MAILING.street));
	for (const street of [null, "   "]) {
		await setAddress(street);
		const resend = resendRecorder(PRODUCTION);
		const message = await draft();
		refused(await schedule(message), "mailing_address_missing");
		assert.equal(await stateOf(message), "draft");
		assert.equal(await mailCount(message), 0);
		assert.deepEqual(resend.take(), []);
		assert.equal(ok(await read("readChurchName")).mailingAddress, null);
	}
	await setAddress(MAILING.street);
	const resend = resendRecorder(PRODUCTION);
	const message = await draft();
	const scheduled = ok(await schedule(message));
	ok(await handOff({ id: message.id, revision: scheduled.revision }, resend.transport, "sendReviewed"));
	const emails = sentEmails(resend);
	assert.equal(emails.length, 2);
	for (const email of emails) assertChurchFooter(email);
});

test("a hand-off refuses when the address is cleared after scheduling, and writes no mail", async (t) => {
	t.after(() => setAddress(MAILING.street));
	const resend = resendRecorder(PRODUCTION);
	const message = await draft();
	const scheduled = ok(await schedule(message));
	await setAddress(null);
	refused(
		await handOff({ id: message.id, revision: scheduled.revision }, resend.transport, "handOffScheduled"),
		"mailing_address_missing",
	);
	assert.equal(await mailCount(message), 0);
	assert.deepEqual(resend.take(), []);
});

test("a scheduled email whose church clears its address is held at its send time and goes out once the address is back", async (t) => {
	t.after(() => setAddress(MAILING.street));
	const resend = resendRecorder(PRODUCTION);
	const message = await draft();
	const scheduled = ok(await schedule(message));
	ok(await handOff({ id: message.id, revision: scheduled.revision }, resend.transport, "handOffScheduled"));
	await setAddress(null);
	await atSendTime(f.admin, f.db, message.id, resend.transport, keys);
	assert.deepEqual(resend.take(), [], "nothing reaches the email service while the address is missing");
	const states = await rows(
		sql`SELECT DISTINCT state FROM mail WHERE logical_key LIKE ${"communication/" + message.id + "/%"}`,
	);
	assert.deepEqual(states, [{ state: "scheduled" }]);
	const item = ok(await read("listHistory", { limit: 100 })).items.find((row) => row.id === message.id);
	assert.equal(item.state, "held");
	assert.equal(hubLabel[item.state], "Held: no mailing address");
	assert.equal(ok(await read("getDeliveryTotals", { communicationId: message.id })).state, "held");

	await setAddress(MAILING.street);
	await minuteRunner(f.db, resend.transport, keys);
	const emails = sentEmails(resend);
	assert.equal(emails.length, 2);
	for (const email of emails) assertChurchFooter(email);
	const after = ok(await read("listHistory", { limit: 100 })).items.find((row) => row.id === message.id);
	assert.equal(after.state, "sending");
});

test("the preview footer shows the same mailing address as the sent email, and says it is missing when unset", async (t) => {
	t.after(() => setAddress(MAILING.street));
	const preview = ok(await read("readPreview", { bodyHtml: "<p>Hello {{name}}.</p>", merge: { name: "Ana" } }));
	assert.ok(preview.previewHtml.includes(`<span data-mailing-address>${FOOTER_LINE}</span>`));
	await setAddress(null);
	const missing = ok(await read("readPreview", { bodyHtml: "<p>Hello {{name}}.</p>", merge: { name: "Ana" } }));
	assert.ok(
		missing.previewHtml.includes(`<span data-mailing-address="missing" style="color:#B42318;">${MISSING}</span>`),
	);
	assert.equal(missing.previewHtml.includes("data-mailing-address>"), false);
	assert.equal(/everyfield/i.test(missing.previewHtml.replace(MISSING, "")), false);
});
