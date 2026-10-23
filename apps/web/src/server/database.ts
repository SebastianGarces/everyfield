import "server-only";
import { checkoutClient, createDatabase, type Database, type DatabaseOptions } from "@everyfield/db/client";

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
 * The most connections one request holds at once on the request pool: the person and meetings pages read on two in
 * parallel (RT-6c). Other pools (the auth login) stay at one: no measured request used two at once.
 */
const REQUEST_CONNECTIONS = 2;
/**
 * Opens the connections one request needs on every pool created so far, all at once, so no early request pays a TLS
 * handshake. It answers once each pool has one open connection; `rest` settles when the others are open too, so the
 * warm-up never delays the first answer (C115). Server start calls it once the identity mount exists.
 */
export async function warmPools(): Promise<{ rest: Promise<unknown> }> {
	const request = requestDatabase();
	const opening = [...pools.values()].map((db) =>
		// Started together, each checkout opens its own connection; each is released as soon as it is open.
		Array.from({ length: db === request ? REQUEST_CONNECTIONS : 1 }, () =>
			checkoutClient(db).then(({ client }) => client.release()),
		),
	);
	await Promise.all(opening.map((pool) => Promise.any(pool)));
	return { rest: Promise.all(opening.flat()) };
}
