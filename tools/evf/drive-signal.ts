import { existsSync, readFileSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { Worker } from "node:worker_threads";
import { findTask, openWorkDb, record } from "./db.ts";
import { EvfError, evfDataDir, type TaskRef } from "./lib.ts";

const now = () => new Date().toISOString();

const SIGNALS = ["SIGTERM", "SIGINT"] as const;

/**
 * A drive stopped by a signal while an evf stage runs leaves that stage's run `started` for good. Close it as
 * aborted, record one drive_stopped event with the stage and the signal, and drop this process's pid file.
 * A drive between stages or inside a seat wait has no open evf run: only the pid file goes.
 */
function recordDriveStopped(root: string, task: TaskRef, signal: string): void {
	const db = openWorkDb(root);
	try {
		const row = findTask(db, task);
		const open = row
			? (db
					.prepare("SELECT id, stage FROM runs WHERE task_id = ? AND role = 'evf' AND status = 'started'")
					.all(row.id) as Array<{ id: number; stage: string }>)
			: [];
		for (const r of open) {
			const summary = `drive stopped by ${signal} during ${r.stage}`;
			db.prepare("UPDATE runs SET status = 'aborted', ended_at = ?, summary = ? WHERE id = ?").run(
				now(),
				summary,
				r.id,
			);
			record(db, row!.id, r.id, "drive_stopped", { stage: r.stage, signal, summary });
		}
	} finally {
		db.close();
	}
	const pidFile = join(evfDataDir(root), "drive", `${task.slug}.pid`);
	if (existsSync(pidFile) && Number(readFileSync(pidFile, "utf8").trim()) === process.pid) unlinkSync(pidFile);
}

/**
 * Run the drive loop in a worker thread. The loop blocks its thread in spawnSync and Atomics.wait, so a signal
 * handler on that thread would wait until the stage returns. The main thread stays free: on SIGTERM or SIGINT it
 * records the stop and ends by the signal (shell status 128 + the signal number).
 */
export function driveWithSignals(root: string, task: TaskRef, once: boolean): Promise<number> {
	return new Promise((resolve, reject) => {
		const handlers = SIGNALS.map((signal) => {
			const handler = () => {
				try {
					recordDriveStopped(root, task, signal);
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
		const done = () => handlers.forEach(([signal, handler]) => process.off(signal, handler));
		const worker = new Worker(new URL("./drive-worker.ts", import.meta.url), {
			workerData: { root, task: task.id, once },
		});
		worker.once("message", (m: { code?: number; refusal?: string }) => {
			done();
			if (m.refusal !== undefined) reject(new EvfError(m.refusal));
			else resolve(m.code ?? 0);
		});
		worker.once("error", (e) => {
			done();
			reject(e);
		});
	});
}
