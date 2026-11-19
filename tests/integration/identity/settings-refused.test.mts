import assert from "node:assert/strict";
import { test } from "node:test";

const FROM = "Everyfield <mail-sentinel-7731@example.test>";
Object.assign(process.env, {
	NEXT_RUNTIME: "nodejs",
	IDENTITY_DATABASE_URL: "postgres://runtime@127.0.0.1:1/never",
	IDENTITY_AUTH_DATABASE_URL: "postgres://auth@127.0.0.1:1/never",
	IDENTITY_ORIGIN: "https://app.everyfield.test",
	IDENTITY_SECRET: "c".repeat(64),
	IDENTITY_MAIL_KEY: "a".repeat(64),
	IDENTITY_ADDRESS_KEY: "b".repeat(64),
	IDENTITY_MAIL_FROM: FROM,
});
delete process.env.VERCEL_ENV;
delete process.env.RESEND_API_KEY;

const { register } = await import("../../../apps/web/src/instrumentation.ts");
const { identityHandler, identityMailEnqueue, identityMailPass } =
	await import("../../../apps/web/src/server/identity/index.ts");
const { mailReady, queuedMailTransport } = await import("../../../apps/web/src/server/mail/transport.ts");

async function stderrOf(run: () => unknown): Promise<Record<string, unknown>[]> {
	const lines: string[] = [];
	const write = console.error;
	console.error = (line: unknown) => void lines.push(String(line));
	try {
		await run();
	} finally {
		console.error = write;
	}
	return lines.map((line) => JSON.parse(line) as Record<string, unknown>);
}

test("INV-settings-log: a display-name IDENTITY_MAIL_FROM is logged by name once per check, with no part of its value, and warm_failed says identity settings were refused", async () => {
	const all = await stderrOf(async () => {
		await register();
		for (let tick = 0; tick < 3; tick += 1) {
			assert.equal((await identityHandler(new Request("https://app.everyfield.test/api/auth/ok"))).status, 503);
			assert.equal(identityMailEnqueue(), null);
			assert.equal(identityMailPass(queuedMailTransport({ keys: {} as never, apiKey: null })), null);
			assert.equal(mailReady(), null);
		}
	});
	const lines = all.filter((line) => line.component !== "evry");
	assert.deepEqual(lines, [
		{ component: "identity", event: "settings_refused", settings: "IDENTITY_MAIL_FROM" },
		{
			component: "server",
			event: "warm_failed",
			ms: lines[1]?.ms ?? -1,
			error: { name: "IdentitySettingsRefused", code: null },
		},
		{ component: "mail", event: "settings_refused", settings: "IDENTITY_MAIL_FROM" },
	]);
	const printed = JSON.stringify(all);
	for (const part of ["Everyfield", "mail-sentinel-7731", "example.test", "<", "Invalid"])
		assert.ok(!printed.includes(part), part);
});

test("INV-settings-log: mail names each refused setting and only those; settings that pass log nothing", async () => {
	process.env.IDENTITY_MAIL_FROM = "mail@everyfield.test";
	assert.deepEqual(await stderrOf(() => assert.notEqual(mailReady(), null)), []);
	process.env.IDENTITY_ADDRESS_KEY = process.env.IDENTITY_MAIL_KEY;
	process.env.VERCEL_ENV = "production";
	assert.deepEqual(
		await stderrOf(() => {
			assert.equal(mailReady(), null);
			assert.equal(mailReady(), null);
		}),
		[{ component: "mail", event: "settings_refused", settings: "RESEND_API_KEY" }],
	);
	process.env.RESEND_API_KEY = "re_test_key";
	assert.deepEqual(await stderrOf(() => assert.equal(mailReady(), null)), [
		{ component: "mail", event: "settings_refused", settings: "IDENTITY_ADDRESS_KEY,IDENTITY_MAIL_KEY" },
	]);
});
