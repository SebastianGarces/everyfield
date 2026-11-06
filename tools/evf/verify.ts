import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { stripVTControlCharacters } from "node:util";
import {
	baseRef,
	command,
	evfDataDir,
	evidenceDir,
	fail,
	fill,
	git,
	gitOk,
	hasRemote,
	isClean,
	EvfError,
	loadConfig,
	packageContext,
	requireWorktree,
	run,
	runtimeDir,
	sleep,
	type CheckDef,
	type RunResult,
	type TaskRef,
} from "./lib.ts";
import { stackEnv, stackInfo } from "./task.ts";
import { cachedTriage } from "./feedback.ts";
import { maintenanceScope, requireSpend, requireTaskScope, requireMaintenancePaths } from "./policy.ts";
import { caseCoverage, caseGrep, hasCaseMarkers, testsOf } from "./coverage.ts";
import { formatScope, wpScope, type ScopeReport } from "./scope.ts";
import { requireFreeMigrationNumbers } from "./migrations.ts";
import { awaitLoad, loadGatePassed, markFullCheck, requireLoadInputs } from "./load.ts";
import { budgetEnv, failedTestFlags, machineBudget, NAMED_PACKAGE_CHECKS } from "./budget.ts";
import { withCheckQueue } from "./check-queue.ts";
import { machineProbes } from "./sampler.ts";
import { uiEscapedGate } from "./escape.ts";
import { checkSignals, type CheckInvalidated, type DriveCaller } from "./signals.ts";
import { changeSince, inputFiles, watchedRun, type StopReason } from "./check-watch.ts";

export type Role = "author" | "verifier";
export type Mode = "full" | "quick";
export type CheckResult = {
	name: string;
	command: string[];
	exitCode: number;
	log: string;
	passed: boolean;
	/** Written since OPS-132. A record from before it has neither. */
	startedAt?: string;
	durationMs?: number;
	/** Why the check started no work and still passed (OPS-144): `evf test` on a branch with no evf path. */
	skipped?: string;
};
export type CheckReport = {
	schema: 3;
	task: string;
	role: Role;
	mode: Mode;
	kind: "tooling" | "application";
	sha: string;
	baseSha: string;
	clean: boolean;
	unchanged: boolean;
	/** The queue wait plus the load wait. A record from before OPS-138 has none. */
	queuedMs?: number;
	checks: CheckResult[];
	/** An author run stops at its first failed check (OPS-144). A record of a run that did not stop has neither. */
	stoppedAfter?: string;
	notRun?: string[];
	/** Why the run cannot count, or that main moved and it still counts (OPS-143). A record from before it has none. */
	invalidated?: CheckInvalidated;
	passed: boolean;
	evidenceDir: string;
	finishedAt: string;
	scope?: ScopeReport;
};

/** Local deterministic checks aid review. They never grant verifier approval or replace GitHub CI. */
export function verify(
	root: string,
	task: TaskRef,
	role: Role,
	mode: Mode,
	head?: string,
	ignoreLoad?: string,
	caller?: DriveCaller,
): CheckReport {
	const wt =
		role === "verifier"
			? git(process.cwd(), "rev-parse", "--show-toplevel")
			: requireWorktree(root, loadConfig(root), task);
	const wp = task.kind === "wp" ? task.wp : task.kind === "fb" ? cachedTriage(root, task.issue!)?.wp : undefined;
	/**
	 * Every refusal that needs no check, and the check list. Main or the checkout can move during a wait, so this runs
	 * again after it. `sha` comes first: a commit after that read makes the run INVALIDATED. A move of main after this
	 * check does not: `evf ship` applies the overlap check and required CI to the merge (OPS-143).
	 */
	const inputs = () => {
		const sha = git(wt, "rev-parse", "HEAD"),
			cfg = loadConfig(wt);
		requireLoadInputs(root, ignoreLoad);
		requireTaskScope(root, wt, task, wp);
		if (hasRemote(root, cfg)) git(root, "fetch", "--quiet", cfg.remote, cfg.baseBranch);
		const ref = baseRef(root, cfg),
			baseSha = git(root, "rev-parse", ref);
		if (head !== undefined && (!/^[a-f0-9]{40}$/.test(head) || sha !== head))
			fail(`Checkout HEAD ${sha} does not match requested SHA ${head}.`);
		if (!isClean(wt)) fail(`The checked checkout ${wt} is not clean. Commit the task changes before verification.`);
		if (!gitOk(wt, "merge-base", "--is-ancestor", baseSha, "HEAD")) fail("Include current main before verification.");
		// After the check above: while main is not included, this diff lists main's own new files as the task's changes.
		requireMaintenancePaths(root, wt, task);
		requireFreeMigrationNumbers(wt, baseSha, task);
		const definitions = withUiEscaped(
			task.kind === "ops" ? withCiParity(maintenanceScope(wt, task).checks, cfg.checks) : cfg.checks,
			cfg.checks,
		);
		if (task.kind !== "ops" && cfg.stack?.usesPaidProviders) requireSpend(root);
		return { ref, baseSha, sha, definitions, fetchBase: hasRemote(root, cfg) ? [cfg.remote, cfg.baseBranch] : null };
	};
	const { definitions } = inputs();
	// OPS-144: a format error takes seconds to find, so it never waits for a slot or the load gate. It then runs once more
	// inside runChecks, which writes the record with its evidence and events.
	const format = definitions.find((c) => c.name === FORMAT && (!c.modes || c.modes.includes(mode)));
	const refused =
		role === "author" &&
		format !== undefined &&
		run(command(format.run)[0], command(format.run).slice(1), { cwd: wt }).code !== 0;
	const queueStart = performance.now();
	// The slot comes first, so waiters keep their arrival order while the load is high.
	const checked = (slot: NodeJS.ProcessEnv = {}) => {
		if (!refused) awaitLoad(root, "verify", ignoreLoad, undefined, task, mode === "full" ? machineProbes(root) : null);
		const queuedMs = Math.round(performance.now() - queueStart);
		return runChecks({ root, wt, task, wp, role, mode, caller, queuedMs, slot, ...inputs() });
	};
	return mode === "full" && !refused ? withCheckQueue(root, task.id, checked) : checked();
}

