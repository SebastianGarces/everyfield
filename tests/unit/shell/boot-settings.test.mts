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

const malformed = {
	IDENTITY_ORIGIN: "sentinel-no-scheme",
	IDENTITY_SECRET: "sentinel-short",
	IDENTITY_MAIL_KEY: "sentinel-mail-key",
	IDENTITY_ADDRESS_KEY: "sentinel-address-key",
	IDENTITY_MAIL_FROM: "Sentinel Church <sentinel-display@example.test>",
};
const malformable = Object.keys(malformed) as (keyof typeof malformed)[];
const pieces = [...Object.values(values), ...Object.values(malformed)].flatMap((value) => [
	value,
	...value.split(/[^A-Za-z0-9]+/).filter((piece) => piece.length > 3),
]);

function boot(replaced: Readonly<Partial<Record<keyof typeof values, string | undefined>>>) {
	const settings = Object.entries({ ...values, ...replaced }).filter(([, value]) => value !== undefined);
	const env: Record<string, string> = {
		PATH: process.env.PATH ?? "",
		NEXT_RUNTIME: "nodejs",
		...Object.fromEntries(settings),
	};
	const child = spawnSync(
		process.execPath,
		[
			"--conditions=react-server",
			"--input-type=module",
			"-e",
			`await (await import(${JSON.stringify(instrumentation)})).register(); console.log("served");`,
		],
		{ env: env as NodeJS.ProcessEnv, encoding: "utf8", timeout: 30_000 },
	);
	return { status: child.status, stdout: child.stdout, stderr: child.stderr };
}

const line = (kind: "missing" | "malformed", names: readonly string[]) => ({
	component: "server",
	event: `settings_${kind}`,
	[kind]: names.toSorted().join(","),
});

function assertRefused(result: ReturnType<typeof boot>, expected: readonly ReturnType<typeof line>[]) {
	assert.equal(result.status, 1, result.stderr);
	assert.equal(result.stdout, "");
	assert.equal(result.stderr, expected.map((entry) => `${JSON.stringify(entry)}\n`).join(""));
	for (const piece of pieces) assert.ok(!result.stderr.includes(piece), "part of a setting value was printed");
	assert.doesNotMatch(result.stderr, /invalid|expected|too small|must match|zod/i, "a zod message was printed");
}

for (const key of keys)
	test(`boot refuses and names ${key} when it alone is unset`, () =>
		assertRefused(boot({ [key]: undefined }), [line("missing", [key])]));

test("boot names every missing setting and only those in one line", () => {
	const removed = { IDENTITY_SECRET: undefined, IDENTITY_DATABASE_URL: undefined, IDENTITY_MAIL_FROM: undefined };
	assertRefused(boot({ ...removed, IDENTITY_ORIGIN: "" }), [
		line("missing", [...Object.keys(removed), "IDENTITY_ORIGIN"]),
	]);
});

for (const key of malformable)
	test(`boot refuses and names ${key} when it alone is malformed`, () =>
		assertRefused(boot({ [key]: malformed[key] }), [line("malformed", [key])]));

test("boot names every malformed setting and only those in one line", () => {
	assertRefused(boot(malformed), [line("malformed", malformable)]);
	const { IDENTITY_MAIL_KEY, IDENTITY_MAIL_FROM } = malformed;
	assertRefused(boot({ IDENTITY_MAIL_KEY, IDENTITY_MAIL_FROM }), [
		line("malformed", ["IDENTITY_MAIL_KEY", "IDENTITY_MAIL_FROM"]),
	]);
});

test("boot names missing settings as missing and malformed ones as malformed, one line of each", () => {
	const { IDENTITY_SECRET, IDENTITY_MAIL_FROM } = malformed;
	assertRefused(boot({ IDENTITY_SECRET, IDENTITY_MAIL_FROM, IDENTITY_ORIGIN: undefined, IDENTITY_DATABASE_URL: "" }), [
		line("missing", ["IDENTITY_ORIGIN", "IDENTITY_DATABASE_URL"]),
		line("malformed", ["IDENTITY_SECRET", "IDENTITY_MAIL_FROM"]),
	]);
});
