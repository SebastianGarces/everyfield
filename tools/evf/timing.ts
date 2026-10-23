import { spawn } from "node:child_process";
import {
	closeSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	openSync,
	readFileSync,
	rmSync,
	writeFileSync,
	writeSync,
} from "node:fs";
import { createRequire } from "node:module";
import { loadavg, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { browserRun } from "./browser.ts";
import {
	EvfError,
	evfDataDir,
	evidenceDir,
	fail,
	git,
	gitOk,
	isClean,
	loadConfig,
	requireWorktree,
	run,
	type TaskRef,
} from "./lib.ts";
import { describeLoad, loadLimit } from "./load.ts";
import { startQuietDatabase, startTimingPreview, stopQuietDatabase, stopTimingPreview } from "./timing-stack.ts";

/**
 * OPS-52 (P1): one tested tool for the timing rulings C108, C113, C114, C118 and C119. It runs a declared timing set on
 * the quiet database (D81) with an independent probe beside it, labels every sample and adds one labeled replacement
 * for each non-qualifying sample. A qualifying miss is never rerun away (C113).
 */

/** A probe round trip above this overlapping a sample makes it non-qualifying (C114 read, C118 write). */
export const SPIKE_MS = 150;
/** How long a sample waits after it ends for each probe to finish a round trip that started later. */
const SETTLE_MS = 2000;

export type Window = { startedAt: number; endedAt: number };
export type ProbeKind = "read" | "write";
export type ProbeRound = { k: ProbeKind; s: number; e: number };
export type Label = "qualifying" | "load" | "database spike" | "database write stall" | "self-interference";
export type Sample = Window & {
	index: number;
	replacementFor?: number;
	ms: number;
	load: [number, number];
	label: Label;
	detail?: string;
};

/**
 * What a set receives: the preview URL, the quiet database (superuser, for its own synthetic seed), the preview's env
 * (for example IDENTITY_SECRET to sign a seeded session), require() from the head's install (Playwright) and its
 * evidence folder.
 */
export type SetContext = {
	url: string;
	databaseUrl: string;
	env: Record<string, string>;
	require: NodeJS.Require;
	out: string;
};
export type SampleContext = SetContext & { index: number; replacementFor?: number };
export type SampleResult = Partial<Window> & { interference?: string };
export type TimingSet = {
	name: string;
	budgetMs: number;
	samples: number;
	/** Saves add the write probe (C118). */
	write: boolean;
	setup?: (ctx: SetContext) => unknown;
	sample: (ctx: SampleContext) => Promise<SampleResult | void> | SampleResult | void;
	teardown?: (ctx: SetContext) => unknown;
};

/** The set file's default export, checked at the boundary. */
export function parseSet(value: unknown, file: string): TimingSet {
	const v = value as Partial<TimingSet> | null;
	const problems = [
		!v || typeof v !== "object" ? "export default an object" : "",
		typeof v?.name !== "string" || !v.name.trim() ? "name: a non-empty string" : "",
		!(Number.isFinite(v?.budgetMs) && v!.budgetMs! > 0) ? "budgetMs: milliseconds above 0" : "",
		!(Number.isInteger(v?.samples) && v!.samples! > 0) ? "samples: a whole number above 0" : "",
		typeof v?.write !== "boolean" ? "write: true for a save (adds the write probe), false for a read" : "",
		typeof v?.sample !== "function" ? "sample(ctx): runs one timed action" : "",
		...(["setup", "teardown"] as const).map((k) =>
			v?.[k] !== undefined && typeof v[k] !== "function" ? `${k}: a function when present` : "",
		),
	].filter(Boolean);
	if (problems.length) fail(`Timing set ${file} needs ${problems.join("; ")}.`);
	return v as TimingSet;
}

/** The label of one sample, from the evidence around its window. Order: what the run caused, the machine, the database. */
export function labelSample(
	w: Window,
	rounds: ProbeRound[],
	load: [number, number],
	limit: number,
	write: boolean,
	interference: string | undefined,
	unsettled: ProbeKind[],
): { label: Label; detail?: string } {
	if (interference) return { label: "self-interference", detail: interference };
	const peak = Math.max(...load);
	if (peak > limit) return { label: "load", detail: `1-minute load ${peak.toFixed(1)}, limit ${limit}` };
	const worst = (k: ProbeKind) =>
		Math.max(0, ...rounds.filter((r) => r.k === k && r.s < w.endedAt && r.e > w.startedAt).map((r) => r.e - r.s));
	const kinds: Array<[ProbeKind, Label, string]> = [
		["write", "database write stall", "write probe"],
		["read", "database spike", "SELECT 1 probe"],
	];
	for (const [k, label, probe] of kinds) {
		if (k === "write" && !write) continue;
		if (unsettled.includes(k))
			return { label, detail: `${probe} gave no answer within ${SETTLE_MS} ms after the sample` };
		if (worst(k) > SPIKE_MS) return { label, detail: `${probe} round trip ${worst(k)} ms, limit ${SPIKE_MS} ms` };
	}
	return { label: "qualifying" };
}

export type Probe = {
	rounds: () => ProbeRound[];
	/** Waits until every probe finished a round trip that started at or after `t`; answers the kinds that did not. */
	settle: (t: number) => Promise<ProbeKind[]>;
};
export type RunDeps = {
	ctx: SetContext;
	probe: Probe;
	load: () => number;
	limit: number;
	log?: (line: string) => void;
};

/**
 * Runs the declared samples. Each non-qualifying sample stays in the evidence and adds exactly one labeled replacement
 * at the end (C108), also when it is itself a replacement. More non-qualifying samples than declared ones stop the
 * run: the set is not measured.
 */
export async function runSet(set: TimingSet, deps: RunDeps): Promise<{ samples: Sample[]; stopped?: string }> {
	const samples: Sample[] = [],
		queue: Array<number | undefined> = Array.from({ length: set.samples }, () => undefined);
	let nonQualifying = 0;
	while (queue.length) {
		const replacementFor = queue.shift(),
			index = samples.length + 1;
		const before = deps.load(),
			called = Date.now();
		let result: SampleResult;
		try {
			result = (await set.sample({ ...deps.ctx, index, ...(replacementFor ? { replacementFor } : {}) })) ?? {};
		} catch (error) {
			return { samples, stopped: `sample ${index} failed: ${error instanceof Error ? error.message : String(error)}` };
		}
		const window = { startedAt: result.startedAt ?? called, endedAt: result.endedAt ?? Date.now() };
		if (!(Number.isFinite(window.startedAt) && Number.isFinite(window.endedAt) && window.endedAt >= window.startedAt))
			return { samples, stopped: `sample ${index} returned a window without epoch milliseconds (Date.now())` };
		const after = deps.load(),
			unsettled = await deps.probe.settle(window.endedAt);
		const { label, detail } = labelSample(
			window,
			deps.probe.rounds(),
			[before, after],
			deps.limit,
			set.write,
			result.interference,
			unsettled,
		);
		const sample: Sample = {
			index,
			...(replacementFor ? { replacementFor } : {}),
			...window,
			ms: window.endedAt - window.startedAt,
			load: [before, after],
			label,
			...(detail ? { detail } : {}),
		};
		samples.push(sample);
		deps.log?.(
			`sample ${index}${replacementFor ? ` (replaces ${replacementFor})` : ""}: ${sample.ms} ms, ${label}${detail ? `: ${detail}` : ""}`,
		);
		if (label === "qualifying") continue;
		if (++nonQualifying > set.samples)
			return { samples, stopped: `more than ${set.samples} non-qualifying samples; the set is not measured` };
		queue.push(index);
	}
	return { samples };
}

export type Summary = {
	verdict: "pass" | "fail";
	reason: string;
	qualifying: number;
	misses: number[];
	nonQualifying: Partial<Record<Label, number>>;
	range?: [number, number];
};

/** The budget is met only when every declared sample has a qualifying result and every qualifying one is under budget. */
export function summarize(set: TimingSet, result: { samples: Sample[]; stopped?: string }): Summary {
	const qualifying = result.samples.filter((s) => s.label === "qualifying"),
		misses = qualifying.filter((s) => s.ms >= set.budgetMs).map((s) => s.index),
		nonQualifying: Partial<Record<Label, number>> = {};
	for (const s of result.samples)
		if (s.label !== "qualifying") nonQualifying[s.label] = (nonQualifying[s.label] ?? 0) + 1;
	const ms = qualifying.map((s) => s.ms),
		range: [number, number] | undefined = ms.length ? [Math.min(...ms), Math.max(...ms)] : undefined;
	const reason = result.stopped
		? result.stopped
		: misses.length
			? `${misses.length} qualifying sample(s) at or above ${set.budgetMs} ms: ${misses.join(", ")}`
			: `${qualifying.length} of ${set.samples} qualifying samples under ${set.budgetMs} ms`;
	return {
		verdict: !result.stopped && !misses.length && qualifying.length === set.samples ? "pass" : "fail",
		reason,
		qualifying: qualifying.length,
		misses,
		nonQualifying,
		...(range ? { range } : {}),
	};
}

function stats(rounds: ProbeRound[], k: ProbeKind) {
	const ms = rounds
		.filter((r) => r.k === k)
		.map((r) => r.e - r.s)
		.sort((a, b) => a - b);
	if (!ms.length) return undefined;
	const at = (q: number) => ms[Math.min(ms.length - 1, Math.floor(q * ms.length))];
	return {
		rounds: ms.length,
		p50: at(0.5),
		p99: at(0.99),
		max: ms[ms.length - 1],
		aboveLimit: ms.filter((m) => m > SPIKE_MS).length,
	};
}

/** The probe child on its own connections. It must outlive the set; an early exit fails the run. */
function startProbe(pgFrom: string, url: string, write: boolean): Probe & { stop: () => void } {
	const child = spawn(process.execPath, [join(import.meta.dirname, "timing-probe.mjs"), pgFrom, write ? "1" : "0"], {
		env: { ...process.env, EVF_PROBE_URL: url },
		stdio: ["ignore", "pipe", "pipe"],
	});
	const rounds: ProbeRound[] = [];
	let buffer = "",
		error = "",
		exited = false;
	child.stdout.on("data", (chunk: Buffer) => {
		const lines = (buffer + chunk).split("\n");
		buffer = lines.pop() ?? "";
		for (const line of lines) if (line) rounds.push(JSON.parse(line) as ProbeRound);
	});
	child.stderr.on("data", (chunk: Buffer) => (error += chunk));
	child.on("exit", () => (exited = true));
	const kinds: ProbeKind[] = write ? ["read", "write"] : ["read"];
	return {
		rounds: () => rounds,
		settle: async (t) => {
			const missing = () => kinds.filter((k) => !rounds.some((r) => r.k === k && r.s >= t));
			for (const end = Date.now() + SETTLE_MS; missing().length && Date.now() < end && !exited;)
				await new Promise((r) => setTimeout(r, 20));
			if (exited) throw new EvfError(`The database probe stopped: ${error.trim() || "no message"}`);
			return missing();
		},
		stop: () => child.kill(),
	};
}

/** One timing set samples at a time on this machine, so two runs never load each other. Setup runs outside it. */
async function acquireLock(path: string, log: (line: string) => void): Promise<() => void> {
	for (const start = Date.now(); ;) {
		try {
			const fd = openSync(path, "wx");
			writeSync(fd, String(process.pid));
			closeSync(fd);
			return () => rmSync(path, { force: true });
		} catch {
			// An empty file is a lock its holder has just created and not yet written.
			const text = existsSync(path) ? readFileSync(path, "utf8") : "0",
				holder = Number(text);
			let live = text === "";
			try {
				if (holder > 0) live = process.kill(holder, 0);
			} catch {
				live = false;
			}
			if (!live) {
				rmSync(path, { force: true });
				continue;
			}
			const waited = Date.now() - start;
			if (waited > 30 * 60_000) fail("Another timing set held the machine for 30 minutes. Retry later.");
			if (waited % 60_000 < 5000)
				log(`waiting for the timing set of process ${holder}, ${Math.floor(waited / 60_000)} min`);
			await new Promise((r) => setTimeout(r, 5000));
		}
	}
}

type Job = {
	setFile: string;
	url: string;
	databaseUrl: string;
	env: Record<string, string>;
	checkout: string;
	out: string;
	limit: number;
	lock: string;
	meta: Record<string, unknown>;
};

/** Runs inside `evf browser run`, so every browser the set opens stops with the run. */
async function sampleJob(job: Job): Promise<number> {
	const log = (line: string) => console.log(`evf timing: ${line}`);
	const set = parseSet((await import(pathToFileURL(job.setFile).href)).default, job.setFile);
	const ctx: SetContext = {
		url: job.url,
		databaseUrl: job.databaseUrl,
		env: job.env,
		require: createRequire(join(job.checkout, "apps/web/package.json")),
		out: job.out,
	};
	let result: { samples: Sample[]; stopped?: string } = { samples: [], stopped: "setup did not finish" };
	let rounds: ProbeRound[] = [];
	const startedAt = new Date().toISOString();
	try {
		await set.setup?.(ctx);
		const probe = startProbe(join(job.checkout, "packages/db/package.json"), job.databaseUrl, set.write);
		try {
			const release = await acquireLock(job.lock, log);
			try {
				const unready = await probe.settle(Date.now());
				if (unready.length) fail(`The ${unready.join(" and ")} probe gave no answer before the first sample.`);
				result = await runSet(set, { ctx, probe, load: () => loadavg()[0], limit: job.limit, log });
			} finally {
				release();
			}
			rounds = probe.rounds();
		} finally {
			probe.stop();
		}
	} catch (error) {
		result = { ...result, stopped: error instanceof Error ? error.message : String(error) };
	} finally {
		await set.teardown?.(ctx);
	}
	const summary = summarize(set, result);
	const report = {
		...job.meta,
		set: { file: job.setFile, name: set.name, budgetMs: set.budgetMs, samples: set.samples, write: set.write },
		loadLimit: job.limit,
		spikeLimitMs: SPIKE_MS,
		startedAt,
		endedAt: new Date().toISOString(),
		probes: { read: stats(rounds, "read"), write: stats(rounds, "write") },
		summary,
		samples: result.samples,
	};
	writeFileSync(join(job.out, "report.json"), JSON.stringify(report, null, 2) + "\n");
	const labels = Object.entries(summary.nonQualifying).map(([l, n]) => `${n} ${l}`);
	log(
		`${summary.verdict === "pass" ? "PASSED" : "FAILED"} "${set.name}" at ${String(job.meta.head).slice(0, 7)}: ${summary.reason}` +
			(summary.range ? ` (${summary.range[0]} to ${summary.range[1]} ms)` : "") +
			(labels.length ? `; non-qualifying, each with one replacement: ${labels.join(", ")}` : "") +
			`. Report: ${join(job.out, "report.json")}`,
	);
	return summary.verdict === "pass" ? 0 : 1;
}

const slug = (name: string) =>
	name
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/^-|-$/g, "")
		.slice(0, 40) || "set";

