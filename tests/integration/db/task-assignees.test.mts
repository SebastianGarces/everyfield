import { createDatabase, closeDatabase } from "../../../packages/db/src/client.ts";
import { sql as querySql } from "../../../packages/db/node_modules/drizzle-orm/index.js";
import test, { before, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { copyFile, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { pathToFileURL } from "node:url";
import { migrate, migrationArtifact } from "../../../packages/db/src/schema/migrate.ts";

// WP-023 F07b criterion 1: the migration that turns the single task assignee into a set keeps every assignment.
const NEW = "task_assignees.sql";
const schema = "wp023_test_" + randomUUID().replaceAll("-", "");
const source = new URL(process.env.DATABASE_URL_UNPOOLED ?? process.env.DATABASE_URL ?? "about:blank");
const localCi =
	process.env.CI === "true" &&
	process.env.EARLY_ACCESS_TEST_DATABASE === "1" &&
	["localhost", "127.0.0.1"].includes(source.hostname) &&
	source.pathname === "/everyfield_ci";
if (
	(!localCi && source.hostname !== "ep-autumn-dew-b8ltidky.c-14.us-east-1.aws.neon.tech") ||
	process.env.NODE_ENV === "production"
)
	throw Error("Only approved shared development direct endpoint allowed");
if (!localCi) source.searchParams.set("sslmode", "verify-full");
const admin = createDatabase({ connectionString: source.href, max: 2, options: `-c search_path=${schema},pg_catalog,pg_temp` });
const run = (q: ReturnType<typeof querySql>) => admin.execute(q);
let directory = "";
before(async () => {
	await run(querySql.raw(`CREATE SCHEMA ${schema}`));
	directory = await mkdtemp(tmpdir() + "/evf-task-assignees-");
});
after(async () => {
	await run(querySql.raw(`DROP SCHEMA IF EXISTS ${schema} CASCADE`)).catch(() => {});
	await rm(directory, { recursive: true, force: true });
	await closeDatabase(admin);
});

test("AC:TARGET-TSK-002 criterion 1: each task keeps its single assignee after the migration, and an unassigned task gets none", async () => {
	const names = (await migrationArtifact()).map(({ name }) => name);
	const migration = names.find((name) => name.endsWith(NEW));
	assert.ok(migration, "the task_assignees migration is registered");
	for (const name of names.filter((name) => name !== migration))
		await copyFile(new URL("../../../packages/db/migrations/" + name, import.meta.url), new URL(name, pathToFileURL(directory + "/")));
	await migrate(admin, schema, pathToFileURL(directory + "/"));

	const plant = randomUUID(),
		first = randomUUID(),
		second = randomUUID();
	await run(
		querySql`INSERT INTO plant(id,name,timezone,warning_days,alert_days,digest_weekday,digest_hour,phase,material_revision) VALUES(${plant},'Synthetic Plant','America/Chicago',7,14,1,8,1,1)`,
	);
	for (const id of [first, second]) {
		const user = randomUUID();
		await run(
			querySql`INSERT INTO auth_user(id,email,email_verified,name) VALUES(${user},${user + "@example.test"},true,'Synthetic')`,
		);
		await run(
			querySql`INSERT INTO account(id,auth_user_id,registration_state,registration_kind) VALUES(${id},${user},'active','planter')`,
		);
	}
	const held = new Map<string, string | null>([
		[randomUUID(), first],
		[randomUUID(), second],
		[randomUUID(), first],
		[randomUUID(), null],
	]);
	for (const [id, assignee] of held)
		await run(
			querySql`INSERT INTO task(id,plant_id,title,category,priority,status,created_at,due_kind,assignee_id) VALUES(${id},${plant},'Call','general','medium','not_started',now(),'undated',${assignee})`,
		);

	assert.deepEqual(await migrate(admin, schema), [migration]);

	const rows = (
		await run(querySql`SELECT task_id, account_id, plant_id FROM task_assignee ORDER BY task_id, account_id`)
	).rows as { task_id: string; account_id: string; plant_id: string }[];
	const expected = [...held].filter(([, assignee]) => assignee !== null).sort(([a], [b]) => (a < b ? -1 : 1));
	assert.deepEqual(
		rows.map((r) => [r.task_id, r.account_id, r.plant_id]),
		expected.map(([id, assignee]) => [id, assignee, plant]),
		"every non-null assignee is one row; the unassigned task has none",
	);
	// No task or obligation column keeps a second stored owner.
	const columns = (
		await run(
			querySql`SELECT table_name FROM information_schema.columns WHERE table_schema=${schema} AND column_name='assignee_id'`,
		)
	).rows;
	assert.deepEqual(columns, []);
	// A task holds an account once.
	const [anyTask, assignee] = expected[0]!;
	await assert.rejects(
		run(querySql`INSERT INTO task_assignee(plant_id,task_id,account_id) VALUES(${plant},${anyTask},${assignee})`),
		(e: { cause?: { code?: string } }) => e.cause?.code === "23505",
	);
	// The app logins hold the same privileges as on task.
	const grants = async (table: string) =>
		(
			await run(
				querySql`SELECT grantee, privilege_type FROM information_schema.role_table_grants WHERE table_schema=${schema} AND table_name=${table} AND grantee IN ('everyfield_runtime','everyfield_cleanup') ORDER BY 1,2`,
			)
		).rows;
	assert.deepEqual(await grants("task_assignee"), await grants("task"));
});
