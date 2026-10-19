import "server-only";
import { createDatabase, type Database, type DatabaseOptions } from "@everyfield/db/client";

// Share connections for the same configured login and schema. The native auth
// adapter and the development proof may use different credentials or schemas.
const pools = new Map<string, Database>();
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
