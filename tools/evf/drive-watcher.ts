import { join } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { findTask, openWorkDb } from "./db.ts";
import { driveHolder } from "./drive-signal.ts";
import { notify, parseTask, run } from "./lib.ts";

/**
 * The dead drive watcher (OPS-137). It restores a drive that was already running and schedules no new work (D86 in
 * docs/architecture/decisions.md). The events table holds all its state, so a new sampler process carries on from it.
 */

const DEAD_AFTER_MS = 5 * 60_000;
const COMMAND_TIMEOUT_MS = 30_000;

export type WatcherProbes = {
	now: () => number;
	/** Whether the task's pid file names a live `evf drive` process. A pid it cannot read counts as live. */
	liveDrive: (slug: string) => boolean;
	/** Runs `evf drive <ref> --detach`. A string is the refusal text; null means that the drive started. */
	startDrive: (ref: string) => string | null;
	notify: (title: string, body: string) => void;
};

/** The real machine. The sampler loads evf once, so only a new process can make the stale-code check on current code. */
export function machineWatcher(root: string): WatcherProbes {
	return {
		now: Date.now,
		liveDrive: (slug) => driveHolder(root, slug).kind !== "none",
		startDrive: (ref) => {
			// The sampler inherits the environment of the drive that started it, which may carry a seat's identity.
			const { EVF_RUN, EVF_WORKTREE, EVF_SESSION, EVF_ROLE, EVF_STAGE, ...env } = process.env;
			const started = run(
				process.execPath,
				["--disable-warning=ExperimentalWarning", join(root, "tools/evf/main.ts"), "drive", ref, "--detach"],
				{ cwd: root, env, timeoutMs: COMMAND_TIMEOUT_MS },
			);
			return started.code === 0 ? null : started.stderr.trim() || `evf drive --detach exited ${started.code}`;
		},
		notify,
	};
}

type Latest = { id: number; ts: string; payload: string };
type Watched = { id: number; ref: string; slug: string };

/** One task's decision. Each early return is a case in which the watcher must leave the task alone. */
function watchTask(db: DatabaseSync, t: Watched, probes: WatcherProbes) {
	const latest = (type: string) =>
		db
			.prepare("SELECT id, ts, payload FROM events WHERE task_id = ? AND type = ? ORDER BY id DESC LIMIT 1")
			.get(t.id, type) as Latest | undefined;
	const later = (e: Latest | undefined, than: Latest) => e !== undefined && e.id > than.id;

	// No heartbeat: this task never had a drive that the watcher knows, or its drive still runs old code.
	const beat = latest("drive_heartbeat");
	if (!beat) return;
	if (later(latest("drive_ended"), beat)) return;
	// A heartbeat from the drive that the request named can land just after the request, and it clears nothing.
	const request = latest("drive_stop_requested");
	if (request) {
		const target = (JSON.parse(request.payload) as { pid: number | null }).pid;
		if (later(request, beat) || target === (JSON.parse(beat.payload) as { pid: number }).pid) return;
	}
	const stopped = latest("drive_stopped");
	if (stopped && later(stopped, beat) && (JSON.parse(stopped.payload) as { signal?: string }).signal === "SIGINT")
		return;
	const alert = latest("drive_death_alert");
	if (later(alert, beat)) return;

	// The allowance is one restart since the last alert, however long that restarted drive lived.
	const restart = latest("drive_restart");
	const used = restart !== undefined && (!alert || restart.id > alert.id) ? restart : undefined;
	const now = probes.now();
	if (now - Math.max(Date.parse(beat.ts), used ? Date.parse(used.ts) : 0) < DEAD_AFTER_MS) return;
	// A silent drive can still be alive, for example after the Mac wakes from sleep.
	if (probes.liveDrive(t.slug)) return;

	const at = new Date(now).toISOString();
	const write = (type: string, payload: Record<string, unknown>) =>
		Number(
			db
				.prepare("INSERT INTO events (task_id, run_id, ts, type, payload) VALUES (?, NULL, ?, ?, ?)")
				.run(t.id, at, type, JSON.stringify(payload)).lastInsertRowid,
		);
	const command = `bin/evf drive ${t.ref} --detach`;
	if (used) {
		const body = `The drive of ${t.ref} died again after its restart. Last heartbeat: ${beat.ts}. Start it with: ${command}`;
		write("drive_death_alert", { lastHeartbeat: beat.ts, summary: body });
		probes.notify(`${t.ref} drive died twice`, body);
		return;
	}
	// The write goes before the spawn, so a crash in this tick can never cause two restarts.
	const restartId = write("drive_restart", {
		lastHeartbeat: beat.ts,
		summary: `${t.ref} had no drive heartbeat since ${beat.ts}: one restart with ${command}`,
	});
	const refusal = probes.startDrive(t.ref);
	if (refusal === null) return;
	// A refused start uses no restart and keeps no restart record. It tries again each minute, with one record and one
	// notification since the last heartbeat, so a long stale period does not fill the recent feed.
	db.prepare("DELETE FROM events WHERE id = ?").run(restartId);
	if (later(latest("drive_restart_refused"), beat)) return;
	const body = `The restart of the ${t.ref} drive was refused: ${refusal}`;
	write("drive_restart_refused", { lastHeartbeat: beat.ts, refusal, summary: body });
	probes.notify(`${t.ref} drive restart refused`, body);
}

/** One minute's look at every active task. A failure on one task leaves the other tasks to go ahead. */
export function watcherTick(root: string, probes: WatcherProbes): void {
	const db = openWorkDb(root);
	try {
		const tasks = db
			.prepare("SELECT id, ref, slug FROM tasks WHERE status IN ('active', 'pr_open') AND ref IS NOT NULL")
			.all() as Watched[];
		for (const t of tasks) {
			try {
				// A restart pins the row that `evf drive` finds, so only that row can come back to life.
				if (findTask(db, parseTask(t.ref))?.id === t.id) watchTask(db, t, probes);
			} catch (e) {
				console.error(`evf watcher ${t.ref}: ${String(e)}`);
			}
		}
	} finally {
		db.close();
	}
}
