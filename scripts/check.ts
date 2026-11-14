// `bin/dev check [--full]`: the local product checks a change needs (T-41). An author run checks what
// tools/ci/select.ts selects from the diff against the merge base with origin/main, through the coverage map of the
// latest green GitHub nightly (.github/workflows/nightly.yml, T-216); `--full`, the verifier's mode, runs everything.
// Either way it writes a checks.json record outside the repository and prints its path.
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { basename, join, relative, resolve } from "node:path";
import {
	CHECKS,
	type CheckId,
	type CoverageMap,
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

/** Runs one command to its end. Tests pass a fake; the real one is `spawnRunner`. */
export type Runner = (
	command: string,
	args: readonly string[],
	options: { cwd: string; env: Record<string, string> },
) => { status: number; stdout: string; output: string };

export const spawnRunner: Runner = (command, args, { cwd, env }) => {
	// Without NODE_TEST_CONTEXT: a test runner that inherits it reports to its parent instead of counting.
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

type Result = "passed" | "failed" | "skipped" | "not run";
export type CheckRecord = {
	head: string | null;
	mergeBase: string | null;
	mode: Selection["mode"];
	fullReasons: string[];
	startedAt: string;
	durationMs: number;
	result: "passed" | "failed";
	failures: string[];
	checks: {
		id: CheckId;
		run: boolean;
		reason: string;
		command: string | null;
		result: Result;
		tests: number | null;
		durationMs: number;
		/** Why a check that ran failed, when it says more than "failed". */
		detail?: string;
		/** test:db: one line per package, in the order they ran. */
		packages?: { name: string; command: string; result: Result; tests: number | null }[];
		/** test:db: the throwaway database the packages ran on. Never its password. */
		database?: { throwaway: true; image: string; container: string };
	}[];
	tests: { file: string; check: CheckId; run: boolean; reason: string; result: Result; tests: number | null }[];
};

/** Where the coverage map and records live: outside every checkout. */
export const ciHome = (env = process.env) => env.EVERYFIELD_CI_HOME ?? join(homedir(), ".everyfield", "ci");

/** A command runner shaped like `gh`: tests pass a fake. */
export type Gh = (args: readonly string[]) => { status: number; stdout: string };
export const spawnGh: Gh = (args) => {
	const r = spawnSync("gh", args, { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
	return { status: r.status ?? 1, stdout: r.stdout ?? "" };
};
export const REPO = "SebastianGarces/everyfield";
/** The GitHub workflow that writes the coverage map, and the name of the run artifact that holds it. */
export const NIGHTLY_WORKFLOW = "nightly.yml";
export const MAP_ARTIFACT = "coverage-map";

/**
 * The coverage map selection reads: the one in the CI home, replaced first by the map of the latest successful
 * nightly run on main when that run is newer (or the home has no usable map). The download goes to a temporary folder
 * and replaces the home's map only once parseCoverageMap accepts it. When gh cannot list or download, or the
 * download is unusable, the home's map stays in use; without one, the problem says why, and selection runs everything.
 */
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
	// An off-shape run fails safe: its download fails, and the reason says so.
	let latest: { databaseId: number; createdAt: string } | undefined;
	try {
		latest = JSON.parse(listed.stdout)[0];
	} catch {
		return without("gh run list returned no run list");
	}
	if (!latest) return without("no GitHub nightly run on main has passed yet");
	// The map of a run is written after the run starts, so a map from that run or a later one is not older.
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
/** Sums node:test's summary lines (spec `ℹ tests N` or TAP `# tests N`) across every run in the output. */
const testCount = (output: string) =>
	[...output.matchAll(/(?:ℹ|#) tests (\d+)\s*$/gm)].reduce((sum, [, n]) => sum + Number(n), 0);

/**
 * Reads the inputs selection needs from the checkout. A git failure means an unreadable diff, never an empty one. A
 * full run selects nothing, so it reads no coverage map.
 */
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

/** The package whose test:db is the statement census. It runs in GitHub CI only, never in bin/dev check (T-105). */
export const CENSUS_PACKAGE = "@everyfield/domain";

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
	const env = { PATH: `${process.execPath.replace(/\/[^/]+$/, "")}:${process.env.PATH ?? ""}` };
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
	for (const id of Object.keys(CHECKS) as CheckId[]) {
		const decision = selection.checks[id];
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
			// The packages the filter selects, from pnpm itself. A filter that selects none would make every package
			// check a silent no-op, so it fails instead.
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
				entry.reason += `; only ${CENSUS_PACKAGE} defines test:db, the statement census, which runs in GitHub CI only`;
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
			const r = exec("corepack", ["pnpm", ...filters, "--if-present", "run", definition.script]);
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
				// No file to hand the runner, which would otherwise run its default set. A suite with nothing is a gap.
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
	for (const c of checks)
		if (c.result === "failed")
			failures.push(
				c.detail ? `${c.id} failed: ${c.detail}` : c.tests === 0 ? `${c.id} reported 0 tests` : `${c.id} failed`,
			);
	for (const t of testRecords) if (t.run && t.tests === 0) failures.push(`${t.file} reported 0 tests`);
	const record: CheckRecord = {
		head: input.head,
		mergeBase: input.mergeBase,
		mode: selection.mode,
		fullReasons: selection.fullReasons,
		startedAt: new Date(started).toISOString(),
		durationMs: Date.now() - started,
		result: failures.length ? "failed" : "passed",
		failures: [...new Set(failures)],
		checks,
		tests: testRecords,
	};
	const dir = join(home, "checks", basename(root));
	mkdirSync(dir, { recursive: true });
	const recordPath = join(dir, "checks.json");
	writeFileSync(recordPath, JSON.stringify(record, null, 2) + "\n");
	return { record, recordPath };
}

/**
 * Runs each package's test:db one after another on one throwaway Postgres, as GitHub CI's db job does, and removes the
 * database on every path. A failed package still lets the later ones run. Any failure, 0 tests included, fails the check.
 */
function databaseTests(
	entry: CheckRecord["checks"][number],
	names: string[],
	options: Omit<PostgresOptions, "readyTimeoutMs" | "sleep" | "watch"> & Partial<PostgresOptions>,
) {
	const { root, env, run } = options;
	entry.packages = names.map((name) => ({
		name,
		command: `corepack pnpm --filter ${name} run test:db`,
		result: "not run",
		tests: null,
	}));
	entry.command = entry.packages.map((p) => p.command).join("; ");
	const problems: string[] = [];
	let db: ReturnType<typeof startPostgres>;
	try {
		db = startPostgres({
			readyTimeoutMs: 60_000,
			sleep: sleepSync,
			watch: watchProcess,
			...options,
		});
	} catch (error) {
		if (!(error instanceof DatabaseError)) throw error;
		entry.result = "failed";
		entry.detail = error.message;
		return;
	}
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

/** The `bin/dev check` command line. */
export function checkCommand(args: string[], root: string): number {
	const full = args.includes("--full");
	if (args.some((a) => a !== "--full")) {
		console.error("usage: dev check [--full]");
		return 2;
	}
	// Orphaned QA databases from runs that died without cleaning up hold the Docker VM's memory (T-356).
	sweepCommand();
	const { record, recordPath } = check({ root, full });
	const ran = record.checks.filter((c) => c.run).map((c) => c.id);
	console.log(`check ${record.mode}: ${record.result}. Ran ${ran.join(", ") || "nothing"}.`);
	if (record.mode === "full") console.log(`Full because ${record.fullReasons.join("; ")}.`);
	for (const failure of record.failures) console.log(`FAIL ${failure}`);
	console.log(`check record: ${recordPath}`);
	return record.result === "passed" ? 0 : 1;
}
