import { appendFileSync, existsSync, mkdirSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { availableParallelism, loadavg } from "node:os";
import { join } from "node:path";
import { findTask, openWorkDb, record, workDbPath } from "./db.ts";
import { evfDataDir, fail, loadConfig, sleep, type TaskRef } from "./lib.ts";
import { alive } from "./ship-queue.ts";

export type LoadLimit = { cores: number; maxPerCore: number; limit: number; maxWaitMinutes: number };
export type LoadProbe = { read: () => number; sleep: (ms: number) => void; now: () => number };
const machine: LoadProbe = { read: () => loadavg()[0], sleep, now: Date.now };

/**
 * C51 and C81: two per core, 30 minutes of waiting. evf.config.json `machineLoad` may override it; an OPS branch
 * cannot add that key, because it may change only its own maintenanceTasks entry (OPS-22).
 */
const DEFAULT_LOAD = { maxPerCore: 2, maxWaitMinutes: 30 };

/** The shared machine's limit from the home checkout's evf.config.json, or the C51/C81 default. */
export function loadLimit(root: string): LoadLimit {
	const setting = loadConfig(root).machineLoad ?? DEFAULT_LOAD;
	if (
		!(Number.isFinite(setting.maxPerCore) && setting.maxPerCore > 0) ||
		!(Number.isFinite(setting.maxWaitMinutes) && setting.maxWaitMinutes >= 0)
	)
		fail("evf.config.json machineLoad needs { maxPerCore: <positive number>, maxWaitMinutes: <minutes, 0 or more> }.");
	const cores = availableParallelism();
	return { cores, ...setting, limit: setting.maxPerCore * cores };
}

export function describeLoad(load: number, gate: LoadLimit): string {
	return `load ${load.toFixed(1)}, limit ${gate.limit} (${gate.maxPerCore} × ${gate.cores} cores)`;
}

/**
 * Heavy commands wait while the 1-minute load average is above the limit, print one line per minute and give up
 * after maxWaitMinutes. `--ignore-load <reason>` runs at once and appends the override to load-overrides.jsonl.
 */
export function awaitLoad(
	root: string,
	command: string,
	override: string | undefined,
	probe = machine,
	task: TaskRef | null = null,
): void {
	const gate = loadLimit(root);
	if (override !== undefined) {
		if (!override.trim()) fail("--ignore-load needs a reason.");
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
	const start = probe.now(),
		maxWaitMs = gate.maxWaitMinutes * 60_000;
	let maxLoad = 0; // Above 0 once a read passed the limit, so a command that never waited records nothing.
	const recordWait = () => recordLoadWait(root, command, task, start, probe.now(), maxLoad);
	for (let printed = 0; ;) {
		const load = probe.read();
		if (load <= gate.limit) {
			if (maxLoad > 0) recordWait();
			return;
		}
		maxLoad = Math.max(maxLoad, load);
		const waited = probe.now() - start;
		if (waited >= maxWaitMs) {
			recordWait();
			fail(
				`The machine stayed above its load limit for ${gate.maxWaitMinutes} min (${describeLoad(load, gate)}). Retry later, or pass --ignore-load "<reason>", which evf logs.`,
			);
		}
		if (waited >= printed * 60_000) {
			console.error(
				`evf ${command}: ${describeLoad(load, gate)}; waiting, ${Math.floor(waited / 60_000)} of ${gate.maxWaitMinutes} min.`,
			);
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
 * Marks a full `evf verify` as live while `checks` runs. `ps` cannot count these: the drive's pr stage runs verify
 * inside its own process. A mark names its pid, so a killed verify stops counting. The mark never changes the checks.
 */
export function withFullCheck<T>(root: string, mode: string, checks: () => T): T {
	if (mode !== "full") return checks();
	const mark = join(fullCheckDir(root), String(process.pid));
	try {
		mkdirSync(fullCheckDir(root), { recursive: true });
		writeFileSync(mark, "");
	} catch (e) {
		console.error(`evf verify: full check not marked: ${String(e)}`);
	}
	try {
		return checks();
	} finally {
		rmSync(mark, { force: true });
	}
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
