// WP-029: outside production, email reaches approved test recipients only. Every other address goes to the capture
// outbox and never appears in a request to Resend, with or without a key. The real writers and transports run here
// against the recording fake of Resend. Nothing calls Resend. The CI db job runs this file.
import test, { after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { setImmediate } from "node:timers/promises";
import { randomBytes, randomUUID } from "node:crypto";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { closeDatabase } from "../../../packages/db/src/client.ts";
import { sql } from "../../../packages/db/src/query.ts";
import { mailRecipientAllowed } from "../../../packages/domain/src/mail-recipients.ts";
import { communicationWriter, withCommunicationWrite } from "../../../packages/domain/src/communication/index.ts";
import { receiveAccessRequest } from "../../../packages/domain/src/early-access/index.ts";
import { withPeopleWrite } from "../../../packages/domain/src/people/core.ts";
import { peopleWriter } from "../../../packages/domain/src/people/people.ts";
import { GET as outboxRoute } from "../../../apps/web/src/app/api/dev/outbox/route.ts";
import { NO_ANSWER_FILE } from "../../../apps/web/src/features/communication/capture.ts";
import {
	anticipateProvider,
	deliveryTransport,
	mailReady,
	queuedMailTransport,
} from "../../../apps/web/src/features/communication/mail.ts";
import { readOutbox } from "../../../apps/web/src/features/communication/outbox.ts";
import { createIdentityService } from "../../../packages/domain/src/identity/index.ts";
import { identityMailEnqueue, identityMailPass } from "../../../apps/web/src/server/identity/index.ts";
import { runDueInvitationMail } from "../../../apps/web/src/server/invitations/index.ts";
import { scheduledJobs } from "../../../apps/web/src/server/jobs/scheduled.ts";
import { createResendTransport } from "../../../apps/web/src/server/jobs/resend.ts";
import { fixture } from "../identity/invitations-support.mts";
import { resendRecorder } from "./resend-recorder.mts";
import { atSendTime, heldAtProvider } from "./scheduled-support.mts";
import { ok } from "../../support/fixture.mts";

const TYPED = "real.person@example.com";
const APPROVED = "delivered+qa-maria@resend.dev";
const DAY = 86_400_000;
const PREVIEW = { VERCEL_ENV: "preview", RESEND_API_KEY: "re_test_key" };
const PRODUCTION = { VERCEL_ENV: "production", RESEND_API_KEY: "re_test_key" };
const RESTRICTED = [
	["absent", {}],
	["development", { VERCEL_ENV: "development" }],
	["preview", { VERCEL_ENV: "preview" }],
	["something-new", { VERCEL_ENV: "something-new" }],
	["Production", { VERCEL_ENV: "Production" }],
	["empty", { VERCEL_ENV: "" }],
];
const mailKeys = { encryptionKey: randomBytes(32), addressKey: randomBytes(32) };
const keys = { ...mailKeys, from: "church@resend.dev", origin: "https://app.example.test" };
const ready = { keys, apiKey: "re_test_key" };
const message = (to, subject = "Hello") => ({ to, subject, html: `<p>${subject}</p>`, text: subject });
const signal = () => AbortSignal.timeout(5_000);
const key = () => randomUUID();
/** True when any request the recorder saw holds the address anywhere: path, header key or body. */
const holds = (requests, address) => JSON.stringify(requests).toLowerCase().includes(address.toLowerCase());
const outboxTo = async () => (await readOutbox()).map((entry) => entry.to);

/** Runs `body` with these process variables and restores them, for the code that reads process.env itself. */
async function withProcessEnv(values, body) {
	const saved = Object.fromEntries(Object.keys(values).map((name) => [name, process.env[name]]));
	const assign = (next) => {
		for (const [name, value] of Object.entries(next)) {
			if (value === undefined) delete process.env[name];
			else process.env[name] = value;
		}
	};
	assign(values);
	try {
		return await body();
	} finally {
		assign(saved);
	}
}

// Each test reads an empty outbox, so one test's captures never prove another's.
beforeEach(() => {
	process.env.EVERYFIELD_DEV_OUTBOX = mkdtempSync(join(tmpdir(), "wp029-outbox-"));
});

// The database starts only for a test that asks for it. The rule and text tests run without one.
let world = null;
async function database() {
	if (world) return world;
	const f = await fixture({ mailKeys });
	const plant = await f.workspace();
	const account = await f.account();
	await f.seat(account, plant, "owner");
	world = { f, plant, owner: await f.actor(account.session) };
	return world;
}
after(async () => {
	if (!world) return;
	const pools = globalThis[Symbol.for("everyfield.web.pools")];
	const pool = pools?.get(world.f.runtimeUrl);
	if (pool) {
		await closeDatabase(pool);
		pools.delete(world.f.runtimeUrl);
	}
	await world.f.close();
});

/** A person added through the same writer the screens call, with the address a tester typed. */
async function person(email) {
	const { f, owner } = await database();
	const created = ok(
		await withPeopleWrite(f.db, owner, (tx, ctx) =>
			peopleWriter.createPerson(tx, ctx, { requestKey: key(), input: { displayName: "Tester typed", email } }),
		),
	);
	return created.person.id;
}
async function draft(people) {
	const { f, owner } = await database();
	const saved = ok(
		await withCommunicationWrite(f.db, owner, (tx, ctx) =>
			communicationWriter.saveDraft(tx, ctx, {
				requestKey: key(),
				input: {
					subject: "Friday gathering",
					bodyHtml: "<p>Hello.</p>",
					audience: { groups: [], teamIds: [], personIds: people },
				},
			}),
		),
	);
	return { id: saved.communicationId, revision: saved.revision };
}
async function held(people, at = new Date(Date.now() + 3 * DAY).toISOString()) {
	const { f, owner } = await database();
	const saved = await draft(people);
	const scheduled = ok(
		await withCommunicationWrite(f.db, owner, (tx, ctx) =>
			communicationWriter.scheduleReviewed(tx, ctx, {
				requestKey: key(),
				expectedRevision: saved.revision,
				input: { communicationId: saved.id, scheduledAt: at },
			}),
		),
	);
	return { id: scheduled.communicationId, revision: scheduled.revision };
}
async function reviewed(op, sent, transport) {
	const { f, owner } = await database();
	return ok(
		await communicationWriter[op](
			f.db,
			owner,
			{ requestKey: key(), expectedRevision: sent.revision, input: { communicationId: sent.id } },
			transport,
			keys,
		),
	);
}
const sendNow = async (people, transport) => reviewed("sendReviewed", await held(people), transport);
/** Schedule, then the send time comes: the minute runner hands it to the email service then (T-241). */
const handOff = async (people, transport) => {
	const message = await held(people);
	const report = await reviewed("handOffScheduled", message, transport);
	const { f } = await database();
	await atSendTime(f.admin, f.db, message.id, transport, keys);
	return { message, report };
};
/** A scheduled email the email service holds with its send time, as before T-241. */
const heldHandOff = async (people, transport) => {
	const message = await held(people);
	const report = await reviewed("handOffScheduled", message, transport);
	const { f } = await database();
	await heldAtProvider(f.admin, message.id, transport, keys);
	return { message, report };
};
async function transactional(address, transport) {
	const { f, owner } = await database();
	return ok(
		await communicationWriter.sendTransactional(
			f.db,
			owner,
			{ requestKey: key(), input: { purpose: "password_reset", token: "reset-token-0123456789", address } },
			transport,
			keys,
		),
	);
}
async function providerIds(id) {
	const { f } = await database();
	const { rows } = await f.admin.execute(sql`SELECT m.provider_message_id AS id, r.provider_key AS key FROM mail m
		JOIN mail_request_member mem ON mem.mail_id = m.id JOIN mail_request r ON r.id = mem.request_id
		WHERE m.logical_key LIKE ${"communication/" + id + "/%"} ORDER BY mem.position`);
	return rows;
}

/** One queued invitation to `address`, sent by the real scheduled worker through the real queued transport. */
async function queuedInvitation(address, env, request) {
	const { f } = await database();
	const s = await f.setup("plant");
	const made = await f.invitations.invite(await f.actor(s.sender.session), {
		requestKey: key(),
		expectedRevision: "1",
		input: { workspace: s.w, role: "member", recipientEmail: address },
	});
	const mailed = await withProcessEnv(
		{
			IDENTITY_DATABASE_URL: f.runtimeUrl,
			IDENTITY_ORIGIN: "https://app.example.test",
			IDENTITY_SECRET: "s".repeat(32),
			IDENTITY_MAIL_KEY: mailKeys.encryptionKey.toString("hex"),
			IDENTITY_ADDRESS_KEY: mailKeys.addressKey.toString("hex"),
			IDENTITY_MAIL_FROM: "invitations@resend.dev",
		},
		() => runDueInvitationMail(queuedMailTransport(ready, request, env), 5, Infinity),
	);
	assert.equal(mailed, 1);
	const { rows } = await f.admin
		.execute(sql`SELECT m.state, m.provider_message_id AS id, r.provider_key AS key FROM mail m
		JOIN mail_request_member mem ON mem.mail_id = m.id JOIN mail_request r ON r.id = mem.request_id
		WHERE m.logical_key = ${`invitation/${made.invitation.invitationId}/1`}`);
	return rows[0];
}

const planter = (email) => ({
	name: "Sam Planter",
	email,
	plant_name: "Hope Church",
	city: "Boston",
	phase: "0 · Discovery",
	sending: "Sending Church",
});
const earlyEnv = (to, extra) => ({
	RESEND_API_KEY: "fake-provider-key",
	EMAIL_FROM: "Everyfield <hello@resend.dev>",
	EARLY_ACCESS_EMAIL_TO: to,
	...extra,
});
async function earlyAccess(env, request) {
	const { f } = await database();
	const email = `visitor-${key().slice(0, 8)}@example.org`;
	const result = await receiveAccessRequest("planter", planter(email), "192.0.2.1", {
		db: f.admin,
		fetch: request,
		env,
	});
	return { result, email };
}
function countingFetch() {
	const calls = [];
	const request = async (url, init) => {
		calls.push({ url: String(url), init });
		return Response.json({ id: `mail-${calls.length}` });
	};
	return { calls, request };
}

// The rule's purity (no value import, require, process, fetch, await or Date) is the everyfield/pure-module lint rule
// in .oxlintrc.json. Each sender refusing an unapproved address: WP-029-4, WP-029-8 and WP-029-14 (mail.ts), WP-029-9
// (server/jobs/resend.ts) and WP-029-10 (early access).
test("INV-email-safety: the rule reads only its two arguments", () => {
	const read = [];
	const env = new Proxy(
		{ VERCEL_ENV: "preview", EMAIL_TEST_RECIPIENTS: "tester@example.org", NODE_ENV: "production" },
		{
			get(target, name) {
				read.push(name);
				return target[name];
			},
		},
	);
	assert.equal(mailRecipientAllowed(env, "tester@example.org"), true);
	assert.deepEqual([...new Set(read)].sort(), ["EMAIL_TEST_RECIPIENTS", "VERCEL_ENV"]);
});

test("INV-email-safety: only VERCEL_ENV exactly production allows any address", () => {
	assert.equal(mailRecipientAllowed({ VERCEL_ENV: "production" }, TYPED), true);
	for (const [name, env] of RESTRICTED) assert.equal(mailRecipientAllowed(env, TYPED), false, name);
});

test("INV-email-safety: a restricted environment approves Resend test addresses and listed full addresses only", () => {
	const env = { VERCEL_ENV: "preview" };
	for (const address of [" Delivered+A@Resend.dev ", "delivered+a@resend.dev", APPROVED])
		assert.equal(mailRecipientAllowed(env, address), true, address);
	for (const address of [
		"delivered+a@resend.dev.example.com",
		"delivered+a@example.com",
		"someone@resend.dev",
		"delivered@resend.dev",
		"delivered+a@sub.resend.dev",
		"delivered+a@resend.dev@example.com",
		"real.person@example.com@delivered+a@resend.dev",
		"delivered+a@b@resend.dev",
		"delivered+a@resend.dev, real.person@example.com",
		"",
		"@",
		"@resend.dev",
	])
		assert.equal(mailRecipientAllowed(env, address), false, address);

	assert.equal(mailRecipientAllowed(env, "tester@example.org"), false, "the list is empty by default");
	const listed = { ...env, EMAIL_TEST_RECIPIENTS: " Tester@Example.org , other@example.net," };
	assert.equal(mailRecipientAllowed(listed, " TESTER@example.ORG "), true);
	assert.equal(mailRecipientAllowed(listed, "other@example.net"), true);
	assert.equal(mailRecipientAllowed(listed, "third@example.org"), false);
	assert.equal(mailRecipientAllowed(listed, ""), false, "the trailing comma approves nothing");
	for (const entry of ["example.com", "@example.com", "*@example.com", "*"]) {
		const pattern = { ...env, EMAIL_TEST_RECIPIENTS: entry };
		for (const address of ["someone@example.com", "*@example.com", "@example.com", "example.com"])
			assert.equal(mailRecipientAllowed(pattern, address), false, `${entry} approved ${address}`);
	}
});

test("INV-email-safety: on a preview with a key a typed address is captured on Send now, scheduled hand-off and transactional mail", async () => {
	const typed = await person(TYPED);
	const settled = [];
	const resend = resendRecorder(PREVIEW, (ids) => settled.push(...ids));

	const now = await sendNow([typed], resend.transport);
	assert.equal(now.acceptedCount, 1);
	assert.equal(settled.length, 1);
	assert.deepEqual(await outboxTo(), [TYPED]);

	const scheduled = await handOff([typed], resend.transport);
	assert.equal(scheduled.report.acceptedCount, 1);
	assert.match((await providerIds(scheduled.message.id))[0].id, /^capture-/);
	assert.equal(settled.length, 2, "at the send time the capture goes out at once");
	assert.deepEqual(await outboxTo(), [TYPED, TYPED]);

	const reset = await transactional("real.reset@example.com", resend.transport);
	assert.equal(reset.deliveryStatus, "accepted");
	assert.equal((await outboxTo()).includes("real.reset@example.com"), true);

	assert.deepEqual(resend.take(), [], "no request at all");

	const response = await withProcessEnv(PREVIEW, () => outboxRoute(new Request("https://preview.test/api/dev/outbox")));
	assert.equal(response.status, 200);
	const page = await response.text();
	assert.match(page, /real\.person@example\.com/);
	assert.match(page, /real\.reset@example\.com/);
});

test("INV-email-safety: a mixed batch splits, whatever the position of the approved message", async () => {
	const typed = await person("real.mixed@example.com");
	const maria = await person(APPROVED);
	const settled = [];
	const resend = resendRecorder(PREVIEW, (ids) => settled.push(...ids));
	const report = await sendNow([typed, maria], resend.transport);
	assert.equal(report.acceptedCount, 2);
	const [call, ...others] = resend.take();
	assert.deepEqual(others, []);
	assert.deepEqual(
		call.body.map((entry) => entry.to),
		[[APPROVED]],
	);
	assert.equal(holds([call], "real.mixed@example.com"), false);
	assert.deepEqual(await outboxTo(), ["real.mixed@example.com"]);
	assert.equal(settled.length, 1);
	assert.match(settled[0], /^capture-/);

	for (const [position, name] of [
		[0, "first"],
		[1, "middle"],
		[2, "last"],
	]) {
		for (const nullId of [false, true]) {
			const seen = [];
			const split = resendRecorder(PREVIEW, (ids) => seen.push(...ids));
			if (nullId) split.batch(() => false);
			const messages = ["one@example.com", "two@example.com"].map((to) => message(to));
			messages.splice(position, 0, message(APPROVED));
			const answer = await split.transport.send({ key: key(), messages, scheduledAt: null }, signal());
			assert.equal(answer.outcome, "ids", name);
			const approvedId = answer.ids[position];
			if (nullId) assert.equal(approvedId, null, name);
			else assert.equal(approvedId, "re-1", name);
			const captured = answer.ids.filter((_, index) => index !== position);
			assert.equal(captured.length, 2);
			for (const id of captured) assert.match(id, /^capture-/, name);
			assert.deepEqual(seen, captured, "settle receives capture ids only");
			const outbox = await readOutbox();
			for (const [index, id] of answer.ids.entries()) {
				if (index === position) continue;
				assert.equal(outbox.find((entry) => entry.id === id)?.to, messages[index].to, "each id is its own message");
			}
			const calls = split.take();
			assert.equal(calls.length, 1);
			assert.deepEqual(
				calls[0].body.map((entry) => entry.to[0]),
				[APPROVED],
			);
		}
	}
});

test("INV-email-safety: cancel and time change pick capture or Resend from the message id", async () => {
	const at = new Date(Date.now() + 3 * DAY).toISOString();
	const later = new Date(Date.now() + 4 * DAY).toISOString();
	const entry = async (id) => (await readOutbox()).find((row) => row.id === id);
	const resend = resendRecorder(PREVIEW, () => {});
	const sent = await resend.transport.send(
		{ key: key(), messages: [message(TYPED), message("second@example.com"), message(APPROVED)], scheduledAt: at },
		signal(),
	);
	const [first, second, provider] = sent.ids;
	resend.take();

	assert.deepEqual(await resend.transport.reschedule([first], later, signal()), [{ outcome: "done" }]);
	assert.equal((await entry(first)).scheduledAt, later);
	assert.deepEqual(await resend.transport.cancel([second], signal()), [{ outcome: "done" }]);
	assert.equal((await entry(second)).cancelled, true);
	assert.deepEqual(resend.take(), [], "a captured message makes no Resend call");

	assert.deepEqual(await resend.transport.reschedule([provider], later, signal()), [{ outcome: "done" }]);
	assert.deepEqual(await resend.transport.cancel([provider], signal()), [{ outcome: "done" }]);
	assert.deepEqual(
		resend.take().map((call) => `${call.method} ${call.path}`),
		[`PATCH /emails/${provider}`, `POST /emails/${provider}/cancel`],
	);

	// A capture id with no key and a Resend id with no key: neither one needs the key to pick its path.
	const noKey = deliveryTransport({ keys, apiKey: null }, resend.fetch, () => {}, PREVIEW);
	assert.deepEqual(await noKey.reschedule([first], later, signal()), [{ outcome: "done" }]);
	assert.deepEqual(await noKey.cancel(["re-unknown"], signal()), [{ outcome: "unknown" }]);
	assert.deepEqual(resend.take(), []);

	// The whole write path: the Messages screen's cancel of a held captured message.
	const typed = await person("real.cancel@example.com");
	const { message: message_ } = await heldHandOff([typed], resend.transport);
	const { f, owner } = await database();
	const { rows } = await f.admin.execute(
		sql`SELECT revision::text AS revision FROM communication WHERE id = ${message_.id}`,
	);
	const cancelled = ok(
		await communicationWriter.cancelScheduledReviewed(
			f.db,
			owner,
			{ requestKey: key(), expectedRevision: rows[0].revision, input: { communicationId: message_.id } },
			resend.transport,
		),
	);
	assert.equal(cancelled.scheduledCancel, "confirmed");
	assert.deepEqual(resend.take(), []);
	const [{ id }] = await providerIds(message_.id);
	assert.equal((await entry(id)).cancelled, true);
});

test("INV-email-safety: refusals and capture faults never reach the provider", async () => {
	const realFetch = globalThis.fetch;
	// The domain list settles through promise jobs only (no body stream), so one event-loop turn after the fetch
	// settles it: the wait is on the read, not on a clock.
	let fetched = 0;
	globalThis.fetch = async () => {
		fetched++;
		return {
			ok: true,
			status: 200,
			json: async () => ({ data: [{ name: "verified.example.org", status: "verified" }] }),
		};
	};
	const unverified = { keys: { ...keys, from: "news@unverified-church.org" }, apiKey: "re_test_key" };
	try {
		anticipateProvider(unverified);
		await setImmediate();
		assert.equal(fetched, 1, "the domain read started before the send");
	} finally {
		globalThis.fetch = realFetch;
	}
	const reserved = { keys: { ...keys, from: "news@example.test" }, apiKey: "re_test_key" };
	for (const [name, sender] of [
		["reserved", reserved],
		["unverified", unverified],
	]) {
		const resend = resendRecorder();
		const settled = [];
		const transport = deliveryTransport(sender, resend.fetch, (ids) => settled.push(...ids), PREVIEW);
		const before = (await readOutbox()).length;
		const captured = await transport.send({ key: key(), messages: [message(TYPED)], scheduledAt: null }, signal());
		assert.equal(captured.outcome, "ids", name);
		assert.match(captured.ids[0], /^capture-/);
		assert.deepEqual(settled, captured.ids);
		assert.equal((await readOutbox()).length, before + 1);
		const mixed = await transport.send(
			{ key: key(), messages: [message(TYPED), message(APPROVED)], scheduledAt: null },
			signal(),
		);
		assert.deepEqual(mixed, { outcome: "refused" }, name);
		assert.equal((await readOutbox()).length, before + 1, "a refused batch leaves no capture a retry would duplicate");
		assert.deepEqual(resend.take(), [], name);
	}

	// The outbox folder is a file, so each capture write fails.
	const blocked = join(process.env.EVERYFIELD_DEV_OUTBOX, "a-file");
	writeFileSync(blocked, "");
	await withProcessEnv({ EVERYFIELD_DEV_OUTBOX: blocked }, async () => {
		const resend = resendRecorder(PREVIEW, () => assert.fail("no capture to settle"));
		assert.deepEqual(
			await resend.transport.send({ key: key(), messages: [message(TYPED)], scheduledAt: null }, signal()),
			{ outcome: "unknown" },
		);
		assert.deepEqual(resend.take(), []);
		assert.deepEqual(
			await resend.transport.send(
				{ key: key(), messages: [message(TYPED), message(APPROVED)], scheduledAt: null },
				signal(),
			),
			{ outcome: "unknown" },
		);
		assert.equal(holds(resend.take(), TYPED), false);
		const queued = queuedMailTransport(ready, resend.fetch, PREVIEW);
		const payload = { from: "a@resend.dev", ...message(TYPED) };
		assert.deepEqual(await queued.send(payload, key(), signal()), { kind: "unknown" });
		assert.deepEqual(resend.take(), []);
	});

	// The no-answer switch stops a batch with a captured message before any POST.
	writeFileSync(join(process.env.EVERYFIELD_DEV_OUTBOX, NO_ANSWER_FILE), "");
	const quiet = resendRecorder(PREVIEW, () => {});
	assert.deepEqual(
		await quiet.transport.send(
			{ key: key(), messages: [message(TYPED), message(APPROVED)], scheduledAt: null },
			signal(),
		),
		{ outcome: "unknown" },
	);
	assert.deepEqual(quiet.take(), []);
});

test("INV-email-safety: queued invitation mail captures a typed address, sends an approved one, and answers a capture lookup from the outbox", async () => {
	const resend = resendRecorder();
	const typed = await queuedInvitation("real.invitee@example.com", PREVIEW, resend.fetch);
	assert.equal(typed.state, "accepted");
	assert.match(typed.id, /^capture-/);
	assert.deepEqual(resend.take(), []);
	assert.deepEqual(await outboxTo(), ["real.invitee@example.com"]);

	const approved = await queuedInvitation("delivered+qa-invitee@resend.dev", PREVIEW, resend.fetch);
	assert.equal(approved.state, "accepted");
	const [call, ...others] = resend.take();
	assert.deepEqual(others, []);
	assert.equal(call.path, "/emails");
	assert.equal(call.body.to, "delivered+qa-invitee@resend.dev");
	assert.equal(call.idempotencyKey, approved.key);
	assert.deepEqual(await outboxTo(), ["real.invitee@example.com"]);

	const transport = queuedMailTransport(ready, resend.fetch, PREVIEW);
	assert.deepEqual(await transport.lookup(typed.id, signal()), { kind: "accepted", id: typed.id });
	assert.deepEqual(resend.take(), [], "a capture id never asks Resend");
	// A replay under the stored key answers with the first capture and writes no second email.
	const { rows } = await (
		await database()
	).f.admin.execute(sql`SELECT r.provider_key AS key FROM mail m
		JOIN mail_request_member mem ON mem.mail_id = m.id JOIN mail_request r ON r.id = mem.request_id
		WHERE m.provider_message_id = ${typed.id}`);
	const payload = { from: "invitations@resend.dev", ...message("real.invitee@example.com") };
	assert.deepEqual(await transport.send(payload, rows[0].key, signal()), { kind: "accepted", id: typed.id });
	assert.deepEqual(await outboxTo(), ["real.invitee@example.com"]);
	assert.deepEqual(resend.take(), []);
	assert.deepEqual(await transport.lookup(approved.id, signal()), { kind: "accepted", id: approved.id });
	assert.equal(resend.take().length, 1, "a Resend id still asks Resend");
});

test("INV-email-safety: the guard is inside createResendTransport.send", async () => {
	const payload = { from: "a@resend.dev", ...message(TYPED) };
	const resend = resendRecorder();
	const transport = createResendTransport("re_test_key", resend.fetch, { VERCEL_ENV: "preview" });
	const outcome = await transport.send(payload, key(), signal());
	assert.equal(outcome.kind, "accepted");
	assert.match(outcome.id, /^capture-/);
	assert.deepEqual(resend.take(), []);
	assert.deepEqual(await outboxTo(), [TYPED]);

	// A future worker passes no environment: the default reads process.env at the call.
	const worker = createResendTransport("re_test_key", resend.fetch);
	await withProcessEnv({ VERCEL_ENV: "preview" }, () => worker.send(payload, key(), signal()));
	await withProcessEnv({ VERCEL_ENV: undefined }, () => worker.send(payload, key(), signal()));
	assert.deepEqual(resend.take(), []);
	assert.deepEqual(await outboxTo(), [TYPED, TYPED, TYPED]);
});

test("INV-email-safety: early access with a recipient that is not approved calls no fetch and answers unavailable", async () => {
	const { f } = await database();
	for (const [name, extra] of RESTRICTED) {
		const blocked = countingFetch();
		const { result, email } = await earlyAccess(earlyEnv("owner@example.org", extra), blocked.request);
		assert.deepEqual(result, { status: "unavailable" }, name);
		assert.deepEqual(blocked.calls, [], name);
		const { rows } = await f.admin.execute(
			sql`SELECT count(*)::int AS n FROM early_access_request WHERE email = ${email}`,
		);
		assert.equal(rows[0].n, 1, "the reservation row stays");
	}

	// The check reads the stored payload, not the current setting. The same request comes back after the setting
	// changed to an approved address, and the stored recipient still gets no request.
	const fields = planter(`stored-${key().slice(0, 8)}@example.org`);
	const stored = countingFetch();
	for (const to of ["owner@example.org", APPROVED]) {
		const answer = await receiveAccessRequest("planter", fields, "192.0.2.1", {
			db: f.admin,
			fetch: stored.request,
			env: earlyEnv(to, { VERCEL_ENV: "preview" }),
		});
		assert.deepEqual(answer, { status: "unavailable" }, to);
	}
	assert.deepEqual(stored.calls, []);

	const approved = countingFetch();
	const { result } = await earlyAccess(earlyEnv(APPROVED, { VERCEL_ENV: "preview" }), approved.request);
	assert.deepEqual(result, { status: "received" });
	assert.equal(approved.calls.length, 1);
	assert.deepEqual(JSON.parse(approved.calls[0].init.body).to, [APPROVED]);
	const listed = countingFetch();
	const allowlist = await earlyAccess(
		earlyEnv("owner@example.org", { VERCEL_ENV: "preview", EMAIL_TEST_RECIPIENTS: "owner@example.org" }),
		listed.request,
	);
	assert.deepEqual(allowlist.result, { status: "received" });
	assert.equal(listed.calls.length, 1);
});

test("INV-email-safety: production sends the typed address on all four paths, with the same request as before", async () => {
	const { f } = await database();
	const typed = await person("real.production@example.com");
	const resend = resendRecorder(PRODUCTION);

	const now = await sendNow([typed], resend.transport);
	assert.equal(now.acceptedCount, 1);
	const [nowCall, ...afterNow] = resend.take();
	assert.deepEqual(afterNow, []);
	assert.equal(nowCall.path, "/emails/batch");
	assert.deepEqual(Object.keys(nowCall.body[0]), ["from", "to", "subject", "html", "text"]);
	assert.equal(nowCall.body[0].from, keys.from);
	assert.deepEqual(nowCall.body[0].to, ["real.production@example.com"]);

	const scheduled = await handOff([typed], resend.transport);
	const [heldCall] = resend.take();
	const [stored] = await providerIds(scheduled.message.id);
	assert.equal(heldCall.idempotencyKey, stored.key);
	assert.deepEqual(heldCall.body[0].to, ["real.production@example.com"]);
	assert.equal(heldCall.body[0].scheduled_at, undefined, "at the send time it goes out at once");
	assert.match(stored.id, /^re-/);

	assert.equal((await transactional("real.prod.reset@example.com", resend.transport)).deliveryStatus, "accepted");
	assert.deepEqual(resend.take()[0].body[0].to, ["real.prod.reset@example.com"]);

	// The exact batch request.
	const batchKey = key();
	await resend.transport.send({ key: batchKey, messages: [message(TYPED)], scheduledAt: null }, signal());
	assert.deepEqual(resend.take(), [
		{
			method: "POST",
			path: "/emails/batch",
			idempotencyKey: batchKey,
			body: [{ from: keys.from, to: [TYPED], subject: "Hello", html: "<p>Hello</p>", text: "Hello" }],
		},
	]);

	// The exact queued request, by the real worker and directly.
	const invited = await queuedInvitation("real.invited@example.com", PRODUCTION, resend.fetch);
	const [queuedCall] = resend.take();
	assert.equal(queuedCall.body.to, "real.invited@example.com");
	assert.equal(queuedCall.idempotencyKey, invited.key);
	const queuedKey = key();
	const payload = { from: "a@resend.dev", ...message(TYPED) };
	await queuedMailTransport(ready, resend.fetch, PRODUCTION).send(payload, queuedKey, signal());
	assert.deepEqual(resend.take(), [{ method: "POST", path: "/emails", idempotencyKey: queuedKey, body: payload }]);

	// The exact early access request.
	const early = countingFetch();
	const { result, email } = await earlyAccess(
		earlyEnv("owner@example.org", { VERCEL_ENV: "production" }),
		early.request,
	);
	assert.deepEqual(result, { status: "received" });
	assert.equal(early.calls.length, 1);
	const [{ url, init }] = early.calls;
	assert.equal(url, "https://api.resend.com/emails");
	const { rows } = await f.admin.execute(sql`SELECT id FROM early_access_request WHERE email = ${email}`);
	assert.equal(new Headers(init.headers).get("idempotency-key"), `early-access/${rows[0].id}`);
	assert.deepEqual(JSON.parse(init.body), {
		from: "Everyfield <hello@resend.dev>",
		to: ["owner@example.org"],
		reply_to: email,
		subject: "Everyfield early access: planter",
		text: [
			"Form: planter",
			"Name: Sam Planter",
			`Email: ${email}`,
			"Plant name: Hope Church",
			"City: Boston",
			"Phase: 0 · Discovery",
			"Sending church or network: Sending Church",
		].join("\n"),
	});

	assert.deepEqual(await readOutbox(), [], "no capture file appears");
});

test("INV-email-safety: unknown, development and absent environments stay restricted, and the outbox stays closed elsewhere", async () => {
	for (const [name, env] of RESTRICTED) {
		const resend = resendRecorder(env, () => {});
		const batch = await resend.transport.send({ key: key(), messages: [message(TYPED)], scheduledAt: null }, signal());
		assert.equal(batch.outcome, "ids", name);
		assert.match(batch.ids[0], /^capture-/, name);
		const queued = await queuedMailTransport(ready, resend.fetch, env).send(
			{ from: "a@resend.dev", ...message(TYPED) },
			key(),
			signal(),
		);
		assert.equal(queued.kind, "accepted", name);
		assert.deepEqual(resend.take(), [], name);
	}
	const unknown = resendRecorder();
	await queuedInvitation("real.unknown@example.com", { VERCEL_ENV: "something-new" }, unknown.fetch);
	await queuedInvitation("real.development@example.com", { VERCEL_ENV: "development" }, unknown.fetch);
	await queuedInvitation("real.absent@example.com", {}, unknown.fetch);
	assert.deepEqual(unknown.take(), []);

	const mailKeysEnv = {
		IDENTITY_MAIL_KEY: "a".repeat(64),
		IDENTITY_ADDRESS_KEY: "b".repeat(64),
		IDENTITY_MAIL_FROM: "church@resend.dev",
		IDENTITY_ORIGIN: "https://app.example.test",
	};
	const request = () => new Request("https://server.test/api/dev/outbox");
	for (const VERCEL_ENV of ["production", "something-new"]) {
		for (const RESEND_API_KEY of ["re_test_key", undefined]) {
			const response = await withProcessEnv({ ...mailKeysEnv, VERCEL_ENV, RESEND_API_KEY }, () =>
				outboxRoute(request()),
			);
			assert.equal(response.status, 404, VERCEL_ENV);
		}
		const none = await withProcessEnv({ ...mailKeysEnv, VERCEL_ENV, RESEND_API_KEY: undefined }, () => mailReady());
		assert.equal(none, null, VERCEL_ENV);
	}
	for (const VERCEL_ENV of ["preview", "development", undefined]) {
		const response = await withProcessEnv({ VERCEL_ENV, RESEND_API_KEY: "re_test_key" }, () => outboxRoute(request()));
		assert.equal(response.status, 200, VERCEL_ENV);
	}
});

test("INV-email-safety: no variable other than VERCEL_ENV turns the guard off", async () => {
	const outbox = process.env.EVERYFIELD_DEV_OUTBOX;
	for (const [name, extra] of [
		["NODE_ENV", { NODE_ENV: "production" }],
		["list star", { EMAIL_TEST_RECIPIENTS: "*" }],
		["list domain", { EMAIL_TEST_RECIPIENTS: "example.com" }],
		["list at-domain", { EMAIL_TEST_RECIPIENTS: "@example.com" }],
		["list wildcard", { EMAIL_TEST_RECIPIENTS: "*@example.com" }],
		["outbox folder", { EVERYFIELD_DEV_OUTBOX: outbox }],
	]) {
		const env = { ...PREVIEW, ...extra };
		const resend = resendRecorder(env, () => {});
		const batch = await resend.transport.send({ key: key(), messages: [message(TYPED)], scheduledAt: null }, signal());
		assert.match(batch.ids[0], /^capture-/, name);
		const queued = await queuedMailTransport(ready, resend.fetch, env).send(
			{ from: "a@resend.dev", ...message(TYPED) },
			key(),
			signal(),
		);
		assert.match(queued.id, /^capture-/, name);
		assert.deepEqual(resend.take(), [], name);
	}
	const env = { ...PREVIEW, EMAIL_TEST_RECIPIENTS: "tester@example.org" };
	const resend = resendRecorder(env, () => {});
	const answer = await resend.transport.send(
		{ key: key(), messages: [message("tester@example.org"), message("different@example.org")], scheduledAt: null },
		signal(),
	);
	assert.equal(answer.outcome, "ids");
	const calls = resend.take();
	assert.deepEqual(
		calls[0].body.map((entry) => entry.to[0]),
		["tester@example.org"],
	);
	assert.equal(holds(calls, "different@example.org"), false);
	assert.equal((await outboxTo()).includes("different@example.org"), true);
});

test("AC:T151-1 a password-reset request reaches the capture outbox within one runner tick", async () => {
	const { f } = await database();
	const reader = await f.account();
	const origin = "https://app.example.test";
	await withProcessEnv(
		{
			IDENTITY_DATABASE_URL: String(f.runtimeUrl),
			IDENTITY_AUTH_DATABASE_URL: String(f.runtimeUrl),
			IDENTITY_ORIGIN: origin,
			IDENTITY_SECRET: "s".repeat(32),
			IDENTITY_MAIL_KEY: mailKeys.encryptionKey.toString("hex"),
			IDENTITY_ADDRESS_KEY: mailKeys.addressKey.toString("hex"),
			IDENTITY_MAIL_FROM: "security@resend.dev",
		},
		async () => {
			// The identity service as the identity mount builds it: its mail goes to the mount's queue.
			const delivery: (() => Promise<void>)[] = [];
			const identity = createIdentityService({
				db: f.db,
				authDb: f.admin,
				admissionDb: f.db,
				origin,
				secret: randomBytes(32).toString("hex"),
				scheduleDelivery: (work) => delivery.push(work),
				trustedIp: () => "127.0.0.1",
				enqueueMail: identityMailEnqueue()!,
				diagnostic: () => {},
			});
			const response = await identity.handle(
				new Request(`${origin}/api/auth/request-password-reset`, {
					method: "POST",
					headers: { host: "app.example.test", origin, "content-type": "application/json" },
					body: JSON.stringify({ email: reader.email }),
				}),
			);
			assert.equal(response.status, 200);
			for (const work of delivery) await work();
			assert.deepEqual(await outboxTo(), [], "the request only queues the email");

			// One tick, with the deployment's capture transport (no provider key) for the identity pass.
			const cron = "cron-" + randomUUID();
			const tick = await scheduledJobs({
				secret: cron,
				db: f.db,
				storage: null,
				cleanup: null,
				reminders: null,
				digests: null,
				mail: null,
				mountMail: { identity: identityMailPass(queuedMailTransport({ keys, apiKey: null })) },
			})(new Request("http://localhost/api/cron/jobs", { headers: { authorization: `Bearer ${cron}` } }));
			const body = await tick.json();
			assert.deepEqual(body.steps["identity-mail"], { status: "ok", count: 1 });
			const [entry, ...others] = await readOutbox();
			assert.deepEqual(others, []);
			assert.equal(entry.to, reader.email);
			assert.equal(entry.subject, "Reset your password");
			assert.match(entry.text, /https:\/\/app\.example\.test\/reset-password\?token=/);
		},
	);
});
