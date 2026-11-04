import { mkdirSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { evfDataDir, sleep, WaitGaveUp } from "./lib.ts";
import { alive, readHolder, type QueueTiming } from "./ship-queue.ts";

/** Code defaults (OPS-138): an OPS branch cannot add a key to evf.config.json, and no flag changes them. */
export const CHECK_CAP = 3;
export type CheckQueueTiming = QueueTiming & { now: () => number; sleep: (ms: number) => void };
export const CHECK_QUEUE: CheckQueueTiming = { waitMs: 120 * 60_000, pollMs: 1000, now: Date.now, sleep };

const tickets = (dir: string) => readdirSync(dir).sort();

/**
 * A ticket's number is never reused and sorts after each ticket that existed when it was taken, so tickets ahead of a
 * process only ever disappear. A later clock reading can reach the folder first; the slower process then takes a new
 * number, and until it does its ticket only makes others wait longer.
 */
function takeTicket(dir: string, task: string): string {
	for (;;) {
		const name = `${String(Math.max(Date.now(), Number.parseInt(tickets(dir).at(-1) ?? "0") + 1)).padStart(15, "0")}.json`;
		try {
			writeFileSync(join(dir, name), JSON.stringify({ pid: process.pid, task, at: new Date().toISOString() }), {
				flag: "wx",
			});
		} catch (e) {
			if ((e as NodeJS.ErrnoException).code === "EEXIST") continue;
			throw e;
		}
		if (tickets(dir).at(-1) === name) return name;
		rmSync(join(dir, name), { force: true });
	}
}

/** The tickets in arrival order. A stopped process's ticket goes; a ticket still being written keeps its place. */
function liveTickets(dir: string): string[] {
	return tickets(dir).filter((name) => {
		const holder = readHolder(join(dir, name));
		if (holder === "stale" || (typeof holder === "object" && !alive(holder.pid))) {
			rmSync(join(dir, name), { force: true });
			return false;
		}
		return true;
	});
}

/**
 * One machine-wide, first-come queue for full checks in the home checkout's Git folder. The first CHECK_CAP live
 * tickets run and the others wait, so a running check keeps its ticket and needs no second lock file. A process that
 * stops loses its ticket; a ticket goes on return, throw or exit.
 */
export function withCheckQueue<T>(root: string, task: string, fn: () => T, timing: CheckQueueTiming): T {
	const dir = join(evfDataDir(root), "check-queue");
	mkdirSync(dir, { recursive: true });
	const ticket = takeTicket(dir, task);
	const release = () => rmSync(join(dir, ticket), { force: true });
	process.on("exit", release);
	try {
		const start = timing.now();
		for (let printed = 0; ;) {
			const index = liveTickets(dir).indexOf(ticket);
			if (index < CHECK_CAP) break;
			const waited = timing.now() - start;
			if (waited >= timing.waitMs)
				throw new WaitGaveUp(
					`${task} waited in the full check queue for ${Math.round(waited / 60_000)} min and no check ran: ${CHECK_CAP} full checks stayed ahead of it. Run it again later.`,
				);
			if (waited >= printed * 60_000) {
				console.error(
					`evf verify: ${task} waits in the full check queue, position ${index - CHECK_CAP + 1}, ${CHECK_CAP} running, ${Math.floor(waited / 60_000)} min.`,
				);
				printed = Math.floor(waited / 60_000) + 1;
			}
			timing.sleep(Math.min(timing.pollMs, timing.waitMs - waited));
		}
		return fn();
	} finally {
		release();
		process.off("exit", release);
	}
}
