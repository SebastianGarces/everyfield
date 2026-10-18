import { parseArgs } from "node:util";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { readdir, readFile, writeFile } from "node:fs/promises";
import { checkMigrationArtifacts, migrationDirectory, ownTableNames } from "../src/schema/artifacts.ts";
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
		if (names.has(name) || !/^\d{4}_[a-z0-9_]+\.sql$/.test(name)) continue;
		const path = new URL(name, migrationDirectory);
		const source = await readFile(path, "utf8");
		const normalized = qualifyVectorTypes(normalizeOwnTableReferences(source, ownTableNames));
		if (normalized !== source) await writeFile(path, normalized);
	}
}
await normalizeGenerated();
await checkMigrationArtifacts();
if (values.name) {
	const result = spawnSync(
		process.execPath,
		[
			fileURLToPath(new URL("../node_modules/drizzle-kit/bin.cjs", import.meta.url)),
			"generate",
			"--name",
			values.name,
			...(values.custom ? ["--custom"] : []),
		],
		{ cwd: fileURLToPath(new URL("../", import.meta.url)), stdio: "inherit" },
	);
	if (result.error) throw result.error;
	if (result.status !== 0) throw Error("Drizzle Kit generation failed");
	await normalizeGenerated();
	await checkMigrationArtifacts();
}
await import("./catalog.ts");
console.log("Review the normalized migration before committing; the runner hashes these exact bytes.");
