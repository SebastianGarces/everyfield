import { spawnSync } from "node:child_process";

export const PREFIX = "qa-test-";
export const LABELS = {
	pid: "everyfield.qa-test.owner-pid",
	start: "everyfield.qa-test.owner-start",
	started: "everyfield.qa-test.started",
} as const;
export const AGE_ENV = "EVERYFIELD_QA_SWEEP_MINUTES";
const DEFAULT_MINUTES = 120;

const spaced = (text: string) => text.trim().replace(/\s+/g, " ");

export function processStart(pid: number): string | null {
	const r = spawnSync("ps", ["-o", "lstart=", "-p", String(pid)], { encoding: "utf8" });
	return r.status === 0 && r.stdout.trim() ? spaced(r.stdout) : null;
}

export function ownerLabels(): string[] {
	const start = processStart(process.pid);
	if (!start) throw new Error(`ps cannot read this process's start time (pid ${process.pid}).`);
	return [
		["--label", `${LABELS.pid}=${process.pid}`],
		["--label", `${LABELS.start}=${start}`],
		["--label", `${LABELS.started}=${new Date().toISOString()}`],
	].flat();
}

type Inspected = { Id: string; Name: string; Created: string; Config: { Labels: Record<string, string> | null } };
export type Swept = { name: string; ageMinutes: number; reason: string };

export function sweep(env = process.env): { removed: Swept[]; skipped?: string } {
	const raw = env[AGE_ENV];
	const minutes = raw === undefined || raw === "" ? DEFAULT_MINUTES : Number(raw);
	if (!Number.isFinite(minutes) || minutes < 0)
		return { removed: [], skipped: `${AGE_ENV}=${raw} is not a number of minutes` };
	const docker = (...args: string[]) => {
		const r = spawnSync("docker", args, { encoding: "utf8", env, timeout: 30_000 });
		if (r.error) throw new Error(`docker is not available: ${r.error.message}`);
		if (r.status !== 0) throw new Error(`docker ${args[0]} failed: ${(r.stderr || r.stdout).trim().split("\n")[0]}`);
		return r.stdout;
	};
	let containers: Inspected[];
	try {
		const ids = docker("ps", "-a", "-q", "--no-trunc", "--filter", `name=${PREFIX}`).split("\n").filter(Boolean);
		containers = ids.length ? (JSON.parse(docker("inspect", ...ids)) as Inspected[]) : [];
	} catch (error) {
		return { removed: [], skipped: (error as Error).message };
	}
	const now = Date.now(),
		removed: Swept[] = [];
	for (const c of containers) {
		const name = c.Name.replace(/^\//, "");
		if (!name.startsWith(PREFIX)) continue;
		const labels = c.Config.Labels ?? {};
		const started = Date.parse(labels[LABELS.started] ?? c.Created);
		const ageMinutes = Math.floor((now - started) / 60_000);
		if (!(ageMinutes >= minutes)) continue;
		const pid = Number(labels[LABELS.pid]),
			start = labels[LABELS.start];
		let reason: string;
		if (!Number.isInteger(pid) || pid <= 0 || !start) reason = "it names no owning run";
		else if (processStart(pid) === start) continue;
		else reason = `its owning run (pid ${pid}, started ${start}) is gone`;
		try {
			docker("rm", "-f", "-v", c.Id);
			removed.push({ name, ageMinutes, reason });
		} catch (error) {
			return { removed, skipped: (error as Error).message };
		}
	}
	return { removed };
}

export function sweepCommand(log: (line: string) => void = console.error, env = process.env): void {
	let result: ReturnType<typeof sweep>;
	try {
		result = sweep(env);
	} catch (error) {
		result = { removed: [], skipped: (error as Error).message };
	}
	for (const r of result.removed) log(`qa-test sweep removed ${r.name}, ${r.ageMinutes} min old: ${r.reason}`);
	if (result.skipped) log(`qa-test sweep skipped: ${result.skipped}`);
}
