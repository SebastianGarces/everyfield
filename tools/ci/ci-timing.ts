// Queue, setup and run time of each job in the last completed CI runs, with cache hits and misses from the job logs.
//   node tools/ci/ci-timing.ts --last <n> [--json]
// Reads GitHub with `gh api --method GET` only. A value without data prints "no data" (null in --json) and is left
// out of the totals, never counted as 0.
import { spawnSync } from "node:child_process";
import { parseArgs } from "node:util";

class CiTimingError extends Error {
	name = "ToolError";
}

/**
 * Setup is this fixed list of GitHub step names. Every other step is run time. Setup covers the runner's own steps,
 * checkout, pnpm and Node setup, the corepack install, `pnpm install`, cache restore, the Playwright browser install
 * and the post-job cleanup.
 */
const SETUP_STEPS: readonly RegExp[] = [
	/^Set up job$/,
	/^Run actions\/checkout@/,
	/^Run pnpm\/action-setup@/,
	/^Run actions\/setup-node@/,
	/^pnpm in the corepack cache\b/,
	/^Run pnpm install\b/,
	/^Run actions\/cache(?:\/restore)?@/,
	/^Chromium for render tests$|playwright install/i,
	/^Post /,
	/^Complete job$/,
];
/** Lines that actions/cache and actions/setup-node print when a cache restores or is absent. */
const CACHE_HIT = /Cache restored from key/;
const CACHE_MISS = /Cache not found for input keys|\bcache is not found\b/;

type Step = { name: string; conclusion?: string | null; started_at?: string | null; completed_at?: string | null };
type Job = { id: number; name: string; created_at?: string | null; started_at?: string | null; steps?: Step[] };
type JobTiming = {
	id: number;
	name: string;
	queueMs: number | null;
	setupMs: number | null;
	runMs: number | null;
	cacheHits: number | null;
	cacheMisses: number | null;
};
type Total = Omit<JobTiming, "id"> & { jobs: number };

const between = (from?: string | null, to?: string | null): number | null => {
	const ms = from && to ? Date.parse(to) - Date.parse(from) : NaN;
	return Number.isFinite(ms) && ms >= 0 ? ms : null;
};

/** One job's split. A category is null when any step in it that ran has no timestamps; skipped steps did not run. */
function jobTiming(job: Job, log: string | null): JobTiming {
	const sums = { setup: 0, run: 0 } as Record<"setup" | "run", number | null>;
	for (const step of job.steps ?? []) {
		if (step.conclusion === "skipped") continue;
		const kind = SETUP_STEPS.some((p) => p.test(step.name)) ? "setup" : "run";
		const ms = between(step.started_at, step.completed_at);
		sums[kind] = ms === null || sums[kind] === null ? null : sums[kind] + ms;
	}
	const lines = log?.split("\n") ?? [];
	return {
		id: job.id,
		name: job.name,
		queueMs: between(job.created_at, job.started_at),
		setupMs: sums.setup,
		runMs: sums.run,
		cacheHits: log === null ? null : lines.filter((l) => CACHE_HIT.test(l)).length,
		cacheMisses: log === null ? null : lines.filter((l) => CACHE_MISS.test(l)).length,
	};
}

/** Totals per job name. Each value sums only the jobs that have it, and stays null when none does. */
function totals(jobs: JobTiming[]): Total[] {
	const byName = new Map<string, Total>();
	for (const job of jobs) {
		const total = byName.get(job.name) ?? {
			name: job.name,
			jobs: 0,
			queueMs: null,
			setupMs: null,
			runMs: null,
			cacheHits: null,
			cacheMisses: null,
		};
		total.jobs++;
		for (const key of ["queueMs", "setupMs", "runMs", "cacheHits", "cacheMisses"] as const) {
			const value = job[key];
			if (value !== null) total[key] = (total[key] ?? 0) + value;
		}
		byName.set(job.name, total);
	}
	return [...byName.values()].sort((a, b) => (b.setupMs ?? -1) - (a.setupMs ?? -1));
}

