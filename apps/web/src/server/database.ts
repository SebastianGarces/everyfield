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

/** Opens one connection on every pool created so far. Server start calls it once the identity mount exists. */
export function warmPools(): Promise<unknown> {
	return Promise.all([...pools.values()].map((db) => db.execute(sql`SELECT 1`)));
}
