import { mkdirSync, readdirSync, realpathSync, rmSync, writeFileSync, writeSync } from "node:fs";
import { dirname, join } from "node:path";
import { evfDataDir, sleep, WaitGaveUp } from "./lib.ts";
import { readHolder, stopped, type QueueTiming } from "./ship-queue.ts";

/** Code defaults (OPS-138): an OPS branch cannot add a key to evf.config.json, and no flag changes them. */
export const CHECK_CAP = 3;
const CHECK_QUEUE: QueueTiming = { waitMs: 120 * 60_000, pollMs: 1000 };

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
		if (!stopped(readHolder(join(dir, name)))) return true;
		rmSync(join(dir, name), { force: true });
		return false;
	});
}

const queueDir = (root: string) => join(evfDataDir(root), "check-queue");

/** The tickets that wait behind the running full checks. */
export function checkQueueWaiting(root: string): number {
	mkdirSync(queueDir(root), { recursive: true });
	return Math.max(0, liveTickets(queueDir(root)).length - CHECK_CAP);
}

/**
 * True when this command runs inside a check that holds a slot of this queue. The token is the holder's ticket path, so
 * a dead holder, a finished check or a token from another queue folder gives no bypass and a stale shell skips nothing.
 */
export function holdsCheckSlot(root: string): boolean {
	const token = process.env.EVF_CHECK_SLOT;
	if (!token) return false;
	mkdirSync(queueDir(root), { recursive: true });
	if (dirname(token) !== realpathSync(queueDir(root))) return false;
	const holder = readHolder(token);
	return holder !== "missing" && !stopped(holder);
}

/**
 * One machine-wide, first-come queue for full checks in the home checkout's Git folder. The first CHECK_CAP live
 * tickets run and the others wait, so a running check keeps its ticket and needs no second lock file. A process that
 * stops, however it stops, loses its ticket to the next reader; a ticket goes on return or throw. `fn` receives the
 * environment that tells a nested `evf test` it runs under this slot.
 */
export function withCheckQueue<T>(
	root: string,
	task: string,
	fn: (slot: NodeJS.ProcessEnv) => T,
	timing = CHECK_QUEUE,
): T {
	const dir = queueDir(root);
	mkdirSync(dir, { recursive: true });
	const ticket = takeTicket(dir, task);
	try {
		const start = Date.now();
		for (let printed = 0; ;) {
			const index = liveTickets(dir).indexOf(ticket);
			if (index < CHECK_CAP) break;
			const waited = Date.now() - start;
			if (waited >= timing.waitMs)
				throw new WaitGaveUp(
					`${task} waited in the full check queue for ${Math.round(waited / 60_000)} min and no check ran: ${CHECK_CAP} full checks stayed ahead of it. Run it again later.`,
				);
			if (waited >= printed * 60_000) {
				// Straight to the descriptor: the drive's pr stage waits in a worker thread that never yields, and a worker's
				// console.error reaches the log only when the wait ends. A closed or full stderr costs a line, never the place.
				try {
					writeSync(
						2,
						`evf: ${task} waits in the full check queue, position ${index - CHECK_CAP + 1}, ${CHECK_CAP} running, ${Math.floor(waited / 60_000)} min.\n`,
					);
				} catch {}
				printed = Math.floor(waited / 60_000) + 1;
			}
			sleep(timing.pollMs);
		}
		return fn({ EVF_CHECK_SLOT: join(realpathSync(dir), ticket) });
	} finally {
		rmSync(join(dir, ticket), { force: true });
	}
}
