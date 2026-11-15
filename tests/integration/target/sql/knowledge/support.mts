// Shared setup for the WP-092 knowledge cases. Each case runs at the exact instant its JSON names, so a suite opens its
// schema with `clock` (test-database.mts installs schema-local clock functions before the migrations) and `freezeClock`
// then holds that clock still at one instant. Every query of the schema, its column defaults and its SECURITY DEFINER
// functions read the frozen value; the host clock and pg_catalog-qualified calls do not move.
import { sql } from "../../../../../packages/db/src/query.ts";
import type { Database } from "../../../../support/test-database.mts";

const SCHEMA = /^[a-z_][a-z0-9_]{0,62}$/;

/** Holds the schema's database clock at `at`: now(), transaction_timestamp(), statement_timestamp() and clock_timestamp(). */
export async function freezeClock(admin: Database, schema: string, at: Date) {
	if (!SCHEMA.test(schema)) throw Error(`Not a test schema: ${schema}`);
	const instant = at.toISOString();
	if (!/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(instant)) throw Error(`Not an instant: ${instant}`);
	for (const [fn, volatility] of [
		["clock_timestamp", "VOLATILE"],
		["statement_timestamp", "STABLE"],
		["transaction_timestamp", "STABLE"],
		["now", "STABLE"],
	])
		await admin.execute(
			sql.raw(`CREATE OR REPLACE FUNCTION ${schema}.${fn}() RETURNS timestamptz LANGUAGE sql ${volatility} PARALLEL SAFE
				AS $$ SELECT '${instant}'::timestamptz $$`),
		);
}

/** The schema's current database clock, as the product reads it. */
export async function databaseClock(db: Database): Promise<Date> {
	const { rows } = await db.execute<{ at: string }>(sql`SELECT clock_timestamp()::text AS at`);
	return new Date(rows[0]!.at);
}
