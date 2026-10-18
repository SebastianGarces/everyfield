import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import type { Pool, PoolClient } from "pg";

async function migrations(directory = new URL("../../migrations/", import.meta.url)) {
  return Promise.all((await readdir(directory)).filter(name => /^\d{4}_[a-z0-9_]+\.sql$/.test(name)).sort().map(async name => {
    const sql = await readFile(new URL(name, directory));
    return { name, sql: sql.toString("utf8"), sha256: createHash("sha256").update(sql).digest("hex") };
  }));
}
async function locked<T>(db: Pool, schema: string, body: (tx: PoolClient) => Promise<T>): Promise<T> {
  if (!/^[a-z][a-z0-9_]{0,62}$/.test(schema)) throw new Error("Invalid migration schema");
  const tx = await db.connect();
  try {
    await tx.query("BEGIN");
    await tx.query("SELECT pg_advisory_xact_lock(7341097)");
    await tx.query(`SET LOCAL search_path TO "${schema}", pg_catalog, pg_temp`);
    const result = await body(tx);
    await tx.query("COMMIT");
    return result;
  } catch (error) { await tx.query("ROLLBACK"); throw error; }
  finally { tx.release(); }
}
export async function migrationArtifact() { return (await migrations()).map(({ name, sha256 }) => ({ name, sha256 })); }

// One transaction covers the batch and original ledger. No automatic checksum adoption.
// Deploy/build/start never calls this; it is an explicit operator command.
export async function migrate(db: Pool, schema = "public", directory?: URL): Promise<string[]> {
  const files = await migrations(directory);
  return locked(db, schema, async tx => {
    await tx.query("CREATE TABLE IF NOT EXISTS schema_migration (name text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now(), sha256 text NOT NULL CHECK(sha256 ~ '^[a-f0-9]{64}$'), provenance text NOT NULL CHECK(provenance IN ('original','adopted')))");
    const columns = await tx.query("SELECT column_name FROM information_schema.columns WHERE table_schema=$1 AND table_name='schema_migration'", [schema]);
    if (!["sha256", "provenance"].every(name => columns.rows.some(row => row.column_name === name))) throw Error("migration_provenance_unverified");
    const old = await tx.query<{ name: string; sha256: string; provenance: string }>("SELECT name,sha256,provenance FROM schema_migration ORDER BY name");
    for (const [index, row] of old.rows.entries()) {
      const file = files[index];
      if (!file || file.name !== row.name || file.sha256 !== row.sha256 || !["original", "adopted"].includes(row.provenance)) throw Error("migration_checksum_conflict");
    }
    const applied: string[] = [];
    for (const file of files.slice(old.rows.length)) {
      await tx.query(file.sql);
      await tx.query("INSERT INTO schema_migration(name,sha256,provenance) VALUES($1,$2,'original')", [file.name, file.sha256]);
      applied.push(file.name);
    }
    return applied;
  });
}

// Explicit reviewed adoption only. Current-byte agreement cannot prove which bytes
// originally ran. Preserve timestamps and mark that limitation in every adopted row.
export async function adoptMigrationHistory(db: Pool, schema: string, approved: Readonly<Record<string, string>>): Promise<{ name: string; provenance: "adopted" }[]> {
  const files = await migrations();
  return locked(db, schema, async tx => {
    const rows = await tx.query<{ name: string }>("SELECT name FROM schema_migration ORDER BY name");
    if (!rows.rows.length || Object.keys(approved).length !== rows.rows.length) throw Error("adoption_review_mismatch");
    for (const [i, row] of rows.rows.entries()) {
      const file = files[i];
      if (!file || row.name !== file.name || approved[row.name] !== file.sha256) throw Error("adoption_review_mismatch");
    }
    const columns = await tx.query("SELECT column_name FROM information_schema.columns WHERE table_schema=$1 AND table_name='schema_migration'", [schema]);
    if (columns.rows.some(row => row.column_name === "sha256" || row.column_name === "provenance")) throw Error("adoption_already_recorded");
    await tx.query("ALTER TABLE schema_migration ADD COLUMN sha256 text, ADD COLUMN provenance text");
    for (const row of rows.rows) await tx.query("UPDATE schema_migration SET sha256=$2,provenance='adopted' WHERE name=$1", [row.name, approved[row.name]]);
    await tx.query("ALTER TABLE schema_migration ALTER COLUMN sha256 SET NOT NULL, ALTER COLUMN provenance SET NOT NULL, ADD CHECK(sha256 ~ '^[a-f0-9]{64}$'), ADD CHECK(provenance IN ('original','adopted'))");
    return rows.rows.map(({ name }) => ({ name, provenance: "adopted" }));
  });
}

export async function inspectMigrationProvenance(db: Pool, schema = "public") {
  if (!/^[a-z][a-z0-9_]{0,62}$/.test(schema)) throw Error("Invalid migration schema");
  const artifact = await migrationArtifact();
  const columns = await db.query("SELECT column_name FROM information_schema.columns WHERE table_schema=$1 AND table_name='schema_migration'", [schema]);
  if (!columns.rowCount) return { state: "uninitialized" as const, applied: [], artifact };
  const proven = ["sha256", "provenance"].every(name => columns.rows.some(row => row.column_name === name));
  const result = await db.query<{ name: string; applied_at: Date; sha256?: string; provenance?: string }>(`SELECT name,applied_at${proven ? ",sha256,provenance" : ""} FROM "${schema}".schema_migration ORDER BY name`);
  const coherent = result.rows.every((row, i) => artifact[i]?.name === row.name && artifact[i]?.sha256 === row.sha256 && ["original", "adopted"].includes(row.provenance ?? ""));
  return { state: !proven ? "unverified" as const : !coherent ? "conflict" as const : result.rows.length < artifact.length ? "pending" as const : "current" as const, applied: result.rows, artifact };
}
