import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { test } from "node:test";

const instrumentation = new URL("../../../apps/web/src/instrumentation.ts", import.meta.url).href;
const values = {
	IDENTITY_DATABASE_URL: "postgres://boot-runtime:sentinel-runtime-pass@127.0.0.1:1/none",
	IDENTITY_AUTH_DATABASE_URL: "postgres://boot-auth:sentinel-auth-pass@127.0.0.1:1/none",
	IDENTITY_ORIGIN: "https://sentinel-origin.example.test",
	IDENTITY_SECRET: "sentinel-secret-".repeat(4),
	IDENTITY_MAIL_KEY: "a".repeat(64),
	IDENTITY_ADDRESS_KEY: "b".repeat(64),
	IDENTITY_MAIL_FROM: "sentinel-sender@example.test",
};
const keys = Object.keys(values) as (keyof typeof values)[];

function boot(removed: readonly string[], emptied: readonly string[] = []) {
	const env: Record<string, string> = { PATH: process.env.PATH ?? "", NEXT_RUNTIME: "nodejs" };
	for (const key of keys) if (!removed.includes(key)) env[key] = emptied.includes(key) ? "" : values[key];
	const child = spawnSync(
		process.execPath,
		[
			"--conditions=react-server",
			"--input-type=module",
			"-e",
			`await (await import(${JSON.stringify(instrumentation)})).register(); console.log("served");`,
		],
		{ env, encoding: "utf8", timeout: 30_000 },
	);
	return { status: child.status, stdout: child.stdout, stderr: child.stderr };
}

function assertRefused(result: ReturnType<typeof boot>, missing: readonly string[]) {
	assert.equal(result.status, 1, result.stderr);
	assert.doesNotMatch(result.stdout, /served/);
	const lines = result.stderr.split("\n").filter(Boolean);
	assert.equal(lines.length, 1, result.stderr);
	assert.deepEqual(JSON.parse(lines[0]!), {
		component: "server",
		event: "settings_missing",
		...Object.fromEntries(missing.map((key) => [key, true])),
	});
	for (const value of Object.values(values))
		assert.ok(!result.stderr.includes(value), "a setting value reached the output");
}

for (const key of keys)
	test(`boot refuses and names ${key} when it alone is unset`, () => assertRefused(boot([key]), [key]));

test("boot names every missing setting and only those in one line", () => {
	const removed = ["IDENTITY_SECRET", "IDENTITY_DATABASE_URL", "IDENTITY_MAIL_FROM"];
	assertRefused(
		boot(removed, ["IDENTITY_ORIGIN"]),
		keys.filter((key) => removed.includes(key) || key === "IDENTITY_ORIGIN"),
	);
});
