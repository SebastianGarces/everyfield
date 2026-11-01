import { existsSync, mkdirSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import {
	followUpsOf,
	partialLine,
	type FollowUp,
	releaseDependents,
	unfiledMessage,
	unfiledSlices,
	waitsFor,
} from "./followups.ts";
import { baseRef, evfDataDir, fail, git, loadConfig, parseTask, sleep, type TaskRef } from "./lib.ts";

/**
 * The harness work store (OPS-57): tasks, runs, events, proofs, approvals, goals and learnings in one sqlite file
 * under the Git common directory, so every worktree of this repository shares it. Writers open it in WAL mode with a
 * busy timeout, so a reader (evf status, the TUI) never blocks a hook that writes. Migrations are the numbered SQL
 * files in db/migrations; the views they define are the read contract.
 */

const MIGRATIONS = join(import.meta.dirname, "db/migrations");
const MIGRATION = /^(\d{3})-([\w-]+)\.sql$/;
const now = () => new Date().toISOString();
type Row = Record<string, unknown>;

export function workDbPath(root: string): string {
	return join(evfDataDir(root), "work.sqlite");
}

/** Open the store. A writer creates and migrates it; a read-only open needs an existing file and never writes. */
export function openWorkDb(root: string, opts: { readOnly?: boolean } = {}): DatabaseSync {
	const path = workDbPath(root);
	if (opts.readOnly) {
		if (!existsSync(path)) fail(`No work store at ${path}. Run evf db migrate first.`);
		const db = new DatabaseSync(path, { readOnly: true });
		db.exec("PRAGMA busy_timeout = 5000");
		return db;
	}
	mkdirSync(evfDataDir(root), { recursive: true });
	const db = new DatabaseSync(path);
	db.exec("PRAGMA busy_timeout = 5000");
	enableWal(db);
	db.exec("PRAGMA foreign_keys = ON");
	migrate(db);
	return db;
}

/**
 * Switching a fresh file to WAL needs the file to itself, and SQLite answers "database is locked" at once instead of
 * waiting when another connection is open on it (the busy timeout does not cover a journal-mode change). Several
 * processes opening a new store at the same moment therefore retry briefly; the first one wins and the rest find WAL.
 */
function enableWal(db: DatabaseSync): void {
	const deadline = Date.now() + 5000;
	for (;;) {
		try {
			const mode = (db.prepare("PRAGMA journal_mode = WAL").get() as { journal_mode: string }).journal_mode;
			if (mode === "wal") return;
			fail(`The work store refused WAL mode (journal_mode is ${mode}).`);
		} catch (e) {
			if (!/locked|busy/i.test(String(e)) || Date.now() > deadline) throw e;
			sleep(25);
		}
	}
}

/**
 * Apply every migration above the stored version, in file order without gaps. Each migration takes the write lock
 * first (BEGIN IMMEDIATE) and reads the version inside it, so two processes opening a fresh store at once apply each
 * migration once: the second one waits on the lock, then sees the version and skips.
 */
export function migrate(db: DatabaseSync): { version: number; applied: string[] } {
	db.exec(
		"CREATE TABLE IF NOT EXISTS schema_version (version INTEGER PRIMARY KEY, name TEXT NOT NULL, applied_at TEXT NOT NULL)",
	);
	const files = readdirSync(MIGRATIONS)
		.map((file) => MIGRATION.exec(file))
		.filter((m): m is RegExpExecArray => m !== null)
		.map((m) => ({ file: m[0], version: Number(m[1]), name: m[2] }))
		.sort((a, b) => a.version - b.version);
	// Two branches can take the same number. A store that applied the other one must stop here, never skip this one.
	const recorded = new Map(
		(db.prepare("SELECT version, name FROM schema_version").all() as Array<{ version: number; name: string }>).map(
			(r) => [r.version, r.name],
		),
	);
	for (const [i, m] of files.entries()) {
		if (files[i + 1]?.version === m.version) fail(`Migrations ${m.file} and ${files[i + 1]!.file} share a number.`);
		const name = recorded.get(m.version);
		if (name !== undefined && name !== m.name)
			fail(
				`The work store applied migration ${m.version} as ${name}, but this evf code numbers ${m.file} ${m.version}. Renumber the newer migration after the last one on main.`,
			);
	}
	const applied: string[] = [];
	let version = schemaVersion(db);
	for (const m of files) {
		if (m.version <= version) continue;
		// A migration may rebuild a table other tables reference (the documented twelve-step ALTER), so foreign
		// keys are off around it and checked afterwards. PRAGMA foreign_keys is a no-op inside a transaction.
		db.exec("PRAGMA foreign_keys = OFF");
		db.exec("BEGIN IMMEDIATE");
		try {
			version = schemaVersion(db);
			if (m.version <= version) {
				db.exec("COMMIT"); // Another process applied it while we waited for the lock.
				continue;
			}
			if (m.version !== version + 1) fail(`Migration ${m.file} skips version ${version + 1}.`);
			db.exec(readFileSync(join(MIGRATIONS, m.file), "utf8"));
			db.prepare("INSERT INTO schema_version (version, name, applied_at) VALUES (?, ?, ?)").run(
				m.version,
				m.name,
				now(),
			);
			const broken = db.prepare("PRAGMA foreign_key_check").all();
			if (broken.length) fail(`Migration ${m.file} left ${broken.length} dangling foreign keys.`);
			db.exec("COMMIT");
		} catch (e) {
			db.exec("ROLLBACK");
			throw e;
		} finally {
			db.exec("PRAGMA foreign_keys = ON");
		}
		version = m.version;
		applied.push(m.file);
	}
	return { version, applied };
}

export function schemaVersion(db: DatabaseSync): number {
	return (db.prepare("SELECT COALESCE(MAX(version), 0) AS v FROM schema_version").get() as { v: number }).v;
}

/**
 * Goals are a cache of the plan documents, never their source: the project line is the first sentence of
 * docs/START-HERE.md and each mission is one S-row of the Vertical slices table in docs/plan/build-plan.md.
 */
export function syncGoals(root: string, db: DatabaseSync): { project: string; missions: string[] } {
	const orientation = readFileSync(join(root, "docs/START-HERE.md"), "utf8");
	const project =
		orientation
			.split("\n")
			.map((line) => line.trim())
			.find((line) => line && !line.startsWith("#")) ?? fail("docs/START-HERE.md has no opening paragraph.");
	const plan = readFileSync(join(root, "docs/plan/build-plan.md"), "utf8");
	const section = plan.split(/^## /m).find((s) => s.startsWith("Vertical slices"));
	if (!section) fail("docs/plan/build-plan.md has no Vertical slices section.");
	const rows = section
		.split("\n")
		.map((line) => line.trim())
		.filter((line) => line.startsWith("|"))
		.map((line) =>
			line
				.split("|")
				.slice(1, -1)
				.map((cell) => cell.trim()),
		)
		.filter((cells) => cells.length >= 3 && /^S\d+[A-Z]*$/.test(cells[0] ?? ""));
	if (!rows.length) fail("docs/plan/build-plan.md lists no S-rows in its Vertical slices table.");
	const ts = now();
	const upsert = db.prepare(
		`INSERT INTO goals (key, kind, title, body, parent_id, packages, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
		 ON CONFLICT (key) DO UPDATE SET title = excluded.title, body = excluded.body, parent_id = excluded.parent_id,
		 packages = excluded.packages, updated_at = excluded.updated_at`,
	);
	db.exec("BEGIN IMMEDIATE");
	try {
		upsert.run("project", "project", "Everyfield v3", project, null, "[]", ts, ts);
		const projectId = (db.prepare("SELECT id FROM goals WHERE key = 'project'").get() as { id: number }).id;
		for (const [key, delivery, packages] of rows as Array<[string, string, string]>) {
			const ids = packages
				.split(",")
				.map((id) => id.trim())
				.filter(Boolean);
			upsert.run(
				key,
				"mission",
				`${key}: ${delivery}`,
				`Delivers ${ids.length} packages: ${ids.join(", ")}.`,
				projectId,
				JSON.stringify(ids),
				ts,
				ts,
			);
		}
		db.exec("COMMIT");
	} catch (e) {
		db.exec("ROLLBACK");
		throw e;
	}
	return { project, missions: rows.map((cells) => cells[0] as string) };
}

type LedgerEvidence = { commit?: string; note?: string; path?: string };
type LedgerMilestone = { task: string; merge_commit: string; stage?: string; acknowledged?: boolean };
type LedgerPackage = {
	status?: string;
	updated_at?: string | null;
	evidence?: LedgerEvidence[];
	milestones?: Record<string, LedgerMilestone>;
};
export type Ledger = { packages?: Record<string, LedgerPackage> };

const slugOf = (ref: string) => ref.toLowerCase().replace(/[^a-z0-9]+/g, "-");

/**
 * Import the merged milestones of docs/build-progress.json as merged tasks, once each, with one legacy_milestone
 * event. It reads the ledger committed on the base branch, never a checkout's working copy, which may hold an
 * unreviewed local edit. A package with no milestones but status done contributes one task per evidence commit.
 */
export function seedProgress(
	root: string,
	db: DatabaseSync,
	ledger?: Ledger,
): { tasks: number; events: number; seen: number } {
	const data: Ledger =
		ledger ?? (JSON.parse(git(root, "show", `${baseRef(root, loadConfig(root))}:docs/build-progress.json`)) as Ledger);
	const entries: Array<{
		pkg: string;
		ref: string;
		commit: string;
		stage: string | null;
		acknowledged: boolean | null;
		p: LedgerPackage;
	}> = [];
	for (const [pkg, p] of Object.entries(data.packages ?? {})) {
		const milestones = Object.values(p.milestones ?? {}).filter((m) => m.task && m.merge_commit);
		if (milestones.length) {
			for (const m of milestones)
				entries.push({
					pkg,
					ref: m.task,
					commit: m.merge_commit,
					stage: m.stage ?? null,
					acknowledged: m.acknowledged ?? null,
					p,
				});
		} else if (p.status === "done") {
			for (const e of p.evidence ?? [])
				if (e.commit) entries.push({ pkg, ref: pkg, commit: e.commit, stage: "done", acknowledged: true, p });
		}
	}
	const insertTask = db.prepare(
		`INSERT INTO tasks (slug, mode, ref, goal_id, title, ask, status, pr_number, merge_commit, created_at, updated_at)
		 VALUES (?, 'implement', ?, ?, ?, ?, 'merged', ?, ?, ?, ?)
		 ON CONFLICT (ref, merge_commit) WHERE merge_commit IS NOT NULL DO NOTHING`,
	);
	const insertEvent = db.prepare(
		"INSERT INTO events (task_id, ts, type, payload) VALUES (?, ?, 'legacy_milestone', ?)",
	);
	let tasks = 0,
		events = 0;
	db.exec("BEGIN IMMEDIATE");
	try {
		for (const x of entries) {
			const evidence = (x.p.evidence ?? []).find((e) => e.commit === x.commit);
			const pr = /PR #(\d+)/.exec(evidence?.note ?? "")?.[1];
			const goal = missionFor(db, x.pkg);
			const at = x.p.updated_at ?? now();
			const inserted = insertTask.run(
				slugOf(x.ref),
				x.ref,
				goal?.id ?? null,
				`${x.ref} (ledger milestone)`,
				evidence?.note ?? "",
				pr ? Number(pr) : null,
				x.commit,
				at,
				at,
			);
			if (!inserted.changes) continue;
			tasks++;
			insertEvent.run(
				inserted.lastInsertRowid,
				at,
				JSON.stringify({
					package: x.pkg,
					stage: x.stage,
					acknowledged: x.acknowledged,
					commit: x.commit,
					pr: pr ? Number(pr) : null,
					path: evidence?.path ?? null,
					summary: evidence?.note ?? `${x.ref} merged at ${x.commit.slice(0, 10)}`,
				}),
			);
			events++;
		}
		db.exec("COMMIT");
	} catch (e) {
		db.exec("ROLLBACK");
		throw e;
	}
	return { tasks, events, seen: entries.length };
}

export type TaskRow = {
	id: number;
	ref: string;
	slug: string;
	mode: string;
	status: string;
	round: number;
	goal_id: number | null;
	spec: string | null;
	pr_number: number | null;
	worktree: string | null;
	seat_model: string | null;
	seat_effort: string | null;
};

/** The mission goal that owns a package, if the goals are synced. */
export function missionFor(db: DatabaseSync, pkg: string): { id: number; title: string } | undefined {
	if (!pkg) return undefined;
	return db
		.prepare(
			"SELECT id, title FROM goals WHERE kind = 'mission' AND EXISTS (SELECT 1 FROM json_each(goals.packages) WHERE value = ?)",
		)
		.get(pkg) as { id: number; title: string } | undefined;
}

/**
 * The current row for a ref: the latest row that is not abandoned, in any other status (merged included). A ref has
 * one current row, so a merge never leaves a ghost behind. A `queued` follow-up (OPS-86) counts only when it is the
 * ref's sole row, so a slice that shares its parent's ref never hides the parent. Read commands never create one.
 */
export function findTask(db: DatabaseSync, task: TaskRef): TaskRow | undefined {
	return db
		.prepare(
			"SELECT id, ref, slug, mode, status, round, goal_id, spec, pr_number, worktree, seat_model, seat_effort FROM tasks WHERE ref = ? AND status != 'abandoned' ORDER BY (status = 'queued'), id DESC LIMIT 1",
		)
		.get(task.id) as TaskRow | undefined;
}

/**
 * Refuse a task a seat must not start (OPS-86): a queued follow-up, or an implement seat for a task whose spec lists
 * later slices without follow-ups. Reading only: a store that does not exist yet has neither.
 */
export function requireStartable(root: string, task: TaskRef, role?: string): void {
	if (!existsSync(workDbPath(root))) return;
	const db = openWorkDb(root, { readOnly: true });
	try {
		const row = findTask(db, task);
		if (!row) return;
		if (row.status === "queued")
			fail(
				`${task.id} is queued: it waits for ${waitsFor(db, row.id) ?? "its parent"} to merge. Nothing starts it before that.`,
			);
		if (role === "implementer" || role === "ui") {
			const unfiled = unfiledSlices(db, row.id, row.spec);
			if (unfiled.length) fail(unfiledMessage(task.id, unfiled));
		}
	} finally {
		db.close();
	}
}

/** The follow-ups of a ref's current row, for owner-facing text. No store, no row or no slices give none. */
export function followUpsOfTask(root: string, task: TaskRef): FollowUp[] {
	if (!existsSync(workDbPath(root))) return [];
	const db = openWorkDb(root, { readOnly: true });
	try {
		const row = findTask(db, task);
		return row ? followUpsOf(db, row.id) : [];
	} finally {
		db.close();
	}
}

/** Owner-review text for a task with follow-ups starts with this line; a task without any gets `text` unchanged. */
export function withPartial(root: string, task: TaskRef, text: string): string {
	const line = partialLine(followUpsOfTask(root, task));
	return line ? `${line}\n${text}` : text;
}

/**
 * The seat override of a ref's current row. No store, a store older than schema 4 or no row gives no override. It
 * opens the store read-only, so a dry run creates nothing.
 */
export function seatOverrideOf(root: string, task: TaskRef): { model?: string; effort?: string } {
	if (!existsSync(workDbPath(root))) return {};
	const db = openWorkDb(root, { readOnly: true });
	try {
		const columns = db.prepare("PRAGMA table_info(tasks)").all() as Array<{ name: string }>;
		if (!columns.some((c) => c.name === "seat_model")) return {};
		const row = findTask(db, task);
		return {
			...(row?.seat_model ? { model: row.seat_model } : {}),
			...(row?.seat_effort ? { effort: row.seat_effort } : {}),
		};
	} finally {
		db.close();
	}
}

/** Append one event to a task's log. */
export function record(
	db: DatabaseSync,
	taskId: number,
	runId: number | null,
	type: string,
	payload: Record<string, unknown>,
): void {
	db.prepare("INSERT INTO events (task_id, run_id, ts, type, payload) VALUES (?, ?, ?, ?, ?)").run(
		taskId,
		runId,
		now(),
		type,
		JSON.stringify(payload),
	);
}

/** Insert a `new` row for a ref. Only `ensureTask` (no current row) and `evf task new` (a reopen) call this. */
export function newTaskRow(db: DatabaseSync, task: TaskRef, mode: string): TaskRow {
	const ts = now();
	const goal = missionFor(db, task.wp);
	const id = db
		.prepare(
			"INSERT INTO tasks (slug, mode, ref, goal_id, title, branch, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, 'new', ?, ?)",
		)
		.run(task.slug, mode, task.id, goal?.id ?? null, task.id, task.branch, ts, ts).lastInsertRowid;
	return {
		id: Number(id),
		ref: task.id,
		slug: task.slug,
		mode,
		status: "new",
		round: 0,
		goal_id: goal?.id ?? null,
		spec: null,
		pr_number: null,
		worktree: null,
		seat_model: null,
		seat_effort: null,
	};
}

/** The current row, created as `new` when the ref has none. A merged row comes back unchanged: it is not reopened. */
export function ensureTask(db: DatabaseSync, task: TaskRef, mode: string): TaskRow {
	return findTask(db, task) ?? newTaskRow(db, task, mode);
}

/**
 * Record that GitHub merged the ref's PR as `commit`. The current open row becomes merged with one `merged` event; a
 * ref the store does not know gets one merged row. A row already merged is left alone, so ship and the drive loop
 * can both call this and leave one event.
 */
export function markMerged(db: DatabaseSync, task: TaskRef, commit: string | null, runId: number | null): void {
	const current = findTask(db, task);
	if (current?.status === "merged") return;
	// The same merge recorded already: a released follow-up is now the current row and must not take it.
	if (commit && db.prepare("SELECT 1 FROM tasks WHERE ref = ? AND merge_commit = ?").get(task.id, commit)) return;
	const summary = `${task.id} merged${commit ? ` as ${commit.slice(0, 10)}` : ""}`;
	const ts = now();
	db.exec("BEGIN IMMEDIATE");
	try {
		let id = current?.id;
		if (id)
			db.prepare("UPDATE tasks SET status = 'merged', merge_commit = ?, updated_at = ? WHERE id = ?").run(
				commit,
				ts,
				id,
			);
		else {
			const goal = missionFor(db, task.wp);
			id = Number(
				db
					.prepare(
						"INSERT INTO tasks (slug, mode, ref, goal_id, title, branch, status, merge_commit, created_at, updated_at) VALUES (?, 'implement', ?, ?, ?, ?, 'merged', ?, ?, ?)",
					)
					.run(task.slug, task.id, goal?.id ?? null, task.id, task.branch, commit, ts, ts).lastInsertRowid,
			);
		}
		record(db, id, runId, "merged", { summary });
		// The ship outcome happened, so an open evf run passed; a seat run lost its task and aborted.
		const close = db.prepare("UPDATE runs SET status = ?, ended_at = ?, summary = ? WHERE id = ?");
		const open = db.prepare("SELECT id, role FROM runs WHERE task_id = ? AND status = 'started'").all(id) as Array<{
			id: number;
			role: string;
		}>;
		for (const r of open)
			if (r.role === "evf") close.run("passed", ts, summary, r.id);
			else close.run("aborted", ts, "task merged while the seat was open", r.id);
		releaseDependents(db, id, runId);
		db.exec("COMMIT");
	} catch (e) {
		db.exec("ROLLBACK");
		throw e;
	}
}

/**
 * Record a merge evf did not run through ship (`evf approve`). The store row comes from the PR head branch; a branch
 * with no row (a Wiki article) writes nothing, so approve never invents a task.
 */
export function markMergedByBranch(root: string, branch: string, commit: string | null): void {
	if (!existsSync(workDbPath(root))) return;
	const db = openWorkDb(root);
	try {
		const row = db
			.prepare(
				"SELECT ref FROM tasks WHERE branch = ? AND status <> 'abandoned' AND ref IS NOT NULL ORDER BY id DESC LIMIT 1",
			)
			.get(branch) as { ref: string } | undefined;
		if (row) markMerged(db, parseTask(row.ref), commit, null);
	} finally {
		db.close();
	}
}

/**
 * For a task that `evf drive` drove (it has a run of role `evf`, which only the drive loop records), the EVF-Author and
 * EVF-Review sessions must be runs evf launched: an implementer (or ui or simplifier) seat for the author and a verifier
 * seat for the review. A task row alone does not count: `evf launch` or `evf task new` by hand creates one too, and an
 * ordinary PR ships as before. Returns the refusal, or null.
 */
export function sessionsRecorded(
	root: string,
	branch: string | undefined,
	author: string,
	verifier: string,
): string | null {
	if (!branch || !existsSync(workDbPath(root))) return null;
	const db = openWorkDb(root, { readOnly: true });
	try {
		const t = db
			.prepare(
				"SELECT t.id, t.ref FROM tasks t WHERE t.branch = ? AND t.status <> 'abandoned' AND EXISTS (SELECT 1 FROM runs r WHERE r.task_id = t.id AND r.role = 'evf') ORDER BY t.id DESC LIMIT 1",
			)
			.get(branch) as { id: number; ref: string } | undefined;
		if (!t) return null;
		const roles = (session: string) =>
			(
				db.prepare("SELECT role FROM runs WHERE task_id = ? AND session_id = ?").all(t.id, session) as Array<{
					role: string;
				}>
			).map((r) => r.role);
		if (!roles(author).some((role) => ["implementer", "ui", "simplifier"].includes(role)))
			return `The work store has no implementer session ${author} for ${t.ref}: the EVF-Author line names a session evf never launched.`;
		if (!roles(verifier).includes("verifier"))
			return `The work store has no verifier session ${verifier} for ${t.ref}: the EVF-Review line names a session evf never launched.`;
		return null;
	} finally {
		db.close();
	}
}

export function dbMigrate(root: string): number {
	const path = workDbPath(root);
	const existed = existsSync(path);
	const db = openWorkDb(root);
	const version = schemaVersion(db);
	db.close();
	console.log(`work store: ${path} (${existed ? "schema" : "created, schema"} ${version}).`);
	return 0;
}

export function dbSeedProgress(root: string): number {
	const db = openWorkDb(root);
	const r = seedProgress(root, db);
	db.close();
	console.log(
		`seed: ${r.tasks} new merged tasks and ${r.events} events from ${r.seen} ledger milestones (${r.seen - r.tasks} already stored).`,
	);
	return 0;
}

export function goalsSync(root: string): number {
	const db = openWorkDb(root);
	const r = syncGoals(root, db);
	db.close();
	console.log(`goals: project and ${r.missions.length} missions (${r.missions.join(", ")}).`);
	return 0;
}

export function goalsList(root: string): number {
	if (!existsSync(workDbPath(root))) {
		console.log("goals: no work store yet. Run evf goals sync.");
		return 0;
	}
	const db = openWorkDb(root, { readOnly: true });
	const rows = db
		.prepare("SELECT key, kind, title, status, json_array_length(packages) AS packages FROM goals ORDER BY id")
		.all() as Row[];
	db.close();
	if (!rows.length) {
		console.log("goals: none. Run evf goals sync.");
		return 0;
	}
	for (const g of rows)
		console.log(
			`${String(g.key).padEnd(8)} ${String(g.kind).padEnd(8)} ${g.status}  ${g.title}${g.kind === "mission" ? ` (${g.packages} packages)` : ""}`,
		);
	return 0;
}

const column = (value: unknown, width: number) =>
	String(value ?? "-")
		.padEnd(width)
		.slice(0, width);

/** The override of a task row as one cell: "default" without one, a missing field as "default". */
export const seatText = (t: { seat_model?: unknown; seat_effort?: unknown }): string =>
	t.seat_model || t.seat_effort ? `${t.seat_model ?? "default"} ${t.seat_effort ?? "default"}` : "default";

export type OrphanRun = {
	ref: string;
	run_id: number;
	stage: string;
	age_minutes: number;
	task_status: string;
	pr_number: number | null;
	repair: string;
};

/**
 * Started runs of role `evf` that no live drive owns: the drive's pid file is missing or its pid is dead (a SIGKILL
 * no handler can catch). Each carries one repair that never ships: a ship stage waits for Sebastian's approval or a
 * reopen; any other stage restarts through the drive's restart recovery, which only aborts the orphan.
 */
export function orphanRuns(db: DatabaseSync, root: string): OrphanRun[] {
	const rows = db
		.prepare(
			"SELECT r.id, r.stage, r.started_at, t.ref, t.slug, t.status, t.pr_number FROM runs r JOIN tasks t ON t.id = r.task_id WHERE r.role = 'evf' AND r.status = 'started' ORDER BY r.id",
		)
		.all() as Array<{
		id: number;
		stage: string;
		started_at: string;
		ref: string | null;
		slug: string;
		status: string;
		pr_number: number | null;
	}>;
	const live = (slug: string) => {
		const file = join(evfDataDir(root), "drive", `${slug}.pid`);
		const pid = existsSync(file) ? Number(readFileSync(file, "utf8").trim()) : 0;
		if (!pid) return false;
		try {
			process.kill(pid, 0);
			return true;
		} catch {
			return false;
		}
	};
	return rows
		.filter((r) => !live(r.slug))
		.map((r) => {
			const ref = r.ref ?? r.slug;
			const repair =
				r.status === "merged"
					? `bin/evf drive ${ref} --once (the late-merge path records the merge and closes the run)`
					: r.stage === "ship"
						? `${r.pr_number ? `bin/evf approve ${r.pr_number} --owner-approval "<his words>" once Sebastian approved, or ` : ""}bin/evf task reopen ${ref} --reason "<words>"`
						: `bin/evf drive ${ref} --once (restart recovery aborts the run; it ships nothing)`;
			return {
				ref,
				run_id: r.id,
				stage: r.stage,
				age_minutes: Math.max(0, Math.round((Date.now() - Date.parse(r.started_at)) / 60_000)),
				task_status: r.status,
				pr_number: r.pr_number,
				repair,
			};
		});
}

export const orphanLine = (o: OrphanRun): string =>
	`orphan evf run ${o.run_id}: ${o.ref} ${o.stage} started ${o.age_minutes} min ago, no live drive. Repair: ${o.repair}`;

/** Tasks, seats, recent events and health, from the views only. `task` narrows to one ref and its parts. */
export function status(root: string, opts: { json: boolean; task?: string }): number {
	const path = workDbPath(root);
	if (!existsSync(path)) {
		const empty = {
			path,
			schema_version: 0,
			health: {
				open_tasks: 0,
				escalated_tasks: 0,
				active_seats: 0,
				merged_24h: 0,
				merged_7d: 0,
				rounds_per_merge_7d: null,
			},
			tasks: [],
			seats: [],
			recent: [],
			orphanRuns: [],
		};
		console.log(opts.json ? JSON.stringify(empty, null, 2) : `work store: none at ${path}. Run evf db migrate.`);
		return 0;
	}
	const db = openWorkDb(root, { readOnly: true });
	const health = db.prepare("SELECT * FROM v_health").get() as Row;
	const tasks = (
		opts.task
			? db
					.prepare("SELECT * FROM v_tasks WHERE ref = ? OR ref LIKE ? OR slug = ? ORDER BY updated_at DESC, id DESC")
					.all(opts.task, `${opts.task}/%`, opts.task)
			: db.prepare("SELECT * FROM v_tasks ORDER BY updated_at DESC, id DESC").all()
	) as Row[];
	// A task with follow-ups carries their labels, and the owner-facing Partial: line, in every listing (OPS-86).
	for (const t of tasks) {
		const labels = followUpsOf(db, t.id as number);
		if (labels.length) {
			t.followUps = labels.map((f) => f.label);
			t.partial = partialLine(labels);
		}
	}
	const seats = db.prepare("SELECT * FROM v_seats ORDER BY started_at, run_id").all() as Row[];
	const ids = tasks.map((t) => t.id as number);
	const inIds = ids.length ? `(${ids.join(",")})` : "(NULL)";
	const recent = (
		opts.task
			? db.prepare(`SELECT * FROM v_recent WHERE task_id IN ${inIds} LIMIT 50`).all()
			: db.prepare("SELECT * FROM v_recent LIMIT 50").all()
	) as Row[];
	const detail = opts.task
		? {
				runs: db.prepare(`SELECT * FROM runs WHERE task_id IN ${inIds} ORDER BY started_at, id`).all() as Row[],
				proofs: db.prepare(`SELECT * FROM proofs WHERE task_id IN ${inIds} ORDER BY id`).all() as Row[],
			}
		: {};
	const orphans = orphanRuns(db, root).filter((o) => !opts.task || tasks.some((t) => (t.ref ?? t.slug) === o.ref));
	const report = {
		path: workDbPath(root),
		schema_version: schemaVersion(db),
		health,
		tasks,
		seats,
		recent,
		orphanRuns: orphans,
		...detail,
	};
	db.close();
	if (opts.json) {
		console.log(JSON.stringify(report, null, 2));
		return 0;
	}
	console.log(`work store: ${report.path} (schema ${report.schema_version})`);
	console.log(
		`tasks: ${tasks.length} listed · open ${health.open_tasks} · escalated ${health.escalated_tasks} · merged 24 h ${health.merged_24h}, 7 d ${health.merged_7d} · seats active ${health.active_seats}`,
	);
	if (tasks.length) {
		console.log(
			`${column("REF", 16)} ${column("MODE", 13)} ${column("STATUS", 10)} ${column("STAGE", 10)} ${column("ROUND", 5)} ${column("PR", 6)} ${column("GOAL", 5)} ${column("SEATS", 26)} UPDATED`,
		);
		for (const t of tasks)
			console.log(
				`${column(t.ref ?? t.slug, 16)} ${column(t.mode, 13)} ${column(t.status, 10)} ${column(t.stage, 10)} ${column(t.round, 5)} ${column(t.pr_number ? `#${t.pr_number}` : "-", 6)} ${column(t.goal_key, 5)} ${column(seatText(t), 26)} ${String(t.updated_at ?? "").slice(0, 16)}`,
			);
	}
	for (const t of tasks) if (t.partial) console.log(`${t.ref ?? t.slug}: ${t.partial}`);
	for (const o of orphans) console.log(orphanLine(o));
	if (seats.length) {
		console.log("seats:");
		for (const s of seats)
			console.log(
				`  ${column(s.seat, 28)} ${column(s.stage, 10)} ${column(s.model, 18)} ${column(s.effort, 6)} ${column(s.status, 8)} ${s.last_event ?? "-"}`,
			);
	}
	if (recent.length) {
		console.log("recent:");
		for (const e of recent.slice(0, 20))
			console.log(
				`  ${String(e.ts).slice(0, 19)} ${column(e.seat ?? e.ref ?? "-", 24)} ${column(e.type, 18)} ${e.summary ?? ""}`,
			);
	}
	return 0;
}
