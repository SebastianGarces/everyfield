import pg from "pg";
import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import type { NodePgTransaction } from "drizzle-orm/node-postgres";
import type { ExtractTablesWithRelations, SQL } from "drizzle-orm";
import { z } from "zod";
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
	const pool = new pg.Pool({ connectionTimeoutMillis: 10_000, idleTimeoutMillis: 300_000, ...options });
	return drizzle({ client: pool, schema });
}

const twoStatementResults = z.tuple([
	z.object({ rows: z.array(z.unknown()) }),
	z.object({ rows: z.array(z.record(z.string(), z.unknown())) }),
]);
export async function secondStatementRows(db: Database, statements: SQL) {
	const [, second] = twoStatementResults.parse(await db.execute(statements));
	return second.rows;
}

export type PoolClient = pg.PoolClient;
const clientDatabases = new WeakMap<pg.PoolClient, Database>();
export async function checkoutClient(db: Database): Promise<{ client: pg.PoolClient; db: Database }> {
	const client = await (db as Database & { $client: pg.Pool }).$client.connect();
	let bound = clientDatabases.get(client);
	if (!bound) clientDatabases.set(client, (bound = drizzle({ client, schema })));
	return { client, db: bound };
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
