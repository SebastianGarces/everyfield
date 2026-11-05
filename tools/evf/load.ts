import { appendFileSync, existsSync, mkdirSync, readdirSync, realpathSync, rmSync, writeFileSync, writeSync } from "node:fs";
import { availableParallelism, loadavg } from "node:os";
import { join } from "node:path";
import { isMainThread } from "node:worker_threads";
import { findTask, openWorkDb, record, workDbPath } from "./db.ts";
import { evfDataDir, fail, loadConfig, sleep, WaitGaveUp, type TaskRef } from "./lib.ts";
import { alive } from "./ship-queue.ts";

export type LoadLimit = {
	cores: number;
	maxPerCore: number;
	limit: number;
	maxWaitMinutes: number;
	memoryFloorPct?: number;
	swapCeilingGb?: number;
};
/** The two OPS-133 readings of `machineProbes`. A probe that throws never blocks a check. */
export type MemoryProbe = { freeMemPct: () => number; swapUsedGb: () => number };
export type LoadProbe = { read: () => number; sleep: (ms: number) => void; now: () => number };
const machine: LoadProbe = { read: () => loadavg()[0], sleep, now: Date.now };

/**
 * C51 and C81: two per core, 30 minutes of waiting. evf.config.json `machineLoad` may override it; an OPS branch
 * cannot add that key, because it may change only its own maintenanceTasks entry (OPS-22).
 *
 * OPS-151: a full check also waits under 15% free memory or over 12 GB of swap used (0.75 × 16 GB; macOS frees swap
 * slowly, so a lower ceiling holds checks after the pressure ended). A `machineLoad` entry replaces this whole default,
 * so an entry that leaves out `memoryFloorPct` and `swapCeilingGb` has no memory or swap wait.
 */
export const DEFAULT_LOAD = { maxPerCore: 2, maxWaitMinutes: 30, memoryFloorPct: 15, swapCeilingGb: 12 };

/** The shared machine's limit from the home checkout's evf.config.json, or the C51/C81 default. */
export function loadLimit(root: string): LoadLimit {
	const setting = loadConfig(root).machineLoad ?? DEFAULT_LOAD;
	if (
		!(Number.isFinite(setting.maxPerCore) && setting.maxPerCore > 0) ||
		!(Number.isFinite(setting.maxWaitMinutes) && setting.maxWaitMinutes >= 0)
	)
		fail("evf.config.json machineLoad needs { maxPerCore: <positive number>, maxWaitMinutes: <minutes, 0 or more> }.");
	if (
		(setting.memoryFloorPct !== undefined && !(setting.memoryFloorPct >= 0 && setting.memoryFloorPct <= 100)) ||
		(setting.swapCeilingGb !== undefined && !(setting.swapCeilingGb >= 0))
	)
		fail("evf.config.json machineLoad memoryFloorPct must be 0 to 100, and swapCeilingGb 0 or more.");
	const cores = availableParallelism();
	return { cores, ...setting, limit: setting.maxPerCore * cores };
}

export function describeLoad(load: number, gate: LoadLimit): string {
	return `load ${load.toFixed(1)}, limit ${gate.limit} (${gate.maxPerCore} × ${gate.cores} cores)`;
}

/**
 * The environment of what a command starts after it passed the gate: nothing inside it waits a second time. It names
 * the home checkout, so a disposable repository of a test keeps its own gate.
 */
export function loadGatePassed(root: string): NodeJS.ProcessEnv {
	return { EVF_LOAD_GATE_ROOT: realpathSync(root) };
}

/** What awaitLoad refuses whatever the load is. A command that waits for anything else first calls it before that wait. */
export function requireLoadInputs(root: string, override: string | undefined): LoadLimit {
	const gate = loadLimit(root);
	if (override !== undefined && !override.trim()) fail("--ignore-load needs a reason.");
	return gate;
}

/** A worker's console.error reaches the log only when the wait ends (the drive's pr stage waits in a worker). */
function say(line: string): void {
	if (isMainThread) return console.error(line);
	try {
		writeSync(2, `${line}\n`);
	} catch {}
}

/**
 * Returns what is short right now, or null. The first failed read prints one line and turns the reading off for this
 * wait, so a broken probe or a platform with no probe never blocks a check.
 */
function memoryReader(command: string, gate: LoadLimit, memory: MemoryProbe | null): () => string | null {
	const { memoryFloorPct: floor, swapCeilingGb: ceiling } = gate;
	let reading = memory !== null && (floor !== undefined || ceiling !== undefined);
	return () => {
		if (!reading) return null;
		try {
			const free = floor === undefined ? null : memory!.freeMemPct(),
				swap = ceiling === undefined ? null : memory!.swapUsedGb();
			if ((free !== null && !Number.isFinite(free)) || (swap !== null && !Number.isFinite(swap)))
				throw new Error("the probe gave no number");
			const short = [
				free !== null && free < floor! ? `free memory ${free}%, floor ${floor}%` : null,
				swap !== null && swap > ceiling! ? `swap used ${swap.toFixed(1)} GB, ceiling ${ceiling} GB` : null,
			].filter((part) => part !== null);
			return short.length ? short.join("; ") : null;
		} catch (e) {
			reading = false;
			say(`evf ${command}: memory and swap not read, so no wait for them: ${(e as Error).message}`);
			return null;
		}
	};
}

