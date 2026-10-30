import test from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { once } from "node:events";
import { randomBytes } from "node:crypto";
import { createRequire } from "node:module";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { source } from "./fixtures.ts";
import { QUIET_IMAGE, removeStaleQuietDatabases, startQuietDatabase, stopQuietDatabase } from "../timing-stack.ts";

const docker = (...args: string[]) => spawnSync("docker", args, { encoding: "utf8" }).stdout.trim();

test("OPS-52-P2: the quiet database starts, migrates, logs the app in as its own roles and stops", async (t) => {
	// A run that crashed left its database behind. Every evf run on this machine sweeps databases whose run has
	// ended, so the owner stays alive until the check below has seen the fixture, then it crashes (OPS-53).
	const owner = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"]);
	t.after(() => owner.kill());
	const stale = `evf-timing-stale-${randomBytes(3).toString("hex")}`;
	docker("create", "--name", stale, "--label", "evf.timing=1", "--label", `evf.pid=${owner.pid}`, QUIET_IMAGE);
	assert.equal(docker("ps", "-a", "--filter", `name=${stale}`, "--format", "{{.Names}}"), stale);
	owner.kill("SIGKILL");
	await once(owner, "exit");

	const db = startQuietDatabase(source, "test");
	try {
		assert.equal(docker("ps", "-a", "--filter", `name=${stale}`, "--format", "{{.Names}}"), "");
		const pg = createRequire(join(source, "packages/db/package.json"))("pg");
		const ask = async (url: string, sql: string) => {
			const client = new pg.Client({ connectionString: url });
			await client.connect();
			try {
				return (await client.query(sql)).rows[0];
			} finally {
				await client.end();
			}
		};
		// Migrated by the head's own db:migrate: every migration file on disk is recorded as applied.
		const files = spawnSync("git", ["-C", source, "ls-files", "packages/db/migrations/*.sql"], { encoding: "utf8" })
			.stdout.trim()
			.split("\n").length;
		assert.deepEqual(await ask(db.adminUrl, "SELECT count(*)::int AS n FROM schema_migration"), { n: files });
		assert.deepEqual(
			await ask(
				db.previewEnv.IDENTITY_DATABASE_URL,
				"SELECT current_user AS u, rolsuper AS s FROM pg_roles WHERE rolname = current_user",
			),
			{ u: "evf_runtime", s: false },
		);
		assert.deepEqual(
			await ask(db.previewEnv.IDENTITY_AUTH_DATABASE_URL, "SELECT pg_has_role('everyfield_auth', 'member') AS m"),
			{ m: true },
		);
		// Every database login the preview gets is on this machine's quiet database.
		for (const key of ["DATABASE_URL", "DATABASE_URL_UNPOOLED", "IDENTITY_DATABASE_URL", "IDENTITY_AUTH_DATABASE_URL"])
			assert.equal(new URL(db.previewEnv[key]).hostname, "127.0.0.1", key);
		assert.equal(db.previewEnv.IDENTITY_ORIGIN, "${PREVIEW_URL}");
	} finally {
		stopQuietDatabase(db);
	}
	assert.equal(docker("ps", "-a", "--filter", `name=${db.container}`, "--format", "{{.Names}}"), "");
});

test("OPS-71: every quiet-database removal also removes the container's anonymous volumes", async (t) => {
	// A fake docker records each call. Its image declares a volume, so a bare `docker rm -f` would leak it.
	const dir = mkdtempSync(join(tmpdir(), "evf-fake-docker-"));
	const log = join(dir, "calls.log");
	writeFileSync(
		join(dir, "docker"),
		`#!/bin/sh
echo "$*" >> "${log}"
case "$1" in
  info) echo 27.0 ;;
  ps) echo "evf-timing-stale-abc 999999999" ;;
  exec) exit 0 ;;
  port) echo "boom" >&2; exit 1 ;;
esac
exit 0
`,
		{ mode: 0o755 },
	);
	const path = process.env.PATH;
	process.env.PATH = `${dir}${delimiter}${path}`;
	t.after(() => {
		process.env.PATH = path;
		rmSync(dir, { recursive: true, force: true });
	});
	const removals = () =>
		readFileSync(log, "utf8")
			.split("\n")
			.filter((line) => line.startsWith("rm "));

	// 1. The stale sweep.
	assert.deepEqual(removeStaleQuietDatabases(), ["evf-timing-stale-abc"]);
	assert.deepEqual(removals(), ["rm -f -v evf-timing-stale-abc"]);

	// 2. The failure path of startQuietDatabase: `docker port` fails after the container started.
	rmSync(log);
	assert.throws(() => startQuietDatabase(source, "fake"), /docker port failed/);
	const failed = removals();
	assert.equal(failed.length, 2, "the sweep and the failure path each remove once");
	assert.match(failed[0], /^rm -f -v evf-timing-stale-abc$/);
	assert.match(failed[1], /^rm -f -v evf-timing-fake-[0-9a-f]{6}$/);

	// 3. stopQuietDatabase.
	rmSync(log);
	stopQuietDatabase({ container: "evf-timing-x" });
	assert.deepEqual(removals(), ["rm -f -v evf-timing-x"]);
});
