import { readdir, readFile } from "node:fs/promises";
import type { Pool } from "pg";

// One lock and transaction cover the entire ordered batch, including its original ledger.
// Production migrations use an operator connection, never ordinary runtime credentials.
export async function migrate(db: Pool, schema = "public"): Promise<string[]> {
  if (!/^[a-z][a-z0-9_]{0,62}$/.test(schema)) throw new Error("Invalid migration schema");
  const client = await db.connect();
  try {
    await client.query("BEGIN");
    await client.query("SELECT pg_advisory_xact_lock(7341097)");
    await client.query(`SET LOCAL search_path TO "${schema}", pg_catalog, pg_temp`);
    await client.query("CREATE TABLE IF NOT EXISTS schema_migration (name text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())");
    const directory = new URL("../../migrations/", import.meta.url);
    const files = (await readdir(directory)).filter(name => /^\d{4}_[a-z0-9_]+\.sql$/.test(name)).sort();
    const applied: string[] = [];
    for (const name of files) {
      const old = await client.query("SELECT name FROM schema_migration WHERE name=$1", [name]);
      if (old.rowCount) continue;
      await client.query(await readFile(new URL(name, directory), "utf8"));
      await client.query("INSERT INTO schema_migration(name) VALUES($1)", [name]);
      applied.push(name);
    }
    await client.query("COMMIT");
    return applied;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally { client.release(); }
}
