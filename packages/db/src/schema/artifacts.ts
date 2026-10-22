import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import { is, getTableName } from "drizzle-orm";
import { PgTable } from "drizzle-orm/pg-core";
import * as schema from "./tables.ts";
import { assertUnqualifiedOwnTables, assertQualifiedVectorTypes } from "./normalize.ts";

export const migrationDirectory = new URL("../../migrations/", import.meta.url);
/** Numbered names until 2026-10-22 (D76), then UTC timestamps (D78). Both sort by name. */
export const migrationName = /^(?:\d{4}|\d{14})_[a-z0-9_]+\.sql$/;
export const ownTableNames = new Set(
	Object.values(schema)
		.filter((value) => is(value, PgTable))
		.map((table) => getTableName(table)),
);
export async function checkMigrationArtifacts(directory = migrationDirectory): Promise<void> {
	const manifest: { files: { name: string; sha256: string }[] } = JSON.parse(
		await readFile(new URL("frozen.json", directory), "utf8"),
	);
	const journal: { entries: { idx: number; tag: string }[] } = JSON.parse(
		await readFile(new URL("meta/_journal.json", directory), "utf8"),
	);
	const files = (await readdir(directory)).filter((name) => name.endsWith(".sql")).sort();
	// Kit's journal registers the numbered migrations only. Timestamped ones need no registry: the folder is one.
	const numbered = files.filter((name) => /^\d{4}_/.test(name));
	const registered = journal.entries.map((entry) => entry.tag + ".sql").sort();
	if (
		new Set(journal.entries.map((entry) => entry.idx)).size !== journal.entries.length ||
		journal.entries.some(
			(entry, index) =>
				!Number.isInteger(entry.idx) ||
				entry.idx < 0 ||
				(index > 0 && entry.idx <= (journal.entries[index - 1]?.idx ?? -1)),
		) ||
		new Set(numbered.map((name) => name.slice(0, 4))).size !== numbered.length ||
		journal.entries.some((entry) => !entry.tag.startsWith(String(entry.idx).padStart(4, "0") + "_")) ||
		new Set(registered).size !== registered.length ||
		JSON.stringify(numbered) !== JSON.stringify(registered)
	)
		throw Error("Unregistered or duplicate migration artifact");
	const frozen = new Map(manifest.files.map((file) => [file.name, file.sha256]));
	for (const file of manifest.files)
		if (!files.includes(file.name)) throw Error("Missing frozen migration " + file.name);
	for (const name of files) {
		const bytes = await readFile(new URL(name, directory));
		if (frozen.has(name)) {
			if (createHash("sha256").update(bytes).digest("hex") !== frozen.get(name))
				throw Error("Frozen migration changed: " + name);
		} else {
			if (!migrationName.test(name)) throw Error("Invalid migration filename: " + name);
			assertUnqualifiedOwnTables(bytes.toString("utf8"), ownTableNames);
			assertQualifiedVectorTypes(bytes.toString("utf8"));
		}
	}
}
