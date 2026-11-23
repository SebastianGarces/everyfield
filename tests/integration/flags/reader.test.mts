import "../platform/setup.mts";
import test, { after, before } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { sql } from "../../../packages/db/src/query.ts";
import { testDatabase, type TestDatabase } from "../../support/test-database.mts";
import { readStaleReleaseFlags, setFlag } from "../../../packages/domain/src/flags/index.ts";
import { FlagError } from "../../../tools/flag/flag.ts";
import { withTarget } from "../../../tools/flag/main.ts";

const declared = {
	"reader-stale": {
		owner: "Tests",
		task: "T-532",
		kind: "release",
		default: false,
		created: "2026-11-01",
		expires: "2027-03-01",
	},
} as const;
const migration = new URL("../../../packages/db/migrations/20261120162941_flag_reader.sql", import.meta.url);

let database: TestDatabase<"reader">;
before(async () => {
	database = await testDatabase({ prefix: "flagreader", roles: { reader: ["flag_reader"] } });
	await setFlag(
		database.admin,
		{ flag: "reader-stale", scope: { kind: "global" }, value: true, operator: { cause: "bin/flag" } },
		declared,
	);
	await database.admin.execute(sql`UPDATE audit_event SET occurred_at=clock_timestamp()-make_interval(days=>15)
 WHERE action='flags.changed'`);
});
after(() => database?.close());

const sqlState = async (statement: string) => {
	try {
		await database.pools.reader.execute(sql.raw(statement));
		return "ok";
	} catch (error) {
		return (error as { cause?: { code?: string } }).cause?.code ?? String(error);
	}
};

test("a login in everyfield_flag_reader reads global rollout state from flag_rollout and nothing else", async () => {
	const { rows } = await database.pools.reader.execute(
		sql`SELECT name, value, changed_at < clock_timestamp()-interval '14 days' AS old FROM flag_rollout`,
	);
	assert.deepEqual(rows, [{ name: "reader-stale", value: true, old: true }]);
	const denied = "42501";
	const notUpdatable = "55000";
	assert.deepEqual(
		{
			feature_flag: await sqlState("SELECT 1 FROM feature_flag"),
			audit_event: await sqlState("SELECT 1 FROM audit_event"),
			account: await sqlState("SELECT 1 FROM account"),
			tenant: await sqlState("SELECT 1 FROM tenant"),
			insert: await sqlState(
				"INSERT INTO feature_flag(name,tenant_id,value) VALUES ('reader-new','00000000-0000-0000-0000-000000000000',true)",
			),
			update: await sqlState("UPDATE feature_flag SET value=false"),
			delete: await sqlState("DELETE FROM feature_flag"),
			"insert into the view": await sqlState("INSERT INTO flag_rollout(name,value) VALUES ('reader-new',true)"),
			"update the view": await sqlState("UPDATE flag_rollout SET value=false"),
			"delete from the view": await sqlState("DELETE FROM flag_rollout"),
		},
		{
			feature_flag: denied,
			audit_event: denied,
			account: denied,
			tenant: denied,
			insert: denied,
			update: denied,
			delete: denied,
			"insert into the view": notUpdatable,
			"update the view": notUpdatable,
			"delete from the view": notUpdatable,
		},
	);
	const { rows: still } = await database.admin.execute(sql`SELECT value FROM feature_flag WHERE name='reader-stale'`);
	assert.deepEqual(still, [{ value: true }]);
});

test("the read-only target refuses a login that does not default to read-only sessions, then lists through the view", async () => {
	const login = database.logins.reader;
	const target = { label: "a throwaway test database, read-only", url: login.url.href, readOnly: true as const };
	await assert.rejects(
		withTarget(target, async () => "read"),
		(error) =>
			error instanceof FlagError &&
			error.message ===
				"The FLAG_READER_DATABASE_URL login does not default to read-only sessions. Run ALTER ROLE <login> SET default_transaction_read_only = on (docs/runbooks/release.md). Nothing read.",
	);
	await database.admin.execute(sql.raw(`ALTER ROLE ${login.name} SET default_transaction_read_only = on`));
	const seen = await withTarget(target, async (db) => {
		const { rows } = await db.execute(
			sql`SELECT current_setting('default_transaction_read_only') AS session, current_setting('transaction_read_only') AS tx`,
		);
		const stale = await readStaleReleaseFlags(db, 14, declared);
		return { settings: rows[0], stale: stale.map((s) => [s.name, s.days]) };
	});
	assert.deepEqual(seen, { settings: { session: "on", tx: "on" }, stale: [["reader-stale", 15]] });
});

test("the flag reader migration is idempotent: rerunning it leaves the role, view and grants as they were", async () => {
	const grants = async () =>
		(
			await database.admin.execute(sql`SELECT grantee, privilege_type FROM information_schema.role_table_grants
 WHERE table_schema=current_schema() AND table_name='flag_rollout' AND grantee<>current_user ORDER BY 1, 2`)
		).rows;
	const before = await grants();
	assert.deepEqual(before, [{ grantee: "everyfield_flag_reader", privilege_type: "SELECT" }]);
	const body = readFileSync(migration, "utf8");
	await database.admin.execute(sql.raw(body));
	await database.admin.execute(sql.raw(body));
	assert.deepEqual(await grants(), before);
	const { rows } = await database.admin.execute(
		sql`SELECT rolcanlogin AS login, rolsuper AS superuser, rolbypassrls AS bypass FROM pg_roles WHERE rolname='everyfield_flag_reader'`,
	);
	assert.deepEqual(rows, [{ login: false, superuser: false, bypass: false }]);
});
