import { parseArgs } from "node:util";
import { readdir, readFile, writeFile } from "node:fs/promises";
import { generateDrizzleJson, generateMigration } from "drizzle-kit/api";
import * as declarations from "../src/schema/tables.ts";
import {
	checkMigrationArtifacts,
	migrationDirectory,
	migrationName,
	ownTableNames,
} from "../src/schema/artifacts.ts";
import { currentSnapshot, definitions } from "../src/schema/drift.ts";
import { normalizeOwnTableReferences, qualifyVectorTypes } from "../src/schema/normalize.ts";

const { values } = parseArgs({
	options: {
		name: { type: "string" },
		custom: { type: "boolean", default: false },
		normalize: { type: "boolean", default: false },
	},
});
if ((!values.name || !/^[a-z][a-z0-9_]*$/.test(values.name)) && !values.normalize)
	throw Error("Use generate --name descriptive_name [--custom], or generate --normalize after editing custom SQL");
if (values.normalize && (values.name || values.custom)) throw Error("Use --normalize alone");
async function normalizeGenerated() {
	const frozen: { files: { name: string }[] } = JSON.parse(
		await readFile(new URL("frozen.json", migrationDirectory), "utf8"),
	);
	const names = new Set(frozen.files.map((file) => file.name));
	for (const name of await readdir(migrationDirectory)) {
		if (names.has(name) || !migrationName.test(name)) continue;
		const path = new URL(name, migrationDirectory);
		const source = await readFile(path, "utf8");
		const normalized = qualifyVectorTypes(normalizeOwnTableReferences(source, ownTableNames));
		if (normalized !== source) await writeFile(path, normalized);
	}
}
await normalizeGenerated();
await checkMigrationArtifacts();
if (values.name) {
	// The pinned Kit diffs the schema after every migration against the declarations, as `drizzle-kit generate`
	// does, without its journal or snapshot chain: those are the files two branches would both append to (D78).
	const previous = await currentSnapshot();
	const declared = definitions(JSON.parse(JSON.stringify(generateDrizzleJson(declarations))));
	const zero = "00000000-0000-0000-0000-000000000000";
	const link = { id: zero, prevId: zero, _meta: { columns: {}, schemas: {}, tables: {} } };
	const statements = values.custom ? [] : await generateMigration({ ...link, ...previous }, { ...link, ...declared });
	if (!values.custom && !statements.length) throw Error("No schema changes, nothing to migrate");
	const stamp = new Date().toISOString().replace(/\D/g, "").slice(0, 14);
	const file = `${stamp}_${values.name}.sql`;
	await writeFile(
		new URL(file, migrationDirectory),
		values.custom ? "-- Custom SQL migration file, put your code below! --" : statements.join("--> statement-breakpoint\n"),
		{ flag: "wx" },
	);
	// A custom migration changes nothing Kit models, so the base carries forward unchanged.
	await writeFile(
		new URL("meta/current.json", migrationDirectory),
		JSON.stringify(values.custom ? previous : declared, null, 2),
	);
	await normalizeGenerated();
	await checkMigrationArtifacts();
	console.log(`Wrote migrations/${file} and migrations/meta/current.json.`);
}
await import("./catalog.ts");
console.log("Review the normalized migration before committing; the runner hashes these exact bytes.");
