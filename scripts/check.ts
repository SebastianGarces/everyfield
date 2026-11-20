import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
	copyFileSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	renameSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import { basename, join, relative, resolve } from "node:path";
import {
	CHECKS,
	type CheckId,
	type CoverageMap,
	censusDecision,
	type Decision,
	everything,
	type MapProblem,
	type Package,
	parseCoverageMap,
	type Selection,
	selectChecks,
	suiteOf,
} from "../tools/ci/select.ts";
import { sweepCommand } from "../tools/qa/containers.ts";
import {
	DatabaseError,
	databaseEnv,
	type PostgresOptions,
	sleepSync,
	startPostgres,
	watchProcess,
} from "./throwaway-postgres.ts";

export type Runner = (
	command: string,
	args: readonly string[],
	options: { cwd: string; env: Record<string, string> },
) => { status: number; stdout: string; output: string };

export const spawnRunner: Runner = (command, args, { cwd, env }) => {
	const { NODE_TEST_CONTEXT: _, ...inherited } = process.env;
	const result = spawnSync(command, args, {
		cwd,
		env: { ...inherited, ...env },
		encoding: "utf8",
		maxBuffer: 256 * 1024 * 1024,
		stdio: ["ignore", "pipe", "pipe"],
	});
	const stdout = result.stdout ?? "";
	return { status: result.status ?? 1, stdout, output: `${stdout}${result.stderr ?? ""}${result.error ?? ""}` };
};

type Result = "passed" | "failed" | "skipped" | "not run" | "running";
export type CheckRecord = {
	head: string | null;
	mergeBase: string | null;
	mode: Selection["mode"];
	fullReasons: string[];
	startedAt: string;
	durationMs: number;
	result: "passed" | "failed";
	complete: boolean;
	running: CheckId | null;
	failures: string[];
	checks: {
		id: CheckId;
		run: boolean;
		reason: string;
		command: string | null;
		result: Result;
		tests: number | null;
		durationMs: number;
		detail?: string;
		packages?: { name: string; command: string; result: Result; tests: number | null }[];
		database?: { throwaway: true; image: string; container: string };
		tightened?: string[];
	}[];
	tests: { file: string; check: CheckId; run: boolean; reason: string; result: Result; tests: number | null }[];
};

export const ciHome = (env = process.env) => env.EVERYFIELD_CI_HOME ?? join(homedir(), ".everyfield", "ci");

