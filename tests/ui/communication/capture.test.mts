// Criterion 35: dev mail capture records sends in development and preview, never in production,
// and production sending through the provider is unchanged.
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, test } from "node:test";
import { captureAllowed, record } from "../../../apps/web/src/features/communication/capture.ts";
import { readOutbox } from "../../../apps/web/src/features/communication/outbox.ts";
import { deliveryTransport, mailReady } from "../../../apps/web/src/features/communication/mail.ts";

const keys = {
	IDENTITY_MAIL_KEY: "a".repeat(64),
	IDENTITY_ADDRESS_KEY: "b".repeat(64),
	IDENTITY_MAIL_FROM: "church@everyfield.test",
	IDENTITY_ORIGIN: "https://app.everyfield.test",
};
const saved = { ...process.env };
const setEnv = (values: Record<string, string | undefined>) => {
	for (const name of ["RESEND_API_KEY", "VERCEL_ENV"]) delete process.env[name];
	Object.assign(process.env, keys);
	for (const [name, value] of Object.entries(values)) {
		if (value === undefined) delete process.env[name];
		else process.env[name] = value;
	}
};
afterEach(() => {
	for (const name of Object.keys(process.env)) if (!(name in saved)) delete process.env[name];
	Object.assign(process.env, saved);
});

test("AC:CASE-COM-003 capture is allowed only without a provider key in local, development or preview", () => {
	assert.equal(captureAllowed({}), true);
	assert.equal(captureAllowed({ VERCEL_ENV: "development" }), true);
	assert.equal(captureAllowed({ VERCEL_ENV: "preview" }), true);
	assert.equal(captureAllowed({ VERCEL_ENV: "production" }), false);
	assert.equal(captureAllowed({ VERCEL_ENV: "something-new" }), false);
	assert.equal(captureAllowed({ RESEND_API_KEY: "re_live" }), false);
});

test("AC:CASE-COM-003 production without a provider key is not ready, so nothing is recorded or sent", () => {
	setEnv({ VERCEL_ENV: "production" });
	assert.equal(mailReady(), null);
	setEnv({ VERCEL_ENV: "production", RESEND_API_KEY: "   " });
	assert.equal(mailReady(), null);
});

test("AC:CASE-COM-003 a development server records each send and calls no provider", async () => {
	setEnv({});
	const ready = mailReady();
	assert.ok(ready && ready.apiKey === null);
	const refuseFetch: typeof fetch = () => Promise.reject(new Error("provider called"));
	const result = await deliveryTransport(ready, refuseFetch).send(
		{
			key: "k-1",
			messages: [{ to: "maria@example.test", subject: "Hello", html: "<p>Hi Maria</p>", text: "Hi Maria" }],
		},
		AbortSignal.timeout(1_000),
	);
	assert.equal(result.outcome, "ids");
	const [entry] = await readOutbox();
	assert.ok(entry);
	assert.equal(entry?.to, "maria@example.test");
	assert.equal(entry?.html, "<p>Hi Maria</p>");
});

test("AC:CASE-COM-003 production sending posts to the provider unchanged", async () => {
	setEnv({ VERCEL_ENV: "production", RESEND_API_KEY: "re_live_key", IDENTITY_MAIL_FROM: "church@resend.dev" });
	const ready = mailReady();
	assert.equal(ready?.apiKey, "re_live_key");
	const calls: string[] = [];
	const provider: typeof fetch = async (url) => {
		calls.push(String(url));
		return Response.json({ data: [{ id: "provider-1" }] });
	};
	const before = (await readOutbox()).length;
	const result = await deliveryTransport(ready!, provider).send(
		{ key: "k-2", messages: [{ to: "a@example.test", subject: "S", html: "<p>x</p>", text: "x" }] },
		AbortSignal.timeout(1_000),
	);
	assert.deepEqual(calls, ["https://api.resend.com/emails/batch"]);
	assert.deepEqual(result, { outcome: "ids", ids: ["provider-1"] });
	assert.equal((await readOutbox()).length, before);
});

test("the outbox lists newest first", async () => {
	const dir = await mkdtemp(join(tmpdir(), "outbox-test-"));
	const message = { from: "f@x.test", to: "t@x.test", html: "h", text: "t" };
	await record({ ...message, subject: "first" }, dir);
	await new Promise((done) => setTimeout(done, 5));
	await record({ ...message, subject: "second" }, dir);
	assert.deepEqual(
		(await readOutbox(dir)).map((e) => e.subject),
		["second", "first"],
	);
});
