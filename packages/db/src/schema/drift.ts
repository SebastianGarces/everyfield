import { randomUUID } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import { isDeepStrictEqual } from "node:util";
import { generateDrizzleJson, generateMigration } from "drizzle-kit/api";
import { sql } from "drizzle-orm";
import type { Database } from "../client.ts";
import * as declarations from "./tables.ts";
import { declaredSnapshot } from "./snapshot.ts";
import { qualifyVectorTypes } from "./normalize.ts";
import { migrationDirectory } from "./artifacts.ts";
import { modeledCatalog, supplementalCatalog } from "./catalog-state.ts";

export async function verifySchemaDrift(
	db: Database,
	migratedSchema: string,
	model: Record<string, unknown> = declarations,
): Promise<void> {
	if (!/^[a-z][a-z0-9_]{0,62}$/.test(migratedSchema)) throw Error("Invalid migration schema");
	const generatedSchema = "evf_model_" + randomUUID().replaceAll("-", "");
	const raw = generateDrizzleJson(model);
	const snapshot = declaredSnapshot(model);
	const ownTables = new Set(Object.values(snapshot.tables).map((table) => table.name));
	const scoped = {
		...raw,
		schemas: { [generatedSchema]: generatedSchema },
		tables: Object.fromEntries(
			Object.values(snapshot.tables).map((table) => [
				generatedSchema + "." + table.name,
				{
					...table,
					schema: generatedSchema,
					foreignKeys: Object.fromEntries(
						Object.entries(table.foreignKeys).map(([name, key]) => [
							name,
							{
								...key,
								schemaTo:
									(!key.schemaTo || key.schemaTo === "public") && ownTables.has(key.tableTo)
										? generatedSchema
										: key.schemaTo,
							},
						]),
					),
				},
			]),
		),
	};
	try {
		const ddl = await generateMigration(generateDrizzleJson({}), scoped);
		await db.transaction(async (tx) => {
			await tx.execute(sql.raw(ddl.map(qualifyVectorTypes).join(";\n")));
		});
		const read = async (schema: string) =>
			db.transaction(async (tx) => {
				await tx.execute(sql`SET LOCAL search_path TO ${sql.identifier(schema)}, pg_catalog, pg_temp`);
				return modeledCatalog(tx, schema);
			});
		const [migrated, generated] = await Promise.all([read(migratedSchema), read(generatedSchema)]);
		for (const key of Object.keys(migrated) as (keyof typeof migrated)[])
			if (!isDeepStrictEqual(migrated[key], generated[key]))
				throw Error("Schema drift in " + key + ": Drizzle declarations differ from frozen plus forward migrations");
	} finally {
		await db.execute(sql`DROP SCHEMA IF EXISTS ${sql.identifier(generatedSchema)} CASCADE`);
	}
	const expected: unknown = JSON.parse(await readFile(new URL("./supplemental.json", import.meta.url), "utf8"));
	const actual = await db.transaction(async (tx) => {
		await tx.execute(sql`SET LOCAL search_path TO ${sql.identifier(migratedSchema)}, pg_catalog, pg_temp`);
		return supplementalCatalog(tx, migratedSchema);
	});
	if (!isDeepStrictEqual(actual, expected))
		throw Error("Custom migration drift: deferred keys, triggers, functions, role attributes or privileges differ");
}

// UUID links and Kit's rename notes identify generation events; the supported definitions must agree.
export const definitions = (snapshot: Record<string, unknown>): Record<string, unknown> =>
	Object.fromEntries(Object.entries(snapshot).filter(([key]) => !["id", "prevId", "_meta"].includes(key)));

/**
 * Kit's diff base: the declared schema after every migration in the folder. Timestamped migrations
 * share one snapshot file, migrations/meta/current.json, which two branches change in separate hunks
 * unless they change the same table (D78). Until the first timestamped migration, a numbered branch
 * that D76 allowed may still extend the numbered chain, so its latest snapshot is the base.
 */
export async function currentSnapshot(): Promise<Record<string, unknown>> {
	const meta = new URL("meta/", migrationDirectory);
	const timestamped = (await readdir(migrationDirectory)).some((name) => /^\d{14}_/.test(name));
	const name = timestamped
		? "current.json"
		: (await readdir(meta))
				.filter((name) => /^\d{4}_snapshot\.json$/.test(name))
				.sort()
				.at(-1);
	if (!name) throw Error("Missing Drizzle baseline snapshot");
	return definitions(JSON.parse(await readFile(new URL(name, meta), "utf8")));
}

export async function verifySnapshotBaseline(): Promise<void> {
	const current = generateDrizzleJson(declarations);
	if (!isDeepStrictEqual(await currentSnapshot(), definitions(JSON.parse(JSON.stringify(current)))))
		throw Error("Schema declarations changed without a Kit migration; run generate and review its output");
	if ((await generateMigration(current, current)).length) throw Error("Kit emitted SQL for an unchanged snapshot");
}
