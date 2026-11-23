import "server-only";
import { checkoutClient, createDatabase, type Database } from "@everyfield/db/client";
import { serverConfig, serverEnv } from "./config.ts";

const POOLS: unique symbol = Symbol.for("everyfield.web.pools");
const pools: Map<string, Database> = ((globalThis as { [POOLS]?: Map<string, Database> })[POOLS] ??= new Map());
export function database(connectionString: string): Database {
	let pool = pools.get(connectionString);
	if (!pool) {
		pool = createDatabase({ connectionString, max: 10 });
		pools.set(connectionString, pool);
	}
	return pool;
}

export const requestDatabase = (): Database => database(serverConfig().IDENTITY_DATABASE_URL);

const statementTimeout = (limit: string) => `${serverEnv().PGOPTIONS ?? ""} -c statement_timeout=${limit}`.trim();

export function jobDatabase(): Database {
	const url = serverConfig().IDENTITY_DATABASE_URL;
	const key = `${url}#jobs`;
	let pool = pools.get(key);
	if (!pool) {
		pool = createDatabase({ connectionString: url, max: 4, options: statementTimeout("5s") });
		pools.set(key, pool);
	}
	return pool;
}

export function cleanupDatabase(): Database | null {
	const url = serverEnv().LIFECYCLE_CLEANUP_DATABASE_URL;
	if (!url) return null;
	const key = `${url}#cleanup`;
	let pool = pools.get(key);
	if (!pool) {
		pool = createDatabase({ connectionString: url, max: 2, options: statementTimeout("60s") });
		pools.set(key, pool);
	}
	return pool;
}

const REQUEST_CONNECTIONS = 2;
export async function warmPools(): Promise<{ rest: Promise<unknown> }> {
	const request = requestDatabase();
	const opening = [...pools.values()].map((db) =>
		Array.from({ length: db === request ? REQUEST_CONNECTIONS : 1 }, () =>
			checkoutClient(db).then(({ client }) => client.release()),
		),
	);
	await Promise.all(opening.map((pool) => Promise.any(pool)));
	return { rest: Promise.all(opening.flat()) };
}
