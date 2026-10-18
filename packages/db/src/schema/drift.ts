import { randomUUID } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import { isDeepStrictEqual } from "node:util";
import { generateDrizzleJson, generateMigration } from "drizzle-kit/api";
import { sql } from "drizzle-orm";
import type { Database } from "../client.ts";
import * as declarations from "./tables.ts";
import { declaredSnapshot } from "./snapshot.ts";
import { qualifyVectorTypes } from "./normalize.ts";
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
			for (const statement of ddl) await tx.execute(sql.raw(qualifyVectorTypes(statement)));
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

export async function verifySnapshotBaseline(): Promise<void> {
	const directory = new URL("../../migrations/meta/", import.meta.url);
	const snapshots = (await readdir(directory)).filter((name) => /^\d{4}_snapshot\.json$/.test(name)).sort();
	const last = snapshots.at(-1);
	if (!last) throw Error("Missing Drizzle baseline snapshot");
	const previous: Record<string, unknown> = JSON.parse(await readFile(new URL(last, directory), "utf8"));
	const current = generateDrizzleJson(declarations);
	// UUID links identify generation events; the actual supported definitions must agree.
	const definitions = (snapshot: Record<string, unknown>): unknown =>
		JSON.parse(
			JSON.stringify(
				Object.fromEntries(Object.entries(snapshot).filter(([key]) => !["id", "prevId", "_meta"].includes(key))),
			),
		);
	if (!isDeepStrictEqual(definitions(previous), definitions(current)))
		throw Error("Schema declarations changed without a Kit migration; run generate and review its output");
	if ((await generateMigration(current, current)).length) throw Error("Kit emitted SQL for an unchanged snapshot");
}
