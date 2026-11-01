import type { DatabaseSync } from "node:sqlite";
import { fail, loadConfig, parseTask } from "./lib.ts";
import { nextId } from "./ids.ts";
import { laterSlices } from "./spec.ts";

/**
 * Later slices (OPS-86). Each item under a spec's `## Later slices` becomes a follow-up row, status `queued`, linked to
 * the task that stored the spec through parent_task_id. An OPS parent gets a newly reserved OPS id for each slice. A WP
 * or FB parent keeps its own ref for each slice. A queued row is filed, not started and not drivable. It becomes `new`
 * when the row it depends on merges: slice 1 depends on the parent, each later slice on the slice before it.
 */

type Row = Record<string, unknown>;
export type LinkedRow = {
	id: number;
	ref: string;
	status: string;
	title: string;
	ask: string;
	parent_task_id: number | null;
	/** The later slice of the parent's spec this row covers (1 is the first), or null for a row that covers none. */
	slice: number | null;
	/** 1 when `evf task link` attached the row, 0 when storing a spec filed it. Storing a spec never edits a linked row. */
	linked: number;
};
const now = () => new Date().toISOString();
const headline = (text: string, max = 100) => text.split("\n")[0]!.slice(0, max);
const COLUMNS = "id, ref, status, title, ask, parent_task_id, slice, linked";

/** The follow-up rows of a task, oldest first. Abandoned rows no longer count. */
export function linkedRows(db: DatabaseSync, parentId: number): LinkedRow[] {
	return db
		.prepare(`SELECT ${COLUMNS} FROM tasks WHERE parent_task_id = ? AND status != 'abandoned' ORDER BY id`)
		.all(parentId) as LinkedRow[];
}

/** The follow-ups that cover a later slice, by slice number. */
const sliceRows = (db: DatabaseSync, parentId: number): LinkedRow[] =>
	db
		.prepare(
			`SELECT ${COLUMNS} FROM tasks WHERE parent_task_id = ? AND slice IS NOT NULL AND status != 'abandoned' ORDER BY slice`,
		)
		.all(parentId) as LinkedRow[];

const rowById = (db: DatabaseSync, id: number) =>
	db.prepare(`SELECT ${COLUMNS} FROM tasks WHERE id = ?`).get(id) as LinkedRow | undefined;

/** The ref's own label (`OPS-123`) when the slice has its own ref, else `<ref> slice <n>`, counting the parent as slice 1. */
export function labelOf(db: DatabaseSync, row: LinkedRow): string {
	let root = row;
	for (let up = root.parent_task_id; up; up = root.parent_task_id) {
		const parent = rowById(db, up);
		if (!parent) break;
		root = parent;
	}
	if (!row.parent_task_id || root.ref !== row.ref) return row.ref;
	const n = (
		db
			.prepare("SELECT COUNT(*) AS n FROM tasks WHERE ref = ? AND status != 'abandoned' AND id >= ? AND id <= ?")
			.get(row.ref, root.id, row.id) as { n: number }
	).n;
	return `${row.ref} slice ${n}`;
}

/** The row a slice depends on: the covered slice before it, or the parent for the first. A plain link depends on none. */
export function dependencyOf(db: DatabaseSync, row: LinkedRow): LinkedRow | undefined {
	if (!row.parent_task_id || row.slice === null) return undefined;
	const before = sliceRows(db, row.parent_task_id).filter((s) => s.slice! < row.slice!);
	return before.at(-1) ?? rowById(db, row.parent_task_id);
}

/** Why a queued row cannot start: the label of the row it waits for, or null for a row that is not queued. */
export function waitsFor(db: DatabaseSync, taskId: number): string | null {
	const row = rowById(db, taskId);
	if (!row || row.status !== "queued") return null;
	const dep = dependencyOf(db, row);
	return dep ? labelOf(db, dep) : "its parent";
}

/** The slices of a stored spec that no follow-up row covers, in order. Abandoned rows and plain links do not count. */
export function unfiledSlices(db: DatabaseSync, taskId: number, spec: string | null): string[] {
	const slices = laterSlices(spec);
	if (!slices.length) return [];
	const covered = new Set(sliceRows(db, taskId).map((r) => r.slice));
	return slices.filter((_, i) => !covered.has(i + 1));
}

/** The follow-ups of a task for owner-facing text: label, status and the slice headline. */
export type FollowUp = { label: string; status: string; title: string };
export function followUpsOf(db: DatabaseSync, taskId: number): FollowUp[] {
	// A store without migration 8, opened read-only, cannot be asked.
	const columns = db.prepare("PRAGMA table_info(tasks)").all() as Array<{ name: string }>;
	if (!columns.some((c) => c.name === "slice")) return [];
	return linkedRows(db, taskId).map((r) => ({ label: labelOf(db, r), status: r.status, title: r.title }));
}

