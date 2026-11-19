import assert from "node:assert/strict";
import { test } from "node:test";
import { setServerEnv } from "../../support/server-env.mts";

setServerEnv();
delete process.env.VERCEL_ENV;
delete process.env.RESEND_API_KEY;

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

test("INV-settings-log: production mail without RESEND_API_KEY is logged by that name once; settings that pass log nothing", async () => {
	assert.deepEqual(await stderrOf(() => assert.notEqual(mailReady(), null)), []);
	process.env.VERCEL_ENV = "production";
	assert.deepEqual(
		await stderrOf(() => {
			assert.equal(mailReady(), null);
			assert.equal(mailReady(), null);
		}),
		[{ component: "mail", event: "settings_refused", settings: "RESEND_API_KEY" }],
	);
});
