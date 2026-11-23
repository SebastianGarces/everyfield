import assert from "node:assert/strict";
import { test } from "node:test";
import { errorClass } from "../../../packages/domain/src/log.ts";
import { setServerEnv } from "../../support/server-env.mts";

const FROM = "Everyfield <mail-sentinel-7731@example.test>";
setServerEnv({ IDENTITY_MAIL_FROM: FROM });
process.env.NEXT_RUNTIME = "nodejs";
delete process.env.VERCEL_ENV;
delete process.env.RESEND_API_KEY;

const { register } = await import("../../../apps/web/src/instrumentation.ts");
const { identityHandler, requestAuth } = await import("../../../apps/web/src/server/identity/index.ts");
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

test("INV-settings-log: a display-name IDENTITY_MAIL_FROM is logged by name once, with no part of its value, and refused identity settings carry their own error name", async () => {
	const failures: unknown[] = [];
	const all = await stderrOf(async () => {
		await register();
		for (let tick = 0; tick < 3; tick += 1) {
			assert.equal((await identityHandler(new Request("https://app.everyfield.test/api/auth/ok"))).status, 503);
			assert.throws(requestAuth, (error) => void failures.push(error) ?? true);
			assert.throws(mailReady, (error) => void failures.push(error) ?? true);
		}
	});
	const lines = all.filter((line) => line.component !== "evry");
	assert.deepEqual(lines, [{ component: "server", event: "config_missing", missing: "IDENTITY_MAIL_FROM" }]);
	for (const failure of failures) assert.deepEqual(errorClass(failure), { name: "ServerConfigError", code: null });
	const printed = JSON.stringify(all);
	for (const part of ["Everyfield", "mail-sentinel-7731", "example.test", "<", "Invalid"])
		assert.ok(!printed.includes(part), part);
});
