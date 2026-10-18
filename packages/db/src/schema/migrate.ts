import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import { sql, eq, asc } from "drizzle-orm";
import type { Database, Transaction } from "../client.ts";
import { schema_migration } from "./tables.ts";

async function migrations(directory = new URL("../../migrations/", import.meta.url)) {
	return Promise.all(
		(await readdir(directory))
			.filter((name) => /^\d{4}_[a-z0-9_]+\.sql$/.test(name))
			.sort()
			.map(async (name) => {
				const sql = await readFile(new URL(name, directory));
				return { name, sql: sql.toString("utf8"), sha256: createHash("sha256").update(sql).digest("hex") };
			}),
	);
}
async function locked<T>(db: Database, schema: string, body: (tx: Transaction) => Promise<T>): Promise<T> {
	if (!/^[a-z][a-z0-9_]{0,62}$/.test(schema)) throw new Error("Invalid migration schema");
	return db.transaction(async (tx) => {
		await tx.execute(sql`SELECT pg_advisory_xact_lock(7341097)`);
		await tx.execute(sql`SET LOCAL search_path TO ${sql.identifier(schema)}, pg_catalog, pg_temp`);
		return body(tx);
	});
}
export async function migrationArtifact() {
	return (await migrations()).map(({ name, sha256 }) => ({ name, sha256 }));
}

// One transaction covers the batch and original ledger. No automatic checksum adoption.
// Deploy/build/start never calls this; it is an explicit operator command.
export async function migrate(db: Database, schema = "public", directory?: URL): Promise<string[]> {
	const files = await migrations(directory);
	return locked(db, schema, async (tx) => {
		await tx.execute(
			sql`CREATE TABLE IF NOT EXISTS schema_migration (name text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now(), sha256 text NOT NULL CHECK(sha256 ~ '^[a-f0-9]{64}$'), provenance text NOT NULL CHECK(provenance IN ('original','adopted')))`,
		);
		const columns = await tx.execute<{ column_name: string }>(
			sql`SELECT column_name FROM information_schema.columns WHERE table_schema=${schema} AND table_name='schema_migration'`,
		);
		if (!["sha256", "provenance"].every((name) => columns.rows.some((row) => row.column_name === name)))
			throw Error("migration_provenance_unverified");
		const old = await tx
			.select({ name: schema_migration.name, sha256: schema_migration.sha256, provenance: schema_migration.provenance })
			.from(schema_migration)
			.orderBy(asc(schema_migration.name));
		for (const [index, row] of old.entries()) {
			const file = files[index];
			if (
				!file ||
				file.name !== row.name ||
				file.sha256 !== row.sha256 ||
				!["original", "adopted"].includes(row.provenance)
			)
				throw Error("migration_checksum_conflict");
		}
		const applied: string[] = [];
		for (const file of files.slice(old.length)) {
			await tx.execute(sql.raw(file.sql));
			await tx.insert(schema_migration).values({ name: file.name, sha256: file.sha256, provenance: "original" });
			applied.push(file.name);
		}
		return applied;
	});
}

// Explicit reviewed adoption only. Current-byte agreement cannot prove which bytes
// originally ran. Preserve timestamps and mark that limitation in every adopted row.
export async function adoptMigrationHistory(
	db: Database,
	schema: string,
	approved: Readonly<Record<string, string>>,
): Promise<{ name: string; provenance: "adopted" }[]> {
	const files = await migrations();
	return locked(db, schema, async (tx) => {
		const rows = await tx
			.select({ name: schema_migration.name })
			.from(schema_migration)
			.orderBy(asc(schema_migration.name));
		if (!rows.length || Object.keys(approved).length !== rows.length) throw Error("adoption_review_mismatch");
		for (const [i, row] of rows.entries()) {
			const file = files[i];
			if (!file || row.name !== file.name || approved[row.name] !== file.sha256)
				throw Error("adoption_review_mismatch");
		}
		const columns = await tx.execute<{ column_name: string }>(
			sql`SELECT column_name FROM information_schema.columns WHERE table_schema=${schema} AND table_name='schema_migration'`,
		);
		if (columns.rows.some((row) => row.column_name === "sha256" || row.column_name === "provenance"))
			throw Error("adoption_already_recorded");
		await tx.execute(sql`ALTER TABLE schema_migration ADD COLUMN sha256 text, ADD COLUMN provenance text`);
		for (const row of rows)
			await tx
				.update(schema_migration)
				.set({ sha256: approved[row.name], provenance: "adopted" })
				.where(eq(schema_migration.name, row.name));
		await tx.execute(
			sql`ALTER TABLE schema_migration ALTER COLUMN sha256 SET NOT NULL, ALTER COLUMN provenance SET NOT NULL, ADD CHECK(sha256 ~ '^[a-f0-9]{64}$'), ADD CHECK(provenance IN ('original','adopted'))`,
		);
		return rows.map(({ name }) => ({ name, provenance: "adopted" }));
	});
}

export async function inspectMigrationProvenance(db: Database, schema = "public") {
	if (!/^[a-z][a-z0-9_]{0,62}$/.test(schema)) throw Error("Invalid migration schema");
	const artifact = await migrationArtifact();
	const columns = await db.execute<{ column_name: string }>(
		sql`SELECT column_name FROM information_schema.columns WHERE table_schema=${schema} AND table_name='schema_migration'`,
	);
	if (!columns.rowCount) return { state: "uninitialized" as const, applied: [], artifact };
	const proven = ["sha256", "provenance"].every((name) => columns.rows.some((row) => row.column_name === name));
	const result = await db.execute<{ name: string; applied_at: Date; sha256?: string; provenance?: string }>(
		sql`SELECT name,applied_at${proven ? sql`,sha256,provenance` : sql``} FROM ${sql.identifier(schema)}.schema_migration ORDER BY name`,
	);
	const coherent = result.rows.every(
		(row, i) =>
			artifact[i]?.name === row.name &&
			artifact[i]?.sha256 === row.sha256 &&
			["original", "adopted"].includes(row.provenance ?? ""),
	);
	return {
		state: !proven
			? ("unverified" as const)
			: !coherent
				? ("conflict" as const)
				: result.rows.length < artifact.length
					? ("pending" as const)
					: ("current" as const),
		applied: result.rows,
		artifact,
	};
}
