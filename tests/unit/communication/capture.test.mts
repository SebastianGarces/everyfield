import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, before, test } from "node:test";
import { isTestDeployment } from "../../../packages/db/src/deployment.ts";
import type { ProviderKey } from "../../../packages/contracts/src/common/values.ts";
import type { Captured } from "../../../apps/web/src/server/mail/capture.ts";
import { readOutbox } from "../../../apps/web/src/features/communication/outbox.ts";
import { deliveryTransport, mailReady } from "../../../apps/web/src/server/mail/transport.ts";

const keys = {
	IDENTITY_MAIL_KEY: "a".repeat(64),
	IDENTITY_ADDRESS_KEY: "b".repeat(64),
	IDENTITY_MAIL_FROM: "church@everyfield.test",
	IDENTITY_ORIGIN: "https://app.everyfield.test",
};
const storedKey = (key: string) => key as ProviderKey;
const saved = { ...process.env };
let outbox = "";
before(async () => {
	outbox = await mkdtemp(join(tmpdir(), "everyfield-capture-test-"));
	process.env.EVERYFIELD_DEV_OUTBOX = outbox;
	saved.EVERYFIELD_DEV_OUTBOX = outbox;
});
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

test("AC:CASE-COM-003 the capture outbox opens in local, development or preview, with or without a provider key", () => {
	assert.equal(isTestDeployment({}), true);
	assert.equal(isTestDeployment({ VERCEL_ENV: "development" }), true);
	assert.equal(isTestDeployment({ VERCEL_ENV: "preview" }), true);
	assert.equal(isTestDeployment({ VERCEL_ENV: "production" }), false);
	assert.equal(isTestDeployment({ VERCEL_ENV: "something-new" }), false);
	assert.equal(isTestDeployment({ RESEND_API_KEY: "re_live" }), true);
	assert.equal(isTestDeployment({ VERCEL_ENV: "preview", RESEND_API_KEY: "re_live" }), true);
	assert.equal(isTestDeployment({ VERCEL_ENV: "production", RESEND_API_KEY: "re_live" }), false);
	assert.equal(isTestDeployment({ VERCEL_ENV: "something-new", RESEND_API_KEY: "re_live" }), false);
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
	const settled: string[] = [];
	const result = await deliveryTransport(ready, refuseFetch, {
		settle: async (_db, ids) => void settled.push(...ids),
	}).send(
		{
			key: storedKey("k-1"),
			messages: [{ to: "maria@example.test", subject: "Hello", html: "<p>Hi Maria</p>", text: "Hi Maria" }],
			scheduledAt: null,
		},
		AbortSignal.timeout(1_000),
	);
	assert.equal(result.outcome, "ids");
	assert.deepEqual(settled, []);
	if (result.outcome === "ids") await result.afterRecord?.(null as never);
	assert.deepEqual(settled, result.outcome === "ids" ? result.ids.filter((id): id is string => id !== null) : []);
	assert.equal(settled.length, 1);
	const [entry] = await readOutbox(outbox);
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
	const before = (await readOutbox(outbox)).length;
	const result = await deliveryTransport(ready!, provider, {
		settle: async () => assert.fail("a provider send settles nothing"),
	}).send(
		{
			key: storedKey("k-2"),
			messages: [{ to: "a@example.test", subject: "S", html: "<p>x</p>", text: "x" }],
			scheduledAt: null,
		},
		AbortSignal.timeout(1_000),
	);
	assert.deepEqual(calls, ["https://api.resend.com/emails/batch"]);
	assert.deepEqual(result, { outcome: "ids", ids: ["provider-1"] });
	assert.equal((await readOutbox(outbox)).length, before);
});

test("INV-communication-outbox: the outbox lists newest first", async () => {
	const dir = await mkdtemp(join(tmpdir(), "outbox-test-"));
	const entry = (subject: string, at: string, n: number): Captured => ({
		id: `capture-0000000${n}-0000-0000-0000-000000000000`,
		at,
		from: "f@x.test",
		to: "t@x.test",
		subject,
		html: "h",
		text: "t",
		scheduledAt: null,
		cancelled: false,
	});
	for (const captured of [
		entry("first", "2026-11-18T10:00:00.000Z", 1),
		entry("second", "2026-11-18T10:00:00.001Z", 2),
	])
		await writeFile(join(dir, `${captured.id}.json`), JSON.stringify(captured));
	assert.deepEqual(
		(await readOutbox(dir)).map((e) => e.subject),
		["second", "first"],
	);
});

