import test from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { once } from "node:events";
import { randomBytes } from "node:crypto";
import { createRequire } from "node:module";
import { join } from "node:path";
import { source } from "./fixtures.ts";
import { QUIET_IMAGE, startQuietDatabase, stopQuietDatabase } from "../timing-stack.ts";

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
