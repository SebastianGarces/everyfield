import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { pathToFileURL } from "node:url";
import { sql } from "../../../packages/db/node_modules/drizzle-orm/index.js";
import { migrate } from "../../../packages/db/src/schema/migrate.ts";
import { waitingOnLock } from "../../support/fixture.mts";
import { dropSchema, testDatabase } from "../../support/test-database.mts";

test("INV-isolation: a test schema's drop waits for a running migration, so files run in parallel never fill Postgres's shared lock table together", async () => {
	const database = await testDatabase({ prefix: "evrylock", migrate: false, roles: {} });
	const directory = await mkdtemp(join(tmpdir(), "evry-lock-"));
	const holder = database.connect("admin", { max: 1 });
	try {
		await database.admin.execute(sql`CREATE TABLE gate (id int)`);
		await writeFile(join(directory, "0001_gate.sql"), "SELECT count(*) FROM gate");
		const other = await database.createSchema(`evrylockdrop_${randomUUID().replaceAll("-", "")}`);
		let locked!: (pid: number) => void;
		let release!: () => void;
		const gateLocked = new Promise<number>((resolve) => (locked = resolve));
		const released = new Promise<void>((resolve) => (release = resolve));
		const holding = holder.transaction(async (tx) => {
			await tx.execute(sql`LOCK TABLE gate IN ACCESS EXCLUSIVE MODE`);
			const { rows } = await tx.execute<{ pid: number }>(sql`SELECT pg_catalog.pg_backend_pid() AS pid`);
			locked(rows[0]!.pid);
			await released;
		});
		const holderPid = await gateLocked;
		const order: string[] = [];
		const migrating = migrate(database.admin, database.schema, pathToFileURL(`${directory}/`)).then(() =>
			order.push("migrate"),
		);
		await waitingOnLock(database.admin, { blockedBy: holderPid });
		const { rows: blocked } = await database.admin.execute<{ pid: number }>(
			sql`SELECT pid FROM pg_catalog.pg_stat_activity WHERE ${holderPid}::int=ANY(pg_catalog.pg_blocking_pids(pid))`,
		);
		const migrationPid = blocked[0]!.pid;
		const dropped = new AbortController();
		const dropping = dropSchema(database.admin, other).then(() => {
			order.push("drop");
			dropped.abort();
		});
		const dropWaited = await waitingOnLock(database.admin, { blockedBy: migrationPid, signal: dropped.signal });
		release();
		await Promise.all([holding, migrating, dropping]);
		assert.equal(dropWaited, true, "the drop waits for the migration lock");
		assert.deepEqual(order, ["migrate", "drop"]);
		const { rows } = await database.admin.execute<{ n: number }>(
			sql`SELECT count(*)::int AS n FROM pg_catalog.pg_namespace WHERE nspname=${other}`,
		);
		assert.equal(rows[0]!.n, 0, "the schema is gone once the migration ends");
	} finally {
		await rm(directory, { recursive: true, force: true });
		await database.close();
	}
});