/**
 * Heavy commands wait while the 1-minute load average is above the limit, print one line per minute and give up
 * after maxWaitMinutes. `--ignore-load <reason>` runs at once and appends the override to load-overrides.jsonl.
 * A full check holding its slot also passes `memory`: the same wait then holds for free memory and swap, under the same
 * time limit, also when an outer command already passed the load gate.
 */
export function awaitLoad(
	root: string,
	command: string,
	override: string | undefined,
	probe = machine,
	task: TaskRef | null = null,
	memory: MemoryProbe | null = null,
): void {
	const gate = requireLoadInputs(root, override);
	if (override !== undefined) {
		const load = probe.read();
		mkdirSync(evfDataDir(root), { recursive: true });
		appendFileSync(
			join(evfDataDir(root), "load-overrides.jsonl"),
			JSON.stringify({ at: new Date(probe.now()).toISOString(), command, load, limit: gate.limit, reason: override }) +
				"\n",
		);
		console.error(`evf ${command}: load override logged (${describeLoad(load, gate)}): ${override}`);
		return;
	}
	const loadPassed = process.env.EVF_LOAD_GATE_ROOT === realpathSync(root);
	if (loadPassed && !memory) return;
	const shortOfMemory = memoryReader(command, gate, memory);
	const start = probe.now(),
		maxWaitMs = gate.maxWaitMinutes * 60_000;
	let held = false, // Set once a read passed a limit, so a command that never waited records nothing.
		maxLoad = 0;
	const recordWait = () => recordLoadWait(root, command, task, start, probe.now(), maxLoad);
	for (let printed = 0; ;) {
		const load = loadPassed ? 0 : probe.read(),
			highLoad = load > gate.limit,
			short = shortOfMemory();
		if (!highLoad && short === null) {
			if (held) recordWait();
			return;
		}
		held = true;
		maxLoad = Math.max(maxLoad, load);
		const reading = [highLoad ? describeLoad(load, gate) : null, short].filter((part) => part !== null).join("; ");
		const waited = probe.now() - start;
		if (waited >= maxWaitMs) {
			recordWait();
			throw new WaitGaveUp(
				`The machine stayed ${highLoad ? "above its load limit" : "short of memory or over its swap ceiling"} for ${gate.maxWaitMinutes} min (${reading}). Retry later, or pass --ignore-load "<reason>", which evf logs.`,
			);
		}
		if (waited >= printed * 60_000) {
			say(`evf ${command}: ${reading}; waiting, ${Math.floor(waited / 60_000)} of ${gate.maxWaitMinutes} min.`);
			printed = Math.floor(waited / 60_000) + 1;
		}
		probe.sleep(Math.min(15_000, maxWaitMs - waited));
	}
}

/** One `load_wait` event (OPS-133). The record is history, so no failure here changes what the gate decides. */
function recordLoadWait(
	root: string,
	command: string,
	task: TaskRef | null,
	startMs: number,
	endMs: number,
	maxLoad: number,
): void {
	try {
		if (!existsSync(workDbPath(root))) return;
		const db = openWorkDb(root);
		try {
			record(db, (task && findTask(db, task)?.id) ?? null, null, "load_wait", {
				command,
				task: task?.id ?? null,
				startAt: new Date(startMs).toISOString(),
				endAt: new Date(endMs).toISOString(),
				maxLoad,
			});
		} finally {
			db.close();
		}
	} catch (e) {
		console.error(`evf ${command}: load_wait not recorded: ${String(e)}`);
	}
}

const fullCheckDir = (root: string) => join(evfDataDir(root), "full-checks");

/**
 * Marks a full `evf verify` as live until the returned call. `ps` cannot count these: the drive's pr stage runs verify
 * inside its own process. A mark names its pid, so a killed verify stops counting. The mark never changes the checks.
 */
export function markFullCheck(root: string, mode: string): () => void {
	if (mode !== "full") return () => {};
	const mark = join(fullCheckDir(root), String(process.pid));
	try {
		mkdirSync(fullCheckDir(root), { recursive: true });
		writeFileSync(mark, "");
	} catch (e) {
		console.error(`evf verify: full check not marked: ${String(e)}`);
	}
	return () => rmSync(mark, { force: true });
}

/** The live full checks. A mark whose process is gone is removed. */
export function countFullChecks(root: string): number {
	const dir = fullCheckDir(root);
	if (!existsSync(dir)) return 0;
	return readdirSync(dir).filter((mark) => {
		const live = alive(Number(mark));
		if (!live) rmSync(join(dir, mark), { force: true });
		return live;
	}).length;
}
