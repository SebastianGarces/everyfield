import test, { afterEach } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { assertDevelopmentDatabase, developmentHosts } from "../../../packages/db/src/development.ts";

const KEYS = ["NODE_ENV", "CI", "EARLY_ACCESS_TEST_DATABASE", "DATABASE_URL", "DATABASE_URL_UNPOOLED"] as const;
const saved = Object.fromEntries(KEYS.map((k) => [k, process.env[k]]));
afterEach(() => {
	for (const k of KEYS)
		if (saved[k] === undefined) delete process.env[k];
		else process.env[k] = saved[k];
});
function env(values: Partial<Record<(typeof KEYS)[number], string>>) {
	for (const k of KEYS) delete process.env[k];
	Object.assign(process.env, values);
}

const [direct, pooled] = [...developmentHosts];
const url = (host: string, path = "/neondb") => `postgresql://user:secret-pw@${host}${path}?sslmode=require`;
const CI = { CI: "true", EARLY_ACCESS_TEST_DATABASE: "1" };

test("INV-dev-database: the guard accepts the pooled and direct development endpoints", () => {
	env({});
	assert.ok(direct && !direct.includes("-pooler") && pooled?.includes("-pooler"));
	for (const host of [direct!, pooled!]) assert.equal(assertDevelopmentDatabase(url(host)).hostname, host);
	assert.equal(assertDevelopmentDatabase(new URL(url(direct!))).hostname, direct);
});

test("INV-dev-database: the guard accepts CI's localhost database only with CI=true and EARLY_ACCESS_TEST_DATABASE=1", () => {
	env(CI);
	for (const host of ["localhost", "127.0.0.1"])
		assert.equal(assertDevelopmentDatabase(url(`${host}:5432`, "/everyfield_ci")).hostname, host);
	for (const partial of [{}, { CI: "true" }, { EARLY_ACCESS_TEST_DATABASE: "1" }, { ...CI, CI: "1" }]) {
		env(partial);
		assert.throws(() => assertDevelopmentDatabase(url("localhost:5432", "/everyfield_ci")));
	}
});

test("INV-dev-database: the guard refuses production, other hosts and bad URLs without echoing them", () => {
	env(CI);
	for (const raw of [
		url("ep-gentle-dust-b8tvq4ha.c-14.us-east-1.aws.neon.tech"),
		url("ep-gentle-dust-b8tvq4ha-pooler.c-14.us-east-1.aws.neon.tech"),
		url("db.example.org"),
		url(`${direct}.example.org`),
		"not a url",
		"",
		undefined,
	])
		assert.throws(
			() => assertDevelopmentDatabase(raw),
			(e: Error) => !e.message.includes("secret-pw") && !e.message.includes("example") && !e.message.includes("ep-"),
		);
});

test("INV-dev-database: the guard refuses every host under NODE_ENV=production", () => {
	env({ ...CI, NODE_ENV: "production" });
	for (const host of [direct!, pooled!, "localhost"]) assert.throws(() => assertDevelopmentDatabase(url(host)));
});

test("INV-dev-database: the tests/ui seeds' guard takes CI's everyfield_ci only under CI's flags", async () => {
	const { testDatabaseUrl } = await import("../../support/test-database.mts");
	const at = (value: string) => {
		process.env.DATABASE_URL = value;
		return () => testDatabaseUrl();
	};
	env(CI);
	for (const host of ["localhost:5432", "127.0.0.1:5432"])
		assert.equal(at(`postgres://ci:ci@${host}/everyfield_ci`)().pathname, "/everyfield_ci");
	assert.equal(at(url(direct!))().searchParams.get("sslmode"), "verify-full");
	assert.throws(at("postgres://ci:ci@localhost:5432/other_db"));
	assert.throws(at("postgres://ci:ci@db.example.org:5432/everyfield_ci"));
	env({});
	assert.throws(at("postgres://ci:ci@localhost:5432/everyfield_ci"));
	env({ ...CI, NODE_ENV: "production" });
	assert.throws(at("postgres://ci:ci@localhost:5432/everyfield_ci"));
});

test("INV-dev-database: the development reset refuses CI's localhost database, which the guard accepts", () => {
	for (const host of ["localhost", "127.0.0.1"]) {
		const raw = `postgresql://made-up-user:made-up-secret@${host}:1/made_up_database`;
		const run = spawnSync(
			process.execPath,
			[fileURLToPath(new URL("../../../packages/db/scripts/reset-dev.ts", import.meta.url))],
			{ env: { PATH: process.env.PATH, ...CI, DATABASE_URL: raw }, encoding: "utf8", timeout: 60_000 },
		);
		const printed = run.stdout + run.stderr;
		assert.equal(run.status, 1, printed);
		assert.match(run.stderr, /^Reset refused\./);
		assert.doesNotMatch(printed, /Development reset failed/);
		for (const part of ["made-up-user", "made-up-secret", "made_up_database", host])
			assert.equal(printed.includes(part), false, part);
	}
});