export type Gh = (args: readonly string[]) => { status: number; stdout: string };
export const spawnGh: Gh = (args) => {
	const r = spawnSync("gh", args, { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
	return { status: r.status ?? 1, stdout: r.stdout ?? "" };
};
export const REPO = "SebastianGarces/everyfield";
export const NIGHTLY_WORKFLOW = "nightly.yml";
export const MAP_ARTIFACT = "coverage-map";

export function coverageMapFor(home: string, gh: Gh): CoverageMap | MapProblem {
	const file = join(home, "coverage-map.json");
	const local = parseCoverageMap(existsSync(file) ? readFileSync(file, "utf8") : null);
	const without = (why: string): CoverageMap | MapProblem =>
		"problem" in local ? { problem: `${local.problem} and ${why}` } : local;
	const listed = gh([
		"run",
		"list",
		"--repo",
		REPO,
		"--workflow",
		NIGHTLY_WORKFLOW,
		"--branch",
		"main",
		"--status",
		"success",
		"--limit",
		"1",
		"--json",
		"databaseId,createdAt",
	]);
	if (listed.status !== 0) return without("gh could not list the GitHub nightly runs");
	let latest: { databaseId: number; createdAt: string } | undefined;
	try {
		latest = JSON.parse(listed.stdout)[0];
	} catch {
		return without("gh run list returned no run list");
	}
	if (!latest) return without("no GitHub nightly run on main has passed yet");
	if (!("problem" in local) && Date.parse(local.createdAt) >= Date.parse(latest.createdAt)) return local;
	const run = `GitHub nightly run ${latest.databaseId}`;
	const dir = mkdtempSync(join(tmpdir(), "evf-coverage-map-"));
	try {
		const got = gh([
			"run",
			"download",
			String(latest.databaseId),
			"--repo",
			REPO,
			"--name",
			MAP_ARTIFACT,
			"--dir",
			dir,
		]);
		if (got.status !== 0) return without(`gh could not download the coverage map of ${run}`);
		const downloaded = join(dir, "coverage-map.json");
		const map = parseCoverageMap(existsSync(downloaded) ? readFileSync(downloaded, "utf8") : null);
		if ("problem" in map) return without(`the download of ${run} is unusable: ${map.problem}`);
		mkdirSync(home, { recursive: true });
		writeFileSync(file + ".tmp", JSON.stringify(map, null, 2) + "\n");
		renameSync(file + ".tmp", file);
		return map;
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
}

const git = (root: string, args: string[]) => {
	const r = spawnSync("git", ["-C", root, ...args], { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
	return r.status === 0 ? r.stdout : null;
};
const lines = (text: string | null, sep = "\n") => (text ?? "").split(sep).filter(Boolean);
const testCount = (output: string) =>
	[...output.matchAll(/(?:ℹ|#) tests (\d+)\s*$/gm)].reduce((sum, [, n]) => sum + Number(n), 0);

function gather(root: string, home: string, full: boolean, gh: Gh) {
	const head = git(root, ["rev-parse", "HEAD"])?.trim() ?? null;
	const mergeBase = git(root, ["merge-base", "HEAD", "origin/main"])?.trim() ?? null;
	const diff = mergeBase ? git(root, ["diff", "--name-only", "-z", mergeBase]) : null;
	const untracked = git(root, ["ls-files", "--others", "--exclude-standard", "-z"]);
	const changed =
		diff === null || untracked === null ? null : [...new Set([...lines(diff, "\0"), ...lines(untracked, "\0")])];
	const files = lines(git(root, ["ls-files", "--cached", "--others", "--exclude-standard", "-z"]), "\0").filter((f) =>
		existsSync(join(root, f)),
	);
	const packages: Package[] = files
		.filter((f) => /^(?:apps|packages)\/[^/]+\/package\.json$/.test(f))
		.map((f) => {
			const pkg = JSON.parse(readFileSync(join(root, f), "utf8")) as {
				name?: string;
				scripts?: Record<string, string>;
			};
			return { dir: f.slice(0, -"/package.json".length), name: pkg.name ?? "", scripts: pkg.scripts ?? {} };
		});
	const map: CoverageMap | MapProblem = full
		? { problem: "a full run reads no coverage map" }
		: coverageMapFor(home, gh);
	return { head, mergeBase, changed, packages, map, testFiles: files.filter((f) => suiteOf(f)).sort() };
}

export const CENSUS_PACKAGE = "@everyfield/domain";
export const CENSUS_ELSEWHERE = "runs as the census check (bin/dev census)";

export const checkTmp = (root: string, home: string) =>
	join(home, "tmp", createHash("sha256").update(resolve(root)).digest("hex").slice(0, 12));

const oxlintThreads = `if(/[\\/]oxlint[\\/]bin[\\/]oxlint$/.test(process.argv[1]??"")&&!process.argv.some((a)=>a.startsWith("--threads")))process.argv.push("--threads=3")`;
export const OXLINT_PRELOAD = `--import=data:text/javascript,${encodeURIComponent(oxlintThreads)}`;

function checkEnv(tmp: string) {
	rmSync(tmp, { recursive: true, force: true });
	mkdirSync(tmp, { recursive: true });
	return {
		PATH: `${process.execPath.replace(/\/[^/]+$/, "")}:${process.env.PATH ?? ""}`,
		TMPDIR: tmp,
		EVF_NODE_TEST_FLAGS: process.env.EVF_NODE_TEST_FLAGS ?? "--test-concurrency=3",
	};
}

export type CheckOptions = {
	root: string;
	full: boolean;
	home?: string;
	now?: Date;
	run?: Runner;
	gh?: Gh;
	database?: Partial<Pick<PostgresOptions, "readyTimeoutMs" | "sleep" | "watch">>;
};

export function check({
	root,
	full,
	home = ciHome(),
	now = new Date(),
	run = spawnRunner,
	gh = spawnGh,
	database = {},
}: CheckOptions) {
	root = resolve(root);
	if (!relative(root, resolve(home)).startsWith("..")) throw new Error(`The CI home ${home} must be outside ${root}.`);
	const started = Date.now();
	const input = gather(root, home, full, gh);
	const context = { testFiles: input.testFiles, packages: input.packages, now };
	const selection = full
		? everything(["verifier run (--full) ignores selection"], context)
		: selectChecks(input.changed, input.map, context);
	const env = checkEnv(checkTmp(root, home));
	const failures: string[] = [];
	const testRecords: CheckRecord["tests"] = Object.entries(selection.tests).map(([file, d]) => ({
		file,
		check: suiteOf(file)!,
		run: d.run,
		reason: d.reason,
		result: d.run ? "not run" : "skipped",
		tests: null,
	}));
	const checks: CheckRecord["checks"] = [];
	const assemble = (running: CheckId | null): CheckRecord => {
		const found = [...failures];
		for (const c of checks)
			if (c.result === "failed")
				found.push(
					c.detail ? `${c.id} failed: ${c.detail}` : c.tests === 0 ? `${c.id} reported 0 tests` : `${c.id} failed`,
				);
		if (running) found.push(`incomplete: ${running} was still running when this record was written`);
		else for (const t of testRecords) if (t.run && t.tests === 0) found.push(`${t.file} reported 0 tests`);
		return {
			head: input.head,
			mergeBase: input.mergeBase,
			mode: selection.mode,
			fullReasons: selection.fullReasons,
			startedAt: new Date(started).toISOString(),
			durationMs: Date.now() - started,
			result: found.length ? "failed" : "passed",
			complete: running === null,
			running,
			failures: [...new Set(found)],
			checks,
			tests: testRecords,
		};
	};
	const progress = (running: CheckId) => writeRecord(home, root, "checks.json", assemble(running));
	for (const id of Object.keys(CHECKS) as CheckId[]) {
		const decision = id === "census" ? { run: false, reason: CENSUS_ELSEWHERE } : selection.checks[id];
		const entry: CheckRecord["checks"][number] = {
			id,
			...decision,
			command: null,
			result: decision.run ? "not run" : "skipped",
			tests: null,
			durationMs: 0,
		};
		checks.push(entry);
		if (!decision.run) continue;
		entry.result = "running";
		progress(id);
		const t0 = Date.now();
		const definition = CHECKS[id];
		const exec = (command: string, args: string[], extra: Record<string, string> = {}) => {
			entry.command = [command, ...args].join(" ");
			console.error(`check ${id}: ${entry.command}`);
			const r = run(command, args, { cwd: root, env: { ...env, ...extra } });
			process.stderr.write(r.output.endsWith("\n") || !r.output ? r.output : r.output + "\n");
			return r;
		};
		if (definition.kind === "package") {
			const filters =
				selection.mode === "full"
					? ["-r"]
					: [`...[${input.mergeBase}]`, ...selection.packageFilters].flatMap((f) => ["--filter", f]);
			const listed = run("corepack", ["pnpm", ...filters, "ls", "--depth", "-1", "--json"], { cwd: root, env });
			let names: string[] = [];
			try {
				if (listed.status === 0) names = (JSON.parse(listed.stdout) as { name: string }[]).map((p) => p.name);
			} catch {}
			if (!names.length) {
				entry.command = `corepack pnpm ${filters.join(" ")} ls`;
				entry.result = "failed";
				entry.reason += "; the pnpm filter selected no package";
				continue;
			}
			const defining = input.packages.filter((p) => names.includes(p.name) && p.scripts[definition.script]);
			if (id === "test:db" && defining.length && defining.every((p) => p.name === CENSUS_PACKAGE)) {
				entry.result = "skipped";
				entry.reason += `; only ${CENSUS_PACKAGE} defines test:db, the statement census, which ${CENSUS_ELSEWHERE}`;
				continue;
			}
			if (!defining.length) {
				entry.result = "skipped";
				entry.reason += `; no selected package defines ${definition.script}`;
				continue;
			}
			if (id === "test:db") {
				const runnable = defining.map((p) => p.name).filter((name) => name !== CENSUS_PACKAGE);
				databaseTests(entry, runnable.sort(), { root, env, run, ...database });
				entry.durationMs = Date.now() - t0;
				continue;
			}
			const concurrency = id === "test:unit" ? ["--workspace-concurrency=2"] : [];
			const extra =
				id === "lint"
					? { NODE_OPTIONS: [process.env.NODE_OPTIONS, OXLINT_PRELOAD].filter(Boolean).join(" ") }
					: undefined;
			const r = exec("corepack", ["pnpm", ...filters, ...concurrency, "--if-present", "run", definition.script], extra);
			entry.result = r.status === 0 ? "passed" : "failed";
			if (id === "test:unit") {
				entry.tests = testCount(r.output);
				if (entry.tests === 0) entry.result = "failed";
			}
		} else if (definition.kind === "command") {
			const [command, ...args] = definition.command;
			const r = exec(command === "node" ? process.execPath : command, args);
			entry.result = r.status === 0 ? "passed" : "failed";
		} else {
			const files = testRecords.filter((t) => t.check === id && t.run);
			if (!files.length) {
				entry.result = "failed";
				entry.tests = 0;
				continue;
			}
			const dir = mkdtempSync(join(tmpdir(), "evf-check-"));
			const report = join(dir, "report.json");
			try {
				const r = exec(process.execPath, ["scripts/test-workflow.mjs", ...files.map((t) => t.file)], {
					EVF_TEST_REPORT: report,
				});
				const reported = existsSync(report)
					? (JSON.parse(readFileSync(report, "utf8")) as { tests: { file?: string; status: string }[] }).tests
					: [];
				for (const t of files) {
					const own = reported.filter((x) => x.file && relative(root, x.file) === t.file);
					t.tests = own.length;
					t.result = own.length && own.every((x) => x.status === "passed") ? "passed" : "failed";
				}
				entry.tests = files.reduce((sum, t) => sum + (t.tests ?? 0), 0);
				entry.result = r.status === 0 && files.every((t) => t.result === "passed") ? "passed" : "failed";
			} finally {
				rmSync(dir, { recursive: true, force: true });
			}
		}
		entry.durationMs = Date.now() - t0;
	}
	if (selection.mode === "selected" && !checks.some((c) => c.run))
		failures.push("the diff selected no checks, so nothing proves it; run bin/dev check --full");
	const record = assemble(null);
	return { record, recordPath: writeRecord(home, root, "checks.json", record) };
}

function writeRecord(home: string, root: string, name: string, record: CheckRecord) {
	const dir = join(home, "checks", basename(root));
	mkdirSync(dir, { recursive: true });
	const recordPath = join(dir, name);
	writeFileSync(recordPath, JSON.stringify(record, null, 2) + "\n");
	return recordPath;
}

type DatabaseOptions = Omit<PostgresOptions, "readyTimeoutMs" | "sleep" | "watch"> & Partial<PostgresOptions>;

function throwawayFor(entry: CheckRecord["checks"][number], options: DatabaseOptions) {
	try {
		return startPostgres({ readyTimeoutMs: 60_000, sleep: sleepSync, watch: watchProcess, ...options });
	} catch (error) {
		if (!(error instanceof DatabaseError)) throw error;
		entry.result = "failed";
		entry.detail = error.message;
		return undefined;
	}
}

function databaseTests(entry: CheckRecord["checks"][number], names: string[], options: DatabaseOptions) {
	const { root, env, run } = options;
	entry.packages = names.map((name) => ({
		name,
		command: `corepack pnpm --filter ${name} run test:db`,
		result: "not run",
		tests: null,
	}));
	entry.command = entry.packages.map((p) => p.command).join("; ");
	const problems: string[] = [];
	const db = throwawayFor(entry, options);
	if (!db) return;
	try {
		entry.database = { throwaway: true, image: db.image, container: db.container };
		for (const p of entry.packages) {
			console.error(`check test:db: ${p.command} on ${db.container}`);
			const r = run("corepack", ["pnpm", "--filter", p.name, "run", "test:db"], {
				cwd: root,
				env: { ...env, ...databaseEnv(db.url) },
			});
			const output = r.output.replaceAll(db.password, "***");
			process.stderr.write(output.endsWith("\n") || !output ? output : output + "\n");
			p.tests = testCount(r.output);
			p.result = r.status === 0 && p.tests > 0 ? "passed" : "failed";
			if (p.result === "failed")
				problems.push(r.status === 0 ? `${p.name} reported 0 tests` : `${p.name} test:db failed`);
		}
	} finally {
		db.stop();
	}
	entry.tests = entry.packages.reduce((sum, p) => sum + (p.tests ?? 0), 0);
	entry.result = problems.length ? "failed" : "passed";
	if (problems.length) entry.detail = problems.join("; ");
}

const LIMITS = "tests/integration/writes/limits.json";
const NEXT_RETRY = "Retry the same command to continue";
const CENSUS_PROBLEM = /^\s*\+\s+'(.+)',?$/gm;

function census(entry: CheckRecord["checks"][number], options: DatabaseOptions) {
	const { root, env, run } = options;
	const build = ["corepack", "pnpm", "--filter", "@everyfield/web", "run", "build"];
	const test = ["corepack", "pnpm", "--filter", CENSUS_PACKAGE, "run", "test:db"];
	entry.command = `${build.join(" ")}; ${test.join(" ")}`;
	const db = throwawayFor(entry, options);
	if (!db) return;
	const tightenedDir = mkdtempSync(join(tmpdir(), "evf-census-tightened-"));
	try {
		entry.database = { throwaway: true, image: db.image, container: db.container };
		const dbEnv = { ...env, ...databaseEnv(db.url) };
		const show = (output: string) => {
			const text = output.replaceAll(db.password, "***");
			process.stderr.write(text.endsWith("\n") || !text ? text : text + "\n");
			return text;
		};
		const buildOnce = () => {
			console.error(`check census: ${build.join(" ")}`);
			const r = run(build[0]!, build.slice(1), { cwd: root, env: { ...dbEnv, NEXT_TELEMETRY_DISABLED: "1" } });
			show(r.output);
			return r;
		};
		let built = buildOnce();
		if (built.status !== 0 && built.output.includes(NEXT_RETRY)) built = buildOnce();
		if (built.status !== 0) {
			entry.result = "failed";
			entry.detail = "the production build for the request budgets failed";
			return;
		}
		console.error(`check census: ${test.join(" ")} on ${db.container}`);
		const r = run(test[0]!, test.slice(1), { cwd: root, env: { ...dbEnv, EVF_CENSUS_TIGHTENED: tightenedDir } });
		const output = show(r.output);
		entry.tests = testCount(r.output);
		entry.result = r.status === 0 && entry.tests > 0 ? "passed" : "failed";
		if (entry.result === "failed") {
			const problems = [...new Set([...output.matchAll(CENSUS_PROBLEM)].map((m) => m[1]!))];
			entry.detail = problems.length
				? `statement census: ${problems.join("; ")}`
				: r.status === 0
					? "the statement census reported 0 tests"
					: "the statement census failed; see its output above";
		}
		const tightened = join(tightenedDir, "limits.json");
		if (existsSync(tightened)) {
			copyFileSync(tightened, join(root, LIMITS));
			entry.tightened = readFileSync(join(tightenedDir, "changes.md"), "utf8")
				.split("\n")
				.filter((line) => line.startsWith("- "))
				.map((line) => line.slice(2));
		}
	} finally {
		rmSync(tightenedDir, { recursive: true, force: true });
		db.stop();
	}
}

export type CensusOptions = Omit<CheckOptions, "full" | "gh"> & { all: boolean };

export function censusCheck({ root, all, home = ciHome(), run = spawnRunner, database = {} }: CensusOptions) {
	root = resolve(root);
	if (!relative(root, resolve(home)).startsWith("..")) throw new Error(`The CI home ${home} must be outside ${root}.`);
	const started = Date.now();
	const head = git(root, ["rev-parse", "HEAD"])?.trim() ?? null;
	const mergeBase = git(root, ["merge-base", "HEAD", "origin/main"])?.trim() ?? null;
	const diff = mergeBase ? git(root, ["diff", "--name-only", "-z", mergeBase]) : null;
	const untracked = git(root, ["ls-files", "--others", "--exclude-standard", "-z"]);
	const changed = diff === null || untracked === null ? null : [...lines(diff, "\0"), ...lines(untracked, "\0")];
	const decision: Decision = all
		? { run: true, reason: "--all runs it regardless of the diff" }
		: censusDecision(changed);
	const entry: CheckRecord["checks"][number] = {
		id: "census",
		...decision,
		command: null,
		result: decision.run ? "not run" : "skipped",
		tests: null,
		durationMs: 0,
	};
	const assemble = (running: boolean): CheckRecord => {
		const failures = [
			...(entry.result === "failed" ? [`census failed: ${entry.detail}`] : []),
			...(running ? ["incomplete: census was still running when this record was written"] : []),
		];
		return {
			head,
			mergeBase,
			mode: all ? "full" : "selected",
			fullReasons: all ? ["--all runs the census regardless of the diff"] : [],
			startedAt: new Date(started).toISOString(),
			durationMs: Date.now() - started,
			result: failures.length ? "failed" : "passed",
			complete: !running,
			running: running ? "census" : null,
			failures,
			checks: [entry],
			tests: [],
		};
	};
	if (decision.run) {
		entry.result = "running";
		writeRecord(home, root, "census.json", assemble(true));
		const env = checkEnv(`${checkTmp(root, home)}-census`);
		census(entry, { root, env, run, scope: "census", ...database });
		entry.durationMs = Date.now() - started;
	}
	const record = assemble(false);
	return { record, recordPath: writeRecord(home, root, "census.json", record) };
}

export function censusCommand(args: string[], root: string): number {
	const all = args.includes("--all");
	if (args.some((a) => a !== "--all")) {
		console.error("usage: dev census [--all]");
		return 2;
	}
	const { record, recordPath } = censusCheck({ root, all });
	const entry = record.checks[0]!;
	console.log(entry.run ? `census: ${record.result}. ${entry.reason}.` : `census: skipped, ${entry.reason}.`);
	for (const failure of record.failures) console.log(`FAIL ${failure}`);
	if (entry.tightened?.length) {
		console.log(`The census tightened ${LIMITS} in this worktree; commit it in this change:`);
		for (const change of entry.tightened) console.log(`  ${change}`);
	}
	console.log(`census record: ${recordPath}`);
	return record.result === "passed" ? 0 : 1;
}

export function checkCommand(args: string[], root: string): number {
	const full = args.includes("--full");
	if (args.some((a) => a !== "--full")) {
		console.error("usage: dev check [--full]");
		return 2;
	}
	sweepCommand();
	const { record, recordPath } = check({ root, full });
	const ran = record.checks.filter((c) => c.run).map((c) => c.id);
	console.log(`check ${record.mode}: ${record.result}. Ran ${ran.join(", ") || "nothing"}.`);
	if (record.mode === "full") console.log(`Full because ${record.fullReasons.join("; ")}.`);
	for (const failure of record.failures) console.log(`FAIL ${failure}`);
	console.log(`check record: ${recordPath}`);
	return record.result === "passed" ? 0 : 1;
}
