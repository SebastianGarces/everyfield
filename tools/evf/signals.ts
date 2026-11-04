import { cpSync, existsSync, mkdtempSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { loadavg } from "node:os";
import { join } from "node:path";
import { findTask, openWorkDb, record, workDbPath } from "./db.ts";
import { git, oneLine, redactConnections, type TaskRef } from "./lib.ts";
import type { CheckReport, CheckResult, Mode, Role } from "./verify.ts";

/** Who started this verify, when a drive stage did. Any other caller is a seat or a person. */
export type DriveCaller = "pr-stage" | "evf-check";
type RunResult = "passed" | "failed" | "invalidated" | "error";

type Context = {
	root: string;
	wt: string;
	task: TaskRef;
	sha: string;
	baseSha: string;
	role: Role;
	mode: Mode;
	dir: string;
	queuedMs: number;
	caller?: DriveCaller;
};

const elapsed = (from: number) => Math.round(performance.now() - from);
const TEST_PATH = /(^|\/)tests\/|(^|\/)[^/]*\.test\.[^/]+$/;

/** What the evidence folder holds now: the next free `attempt-<n>` number and the earlier run's entries, if any. */
function earlierRun(dir: string): { next: number; entries: string[] } {
	const all = readdirSync(dir),
		used = all.flatMap((e) => /^attempt-(\d+)$/.exec(e)?.[1] ?? []).map(Number);
	return { next: Math.max(0, ...used) + 1, entries: all.filter((e) => !/^\.?attempt-/.test(e)) };
}

/**
 * Copy the earlier run to `attempt-<next>`. The copy is built under a temporary name and renamed last, so a crash never
 * leaves a half-written attempt.
 */
function keepEarlierRun(dir: string, { next, entries }: { next: number; entries: string[] }): void {
	const target = join(dir, `attempt-${next}`),
		building = mkdtempSync(join(dir, ".attempt-"));
	try {
		for (const entry of entries) cpSync(join(dir, entry), join(building, entry), { recursive: true });
		if (entries.includes("checks.json")) {
			const path = join(building, "checks.json"),
				report = JSON.parse(readFileSync(path, "utf8")) as CheckReport,
				inside = (p: string) => (p.startsWith(`${dir}/`) ? join(target, p.slice(dir.length + 1)) : p);
			report.evidenceDir = target;
			for (const check of report.checks) check.log = inside(check.log);
			writeFileSync(path, JSON.stringify(report, null, 2) + "\n");
		}
		renameSync(building, target);
	} finally {
		rmSync(building, { recursive: true, force: true });
	}
}

/** The test names one check failed: its EVF_TEST_REPORT file and the names `evf test` wrote, each name once. */
function failedNames(testReport: string, failedTests: string): string[] {
	const names = new Set<string>();
	if (existsSync(testReport)) {
		const { tests } = JSON.parse(readFileSync(testReport, "utf8")) as {
			tests: Array<{ name: unknown; status: unknown }>;
		};
		for (const t of tests) if (t.status === "failed" && typeof t.name === "string") names.add(t.name);
	}
	if (existsSync(failedTests))
		for (const line of readFileSync(failedTests, "utf8").split("\n")) if (line) names.add(JSON.parse(line) as string);
	return [...names];
}

/**
 * The events of one verify run. They only observe: every failure here becomes one warning line on stderr, so verify
 * runs the same checks and returns the same result without them. Payloads are built from these fields by hand, and
 * never from a command, the environment or a log.
 */
export function checkSignals(ctx: Context) {
	const { root, wt, task, sha, baseSha, role, mode, dir, queuedMs, caller } = ctx;
	let warned = false;
	const guard = <T>(what: string, action: () => T): T | undefined => {
		try {
			return action();
		} catch (error) {
			if (!warned) console.error(`evf verify: warning: ${what}: ${oneLine(String(error))}`);
			warned = true;
			return undefined;
		}
	};
	let target = guard("no check events recorded", () => {
		if (!existsSync(workDbPath(root))) throw new Error(`no work store at ${workDbPath(root)}`);
		const db = openWorkDb(root);
		try {
			const row = findTask(db, task);
			if (!row) throw new Error(`the work store does not know ${task.id}`);
			const id = Number(process.env.EVF_RUN);
			return { taskId: row.id, run: id && db.prepare("SELECT 1 FROM runs WHERE id = ?").get(id) ? id : null };
		} finally {
			db.close();
		}
	});
	const emit = (type: string, payload: Record<string, unknown>) => {
		const open = target;
		if (!open) return;
		const written = guard("check events stopped", () => {
			const db = openWorkDb(root);
			try {
				record(db, open.taskId, open.run, type, payload);
				return true;
			} finally {
				db.close();
			}
		});
		if (!written) target = undefined;
	};
	const treeHash = git(wt, "rev-parse", "HEAD^{tree}"),
		trigger = caller ?? (process.env.EVF_RUN ? "seat" : "manual"),
		runFields = (durationMs: number | null, result: RunResult | null) => ({
			run: target?.run ?? null,
			task: task.id,
			head: sha,
			treeHash,
			role,
			mode,
			trigger,
			queuedMs,
			durationMs,
			result,
		});
	const earlier = earlierRun(dir);
	if (earlier.entries.length) guard("earlier evidence not copied", () => keepEarlierRun(dir, earlier));
	const attempt = earlier.entries.length ? earlier.next + 1 : earlier.next;
	const touchesTestPaths = git(wt, "diff", "--name-only", "--no-renames", "-z", `${baseSha}..${sha}`)
		.split("\0")
		.some((path) => TEST_PATH.test(path));
	const started = performance.now();
	emit("check_start", runFields(null, null));
	return {
		/** Start one suite's clock. The returned function stops it and gives the entry for checks.json. */
		suite() {
			const startedAt = new Date().toISOString(),
				loadStart = loadavg()[0],
				from = performance.now();
			return (result: CheckResult): CheckResult => {
				const durationMs = elapsed(from);
				emit("check_suite_end", {
					task: task.id,
					head: sha,
					role,
					mode,
					suite: result.name,
					startedAt,
					durationMs,
					passed: result.passed,
					loadStart,
					loadEnd: loadavg()[0],
				});
				return { ...result, startedAt, durationMs };
			};
		},
		testsFailed(suite: string, testReport: string, failedTests: string) {
			for (const name of guard("failed test names not read", () => failedNames(testReport, failedTests)) ?? []) {
				emit("test_failed", {
					task: task.id,
					head: sha,
					attempt,
					suite,
					test: redactConnections(name),
					touchesTestPaths,
				});
			}
		},
		end(result: RunResult) {
			emit("check_end", runFields(elapsed(started), result));
		},
	};
}
