import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { git, isClean, run, type RunResult } from "./lib.ts";

/**
 * OPS-143: `evf verify` stops a check once its run cannot count. verify is synchronous and `run` is spawnSync, so a small
 * process sits between evf and each check. It polls the checkout, and on a change it records why and stops the check with
 * everything the check started.
 */

export type StopReason = "tree_changed" | "inputs_changed";
type WatchSpec = { argv: string[]; wt: string; sha: string; inputs: string; stopFile: string; pollMs: number };

const POLL_MS = 10_000,
	/** A change must hold on this many polls in a row, so a temporary file that a check removes stops nothing. */
	CONFIRM_POLLS = 2,
	TERM_GRACE_MS = 5000,
	KILL_WAIT_MS = 5000,
	STOP_STEP_MS = 100,
	INSTALL_RECORD = "node_modules/.pnpm/lock.yaml";

/** Env file metadata and pnpm's record of the install: what a check reads that the clean-tree test cannot see. */
export function inputFiles(wt: string): string {
	const apps = join(wt, "apps"),
		dirs = [wt, ...(existsSync(apps) ? readdirSync(apps).map((app) => join(apps, app)) : [])];
	const hash = createHash("sha256");
	for (const dir of dirs) {
		if (!statSync(dir, { throwIfNoEntry: false })?.isDirectory()) continue;
		for (const name of readdirSync(dir).sort()) {
			if (!name.startsWith(".env")) continue;
			// Only the size and time: evf never reads an env file (AGENTS.md guard 3).
			const file = statSync(join(dir, name), { throwIfNoEntry: false });
			hash.update(`${join(dir, name)}\0${file?.size}\0${file?.mtimeMs}\0`);
		}
	}
	const record = join(wt, INSTALL_RECORD);
	if (existsSync(record)) hash.update(readFileSync(record));
	return hash.digest("hex");
}

/** Why a run on this `sha` and these inputs can no longer count, or null. A failed git read throws. */
export function changeSince(wt: string, sha: string, inputs: string): StopReason | null {
	if (git(wt, "rev-parse", "HEAD") !== sha || !isClean(wt)) return "tree_changed";
	return inputFiles(wt) === inputs ? null : "inputs_changed";
}

/** Run one command under the watch. `stopped` names the reason when the watch stopped it. */
export function watchedRun(
	argv: string[],
	opts: { cwd?: string; env?: NodeJS.ProcessEnv; wt: string; sha: string; inputs: string; stopFile: string },
): RunResult & { stopped?: StopReason } {
	const { cwd, env, ...watch } = opts,
		pollMs = Number(process.env.EVF_CHECK_POLL_MS) || POLL_MS,
		spec: WatchSpec = { argv, pollMs, ...watch };
	const result = run(
		process.execPath,
		["--disable-warning=ExperimentalWarning", import.meta.filename, JSON.stringify(spec)],
		{ cwd, env },
	);
	return existsSync(opts.stopFile) ? { ...result, stopped: readFileSync(opts.stopFile, "utf8") as StopReason } : result;
}

type Process = { pid: number; ppid: number; pgid: number; zombie: boolean; started: string };

function processTable(): Process[] {
	const rows = run("ps", ["-A", "-o", "pid=,ppid=,pgid=,stat=,lstart="], { timeoutMs: 10_000 }).stdout.split("\n");
	return rows.flatMap((row) => {
		const m = /^\s*(\d+)\s+(\d+)\s+(\d+)\s+(\S+)\s+(.+?)\s*$/.exec(row);
		return m
			? [{ pid: Number(m[1]), ppid: Number(m[2]), pgid: Number(m[3]), zombie: m[4].startsWith("Z"), started: m[5] }]
			: [];
	});
}

const pause = (ms: number) => new Promise((done) => setTimeout(done, ms));

function signal(pid: number, name: NodeJS.Signals): void {
	try {
		process.kill(pid, name);
	} catch {}
}

function supervise({ argv, wt, sha, inputs, stopFile, pollMs }: WatchSpec): void {
	const parent = process.ppid;
	const child = spawn(argv[0], argv.slice(1), { detached: true, stdio: ["ignore", "inherit", "inherit"] });
	child.on("error", (error) => {
		console.error(error.message);
		process.exit(127);
	});
	const root = child.pid;
	if (root === undefined) return;
	/** pid to start time, so a pid the system reuses is never signalled. A process stays here after its parent exits. */
	const family = new Map<number, string>();
	const live = () => {
		const table = processTable();
		for (let grew = true; grew;) {
			grew = false;
			for (const p of table)
				if (!family.has(p.pid) && (p.pid === root || p.pgid === root || family.has(p.ppid))) {
					family.set(p.pid, p.started);
					grew = true;
				}
		}
		return table.filter((p) => !p.zombie && family.get(p.pid) === p.started);
	};
	const signalAll = (name: NodeJS.Signals) => {
		signal(-root, name);
		for (const p of live()) signal(p.pid, name);
	};
	let stopping = false;
	const stopAll = async (code: number) => {
		if (stopping) return;
		stopping = true;
		signalAll("SIGTERM");
		for (const end = Date.now() + TERM_GRACE_MS; live().length && Date.now() < end;) await pause(STOP_STEP_MS);
		signalAll("SIGKILL");
		for (const end = Date.now() + KILL_WAIT_MS; live().length && Date.now() < end;) await pause(STOP_STEP_MS);
		process.exit(code);
	};
	child.on("exit", (code) => {
		if (!stopping) process.exit(code ?? 1);
	});
	process.on("SIGINT", () => void stopAll(130));
	process.on("SIGTERM", () => void stopAll(143));
	process.on("SIGHUP", () => void stopAll(129));
	let held = 0;
	setInterval(() => {
		if (stopping) return;
		// evf itself was killed: nobody waits for this check any more.
		if (process.ppid !== parent) return void stopAll(1);
		live();
		let reason: StopReason | null = null;
		try {
			reason = changeSince(wt, sha, inputs);
		} catch {
			// A failed read proves no change. The end-of-check test in verify still reads the tree and fails loudly.
		}
		held = reason ? held + 1 : 0;
		if (!reason || held < CONFIRM_POLLS) return;
		console.error(`evf verify: stopped this check: ${reason}.`);
		writeFileSync(stopFile, reason);
		void stopAll(1);
	}, pollMs);
}

if (process.argv[1] === import.meta.filename) supervise(JSON.parse(process.argv[2]) as WatchSpec);
