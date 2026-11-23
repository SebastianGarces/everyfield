import assert from "node:assert/strict";
import { test } from "node:test";
import { setServerEnv, SERVER_ENV } from "../../support/server-env.mts";

setServerEnv({ IDENTITY_ADDRESS_KEY: SERVER_ENV.IDENTITY_MAIL_KEY });
process.env.RESEND_API_KEY = "re_test_key";
delete process.env.VERCEL_ENV;

const { mailReady } = await import("../../../apps/web/src/server/mail/transport.ts");

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

test("INV-settings-log: mail keys that are equal are logged by both names once, with no value", async () => {
	const lines = await stderrOf(() => {
		assert.equal(mailReady(), null);
		assert.equal(mailReady(), null);
	});
	assert.deepEqual(lines, [
		{ component: "mail", event: "settings_refused", settings: "IDENTITY_ADDRESS_KEY,IDENTITY_MAIL_KEY" },
	]);
	for (const part of ["re_test_key", SERVER_ENV.IDENTITY_MAIL_KEY]) assert.ok(!JSON.stringify(lines).includes(part));
});
