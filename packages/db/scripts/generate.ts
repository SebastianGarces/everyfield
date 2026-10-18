import { parseArgs } from "node:util";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { readdir, readFile, writeFile } from "node:fs/promises";
import { checkMigrationArtifacts, migrationDirectory, ownTableNames } from "../src/schema/artifacts.ts";
import { normalizeOwnTableReferences, qualifyVectorTypes } from "../src/schema/normalize.ts";

const { values } = parseArgs({ options: { name: { type: "string" }, custom: { type: "boolean", default: false } } });
if (!values.name || !/^[a-z][a-z0-9_]*$/.test(values.name))
	throw Error("Use generate --name descriptive_name [--custom]");
await checkMigrationArtifacts();
const before = new Set(await readdir(migrationDirectory));
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
for (const name of await readdir(migrationDirectory)) {
	if (before.has(name) || !name.endsWith(".sql")) continue;
	const path = new URL(name, migrationDirectory);
	const bytes = await readFile(path, "utf8");
	await writeFile(path, qualifyVectorTypes(normalizeOwnTableReferences(bytes, ownTableNames)));
}
await checkMigrationArtifacts();
await import("./catalog.ts");
console.log("Review the normalized migration before committing; the runner hashes these exact bytes.");
