import { mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { evfDataDir, fail, sleep } from "./lib.ts";

export type QueueTiming = { waitMs: number; pollMs: number };
type Holder = { pid: number; task: string; at: string };

function alive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch (e) {
		return (e as NodeJS.ErrnoException).code === "EPERM";
	}
}

/** A holder file that never got its content is stale once its writer had ample time to finish. */
function readHolder(path: string): Holder | "missing" | "stale" {
	try {
		return JSON.parse(readFileSync(path, "utf8")) as Holder;
	} catch (e) {
		if ((e as NodeJS.ErrnoException).code === "ENOENT") return "missing";
		try {
			return Date.now() - statSync(path).mtimeMs > 10_000 ? "stale" : "missing";
		} catch {
			return "missing";
		}
	}
}

/**
 * One machine-wide ship queue in the home checkout's Git folder. Waiters take numbered tickets and the oldest
 * live ticket creates the lock file exclusively, so ships run one at a time in arrival order. A holder or waiter
 * whose process is gone (crash, kill) loses its place; the lock is released on return, refusal or exit.
 */
export function withShipQueue<T>(root: string, task: string, fn: () => T, timing: QueueTiming): T {
	const dir = join(evfDataDir(root), "ship-queue"),
		tickets = join(dir, "tickets"),
		lock = join(dir, "lock.json");
	mkdirSync(tickets, { recursive: true });
	const me: Holder = { pid: process.pid, task, at: new Date().toISOString() };
	const ticket = join(tickets, `${String(Date.now()).padStart(15, "0")}-${process.pid}.json`);
	writeFileSync(ticket, JSON.stringify(me));
	let held = false;
	const release = () => {
		rmSync(ticket, { force: true });
		const holder = held ? readHolder(lock) : "missing";
		if (typeof holder === "object" && holder.pid === process.pid) rmSync(lock, { force: true });
		held = false;
	};
	process.on("exit", release);
	try {
		const start = Date.now();
		for (let printed = 0; ;) {
			const live = readdirSync(tickets)
				.sort()
				.filter((name) => {
					const holder = readHolder(join(tickets, name));
					if (holder === "stale" || (typeof holder === "object" && !alive(holder.pid))) {
						rmSync(join(tickets, name), { force: true });
						return false;
					}
					return holder !== "missing";
				});
			let ahead: Holder | "stale" | "missing" = "missing";
			if (live[0] === ticket.slice(tickets.length + 1)) {
				try {
					writeFileSync(lock, JSON.stringify(me), { flag: "wx" });
					held = true;
					rmSync(ticket, { force: true });
					break;
				} catch (e) {
					if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
				}
				ahead = readHolder(lock);
				if (ahead === "stale" || (typeof ahead === "object" && !alive(ahead.pid))) {
					console.error(
						`ship: removed the queue lock of a stopped ship${typeof ahead === "object" ? ` (${ahead.task}, pid ${ahead.pid})` : ""}.`,
					);
					rmSync(lock, { force: true });
					continue;
				}
			} else if (live.length) ahead = readHolder(join(tickets, live[0]));
			const waited = Date.now() - start;
			if (waited >= timing.waitMs)
				fail(
					`The ship queue is still busy after ${Math.round(waited / 60_000)} min. Nothing of ${task} changed; run evf ship ${task} again later.`,
				);
			if (waited >= printed * 60_000) {
				const name = typeof ahead === "object" ? `${ahead.task} (pid ${ahead.pid})` : "another ship";
				console.error(
					`ship: ${task} waits in the ship queue behind ${name}, position ${live.indexOf(ticket.slice(tickets.length + 1)) + 1}, ${Math.floor(waited / 60_000)} min.`,
				);
				printed = Math.floor(waited / 60_000) + 1;
			}
			sleep(Math.min(timing.pollMs, timing.waitMs - waited));
		}
		return fn();
	} finally {
		release();
		process.off("exit", release);
	}
}