function runChecks({
	root,
	wt,
	task,
	wp,
	role,
	mode,
	caller,
	definitions,
	queuedMs,
	slot,
	ref,
	baseSha,
	sha,
	fetchBase,
}: {
	root: string;
	wt: string;
	task: TaskRef;
	wp: string | undefined;
	role: Role;
	mode: Mode;
	caller: DriveCaller | undefined;
	definitions: CheckDef[];
	queuedMs: number;
	slot: NodeJS.ProcessEnv;
	ref: string;
	baseSha: string;
	sha: string;
	fetchBase: string[] | null;
}): CheckReport {
	const cases = wp ? packageContext(wt, wp).case_ids : [];
	const dir = evidenceDir(root, task, sha, `${role}-${mode}`);
	mkdirSync(dir, { recursive: true });
	const vars = {
		task: task.id,
		taskSlug: task.slug,
		wp: wp ?? "",
		part: task.part ?? "",
		sha,
		worktree: wt,
		evidenceDir: dir,
		runtimeDir: runtimeDir(root, task),
		node: process.execPath,
		acGrep: caseGrep(cases),
		baseUrl: stackInfo(root, task).url ?? "",
		role,
		mode,
	};
	const checks: CheckResult[] = [];
	const env = {
		...stackEnv(root, task, wt),
		...loadGatePassed(root),
		...budgetEnv(machineBudget()),
		...slot,
		EVF_SHA: sha,
		EVF_EVIDENCE_DIR: dir,
		EVF_ROLE: role,
		EVF_MODE: mode,
		EVF_BASE_URL: vars.baseUrl,
		// The promise holds here: `run` below is spawnSync, so this process waits for every check child. A guarded evf
		// command inside a check (`evf test`) may therefore run without a terminal. An existing value stays.
		EVF_MONITOR: process.env.EVF_MONITOR?.trim() || `evf verify ${task.id}`,
	};
	const signals = checkSignals({ root, wt, task, sha, baseSha, role, mode, dir, queuedMs, caller });
	const unmarkFullCheck = markFullCheck(root, mode);
	try {
		const reports: string[] = [];
		const inputs = inputFiles(wt);
		/** Set once a check ends or stops on a change. Later steps of the run then do not start. */
		let invalidReason: StopReason | null = null;
		const stillValid = () => (invalidReason ??= changeSince(wt, sha, inputs)) === null;
		const watched = (argv: string[], stopFile: string, opts: { cwd: string; env?: NodeJS.ProcessEnv }) => {
			rmSync(stopFile, { force: true });
			const result = watchedRun(argv, { ...opts, wt, sha, inputs, stopFile });
			invalidReason ??= result.stopped ?? null;
			return result;
		};
		const planned = formatFirst(definitions.filter((c) => !c.modes || c.modes.includes(mode)));
		const notRun: string[] = [];
		const stopped = () => role === "author" && checks.some((c) => !c.passed);
		for (const [index, c] of planned.entries()) {
			if (stopped()) {
				notRun.push(...planned.slice(index).map((p) => p.name));
				break;
			}
			const finished = signals.suite();
			// Each check writes its own report, so one check can never overwrite another's results.
			// The index keeps names that slug alike ("package cases", "package_cases") in separate files.
			const file = `${index + 1}-${c.name.replace(/[^\w.-]+/g, "_")}`,
				testReport = join(dir, `${file}.tests.json`),
				failedTests = join(dir, `${file}.failed-tests.jsonl`),
				skipReason = join(dir, `${file}.skip`),
				stopFile = join(dir, `${file}.stopped`);
			rmSync(testReport, { force: true });
			rmSync(failedTests, { force: true });
			rmSync(skipReason, { force: true });
			reports.push(testReport);
			const argv = command(fill(c.run, { ...vars, testReport }));
			const log = join(dir, `${file}.log`);
			let checkEnv: NodeJS.ProcessEnv = {
				...env,
				EVF_TEST_REPORT: testReport,
				EVF_FAILED_TESTS: failedTests,
				EVF_SKIP_REASON: skipReason,
				...(NAMED_PACKAGE_CHECKS.has(c.name)
					? { EVF_NODE_TEST_FLAGS: `${env.EVF_NODE_TEST_FLAGS} ${failedTestFlags()}` }
					: {}),
			};
			if (c.name === UI_ESCAPED) {
				const escaped = uiEscapedGate(root, wt, task, baseSha);
				if ("skip" in escaped) {
					console.error(`evf verify: ${UI_ESCAPED} skipped: ${escaped.skip}`);
					continue;
				}
				if ("fail" in escaped) {
					console.error(`evf verify: ${UI_ESCAPED} failed. ${escaped.fail}`);
					writeFileSync(log, `$ ${argv.join(" ")}\n\nNot run.\n${escaped.fail}\n`);
					checks.push(finished({ name: c.name, command: argv, exitCode: 1, log, passed: false }));
					continue;
				}
				checkEnv = { ...checkEnv, UI_BASE_URL: escaped.baseUrl };
			}
			console.error(`evf verify: running ${c.name}.`);
			let result = watched(argv, stopFile, { cwd: wt, env: checkEnv });
			let output = `${result.stdout}\n${result.stderr}`;
			for (
				let retry = 1;
				result.code !== 0 &&
				retry <= 3 &&
				/Another next build process is already running\./i.test(
					stripVTControlCharacters(`${result.stdout}\n${result.stderr}`),
				) &&
				stillValid();
				retry++
			) {
				const notice = `Retry ${retry}/3: held Next build lock; waiting 10 seconds.`;
				console.error(notice);
				sleep(10_000);
				if (!stillValid()) break;
				rmSync(testReport, { force: true });
				rmSync(failedTests, { force: true });
				result = watched(argv, stopFile, { cwd: wt, env: checkEnv });
				output += `\n${notice}\n${result.stdout}\n${result.stderr}`;
			}
			const skipped = result.code === 0 && existsSync(skipReason) ? readFileSync(skipReason, "utf8") : undefined;
			console.error(
				`evf verify: ${c.name} ${skipped ? `skipped: ${skipped}` : result.code === 0 ? "passed" : "failed"}.`,
			);
			const formatFix = c.name === FORMAT && result.code !== 0 ? `${FORMAT_FIX}\n` : "";
			if (formatFix) console.error(`evf verify: ${formatFix.trim()}\n${warnLines(output)}`);
			writeFileSync(log, `${formatFix}$ ${argv.join(" ")}\n\n${output}`);
			checks.push(
				finished({
					name: c.name,
					command: argv,
					exitCode: result.code,
					log,
					passed: result.code === 0,
					...(skipped ? { skipped } : {}),
				}),
			);
			// A stopped check's failures say nothing about its tests, and the broken-main brake reads this event.
			if (!result.stopped) signals.testsFailed(c.name, testReport, failedTests);
			if (!stillValid()) break;
		}
		if (invalidReason === null && task.kind !== "ops" && mode === "full" && existsSync(join(wt, "package.json"))) {
			if (stopped()) notRun.push("fresh-checkout-typecheck");
			else {
				console.error("evf verify: running fresh-checkout-typecheck.");
				const finished = signals.suite();
				const stopFile = join(dir, "fresh-checkout-typecheck.stopped");
				checks.push(
					finished(
						freshCheckoutTypecheck(root, wt, sha, dir, role, undefined, (argv, cwd) =>
							watched(argv, stopFile, { cwd }),
						),
					),
				);
				stillValid();
			}
		}
		// Coverage runs only when some report carries AC: markers; tooling-only reports never opt a task in (D19).
		// Real acceptance remains the verifier's job.
		const results =
			invalidReason === null
				? reports.filter(existsSync).map((path) => JSON.parse(readFileSync(path, "utf8")) as unknown)
				: [];
		if (results.some(hasCaseMarkers) && stopped()) notRun.push("case-coverage");
		else if (results.some(hasCaseMarkers)) {
			const finished = signals.suite();
			const coverage = caseCoverage(cases, { tests: results.flatMap((r) => testsOf(r)) }),
				log = join(dir, "case-coverage.log");
			writeFileSync(log, JSON.stringify(coverage, null, 2));
			checks.push(
				finished({
					name: "case-coverage",
					command: ["evf", "coverage"],
					exitCode: coverage.missing.length ? 1 : 0,
					log,
					passed: coverage.missing.length === 0,
				}),
			);
		}
		// Advisory: the verifier reviews paths outside the owning paths and the narrow D14/D16 rulings.
		const scope = task.kind === "wp" ? wpScope(wt, baseSha, task.wp, task.part) : undefined;
		if (scope) {
			writeFileSync(join(dir, "scope.json"), JSON.stringify(scope, null, 2) + "\n");
			console.log(formatScope(scope));
		}
		const unchanged = stillValid();
		// Other worktrees fetch at their own pace, so this run asks. Without a network the event only comes later or never.
		if (fetchBase) run("git", ["fetch", "--quiet", ...fetchBase], { cwd: root, timeoutMs: BASE_FETCH_MS });
		const newBase = git(root, "rev-parse", ref),
			invalidated = signals.invalidated(invalidReason, newBase);
		const report: CheckReport = {
			schema: 3,
			task: task.id,
			role,
			mode,
			kind: task.kind === "ops" ? "tooling" : "application",
			sha,
			baseSha,
			clean: true,
			unchanged,
			queuedMs,
			checks,
			...(notRun.length ? { stoppedAfter: checks.find((c) => !c.passed)!.name, notRun } : {}),
			...(invalidated ? { invalidated } : {}),
			passed: unchanged && checks.length > 0 && checks.every((c) => c.passed),
			evidenceDir: dir,
			finishedAt: new Date().toISOString(),
			...(scope ? { scope } : {}),
		};
		writeFileSync(join(dir, "checks.json"), JSON.stringify(report, null, 2) + "\n");
		signals.end(!unchanged ? "invalidated" : report.passed ? "passed" : "failed");
		if (notRun.length)
			console.error(`evf verify: stopped after ${report.stoppedAfter}. Did not run: ${notRun.join(", ")}.`);
		console.log(
			`${!unchanged ? `INVALIDATED (${invalidReason}): checked tree or inputs changed during verification; rerun on stable inputs.` : report.passed ? "PASSED" : "FAILED"} local ${report.kind} checks: ${join(dir, "checks.json")}. Independent real verification and GitHub CI are separate.`,
		);
		return report;
	} catch (error) {
		signals.end("error");
		throw error;
	} finally {
		unmarkFullCheck();
	}
}