type GhResult = { ok: true; out: string } | { ok: false; status: number | null; message: string };

/** Every GitHub read goes through here, and it only ever sends GET. */
function gh(path: string): GhResult {
	const r = spawnSync("gh", ["api", "--method", "GET", path], { encoding: "utf8", maxBuffer: 512 * 1024 * 1024 });
	if (r.error) throw new CiTimingError("Cannot run gh. Install the GitHub CLI and run gh auth login.");
	if (r.status === 0) return { ok: true, out: r.stdout };
	const status = /HTTP (\d{3})/.exec(r.stderr)?.[1];
	return { ok: false, status: status ? Number(status) : null, message: r.stderr.trim().split("\n")[0] ?? "" };
}

function json(path: string): unknown {
	const r = gh(path);
	if (!r.ok) throw new CiTimingError(`GitHub read failed for ${path}: ${r.message}`);
	return JSON.parse(r.out);
}

function list<T>(value: unknown, key: string): T[] {
	const items = value && typeof value === "object" && key in value ? (value as Record<string, unknown>)[key] : null;
	if (!Array.isArray(items)) throw new CiTimingError(`GitHub returned no ${key} list.`);
	return items as T[];
}

const show = (ms: number | null): string =>
	ms === null ? "no data" : ms >= 60_000 ? `${(ms / 60_000).toFixed(1)} min` : `${(ms / 1000).toFixed(1)} s`;
const count = (n: number | null): string => (n === null ? "no data" : String(n));
const line = (name: string, t: Omit<JobTiming, "id" | "name">): string =>
	`  ${name.padEnd(52)} queue ${show(t.queueMs).padStart(9)}  setup ${show(t.setupMs).padStart(9)}  run ${show(t.runMs).padStart(9)}  cache hits ${count(t.cacheHits)} misses ${count(t.cacheMisses)}`;

function main(): void {
	const { values } = parseArgs({ options: { last: { type: "string" }, json: { type: "boolean" } } });
	const last = Number(values.last);
	if (!Number.isInteger(last) || last < 1 || last > 100)
		throw new CiTimingError("Usage: node tools/ci/ci-timing.ts --last <1-100> [--json]");
	type Run = { id: number; created_at: string };
	const runs = list<Run>(
		json(`repos/{owner}/{repo}/actions/workflows/ci.yml/runs?status=completed&per_page=${last}`),
		"workflow_runs",
	).slice(0, last);
	const result = runs.map((run) => ({
		id: run.id,
		createdAt: run.created_at,
		jobs: list<Job>(json(`repos/{owner}/{repo}/actions/runs/${run.id}/jobs?per_page=100`), "jobs").map((job) => {
			const log = gh(`repos/{owner}/{repo}/actions/jobs/${job.id}/logs`);
			// An expired or missing log (HTTP 410 or 404) has no cache data. Any other failure stops the report.
			if (!log.ok && log.status !== 404 && log.status !== 410)
				throw new CiTimingError(`GitHub read failed for the log of job ${job.id}: ${log.message}`);
			return jobTiming(job, log.ok ? log.out : null);
		}),
	}));
	const sum = totals(result.flatMap((r) => r.jobs));
	if (values.json) return console.log(JSON.stringify({ runs: result, totals: sum }, null, 2));
	for (const run of result) {
		console.log(`Run ${run.id} (${run.createdAt})`);
		for (const job of run.jobs) console.log(line(job.name, job));
	}
	console.log(`Totals per job across ${result.length} run(s)`);
	for (const t of sum) console.log(line(`${t.name} (${t.jobs})`, t));
}

if (import.meta.main) {
	try {
		main();
	} catch (error) {
		if (!(error instanceof CiTimingError)) throw error;
		console.error(`ci-timing: ${error.message}`);
		process.exitCode = 1;
	}
}