test("AC:CASE-COM-012 a scheduled capture waits in the outbox, and cancel and time change act on it by its id", async () => {
	setEnv({});
	const ready = mailReady()!;
	const settled: string[] = [];
	const capture = deliveryTransport(ready, () => Promise.reject(new Error("provider called")), {
		settle: async (_db, ids) => void settled.push(...ids),
	});
	const signal = () => AbortSignal.timeout(1_000);
	const friday = new Date(Date.now() + 3 * 86_400_000).toISOString();
	const saturday = new Date(Date.now() + 4 * 86_400_000).toISOString();
	const held = await capture.send(
		{
			key: storedKey("k-held"),
			messages: [
				{ to: "ana@example.test", subject: "Held", html: "<p>a</p>", text: "a" },
				{ to: "ben@example.test", subject: "Held", html: "<p>b</p>", text: "b" },
			],
			scheduledAt: friday,
		},
		signal(),
	);
	assert.equal(held.outcome, "ids");
	const [first, second] = held.outcome === "ids" ? (held.ids as string[]) : [];
	assert.deepEqual(settled, []);
	const entry = async (id: string) => JSON.parse(await readFile(join(outbox, `${id}.json`), "utf8"));
	assert.equal((await entry(first!)).scheduledAt, friday);

	assert.deepEqual(await capture.reschedule([first!], saturday, signal()), [{ outcome: "done" }]);
	assert.equal((await entry(first!)).scheduledAt, saturday);
	assert.deepEqual(await capture.reschedule([first!], saturday, signal()), [{ outcome: "done" }]);
	assert.deepEqual(await capture.cancel([second!], signal()), [{ outcome: "done" }]);
	assert.equal((await entry(second!)).cancelled, true);
	assert.deepEqual(await capture.cancel([second!], signal()), [{ outcome: "done" }]);
	assert.deepEqual(await capture.reschedule([second!], saturday, signal()), [{ outcome: "unknown" }]);
	assert.deepEqual(await capture.cancel(["capture-00000000-0000-0000-0000-000000000000"], signal()), [
		{ outcome: "unknown" },
	]);
	assert.deepEqual(await capture.cancel(["../escape"], signal()), [{ outcome: "unknown" }]);

	const past = await capture.send(
		{
			key: storedKey("k-now"),
			messages: [{ to: "cy@example.test", subject: "Now", html: "<p>c</p>", text: "c" }],
			scheduledAt: null,
		},
		signal(),
	);
	const sentId = past.outcome === "ids" ? past.ids[0]! : "";
	assert.deepEqual(await capture.cancel([sentId], signal()), [{ outcome: "sent" }]);
	assert.deepEqual(await capture.reschedule([sentId], saturday, signal()), [{ outcome: "sent" }]);
});

test("AC:CASE-COM-012 a silent capture answers nothing, so each not-confirmed state can be shown", async () => {
	setEnv({});
	const ready = mailReady()!;
	const refuse = () => Promise.reject(new Error("provider called"));
	const capture = deliveryTransport(ready, refuse, { settle: async () => {} });
	const silent = deliveryTransport(ready, refuse, { silent: true });
	const signal = () => AbortSignal.timeout(1_000);
	const friday = new Date(Date.now() + 3 * 86_400_000).toISOString();
	const held = await capture.send(
		{
			key: storedKey("k-quiet"),
			messages: [{ to: "dee@example.test", subject: "Q", html: "<p>d</p>", text: "d" }],
			scheduledAt: friday,
		},
		signal(),
	);
	const id = held.outcome === "ids" ? held.ids[0]! : "";
	const before = (await readOutbox(outbox)).length;
	assert.deepEqual(await silent.cancel([id], signal()), [{ outcome: "unknown" }]);
	const later = new Date(Date.now() + 5 * 86_400_000).toISOString();
	assert.deepEqual(await silent.reschedule([id], later, signal()), [{ outcome: "unknown" }]);
	assert.deepEqual(
		await silent.send(
			{
				key: storedKey("k-q2"),
				messages: [{ to: "eli@example.test", subject: "Q", html: "<p>e</p>", text: "e" }],
				scheduledAt: null,
			},
			signal(),
		),
		{ outcome: "unknown" },
	);
	assert.equal((await readOutbox(outbox)).length, before);
	assert.deepEqual(await capture.cancel([id], signal()), [{ outcome: "done" }]);
});
