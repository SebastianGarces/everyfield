import { spawn, spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { constants, homedir, tmpdir } from "node:os";
import { join } from "node:path";

// Every process a browser run starts inherits this variable, also the browsers that leave its
// process group (Playwright and the agent-browser daemon start their own groups). Cleanup finds
// them by this token: by what the run started, never by a process name.
const TAG = "EVF_BROWSER_RUN";
const AGENT_BROWSER_DIR = join(homedir(), ".agent-browser");
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Live processes, other than this one, whose environment carries TAG=token. */
export function taggedProcesses(token: string): number[] {
	const needle = `${TAG}=${token}`;
	let pids: number[];
	if (process.platform === "linux") {
		pids = readdirSync("/proc")
			.filter((d) => /^\d+$/.test(d))
			.filter((d) => {
				try {
					return readFileSync(`/proc/${d}/environ`, "utf8").split("\0").includes(needle);
				} catch {
					return false; // exited or not ours
				}
			})
			.map(Number);
	} else {
		// macOS appends the environment of the caller's own processes to the command.
		const ps = spawnSync("ps", ["-A", "-wwE", "-o", "pid=,command="], { encoding: "utf8", maxBuffer: 256 << 20 });
		const match = new RegExp(`\\s${needle}(\\s|$)`);
		pids = ps.stdout
			.split("\n")
			.filter((line) => match.test(line))
			.map((line) => Number(line.trim().split(/\s+/)[0]));
	}
	return pids.filter((pid) => pid !== process.pid);
}

function signal(pid: number, sig: NodeJS.Signals): void {
	try {
		process.kill(pid, sig);
	} catch {
		// already gone
	}
}

async function stopTagged(token: string): Promise<number[]> {
	for (const [sig, waitMs] of [
		["SIGTERM", 5000],
		["SIGKILL", 2000],
	] as const) {
		const pids = taggedProcesses(token);
		if (!pids.length) return [];
		for (const pid of pids) signal(pid, sig);
		for (let t = 0; t < waitMs && taggedProcesses(token).length; t += 100) await sleep(100);
	}
	return taggedProcesses(token);
}

export type BrowserRunOptions = { timeoutSeconds: number; session?: string };

/**
 * Run a browser check in its own process group with a timeout. Afterwards, on success, failure,
 * timeout or a signal to evf, close its agent-browser session, stop every process it started
 * and delete its temporary directory (Playwright profiles live there through TMPDIR).
 */
export async function browserRun(argv: string[], opts: BrowserRunOptions): Promise<number> {
	const token = randomBytes(8).toString("hex"),
		tmp = mkdtempSync(join(tmpdir(), "evf-browser-")),
		session = opts.session ?? `evf-${token}`;
	const env = {
		...process.env,
		[TAG]: token,
		TMPDIR: tmp,
		AGENT_BROWSER_SESSION: session,
		AGENT_BROWSER_IDLE_TIMEOUT_MS: process.env.AGENT_BROWSER_IDLE_TIMEOUT_MS ?? "300000",
	};
	const child = spawn(argv[0], argv.slice(1), { detached: true, stdio: "inherit", env });
	let stopped: { reason: string; code: number } | undefined;
	const stop = (reason: string, code: number) => {
		stopped ??= { reason, code };
		if (child.pid) signal(-child.pid, "SIGTERM");
		setTimeout(() => child.pid && signal(-child.pid, "SIGKILL"), 5000).unref();
	};
	const timer = setTimeout(() => stop(`timed out after ${opts.timeoutSeconds}s`, 124), opts.timeoutSeconds * 1000);
	const handlers = (["SIGINT", "SIGTERM", "SIGHUP"] as const).map((sig) => {
		const h = () => stop(`evf received ${sig}`, 128 + constants.signals[sig]);
		process.on(sig, h);
		return [sig, h] as const;
	});
	const exit = await new Promise<number>((resolve) => {
		child.on("error", (e) => {
			console.error(`evf browser: cannot start ${argv[0]}: ${e.message}`);
			resolve(127);
		});
		child.on("exit", (code, sig) => resolve(code ?? 128 + (sig ? constants.signals[sig] : 0)));
	});
	clearTimeout(timer);
	if (child.pid) signal(-child.pid, "SIGTERM"); // anything still in the run's own group

	// Let agent-browser save and close its session before the processes get a signal.
	if (existsSync(join(AGENT_BROWSER_DIR, `${session}.pid`)))
		spawnSync("agent-browser", ["--session", session, "close"], { env, stdio: "ignore", timeout: 15000 });
	const left = await stopTagged(token);
	// A generated session belongs to this run alone; remove its state files (config, target, ...).
	if (!opts.session && existsSync(AGENT_BROWSER_DIR))
		for (const f of readdirSync(AGENT_BROWSER_DIR))
			if (f.startsWith(`${session}.`)) rmSync(join(AGENT_BROWSER_DIR, f), { force: true });
	for (const [sig, h] of handlers) process.off(sig, h);
	rmSync(tmp, { recursive: true, force: true });

	if (stopped) console.error(`evf browser: ${stopped.reason}; stopped the run.`);
	if (left.length) {
		console.error(`evf browser: processes still running after SIGKILL: ${left.join(", ")}`);
		return exit || 1;
	}
	console.error("evf browser: no browser process from this run is left.");
	return stopped?.code ?? exit;
}

export type LeftoverBrowser = { pid: number; kind: string; ageMinutes: number; memoryMb: number };

/** ps etime ([[dd-]hh:]mm:ss) in seconds. */
function seconds(etime: string): number {
	const [days, clock] = etime.includes("-") ? etime.split("-") : ["0", etime];
	return (
		clock
			.split(":")
			.map(Number)
			.reduce((total, part) => total * 60 + part, 0) +
		Number(days) * 86400
	);
}

function agentBrowserSessions(): Map<number, string> {
	const sessions = new Map<number, string>();
	for (const f of existsSync(AGENT_BROWSER_DIR) ? readdirSync(AGENT_BROWSER_DIR) : [])
		if (f.endsWith(".pid"))
			sessions.set(Number(readFileSync(join(AGENT_BROWSER_DIR, f), "utf8").trim()), f.slice(0, -4));
	return sessions;
}

/**
 * Headless browsers and agent-browser daemons older than the age limit, one entry per process
 * tree with the memory of the whole tree. Report only: doctor never stops other processes.
 */
export function leftoverBrowsers(
	minAgeMinutes: number,
	psTable = spawnSync("ps", ["-A", "-ww", "-o", "pid=,ppid=,rss=,etime=,command="], { encoding: "utf8" }).stdout,
): LeftoverBrowser[] {
	const procs = psTable
		.split("\n")
		.map((line) => line.trim().match(/^(\d+)\s+(\d+)\s+(\d+)\s+(\S+)\s+(.*)$/))
		.filter((m) => m !== null)
		.map((m) => ({ pid: Number(m[1]), ppid: Number(m[2]), rss: Number(m[3]), age: seconds(m[4]), command: m[5] }));
	const sessions = agentBrowserSessions();
	const kind = (p: (typeof procs)[number]): string | null => {
		if (/\bagent-browser-(darwin|linux)/.test(p.command))
			return `agent-browser daemon (session ${sessions.get(p.pid) ?? "unknown"})`;
		const pw = p.command.match(/\/ms-playwright\/([a-z_-]+)-[^/]*\//);
		if (pw) return `Playwright ${pw[1]}`;
		if (/\/\.agent-browser\/browsers\//.test(p.command)) return "agent-browser Chrome";
		if (/(chrom(e|ium)|headless_shell|webkit)/i.test(p.command) && /\s--headless\b/.test(p.command))
			return "headless Chromium";
		return null;
	};
	const browsers = new Map(
		procs.flatMap((p) => {
			const k = kind(p);
			return k ? [[p.pid, { ...p, kind: k }] as const] : [];
		}),
	);
	const children = new Map<number, typeof procs>();
	for (const p of procs) children.set(p.ppid, [...(children.get(p.ppid) ?? []), p]);
	const treeRss = (pid: number): number =>
		(children.get(pid) ?? []).reduce((sum, c) => sum + c.rss + treeRss(c.pid), 0);
	return [...browsers.values()]
		.filter((p) => !browsers.has(p.ppid) && p.age >= minAgeMinutes * 60)
		.map((p) => ({
			pid: p.pid,
			kind: p.kind,
			ageMinutes: Math.floor(p.age / 60),
			memoryMb: Math.round((p.rss + treeRss(p.pid)) / 1024),
		}));
}
