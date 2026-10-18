import { readFile, writeFile } from "node:fs/promises";
import { declaredSnapshot } from "../src/schema/snapshot.ts";
import { getTableConfig, PgTable } from "drizzle-orm/pg-core";
import { is } from "drizzle-orm";
import * as declarations from "../src/schema/tables.ts";

type Notes = {
	document: Record<string, unknown> & { type_contracts: Record<string, unknown> };
	tables: Record<
		string,
		{
			table: Record<string, unknown>;
			columns: Record<string, Record<string, unknown>>;
			foreignKeys: Record<string, Record<string, unknown>>;
		}
	>;
};
const root = new URL("../../../", import.meta.url);
const annotations: Notes = JSON.parse(
	await readFile(new URL("../src/schema/annotations.json", import.meta.url), "utf8"),
);
const snapshot = declaredSnapshot(declarations);
const typeContracts: Record<string, unknown> = Object.fromEntries(
	Object.entries(annotations.document.type_contracts).filter(([, v]) => !Array.isArray(v)),
);
for (const value of Object.values(declarations))
	if (is(value, PgTable))
		for (const column of getTableConfig(value).columns) {
			if (column.enumValues?.length) typeContracts[getTableConfig(value).name + "." + column.name] = column.enumValues;
		}
function literalSet(value: string) {
	const match = value.match(/^\(?([a-z_][\w]*) = ANY \(ARRAY\[((?:'(?:''|[^'])*'::text(?:, )?)+)\]\)\)?$/);
	if (!match?.[1] || !match[2]) return undefined;
	return {
		column: match[1],
		sql: match[2].replaceAll("::text", ""),
		values: [...match[2].matchAll(/'((?:''|[^'])*)'/g)].map((m) => (m[1] ?? "").replaceAll("''", "'")),
	};
}
for (const table of Object.values(snapshot.tables))
	for (const check of Object.values(table.checkConstraints)) {
		const set = literalSet(check.value);
		if (!set) continue;
		const key = table.name + "." + set.column,
			declared = typeContracts[key];
		if (Array.isArray(declared) && JSON.stringify([...declared].sort()) !== JSON.stringify([...set.values].sort()))
			throw Error("Typed enum differs from its CHECK: " + key);
		typeContracts[key] = set.values;
	}
if (typeContracts["person.source"]) {
	typeContracts.person_source = typeContracts["person.source"];
	typeContracts.ApprovedRecruitmentSource = typeContracts["person.source"];
}
function displayCheck(value: string) {
	const set = literalSet(value);
	return set ? set.column + " in (" + set.sql + ")" : value;
}
const tables = Object.values(snapshot.tables)
	.sort((a, b) => a.name.localeCompare(b.name))
	.map((table) => {
		const notes = annotations.tables[table.name];
		if (!notes) throw Error("Missing documentary annotations for " + table.name);
		const primary = Object.values(table.compositePrimaryKeys).flatMap((k) => k.columns);
		if (!primary.length)
			primary.push(
				...Object.values(table.columns)
					.filter((c) => c.primaryKey)
					.map((c) => c.name),
			);
		const unique_keys = [
			...Object.values(table.uniqueConstraints).map((key) => ({ columns: key.columns })),
			...Object.values(table.indexes)
				.filter((index) => index.isUnique)
				.map((index) => ({
					columns: index.columns.map((column) => column.expression),
					...(index.where ? { where: index.where } : {}),
				})),
		];
		const foreign_keys = Object.values(table.foreignKeys)
			.sort((a, b) => a.name.localeCompare(b.name))
			.map((key) => ({
				...(notes.foreignKeys[key.columnsFrom.join(",") + "->" + key.tableTo + "(" + key.columnsTo.join(",") + ")"] ??
					{}),
				columns: key.columnsFrom,
				references: { table: key.tableTo, columns: key.columnsTo },
				on_delete: key.onDelete ?? "no action",
			}));
		return {
			...notes.table,
			name: table.name,
			columns: Object.values(table.columns).map((column) => ({
				...(notes.columns[column.name] ?? {}),
				name: column.name,
				type: column.type
					.replace("timestamp with time zone", "timestamptz")
					.replace("time without time zone", "time")
					.replace("public.vector", "vector"),
				nullable: !column.notNull,
				...(column.default === undefined ? {} : { default: column.default }),
			})),
			primary_key: primary,
			unique_keys,
			foreign_keys,
			checks: Object.values(table.checkConstraints)
				.sort((a, b) => a.name.localeCompare(b.name))
				.map((check) => displayCheck(check.value)),
			indexes: table.indexes,
			constraint_names: {
				primary: Object.keys(table.compositePrimaryKeys),
				unique: Object.keys(table.uniqueConstraints),
				foreign: Object.keys(table.foreignKeys),
				checks: Object.keys(table.checkConstraints),
			},
			policies: table.policies,
			rls: table.isRLSEnabled,
		};
	});
const catalog = {
	...annotations.document,
	tables,
	table_count: tables.length,
	column_count: tables.reduce((n, t) => n + t.columns.length, 0),
	foreign_key_count: tables.reduce((n, t) => n + t.foreign_keys.length, 0),
	type_contracts: typeContracts,
	generated_from: "packages/db/src/schema/tables.ts",
};
const path = new URL("docs/schema/target.json", root);
const rendered = JSON.stringify(catalog, null, 2) + "\n";
if (process.argv.includes("--check")) {
	if ((await readFile(path, "utf8")) !== rendered)
		throw Error("Schema target is stale; run pnpm --filter @everyfield/db catalog");
	console.log("Schema target matches the Drizzle declarations.");
} else {
	await writeFile(path, rendered);
	console.log("Generated schema target from Drizzle declarations.");
}
