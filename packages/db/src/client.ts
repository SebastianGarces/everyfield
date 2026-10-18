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
  const pool = new pg.Pool({ connectionTimeoutMillis: 10_000, idleTimeoutMillis: 10_000, ...options });
  return drizzle({ client: pool, schema });
}

export function closeDatabase(db: ReturnType<typeof createDatabase>): Promise<void> {
  return db.$client.end();
}

let configured: ReturnType<typeof createDatabase> | undefined;
export function database() {
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) throw new Error("DATABASE_URL is required");
  return configured ??= createDatabase({ connectionString, max: 5 });
}