/** The `Partial:` line owner-facing text starts with. Null for a task without follow-ups. */
export function partialLine(followUps: FollowUp[]): string | null {
	return followUps.length
		? `Partial: this PR covers only part of the ask. Deferred: ${followUps.map((f) => `${f.title} (${f.label})`).join("; ")}.`
		: null;
}

/** The refusal text for slices that have no follow-up, with the command that files them. */
export function unfiledMessage(ref: string, slices: string[]): string {
	return `${ref} lists ${slices.length} later slice${slices.length === 1 ? "" : "s"} with no follow-up: ${slices.map((s) => `"${headline(s, 80)}"`).join("; ")}. File them by storing the spec again: bin/evf task spec ${ref} --file <spec>.`;
}

const askOf = (slice: string, parent: { ref: string; ask: string }) =>
	`${slice}\n\nParent task ${parent.ref}, verbatim ask:\n${parent.ask}`;

type Parent = { id: number; ref: string; ask: string; goal_id: number | null };

/**
 * File the later slices of `spec` for `parent`, and return the follow-up labels in order. A repeat gives the same rows:
 * a changed slice updates its queued row and a removed slice abandons its queued row. A slice that a linked row covers
 * (`evf task link --slice`) is not filed, and the linked row is never edited or abandoned. OPS ids are reserved before
 * anything is written, so one failed reservation leaves the store untouched. The caller runs this inside its
 * transaction after calling `reserveFollowUpIds`.
 */
export function fileFollowUps(db: DatabaseSync, parent: Parent, spec: string, ids: string[]): string[] {
	const slices = laterSlices(spec);
	const existing = sliceRows(db, parent.id);
	const ts = now();
	let reserved = 0;
	slices.forEach((slice, i) => {
		const row = existing.find((r) => r.slice === i + 1);
		if (row) {
			if (!row.linked && row.status === "queued" && row.ask !== askOf(slice, parent))
				db.prepare("UPDATE tasks SET ask = ?, title = ?, updated_at = ? WHERE id = ?").run(
					askOf(slice, parent),
					headline(slice),
					ts,
					row.id,
				);
			return;
		}
		const ref = ids[reserved++] ?? parent.ref;
		const t = parseTask(ref);
		const id = Number(
			db
				.prepare(
					`INSERT INTO tasks (slug, mode, ref, goal_id, title, ask, branch, status, parent_task_id, slice, created_at, updated_at)
					 VALUES (?, 'implement', ?, ?, ?, ?, ?, 'queued', ?, ?, ?, ?)`,
				)
				.run(t.slug, t.id, parent.goal_id, headline(slice), askOf(slice, parent), t.branch, parent.id, i + 1, ts, ts)
				.lastInsertRowid,
		);
		const filed = rowById(db, id)!;
		const dep = dependencyOf(db, filed);
		recordEvent(db, parent.id, "follow_up_filed", {
			follow_up: id,
			summary: `${parent.ref}: filed ${labelOf(db, filed)} (${headline(slice, 80)})`,
		});
		if (dep?.status === "merged") release(db, filed, dep, null);
	});
	for (const row of existing)
		if (row.slice! > slices.length && !row.linked && row.status === "queued") {
			db.prepare("UPDATE tasks SET status = 'abandoned', updated_at = ? WHERE id = ?").run(ts, row.id);
			recordEvent(db, parent.id, "follow_up_abandoned", {
				follow_up: row.id,
				summary: `${parent.ref}: ${labelOf(db, row)} left the spec and is abandoned`,
			});
		}
	return linkedRows(db, parent.id).map((r) => `${labelOf(db, r)} ${r.status} ${r.title}`);
}

/** The OPS ids a spec needs: one for each slice that has no row yet, when the parent is an OPS task. */
export function reserveFollowUpIds(
	root: string,
	db: DatabaseSync,
	parent: { id: number; ref: string },
	spec: string,
): string[] {
	if (parseTask(parent.ref).kind !== "ops") return [];
	const missing = unfiledSlices(db, parent.id, spec).length; // id 0: a ref without a row has no follow-ups yet
	if (!missing) return [];
	const cfg = loadConfig(root);
	return Array.from({ length: missing }, () => nextId(root, cfg, "ops"));
}

function recordEvent(db: DatabaseSync, taskId: number, type: string, payload: Row, runId: number | null = null): void {
	db.prepare("INSERT INTO events (task_id, run_id, ts, type, payload) VALUES (?, ?, ?, ?, ?)").run(
		taskId,
		runId,
		now(),
		type,
		JSON.stringify(payload),
	);
}

