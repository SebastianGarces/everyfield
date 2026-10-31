import type { DatabaseSync } from "node:sqlite";
import { loadConfig, parseTask } from "./lib.ts";
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
};
const now = () => new Date().toISOString();
const headline = (text: string, max = 100) => text.split("\n")[0]!.slice(0, max);
const COLUMNS = "id, ref, status, title, ask, parent_task_id";

/** The follow-up rows of a task, oldest first. Abandoned rows no longer count. */
export function linkedRows(db: DatabaseSync, parentId: number): LinkedRow[] {
	return db
		.prepare(`SELECT ${COLUMNS} FROM tasks WHERE parent_task_id = ? AND status != 'abandoned' ORDER BY id`)
		.all(parentId) as LinkedRow[];
}

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

/** The row a follow-up depends on: the slice before it, or the parent for the first slice. */
export function dependencyOf(db: DatabaseSync, row: LinkedRow): LinkedRow | undefined {
	if (!row.parent_task_id) return undefined;
	const siblings = linkedRows(db, row.parent_task_id);
	const at = siblings.findIndex((s) => s.id === row.id);
	return at > 0 ? siblings[at - 1] : rowById(db, row.parent_task_id);
}

/** Why a queued row cannot start: the label of the row it waits for, or null for a row that is not queued. */
export function waitsFor(db: DatabaseSync, taskId: number): string | null {
	const row = rowById(db, taskId);
	if (!row || row.status !== "queued") return null;
	const dep = dependencyOf(db, row);
	return dep ? labelOf(db, dep) : "its parent";
}

/** The slices of a stored spec that have no follow-up row yet, in order. Abandoned rows do not count. */
export function unfiledSlices(db: DatabaseSync, taskId: number, spec: string | null): string[] {
	const slices = laterSlices(spec);
	return slices.length ? slices.slice(linkedRows(db, taskId).length) : [];
}

/** The follow-ups of a task for owner-facing text: label, status and the slice headline. */
export type FollowUp = { label: string; status: string; title: string };
export function followUpsOf(db: DatabaseSync, taskId: number): FollowUp[] {
	// A store older than schema 5, opened read-only, has no follow-ups and cannot be asked.
	const columns = db.prepare("PRAGMA table_info(tasks)").all() as Array<{ name: string }>;
	if (!columns.some((c) => c.name === "parent_task_id")) return [];
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
 * a changed slice updates its queued row and a removed slice abandons its queued row. OPS ids are reserved before
 * anything is written, so one failed reservation leaves the store untouched. The caller runs this inside its
 * transaction after calling `reserveFollowUpIds`.
 */
export function fileFollowUps(db: DatabaseSync, parent: Parent, spec: string, ids: string[]): string[] {
	const slices = laterSlices(spec);
	const existing = linkedRows(db, parent.id);
	const ts = now();
	let reserved = 0;
	slices.forEach((slice, i) => {
		const row = existing[i];
		if (row) {
			if (row.status === "queued" && row.ask !== askOf(slice, parent))
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
					`INSERT INTO tasks (slug, mode, ref, goal_id, title, ask, branch, status, parent_task_id, created_at, updated_at)
					 VALUES (?, 'implement', ?, ?, ?, ?, ?, 'queued', ?, ?, ?)`,
				)
				.run(t.slug, t.id, parent.goal_id, headline(slice), askOf(slice, parent), t.branch, parent.id, ts, ts)
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
	for (const row of existing.slice(slices.length))
		if (row.status === "queued") {
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
