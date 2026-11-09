#!/usr/bin/env node
// Setup step timing for local previews: how long install and build take, and whether the build cache was warm.
//   node scripts/setup-step.mjs run --source stack|verify-preview --step install|build --records <dir>
//        [--task <t>] [--role <r>] -- <command...>     run the command unchanged and record one setup step
//   node scripts/setup-step.mjs report [--json] [--records <dir>]   weekly totals per (source, step)
// Records are one JSON file each, outside the checkout: <git common dir>/evf-setup-steps, or EVF_SETUP_STEPS_DIR.
// A record holds exactly the eight RECORD_KEYS. Step names are fixed labels, never the command line.
import { spawn, spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdirSync, readdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

export const RECORD_KEYS = ["task", "head", "role", "source", "step", "startedAt", "durationMs", "cacheState"];
const SOURCES = ["stack", "verify-preview"];
const STEPS = ["install", "build"];
const WRAPPER = fileURLToPath(import.meta.url);

/** The record directory for a checkout, or null when it is not a git checkout and no override is set. */
export function recordsDir(cwd) {
	if (process.env.EVF_SETUP_STEPS_DIR) return process.env.EVF_SETUP_STEPS_DIR;
	const git = spawnSync("git", ["-C", cwd, "rev-parse", "--path-format=absolute", "--git-common-dir"], {
		encoding: "utf8",
	});
	return git.status === 0 ? join(git.stdout.trim(), "evf-setup-steps") : null;
}

/**
 * The same preview config with its install and build commands run through this wrapper. Every other key and the
 * commands themselves stay as they were. Portless gives jobs a fixed env, so task and role travel as wrapper options.
 */
export function wrapSetupCommands(config, { source, records, node }) {
	const wrapped = { ...config };
	for (const step of STEPS) {
		if (!config[step]) continue;
		const who = [
			...(process.env.EVF_TASK ? ["--task", process.env.EVF_TASK] : []),
			...(process.env.EVF_ROLE ? ["--role", process.env.EVF_ROLE] : []),
		];
		wrapped[step] = [
			node,
			WRAPPER,
			"run",
			"--source",
			source,
			"--step",
			step,
			"--records",
			records,
			...who,
			"--",
			...config[step],
		];
	}
	return wrapped;
}

/** hit when the build cache already has content, miss when it is missing or empty, unknown when it cannot be read. */
export function buildCacheState(cwd) {
	try {
		return readdirSync(join(cwd, "apps/web/.next/cache")).length > 0 ? "hit" : "miss";
	} catch (error) {
		return error.code === "ENOENT" ? "miss" : "unknown";
	}
}

function head(cwd) {
	if (process.env.PREVIEW_SHA) return process.env.PREVIEW_SHA;
	const git = spawnSync("git", ["-C", cwd, "rev-parse", "HEAD"], { encoding: "utf8" });
	return git.status === 0 ? git.stdout.trim() : null;
}

function writeRecord(dir, record) {
	mkdirSync(dir, { recursive: true, mode: 0o700 });
	const file = join(
		dir,
		`${record.startedAt.replace(/[:.]/g, "-")}-${record.source}-${record.step}-${randomUUID().slice(0, 8)}.json`,
	);
	writeFileSync(`${file}.tmp`, JSON.stringify(record) + "\n", { mode: 0o600 });
	renameSync(`${file}.tmp`, file);
}

async function run(args) {
	const split = args.indexOf("--");
	const { values } = parseArgs({
		args: split < 0 ? args : args.slice(0, split),
		options: {
			source: { type: "string" },
			step: { type: "string" },
			records: { type: "string" },
			task: { type: "string" },
			role: { type: "string" },
		},
	});
	const command = split < 0 ? [] : args.slice(split + 1);
	if (!SOURCES.includes(values.source) || !STEPS.includes(values.step) || !values.records || !command.length) {
		console.error(
			"Usage: setup-step.mjs run --source stack|verify-preview --step install|build --records <dir> -- <command...>",
		);
		process.exit(2);
	}
	const cwd = process.cwd();
	// Read the cache before the build writes to it.
	const cacheState = values.step === "build" ? buildCacheState(cwd) : "unknown";
	const startedAt = new Date();
	const started = performance.now();
	const result = await new Promise((resolve) => {
		const child = spawn(command[0], command.slice(1), { stdio: "inherit" });
		child.on("error", (error) => resolve({ error }));
		child.on("exit", (code, signal) => resolve({ code, signal }));
	});
	const record = {
		task: values.task ?? null,
		head: head(cwd),
		role: values.role ?? null,
		source: values.source,
		step: values.step,
		startedAt: startedAt.toISOString(),
		durationMs: Math.round(performance.now() - started),
		cacheState,
	};
	try {
		writeRecord(values.records, record);
	} catch (error) {
		console.error(
			`setup-step: could not write the ${values.step} record (${error.code ?? error.message}); the command result is unchanged.`,
		);
	}
	if (result.error) {
		console.error(result.error.message);
		process.exit(1);
	}
	if (result.signal) process.kill(process.pid, result.signal);
	process.exit(result.code ?? 1);
}

/** ISO 8601 week of a date, in UTC, as 2026-W45. */
export function isoWeek(date) {
	const d = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
	d.setUTCDate(d.getUTCDate() + 4 - (d.getUTCDay() || 7));
	const year = d.getUTCFullYear();
	const week = Math.ceil(((d - Date.UTC(year, 0, 1)) / 86_400_000 + 1) / 7);
	return `${year}-W${String(week).padStart(2, "0")}`;
}

function weekStart(date) {
	const d = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
	d.setUTCDate(d.getUTCDate() - ((d.getUTCDay() || 7) - 1));
	return d;
}

function isRecord(value) {
	return (
		value &&
		typeof value === "object" &&
		Object.keys(value).length === RECORD_KEYS.length &&
		RECORD_KEYS.every((key) => key in value) &&
		SOURCES.includes(value.source) &&
		STEPS.includes(value.step) &&
		["hit", "miss", "unknown"].includes(value.cacheState) &&
		Number.isFinite(value.durationMs) &&
		!Number.isNaN(Date.parse(value.startedAt))
	);
}

function readRecords(dir) {
	let files;
	try {
		files = readdirSync(dir).filter((f) => f.endsWith(".json"));
	} catch (error) {
		if (error.code === "ENOENT") return [];
		throw error;
	}
	const records = [];
	let skipped = 0;
	for (const file of files) {
		try {
			const value = JSON.parse(readFileSync(join(dir, file), "utf8"));
			if (isRecord(value)) records.push(value);
			else skipped++;
		} catch {
			skipped++;
		}
	}
	if (skipped) console.error(`setup-step: skipped ${skipped} unreadable record file(s).`);
	return records;
}

/**
 * Each ISO week from the first record to the last, with every (source, step) pair sorted by total time. A week with
 * no records has no pairs. hitRate is hits over hits and misses, and null when the pair has neither.
 */
export function setupReport(records) {
	if (!records.length) return { weeks: [] };
	const times = records.map((r) => Date.parse(r.startedAt));
	const weeks = [];
	for (
		let d = weekStart(new Date(Math.min(...times)));
		d.getTime() <= Math.max(...times);
		d.setUTCDate(d.getUTCDate() + 7)
	)
		weeks.push({ week: isoWeek(d), pairs: [] });
	const pairs = new Map();
	for (const r of records) {
		const key = `${isoWeek(new Date(r.startedAt))} ${r.source} ${r.step}`;
		if (!pairs.has(key))
			pairs.set(key, { week: isoWeek(new Date(r.startedAt)), source: r.source, step: r.step, items: [] });
		pairs.get(key).items.push(r);
	}
	for (const { week, source, step, items } of pairs.values()) {
		const durations = items.map((r) => r.durationMs).sort((a, b) => a - b);
		const mid = Math.floor(durations.length / 2);
		const hits = items.filter((r) => r.cacheState === "hit").length;
		const misses = items.filter((r) => r.cacheState === "miss").length;
		weeks
			.find((w) => w.week === week)
			.pairs.push({
				source,
				step,
				runs: items.length,
				totalMs: durations.reduce((a, b) => a + b, 0),
				medianMs: durations.length % 2 ? durations[mid] : Math.round((durations[mid - 1] + durations[mid]) / 2),
				hitRate: hits + misses ? hits / (hits + misses) : null,
			});
	}
	for (const w of weeks) w.pairs.sort((a, b) => b.totalMs - a.totalMs);
	return { weeks };
}

const seconds = (ms) => (ms >= 60_000 ? `${(ms / 60_000).toFixed(1)} min` : `${(ms / 1000).toFixed(1)} s`);

export function formatReport(report) {
	if (!report.weeks.length) return "no data";
	const lines = [];
	for (const w of report.weeks) {
		lines.push(w.week);
		if (!w.pairs.length) lines.push("  no data");
		for (const p of w.pairs)
			lines.push(
				`  ${`${p.source} ${p.step}`.padEnd(22)} runs ${String(p.runs).padStart(3)}  total ${seconds(p.totalMs).padStart(9)}  median ${seconds(p.medianMs).padStart(9)}  hit rate ${p.hitRate === null ? "no data" : `${Math.round(p.hitRate * 100)}%`}`,
			);
	}
	return lines.join("\n");
}

function report(args) {
	const { values } = parseArgs({ args, options: { json: { type: "boolean" }, records: { type: "string" } } });
	const dir = values.records ?? recordsDir(process.cwd());
	if (!dir) {
		console.error("setup-step: run inside the repository or set EVF_SETUP_STEPS_DIR.");
		process.exit(2);
	}
	const result = setupReport(readRecords(dir));
	console.log(values.json ? JSON.stringify(result, null, 2) : formatReport(result));
}

if (process.argv[1] === WRAPPER) {
	const [action, ...rest] = process.argv.slice(2);
	if (action === "run") await run(rest);
	else if (action === "report") report(rest);
	else {
		console.error("Usage: setup-step.mjs run ... -- <command...> | report [--json] [--records <dir>]");
		process.exit(2);
	}
}
