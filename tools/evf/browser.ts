import { spawnSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

// The runner moved to scripts/browser.ts. `evf browser run`, evf ac run and evf timing call it from there.
export { browserRun, type BrowserRunOptions } from "../../scripts/browser.ts";

const AGENT_BROWSER_DIR = join(homedir(), ".agent-browser");

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
