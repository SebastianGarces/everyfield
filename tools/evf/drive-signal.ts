import { existsSync, readFileSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { Worker } from "node:worker_threads";
import { findTask, openWorkDb, record, taskById } from "./db.ts";
import { EvfError, evfDataDir, fail, processCommand, type TaskRef } from "./lib.ts";
import { HEADLESS_ROLES_SQL } from "./seats.ts";
import { alive } from "./ship-queue.ts";

const SIGNALS = ["SIGTERM", "SIGINT"] as const;
const HEARTBEAT_MS = 60_000;
const PARENT_READ_MS = 2000;
const PARENT_COMMAND_CHARS = 200;
const MERGE_WINDOW_MS = 60_000;
const PS_TIMEOUT_MS = 10_000;

const drivePidFile = (root: string, slug: string) => join(evfDataDir(root), "drive", `${slug}.pid`);

/**
 * Who holds the task's pid file. A pid gets reused, so a live pid must also run the drive command. `unread` is a live pid
 * whose command `ps` cannot read, and each caller takes the safe way: a start and the watcher treat it as a drive, and
 * `--stop` sends it no signal.
 */
export type DriveHolder = { kind: "none" } | { kind: "drive"; pid: number } | { kind: "unread"; pid: number };

export function driveHolder(root: string, slug: string): DriveHolder {
	const pidFile = drivePidFile(root, slug);
	const pid = existsSync(pidFile) ? Number(readFileSync(pidFile, "utf8").trim()) : 0;
	if (!pid || !alive(pid)) return { kind: "none" };
	const command = processCommand(pid, PS_TIMEOUT_MS);
	if (command === null) return alive(pid) ? { kind: "unread", pid } : { kind: "none" };
	return /main\.ts drive\b/.test(command) ? { kind: "drive", pid } : { kind: "none" };
}

/** The parent's command line, or null when the read fails. It describes the parent. It does not name a signal's sender. */
export function readParentCommand(ppid: number): string | null {
	return processCommand(ppid, PARENT_READ_MS)?.slice(0, PARENT_COMMAND_CHARS) ?? null;
}

export type StopProbes = { now: () => number; parentCommand: (ppid: number) => string | null };

/**
 * One drive_stopped event for one stop, in any place the drive can be. An open evf run also closes as aborted, because
 * a stopped drive leaves it `started` for good. A seat's run stays open: the seat goes on working, so the event's
 * run_id stays null and the seat's own last event does not change. The pid file goes even when the store write fails.
 */
export function recordDriveStopped(
	root: string,
	task: TaskRef,
	signal: string,
	pin?: number,
	probes: StopProbes = { now: Date.now, parentCommand: readParentCommand },
): void {
	try {
		const parentCommand = probes.parentCommand(process.ppid);
		const db = openWorkDb(root);
		try {
			const row = pin === undefined ? findTask(db, task) : taskById(db, pin);
			if (!row) return;
			type Open = { id: number; stage: string };
			const evfRuns = db
				.prepare(
					"SELECT id, stage FROM runs WHERE task_id = ? AND role = 'evf' AND status = 'started' ORDER BY id DESC",
				)
				.all(row.id) as Open[];
			const seatRun = db
				.prepare(
					`SELECT id, stage FROM runs WHERE task_id = ? AND status = 'started' AND role <> 'evf' AND role NOT IN ${HEADLESS_ROLES_SQL} ORDER BY id DESC LIMIT 1`,
				)
				.get(row.id) as Open | undefined;
			const open = evfRuns[0] ?? seatRun ?? null;
			const { lastMergeAt } = db.prepare("SELECT MAX(ts) AS lastMergeAt FROM events WHERE type = 'merged'").get() as {
				lastMergeAt: string | null;
			};
			const nowMs = probes.now();
			const mergeWithin60s = lastMergeAt !== null && nowMs - Date.parse(lastMergeAt) <= MERGE_WINDOW_MS;
			const at = new Date(nowMs).toISOString();
			for (const r of evfRuns)
				db.prepare("UPDATE runs SET status = 'aborted', ended_at = ?, summary = ? WHERE id = ?").run(
					at,
					`drive stopped by ${signal} during ${r.stage}`,
					r.id,
				);
			const where = open ? `during ${open.stage}` : "between stages";
			record(db, row.id, evfRuns[0]?.id ?? null, "drive_stopped", {
				pid: process.pid,
				ppid: process.ppid,
				parentCommand,
				stage: open?.stage ?? null,
				run: open?.id ?? null,
				lastMergeAt,
				mergeWithin60s,
				signal,
				summary: `drive stopped by ${signal} ${where}${mergeWithin60s ? `; a merge came within 60 s before the stop (${lastMergeAt}), so consider an OPS task` : ""}`,
			});
		} finally {
			db.close();
		}
	} finally {
		const pidFile = drivePidFile(root, task.slug);
		if (existsSync(pidFile) && Number(readFileSync(pidFile, "utf8").trim()) === process.pid) unlinkSync(pidFile);
	}
}

/** A drive's own record on its pinned row. A failed write costs that record, never the drive. */
function recordSafely(root: string, pin: number, type: string, payload: Record<string, unknown>): void {
	try {
		const db = openWorkDb(root);
		try {
			record(db, pin, null, type, payload);
		} finally {
			db.close();
		}
	} catch (e) {
		console.error(`evf drive: ${type} did not record: ${String(e)}`);
	}
}

/** One heartbeat now and one per minute. Returns the function that ends them. */
export function startHeartbeat(root: string, pin: number): () => void {
	const beat = () => recordSafely(root, pin, "drive_heartbeat", { pid: process.pid });
	beat();
	const timer = setInterval(beat, HEARTBEAT_MS);
	timer.unref();
	return () => clearInterval(timer);
}

/**
 * `evf drive <task> --stop`. The request goes in first, so that the watcher never restarts this drive. It also goes in
 * when no drive runs, because a drive that died just before the stop must stay down too. A pid it cannot read gets no
 * signal and no request, because that request would hide a drive that may still run from the watcher.
 */
export function stopDrive(root: string, task: TaskRef): number {
	const holder = driveHolder(root, task.slug);
	if (holder.kind === "unread")
		fail(
			`evf drive --stop could not read the command of pid ${holder.pid}, so it sent no signal and recorded no stop. Run it again.`,
		);
	const pid = holder.kind === "drive" ? holder.pid : null;
	const db = openWorkDb(root);
	try {
		const row = findTask(db, task);
		if (row)
			record(db, row.id, null, "drive_stop_requested", {
				pid,
				summary:
					pid === null
						? `stop requested for ${task.id}; no drive runs`
						: `stop requested for the drive of ${task.id} (pid ${pid})`,
			});
	} finally {
		db.close();
	}
	if (pid === null) {
		console.log(`No drive runs for ${task.id}.`);
		return 0;
	}
	try {
		process.kill(pid, "SIGTERM");
	} catch (e) {
		if ((e as NodeJS.ErrnoException).code !== "ESRCH") throw e;
		console.log(`No drive runs for ${task.id}: pid ${pid} ended before the signal.`);
		return 0;
	}
	console.log(`Sent SIGTERM to the drive of ${task.id} (pid ${pid}).`);
	return 0;
}

/**
 * Run the drive loop in a worker thread. The loop blocks its thread in spawnSync and Atomics.wait, so a timer or a
 * signal handler on that thread would wait until the stage returns. The main thread stays free: it records the
 * heartbeats from the moment the worker holds the task, and on SIGTERM or SIGINT it records the stop and ends by the
 * signal (shell status 128 + the signal number).
 */
export function driveWithSignals(root: string, task: TaskRef, once: boolean): Promise<number> {
	return new Promise((resolve, reject) => {
		let pin: number | undefined;
		let stopHeartbeat = () => {};
		const handlers = SIGNALS.map((signal) => {
			const handler = () => {
				stopHeartbeat();
				try {
					recordDriveStopped(root, task, signal, pin);
				} finally {
					// process.exit would wait for the worker, which sits in a blocking child. With the handlers gone the
					// signal's default action ends the process at once; a shell reads that as 128 + the signal number.
					for (const [name, h] of handlers) process.off(name, h);
					process.kill(process.pid, signal);
				}
			};
			process.on(signal, handler);
			return [signal, handler] as const;
		});
		const done = () => {
			stopHeartbeat();
			handlers.forEach(([signal, handler]) => process.off(signal, handler));
		};
		const worker = new Worker(new URL("./drive-worker.ts", import.meta.url), {
			workerData: { root, task: task.id, once },
		});
		worker.on(
			"message",
			(m: { pin?: number; code?: number; refusal?: string; end?: { stage: string; reason: string } }) => {
				if (m.pin !== undefined) {
					pin = m.pin;
					stopHeartbeat = startHeartbeat(root, pin);
					return;
				}
				done();
				if (m.refusal !== undefined) return reject(new EvfError(m.refusal));
				const code = m.code ?? 0;
				// done() ended the heartbeats, so no heartbeat can follow a drive_ended.
				if (m.end && pin !== undefined)
					recordSafely(root, pin, "drive_ended", {
						stage: m.end.stage,
						code,
						summary: `drive ended at ${m.end.stage}, exit ${code}: ${m.end.reason}`,
					});
				resolve(code);
			},
		);
		worker.once("error", (e) => {
			done();
			reject(e);
		});
	});
}