/**
 * evf timing <task> --set <file> [--head <sha>]: the exact head (the author's task worktree, or a verifier's --head)
 * in its own detached worktree, a quiet database, a production preview on it, the set inside `evf browser run`, then
 * everything removed. Exit 0 only when the budget is met.
 */
export async function timing(
	root: string,
	task: TaskRef,
	opts: { setFile: string; head?: string; timeoutSeconds: number },
): Promise<number> {
	const setFile = resolve(opts.setFile);
	if (!existsSync(setFile)) fail(`No timing set at ${setFile}.`);
	const cfg = loadConfig(root);
	let head = opts.head;
	if (!head) {
		const wt = requireWorktree(root, cfg, task);
		if (!isClean(wt)) fail("Commit your work first: evf timing measures a commit.");
		head = git(wt, "rev-parse", "HEAD");
	}
	if (!/^[0-9a-f]{40}$/.test(head) || !gitOk(root, "cat-file", "-e", `${head}^{commit}`))
		fail("--head needs a full 40-character commit SHA that this checkout has (fetch the PR head first).");
	const sha7 = head.slice(0, 7),
		checkout = join(root, cfg.worktreeDir, `timing-${sha7}`),
		out = evidenceDir(
			root,
			task,
			head,
			`timing-${slug(
				setFile
					.split("/")
					.pop()!
					.replace(/\.[mc]?[jt]s$/, ""),
			)}`,
		),
		jobDir = mkdtempSync(join(tmpdir(), "evf-timing-job-"));
	mkdirSync(out, { recursive: true });
	if (existsSync(checkout)) git(root, "worktree", "remove", "--force", checkout);
	git(root, "worktree", "add", "--quiet", "--detach", checkout, head);
	let db: ReturnType<typeof startQuietDatabase> | undefined, preview: ReturnType<typeof startTimingPreview> | undefined;
	try {
		console.log(`evf timing: ${task.id} at ${sha7}: installing, starting the quiet database and a production preview.`);
		const install = run("corepack", ["pnpm", "install", "--frozen-lockfile"], { cwd: checkout });
		if (install.code !== 0) fail(`Dependency install failed in ${checkout}:\n${install.stderr.trim()}`);
		db = startQuietDatabase(checkout, sha7);
		preview = startTimingPreview(checkout, db.previewEnv);
		if (preview.head !== head) fail(`The timing preview serves ${preview.head}, not ${head}.`);
		const limit = loadLimit(root);
		console.log(`evf timing: preview ${preview.url} on the quiet database; ${describeLoad(loadavg()[0], limit)}.`);
		const job: Job = {
			setFile,
			url: preview.url,
			databaseUrl: db.adminUrl,
			env: db.previewEnv,
			checkout,
			out,
			limit: limit.limit,
			lock: join(evfDataDir(root), "timing.lock"),
			meta: { task: task.id, head, database: "quiet local Postgres (D81)", previewUrl: preview.url },
		};
		writeFileSync(join(jobDir, "job.json"), JSON.stringify(job), { mode: 0o600 });
		process.env.EVF_TIMING_JOB = join(jobDir, "job.json");
		return await browserRun([process.execPath, import.meta.filename], { timeoutSeconds: opts.timeoutSeconds });
	} finally {
		delete process.env.EVF_TIMING_JOB;
		rmSync(jobDir, { recursive: true, force: true });
		if (preview) stopTimingPreview(preview);
		if (db) stopQuietDatabase(db);
		run("git", ["worktree", "remove", "--force", checkout], { cwd: root });
	}
}

if (import.meta.main) {
	const path = process.env.EVF_TIMING_JOB;
	if (!path) {
		console.error("evf timing: run it as bin/evf timing <task> --set <file>.");
		process.exitCode = 2;
	} else {
		const job = JSON.parse(readFileSync(path, "utf8")) as Job;
		rmSync(path, { force: true });
		process.exitCode = await sampleJob(job).catch((e: unknown) => {
			console.error(`evf timing: ${e instanceof Error ? e.message : String(e)}`);
			return 1;
		});
		process.exit();
	}
}