const BASE_FETCH_MS = 30_000;
const FORMAT = "format";
const FORMAT_FIX = "Format error. Run corepack pnpm format (prettier --write), commit, then run evf verify again.";
/** The cheapest check goes first, so a format error costs no time in a longer check. */
const formatFirst = (checks: CheckDef[]) => [
	...checks.filter((c) => c.name === FORMAT),
	...checks.filter((c) => c.name !== FORMAT),
];
/** Prettier's lines that name each unformatted file. */
const warnLines = (output: string) =>
	stripVTControlCharacters(output)
		.split("\n")
		.filter((line) => line.startsWith("[warn]"))
		.join("\n");

/**
 * CI runs Prettier and every package's unit tests, including the db schema check, on every PR. An OPS task's
 * own checks never replace them: OPS-18, OPS-17 and OPS-20 passed locally and failed CI on exactly these.
 */
const CI_PARITY = ["format", "package-unit-tests"];
function withCiParity(own: CheckDef[], configured: CheckDef[]): CheckDef[] {
	const parity = CI_PARITY.map((name) => {
		const check = configured.find((c) => c.name === name);
		if (!check) fail(`evf.config.json checks must define "${name}", which CI runs on every PR.`);
		return check;
	});
	return [...own, ...parity.filter((p) => !own.some((c) => c.name === p.name))];
}