function release(db: DatabaseSync, row: LinkedRow, dep: LinkedRow, runId: number | null): void {
	db.prepare("UPDATE tasks SET status = 'new', updated_at = ? WHERE id = ?").run(now(), row.id);
	recordEvent(
		db,
		row.id,
		"follow_up_released",
		{ summary: `${labelOf(db, row)} can start: ${labelOf(db, dep)} merged` },
		runId,
	);
}

/** A row merged: the queued follow-up that depends on it becomes `new`. The slice after that stays queued. */
export function releaseDependents(db: DatabaseSync, mergedId: number, runId: number | null): void {
	const merged = rowById(db, mergedId);
	if (!merged) return;
	const queued = db
		.prepare(`SELECT ${COLUMNS} FROM tasks WHERE status = 'queued' AND parent_task_id IN (?, ?) ORDER BY id`)
		.all(mergedId, merged.parent_task_id ?? mergedId) as LinkedRow[];
	for (const q of queued) if (dependencyOf(db, q)?.id === mergedId) release(db, q, merged, runId);
}

/** The task that stores a spec, as `evf task link` reads it. */
type LinkParent = { id: number; ref: string; spec: string | null };

/**
 * `evf task link` (OPS-109): make an existing row a follow-up of `parent`, and with `slice` the row that covers that
 * later slice of the parent's spec. The row keeps its ref, id and status, so no id is reserved. Returns the event
 * summary, or null when the row already is that follow-up.
 */
export function linkFollowUp(
	db: DatabaseSync,
	parent: LinkParent,
	row: LinkedRow,
	slice: number | null,
): string | null {
	const label = labelOf(db, row);
	if (row.id === parent.id) fail(`${label} cannot be a follow-up of itself.`);
	for (let up = rowById(db, parent.id)?.parent_task_id ?? null; up; up = rowById(db, up)?.parent_task_id ?? null)
		if (up === row.id) fail(`${parent.ref} is already a follow-up of ${label}; the link would make a cycle.`);
	if (row.status === "abandoned" || row.status === "merged")
		fail(`Store row ${row.id} (${label}) is ${row.status}; link an open row.`);
	if (row.parent_task_id && row.parent_task_id !== parent.id)
		fail(`Store row ${row.id} (${label}) is already a follow-up of ${labelOf(db, rowById(db, row.parent_task_id)!)}.`);
	if (row.parent_task_id === parent.id && row.slice === slice) return null;
	if (row.parent_task_id === parent.id && !row.linked)
		fail(`${label} is slice ${row.slice} that storing the ${parent.ref} spec filed; it cannot be relinked.`);
	if (slice !== null) {
		const count = laterSlices(parent.spec).length;
		if (slice > count)
			fail(
				`The stored ${parent.ref} spec has ${count} later slice${count === 1 ? "" : "s"}, so there is no slice ${slice}.`,
			);
		const holder = sliceRows(db, parent.id).find((r) => r.slice === slice && r.id !== row.id);
		if (holder)
			fail(`Slice ${slice} of ${parent.ref} already has a follow-up: ${labelOf(db, holder)} (store row ${holder.id}).`);
	}
	db.prepare("UPDATE tasks SET parent_task_id = ?, slice = ?, linked = 1, updated_at = ? WHERE id = ?").run(
		parent.id,
		slice,
		now(),
		row.id,
	);
	const summary = `${parent.ref}: linked ${labelOf(db, rowById(db, row.id)!)} (store row ${row.id}) as a follow-up${slice ? ` for later slice ${slice}` : ""}`;
	recordEvent(db, parent.id, "follow_up_linked", { follow_up: row.id, slice, summary });
	return summary;
}

/** Undo a link that `evf task link` made. Returns the event summary, or null when the row is no follow-up at all. */
export function unlinkFollowUp(db: DatabaseSync, parent: LinkParent, row: LinkedRow): string | null {
	const label = labelOf(db, row);
	if (!row.parent_task_id) return null;
	if (row.parent_task_id !== parent.id) fail(`Store row ${row.id} (${label}) is not a follow-up of ${parent.ref}.`);
	if (!row.linked)
		fail(`${label} is a slice that storing the ${parent.ref} spec filed; store the spec without that slice instead.`);
	db.prepare("UPDATE tasks SET parent_task_id = NULL, slice = NULL, linked = 0, updated_at = ? WHERE id = ?").run(
		now(),
		row.id,
	);
	const summary = `${parent.ref}: unlinked ${row.ref} (store row ${row.id})`;
	recordEvent(db, parent.id, "follow_up_unlinked", { follow_up: row.id, summary });
	return summary;
}

/** The store rows of a ref, oldest first, for `evf task link --follow-up`. */
export const rowsOfRef = (db: DatabaseSync, ref: string): LinkedRow[] =>
	db.prepare(`SELECT ${COLUMNS} FROM tasks WHERE ref = ? ORDER BY id`).all(ref) as LinkedRow[];
