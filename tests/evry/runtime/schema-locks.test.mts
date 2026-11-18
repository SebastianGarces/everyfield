import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { setTimeout as sleep } from "node:timers/promises";
import { pathToFileURL } from "node:url";
import { sql } from "../../../packages/db/node_modules/drizzle-orm/index.js";
import { migrate } from "../../../packages/db/src/schema/migrate.ts";
import { dropSchema, testDatabase } from "../../support/test-database.mts";

test("INV-isolation: a test schema's drop waits for a running migration, so files run in parallel never fill Postgres's shared lock table together", async () => {
	const database = await testDatabase({ prefix: "evrylock", migrate: false, roles: {} });
	const directory = await mkdtemp(join(tmpdir(), "evry-lock-"));
	try {
		await writeFile(join(directory, "0001_hold.sql"), "SELECT pg_sleep(1) AS evry_lock_hold");
		const other = await database.createSchema(`evrylockdrop_${randomUUID().replaceAll("-", "")}`);
		const order: string[] = [];
		const migrating = migrate(database.admin, database.schema, pathToFileURL(`${directory}/`)).then(() =>
			order.push("migrate"),
		);
		const holding = async () => {
			const { rows } = await database.admin.execute<{ n: number }>(
				sql`SELECT count(*)::int AS n FROM pg_catalog.pg_stat_activity
					WHERE state='active' AND pid<>pg_catalog.pg_backend_pid() AND query LIKE '%evry_lock_hold%'`,
			);
			return rows[0]!.n > 0;
		};
		for (let n = 0; n < 100 && !(await holding()); n++) await sleep(20);
		assert.ok(await holding(), "the migration is running and holds the migration lock");
		const dropping = dropSchema(database.admin, other).then(() => order.push("drop"));
		await Promise.all([migrating, dropping]);
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