/**
 * OPS-114: every task gets the escaped-bug check, so no task's own check list leaves it out. It is built in because an
 * OPS task may change only its own evf.config.json entry; a configured check of the same name replaces the command.
 * The gate in escape.ts decides per task whether it runs, skips with a reason or fails closed.
 */
const UI_ESCAPED = "ui-escaped";
const UI_ESCAPED_CHECK: CheckDef = { name: UI_ESCAPED, run: ["node", "--test", "tests/ui/escaped/*.test.mjs"] };
function withUiEscaped(own: CheckDef[], configured: CheckDef[]): CheckDef[] {
	if (own.some((c) => c.name === UI_ESCAPED)) return own;
	return [...own, configured.find((c) => c.name === UI_ESCAPED) ?? UI_ESCAPED_CHECK];
}

/**
 * CI type-checks a fresh clone. Ignored files in the task worktree, such as Next's generated next-env.d.ts, made
 * WP-097's local typecheck pass while CI failed (PR #175), so the typecheck also runs on a clean checkout of HEAD.
 * Each run checks out into its own new folder and removes only that folder: an author and a verifier checking the
 * same head at once deleted each other's checkout, and a crashed run's leftover blocked the next run (PR #207).
 */
export function freshCheckoutTypecheck(
	root: string,
	wt: string,
	sha: string,
	dir: string,
	role: Role,
	steps: string[][] = [
		["corepack", "pnpm", "install", "--frozen-lockfile", "--prefer-offline"],
		["corepack", "pnpm", "typecheck"],
	],
	runStep: (argv: string[], cwd: string) => RunResult = (argv, cwd) => run(argv[0], argv.slice(1), { cwd }),
): CheckResult {
	const base = join(evfDataDir(root), "fresh"),
		log = join(dir, "fresh-checkout-typecheck.log");
	mkdirSync(base, { recursive: true });
	const fresh = mkdtempSync(join(base, `${sha.slice(0, 12)}-${role}-`));
	let output = "",
		exitCode = 0,
		admin: string | undefined;
	try {
		git(wt, "worktree", "add", "--quiet", "--detach", fresh, sha);
		admin = git(fresh, "rev-parse", "--absolute-git-dir");
		for (const argv of steps) {
			const result = runStep(argv, fresh);
			output += `$ ${argv.join(" ")}\n\n${result.stdout}\n${result.stderr}\n`;
			exitCode = result.code;
			if (exitCode !== 0) break;
		}
	} finally {
		// Clean up only this run's folder and registration. A global prune would also drop other worktrees' entries.
		run("git", ["worktree", "remove", "--force", fresh], { cwd: wt });
		rmSync(fresh, { recursive: true, force: true });
		if (admin) rmSync(admin, { recursive: true, force: true });
	}
	writeFileSync(log, output);
	console.error(`evf verify: fresh-checkout-typecheck ${exitCode === 0 ? "passed" : "failed"}.`);
	return { name: "fresh-checkout-typecheck", command: steps.flat(), exitCode, log, passed: exitCode === 0 };
}

