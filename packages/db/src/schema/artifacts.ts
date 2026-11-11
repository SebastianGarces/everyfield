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
	const auditActions: { name: string; actions: string[] }[] = [];
	for (const name of files) {
		const bytes = await readFile(new URL(name, directory));
		const list = /^\d{14}_/.test(name) ? lastAuditActionList(bytes.toString("utf8")) : undefined;
		if (list) auditActions.push({ name, actions: list });
		if (frozen.has(name)) {
			if (createHash("sha256").update(bytes).digest("hex") !== frozen.get(name))
				throw Error("Frozen migration changed: " + name);
		} else {
			if (!migrationName.test(name)) throw Error("Invalid migration filename: " + name);
			assertUnqualifiedOwnTables(bytes.toString("utf8"), ownTableNames);
			assertQualifiedVectorTypes(bytes.toString("utf8"));
		}
	}
	assertAdditiveAuditActions(auditActions);
}
const auditActionCheck = /ADD CONSTRAINT "audit_action" CHECK \(\(action IN \(([^)]*)\)\)\)/g;
/** The allowed actions of the last `audit_action` CHECK a migration sets, if it sets one. */
function lastAuditActionList(sql: string): string[] | undefined {
	const list = [...sql.matchAll(auditActionCheck)].at(-1)?.[1];
	return list === undefined ? undefined : [...list.matchAll(/'([^']*)'/g)].map((match) => match[1] ?? "");
}
/** Audit rows outlive the code that wrote them, so a later list may add actions but never drop one (pac-9). */
function assertAdditiveAuditActions(lists: { name: string; actions: string[] }[]): void {
	const last = lists.at(-1);
	if (!last) return;
	const kept = new Set(last.actions);
	for (const earlier of lists.slice(0, -1)) {
		const dropped = earlier.actions.filter((action) => !kept.has(action));
		if (dropped.length) throw Error(`${last.name} drops audit actions ${earlier.name} allowed: ${dropped.join(", ")}`);
	}
}
