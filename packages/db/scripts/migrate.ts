import { readFile } from "node:fs/promises";
import { database } from "../src/index.js";

const db = database();
const client = await db.connect();
try {
  await client.query("BEGIN");
  await client.query("SELECT pg_advisory_xact_lock(7341097)");
  await client.query("CREATE TABLE IF NOT EXISTS schema_migration (name text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())");
  const name = "0001_early_access.sql";
  const applied = await client.query("SELECT name FROM schema_migration WHERE name = $1", [name]);
  if (applied.rowCount === 0) {
    await client.query(await readFile(new URL("../migrations/" + name, import.meta.url), "utf8"));
    await client.query("INSERT INTO schema_migration (name) VALUES ($1)", [name]);
  }
  await client.query("COMMIT");
  console.log("Early access migration applied or already current.");
} catch {
  await client.query("ROLLBACK");
  console.error("Database migration failed. No credential values were logged.");
  process.exitCode = 1;
} finally {
  client.release();
  await db.end();
}