/** True when the clean head already has a passing full author record. */
export function hasVerifiedHead(root: string, task: TaskRef): boolean {
	try {
		requireVerifiedHead(root, task);
		return true;
	} catch (error) {
		if (error instanceof EvfError) return false;
		throw error;
	}
}

/** Read-only gate shared by PR open and the explicit pre-push check. */
export function requireVerifiedHead(root: string, task: TaskRef): string {
	const wt = requireWorktree(root, loadConfig(root), task),
		sha = git(wt, "rev-parse", "HEAD");
	if (!isClean(wt)) fail("The task checkout is not clean. Commit before the pre-push check.");
	const path = join(evidenceDir(root, task, sha, "author-full"), "checks.json");
	const report: unknown = existsSync(path) ? JSON.parse(readFileSync(path, "utf8")) : null;
	if (
		!report ||
		typeof report !== "object" ||
		!(
			"schema" in report &&
			report.schema === 3 &&
			"task" in report &&
			report.task === task.id &&
			"sha" in report &&
			report.sha === sha &&
			"role" in report &&
			report.role === "author" &&
			"mode" in report &&
			report.mode === "full" &&
			"passed" in report &&
			report.passed === true &&
			"clean" in report &&
			report.clean === true &&
			"unchanged" in report &&
			report.unchanged === true
		)
	)
		fail(`A passing full evf verify ${task.id} record is required for exact HEAD ${sha}. Run it before pushing.`);
	return sha;
}
