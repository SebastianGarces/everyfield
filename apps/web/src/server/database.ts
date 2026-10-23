import "server-only";
import { createDatabase, type Database, type DatabaseOptions } from "@everyfield/db/client";
import { sql } from "@everyfield/db/query";

// Share connections for the same configured login and schema. The native auth
// adapter and the development proof may use different credentials or schemas.
// Next bundles the instrumentation hook, route handlers and server components as separate module graphs, each with its
// own copy of this module. The map lives on globalThis so the pools the start-up warm opens are the ones every request
// then uses.
const POOLS: unique symbol = Symbol.for("everyfield.web.pools");
const pools: Map<string, Database> = ((globalThis as { [POOLS]?: Map<string, Database> })[POOLS] ??= new Map());
export function database(
	connectionString: string,
	options: Pick<DatabaseOptions, "connectionTimeoutMillis" | "idleTimeoutMillis"> = {},
): Database {
	let pool = pools.get(connectionString);
	if (!pool) {
		pool = createDatabase({ connectionString, max: 10, ...options });
		pools.set(connectionString, pool);
	}
	return pool;
}

export function requestDatabase(): Database | null {
	const url = process.env.IDENTITY_DATABASE_URL;
	return url ? database(url) : null;
}

/**
 * The scheduled runner's own pool. Every statement on it, lock waits included, ends after 5 s unless its boundary sets
 * its own timeout (the native write gate sets 10 s), so a job worker that writes outside a bounded transaction (People
 * imports) cannot wait without limit. Other PGOPTIONS stay.
 */
export function jobDatabase(): Database | null {
	const url = process.env.IDENTITY_DATABASE_URL;
	if (!url) return null;
	const key = `${url}#jobs`;
	let pool = pools.get(key);
	if (!pool) {
		const options = `${process.env.PGOPTIONS ?? ""} -c statement_timeout=5s`.trim();
		pool = createDatabase({ connectionString: url, max: 4, options });
		pools.set(key, pool);
	}
	return pool;
}

/** Opens one connection on every pool created so far. Server start calls it once the identity mount exists. */
export function warmPools(): Promise<unknown> {
	return Promise.all([...pools.values()].map((db) => db.execute(sql`SELECT 1`)));
}
