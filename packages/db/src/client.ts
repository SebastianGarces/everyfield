import pg from "pg";
import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import type { NodePgTransaction } from "drizzle-orm/node-postgres";
import type { ExtractTablesWithRelations } from "drizzle-orm";
import * as schema from "./schema/tables.ts";

export type Database = NodePgDatabase<typeof schema>;
export type Transaction = NodePgTransaction<typeof schema, ExtractTablesWithRelations<typeof schema>>;
export type DatabaseOptions = {
	connectionString: string;
	max?: number;
	options?: string;
	connectionTimeoutMillis?: number;
	idleTimeoutMillis?: number;
};

export function createDatabase(options: DatabaseOptions) {
	// An idle client stays open for five minutes, so the first query after a short pause reuses a warm connection
	// instead of paying a new TLS handshake and authentication. Five minutes matches Neon's own inactivity window.
	const pool = new pg.Pool({ connectionTimeoutMillis: 10_000, idleTimeoutMillis: 300_000, ...options });
	return drizzle({ client: pool, schema });
}

export function closeDatabase(db: ReturnType<typeof createDatabase>): Promise<void> {
	return db.$client.end();
}

let configured: ReturnType<typeof createDatabase> | undefined;
export function database() {
	const connectionString = process.env.DATABASE_URL;
	if (!connectionString) throw new Error("DATABASE_URL is required");
	return (configured ??= createDatabase({ connectionString, max: 5 }));
}
