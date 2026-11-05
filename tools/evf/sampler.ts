import { spawn } from "node:child_process";
import {
	appendFileSync,
	existsSync,
	linkSync,
	mkdirSync,
	readFileSync,
	renameSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { loadavg } from "node:os";
import { basename, join } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { openWorkDb, record, type TaskRow } from "./db.ts";
import { claimPoll, startPoll } from "./check-alarm.ts";
import { nextStageFromStore } from "./drive.ts";
import { evfDataDir, parseTask, run, sleep } from "./lib.ts";
import { countFullChecks } from "./load.ts";
import { HEADLESS_ROLES_SQL } from "./seats.ts";
import { alive } from "./ship-queue.ts";

/**
 * The minute sampler (OPS-133): one detached process that records load, CPU share by class and queue state once per
 * minute, so a bottleneck review reads numbers. It only writes history: nothing reads these records to decide anything.
 * One exception (OPS-139): a tick also starts the check alarm's poll, in its own process, when the last poll is 5 min old.
 * The rules a reader of the records needs are in the "Minute sampler" section of tools/evf/README.md.
 */

/** A slot is one seat up to the top of the seat target of 8 to 12. */
const SLOT_TARGET = 12;
const RETENTION_MS = 30 * 24 * 60 * 60_000;
const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;
/** A tick's five child processes at this timeout and a busy store still end inside one minute, so ticks cannot stack. */
const PROBE_TIMEOUT_MS = 10_000;
const LOAD_FILE = "load.jsonl";
const CPU_FILE = "cpu.jsonl";
/** The states preview-slots.mjs does not count as in use. */
const DEAD_PREVIEW_STATES = new Set(["removed", "failed", "expired"]);

export const CPU_CLASSES = ["next", "node-test", "browser", "tsc", "claude", "macOS", "other"] as const;
type CpuClass = (typeof CPU_CLASSES)[number];
export type ProcessRow = { pcpu: number; command: string };

export type SamplerProbes = {
	now: () => number;
	sleep: (ms: number) => void;
	load: () => [number, number];
	swapUsedGb: () => number;
	freeMemPct: () => number;
	previews: () => number;
	processes: () => ProcessRow[];
	fullChecks: () => number;
	/** Starts the check alarm's poll and returns at once. */
	startCheckPoll: () => void;
};

const round = (n: number, digits: number) => Number(n.toFixed(digits));

const NODE_ARG_RULES: Array<[CpuClass, RegExp]> = [
	["node-test", /^--test(=|-|$)|\.test\.[cm]?[jt]sx?$|\/vitest\//],
	["next", /\/\.next\/|\/next\/dist\/|\/\.bin\/next$/],
	["tsc", /\/typescript\/(bin|lib)\/|\/\.bin\/(tsc|tsgo)$/],
	["claude", /\/claude-code\//],
	["browser", /playwright/i],
];
const BROWSER_PROGRAM = /Chrom(e|ium)|WebKit|Firefox|headless_shell/i;
/** An application path holds spaces, so this rule reads the command from its start. */
const BROWSER_APP = /^\/Applications\/(Google Chrome|Chromium|Safari|Firefox)[^/]*\.app\//;
const MACOS_PROGRAM = /^(\/System\/|\/usr\/libexec\/|\/usr\/sbin\/|\/sbin\/|\/Library\/Apple\/|kernel_task$)/;

/**
 * A process's class. Only the program decides, and for node also its arguments, because a node process's program says
 * nothing about its work. The result is one of the fixed names, so no command text can reach the file.
 */
function classify(command: string): CpuClass {
	const [first = "", ...args] = command.trim().split(/\s+/);
	const program = basename(first);
	if (program === "node") {
		for (const [name, rule] of NODE_ARG_RULES) if (args.some((a) => rule.test(a))) return name;
		return "other";
	}
	if (/^next(-server)?$/.test(program)) return "next";
	if (/^(tsc|tsgo|tsserver)$/.test(program)) return "tsc";
	if (program === "claude" || first.includes("/claude/versions/")) return "claude";
	if (MACOS_PROGRAM.test(first)) return "macOS";
	if (BROWSER_APP.test(command) || BROWSER_PROGRAM.test(first)) return "browser";
	return "other";
}

/** Each class's part of the CPU in use at this tick. The parts sum to 1, or all read 0 on a table with no CPU in use. */
export function cpuShares(rows: ProcessRow[]): Record<CpuClass, number> {
	const sums = Object.fromEntries(CPU_CLASSES.map((c) => [c, 0])) as Record<CpuClass, number>;
	for (const row of rows) sums[classify(row.command)] += row.pcpu;
	const total = rows.reduce((sum, row) => sum + row.pcpu, 0);
	for (const c of CPU_CLASSES) sums[c] = total > 0 ? round(sums[c] / total, 4) : 0;
	return sums;
}

function probeOutput(cmd: string, args: string[], timeoutMs: number): string {
	const r = run(cmd, args, { timeoutMs });
	if (r.code !== 0) throw new Error(`${cmd} exited ${r.code}`);
	return r.stdout;
}

/** The real machine. Each child gets a timeout; a failure throws, and the tick writes null for that field. */
export function machineProbes(root: string, timeoutMs = PROBE_TIMEOUT_MS): SamplerProbes {
	return {
		now: Date.now,
		sleep,
		load: () => {
			const [load1, load5] = loadavg();
			return [load1!, load5!];
		},
		swapUsedGb: () => {
			const used = /used = ([\d.]+)([MG])/.exec(probeOutput("sysctl", ["-n", "vm.swapusage"], timeoutMs));
			if (!used) throw new Error("sysctl vm.swapusage has no used figure");
			return Number(used[1]) / (used[2] === "M" ? 1024 : 1);
		},
		// The figure `memory_pressure` prints as "free percentage"; os.freemem leaves out memory macOS can reclaim.
		freeMemPct: () => Number(probeOutput("sysctl", ["-n", "kern.memorystatus_level"], timeoutMs)),
		previews: () => {
			const records = JSON.parse(probeOutput("portless", ["preview", "status", "--json"], timeoutMs)) as Array<{
				state: string;
			}>;
			return records.filter((p) => !DEAD_PREVIEW_STATES.has(p.state)).length;
		},
		processes: () =>
			probeOutput("ps", ["-Awwo", "pcpu=,command="], timeoutMs)
				.split("\n")
				.flatMap((line) => {
					const m = /^\s*([\d.,]+)\s+(.*)$/.exec(line);
					return m ? [{ pcpu: Number(m[1]!.replace(",", ".")) || 0, command: m[2]! }] : [];
				}),
		fullChecks: () => countFullChecks(root),
		startCheckPoll: () => startPoll(root, timeoutMs),
	};
}

/** Runnable and held open tasks with no started run, and the seats and free slots. A headless session is not a seat. */
function queueCounts(db: DatabaseSync) {
	const { seats } = db
		.prepare(
			`SELECT COUNT(*) AS seats FROM runs WHERE status = 'started' AND role <> 'evf' AND role NOT IN ${HEADLESS_ROLES_SQL}`,
		)
		.get() as { seats: number };
	const tasks = db
		.prepare(
			`SELECT * FROM tasks t WHERE status NOT IN ('merged', 'done', 'abandoned')
			AND NOT EXISTS (SELECT 1 FROM runs r WHERE r.task_id = t.id AND r.status = 'started' AND r.role NOT IN ${HEADLESS_ROLES_SQL})`,
		)
		.all() as TaskRow[];
	const holdReasons = { blocked: 0, escalated: 0, waiting: 0, queued: 0 };
	let runnable = 0;
	for (const t of tasks) {
		const { stage } = nextStageFromStore(db, parseTask(t.ref), t);
		if (stage === "done" || stage === "abandoned") continue;
		if (stage === "escalated") holdReasons.escalated++;
		// A task at `pick` waits for Sebastian: no free slot can take it, so it is held, as `waiting`.
		else if (stage === "waiting" || stage === "pick") holdReasons.waiting++;
		else if (stage === "blocked" || stage === "held") holdReasons[t.status === "queued" ? "queued" : "blocked"]++;
		else runnable++; // What is left names a stage to perform.
	}
	const held = Object.values(holdReasons).reduce((sum, n) => sum + n, 0);
	return { runnable, held, holdReasons, seats, slotsFree: Math.max(0, SLOT_TARGET - seats) };
}

/** A failure costs one value or one write, never the sampler. */
function attempt<T>(action: () => T): T | null {
	try {
		return action();
	} catch {
		return null;
	}
}

const appendLine = (dir: string, file: string, line: Record<string, unknown>) =>
	appendFileSync(join(dir, file), `${JSON.stringify(line)}\n`);

/** One minute's records. The store writes go last: a busy store costs only the queue_tick and this tick's check poll. */
export function samplerTick(root: string, probes: SamplerProbes): void {
	const dir = evfDataDir(root),
		at = new Date(probes.now()).toISOString();
	const db = attempt(() => openWorkDb(root));
	try {
		const queue = db && attempt(() => queueCounts(db)),
			[load1 = null, load5 = null] = attempt(probes.load)?.map((n) => round(n, 2)) ?? [],
			swapUsed = attempt(probes.swapUsedGb),
			processes = attempt(probes.processes),
			shares = processes && cpuShares(processes);
		attempt(() =>
			appendLine(dir, LOAD_FILE, {
				at,
				load1,
				load5,
				swapUsedGb: swapUsed === null ? null : round(swapUsed, 2),
				freeMemPct: attempt(probes.freeMemPct),
				seats: queue?.seats ?? null,
				fullChecks: attempt(probes.fullChecks),
				previews: attempt(probes.previews),
			}),
		);
		attempt(() =>
			appendLine(dir, CPU_FILE, {
				at,
				...Object.fromEntries(CPU_CLASSES.map((c) => [c, shares?.[c] ?? null])),
			}),
		);
		if (db && queue) attempt(() => record(db, null, null, "queue_tick", { ...queue, load: load1 }));
		if (db)
			attempt(() => {
				if (claimPoll(db, probes.now())) probes.startCheckPoll();
			});
	} finally {
		db?.close();
	}
}

/** A line stays unless its `at` reads as a time before the cutoff. */
function isOld(line: string, cutoffMs: number): boolean {
	try {
		const at = (JSON.parse(line) as { at?: unknown }).at;
		return typeof at === "string" && Date.parse(at) < cutoffMs;
	} catch {
		return false;
	}
}

function trimFile(path: string, cutoffMs: number): void {
	if (!existsSync(path)) return;
	const lines = readFileSync(path, "utf8").split("\n"),
		kept = lines.filter((line) => !isOld(line, cutoffMs));
	const temporary = `${path}.${process.pid}.tmp`;
	writeFileSync(temporary, kept.join("\n"));
	renameSync(temporary, path);
}

/** The retention rule: 30 days for all four record kinds. A failure in one place leaves the others to go ahead. */
export function applyRetention(root: string, nowMs: number): void {
	const dir = evfDataDir(root),
		cutoffMs = nowMs - RETENTION_MS;
	for (const file of [LOAD_FILE, CPU_FILE]) attempt(() => trimFile(join(dir, file), cutoffMs));
	attempt(() => {
		const db = openWorkDb(root);
		try {
			db.prepare("DELETE FROM events WHERE type IN ('queue_tick', 'load_wait') AND ts < ?").run(
				new Date(cutoffMs).toISOString(),
			);
		} finally {
			db.close();
		}
	});
}

const lockPath = (root: string) => join(evfDataDir(root), "sampler.lock");

function lockPid(lock: string): number | null {
	try {
		const pid = Number(readFileSync(lock, "utf8").trim());
		return Number.isInteger(pid) && pid > 0 ? pid : null;
	} catch {
		return null;
	}
}

/**
 * The pid in the lock when a sampler runs there, or null. A lock survives a reboot and a pid gets reused, so a live pid
 * must also run the sampler command; `sampler stop` would otherwise signal a stranger.
 */
function liveHolder(lock: string): number | null {
	const pid = lockPid(lock);
	if (pid === null || !alive(pid)) return null;
	if (pid === process.pid) return pid;
	const ps = run("ps", ["-p", String(pid), "-wwo", "command="], { timeoutMs: PROBE_TIMEOUT_MS });
	return ps.code !== 0 || /main\.ts sampler run/.test(ps.stdout) ? pid : null;
}

/** Take the lock, or return false if a sampler holds it. A hard link is atomic and never shows an empty lock. */
function claimLock(lock: string): boolean {
	const temporary = `${lock}.${process.pid}`;
	writeFileSync(temporary, `${process.pid}\n`);
	try {
		for (let attempts = 0; attempts < 2; attempts++) {
			try {
				linkSync(temporary, lock);
				return true;
			} catch (e) {
				if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
				if (liveHolder(lock) !== null) return false;
				rmSync(lock, { force: true });
			}
		}
		return false;
	} finally {
		rmSync(temporary, { force: true });
	}
}

/**
 * The sampler loop. It returns at once when another sampler holds the lock, and it ends when the lock no longer names
 * it, which also closes the rare race of two starts that both reap one stale lock. `ticks` bounds a test's run.
 */
export function runSampler(root: string, probes = machineProbes(root), opts: { ticks?: number } = {}): void {
	const lock = lockPath(root);
	mkdirSync(evfDataDir(root), { recursive: true });
	if (!claimLock(lock)) return;
	let retainedAt = -Infinity,
		nextAt = probes.now();
	for (let n = 0; opts.ticks === undefined || n < opts.ticks; n++) {
		if (lockPid(lock) !== process.pid) return;
		const now = probes.now();
		if (now - retainedAt >= HOUR_MS) {
			retainedAt = now;
			applyRetention(root, now);
		}
		attempt(() => samplerTick(root, probes));
		const after = probes.now();
		nextAt += MINUTE_MS;
		while (nextAt <= after) nextAt += MINUTE_MS; // A slow tick skips a minute; it never runs two at once.
		probes.sleep(nextAt - after);
	}
	rmSync(lock, { force: true });
}

/**
 * Each tick's store open reads the migrations folder beside the code that runs, so a sampler must not run from a
 * worktree that ship can remove: the home checkout's copy outlives it. A test fixture has no evf code of its own.
 */
function spawnSampler(root: string): number | undefined {
	const home = join(root, "tools/evf/main.ts");
	const child = spawn(
		process.execPath,
		[
			"--disable-warning=ExperimentalWarning",
			existsSync(home) ? home : join(import.meta.dirname, "main.ts"),
			"sampler",
			"run",
		],
		{ cwd: root, detached: true, stdio: "ignore" },
	);
	child.unref();
	return child.pid;
}

/** `evf sampler start`. Two starts at once both spawn; the lock lets one child through and the other exits. */
export function startSampler(root: string): number {
	const lock = lockPath(root),
		waitMs = 10_000;
	const running = liveHolder(lock);
	if (running !== null) {
		console.log(`A sampler already runs (pid ${running}).`);
		return 0;
	}
	const pid = spawnSampler(root);
	for (const deadline = Date.now() + waitMs; Date.now() < deadline; sleep(50)) {
		const holder = liveHolder(lock);
		if (holder === null) continue;
		console.log(holder === pid ? `Sampler started (pid ${pid}).` : `A sampler already runs (pid ${holder}).`);
		return 0;
	}
	console.error(
		`The sampler (pid ${pid}) did not take its lock in ${waitMs / 1000} s. Is the home checkout's evf code current?`,
	);
	return 1;
}

/** `evf sampler stop`. SIGTERM ends the sampler at once: it has no handler, and its records are whole lines. */
export function stopSampler(root: string): number {
	const lock = lockPath(root),
		pid = liveHolder(lock);
	if (pid === null) {
		rmSync(lock, { force: true });
		console.log("No sampler runs.");
		return 0;
	}
	process.kill(pid, "SIGTERM");
	for (const deadline = Date.now() + 5000; alive(pid) && Date.now() < deadline;) sleep(50);
	rmSync(lock, { force: true });
	console.log(`Sampler stopped (pid ${pid}).`);
	return 0;
}

/** The drive's start: no wait and no print. A test's drive through main.ts sets EVF_NO_SAMPLER (tests/fixtures.ts). */
export function ensureSampler(root: string): void {
	if (process.env.EVF_NO_SAMPLER) return;
	if (liveHolder(lockPath(root)) === null) spawnSampler(root);
}
