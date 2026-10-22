import { requireForeground } from "./foreground.ts";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, unlinkSync } from "node:fs";
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
	loadConfig,
	packageContext,
	requireWorktree,
	run,
	runtimeDir,
	sleep,
	type CheckDef,
	type TaskRef,
} from "./lib.ts";
import { stackEnv, stackInfo } from "./task.ts";
import { cachedTriage } from "./feedback.ts";
import { maintenanceScope, requireSpend, requireTaskScope, requireMaintenancePaths } from "./policy.ts";
import { caseCoverage, caseGrep, hasCaseMarkers, testsOf } from "./coverage.ts";
import { formatScope, wpScope, type ScopeReport } from "./scope.ts";
import { requireFreeMigrationNumbers } from "./migrations.ts";

export type Role = "author" | "verifier";
export type Mode = "full" | "quick";
export type CheckResult = { name: string; command: string[]; exitCode: number; log: string; passed: boolean };
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
	checks: CheckResult[];
	passed: boolean;
	evidenceDir: string;
	finishedAt: string;
	scope?: ScopeReport;
};

/** Local deterministic checks aid review. They never grant verifier approval or replace GitHub CI. */
export function verify(root: string, task: TaskRef, role: Role, mode: Mode, head?: string): CheckReport {
	requireForeground("verify", "2-15 minutes");
	const wt =
		role === "verifier"
			? git(process.cwd(), "rev-parse", "--show-toplevel")
			: requireWorktree(root, loadConfig(root), task);
	const cfg = loadConfig(wt);
	const wp = task.kind === "wp" ? task.wp : task.kind === "fb" ? cachedTriage(root, task.issue!)?.wp : undefined;
	requireTaskScope(root, wt, task, wp);
	requireMaintenancePaths(root, wt, task);
	if (hasRemote(root, cfg)) git(root, "fetch", "--quiet", cfg.remote, cfg.baseBranch);
	const ref = baseRef(root, cfg),
		baseSha = git(root, "rev-parse", ref),
		sha = git(wt, "rev-parse", "HEAD");
	if (head !== undefined && (!/^[a-f0-9]{40}$/.test(head) || sha !== head))
		fail(`Checkout HEAD ${sha} does not match requested SHA ${head}.`);
	if (!isClean(wt)) fail(`The checked checkout ${wt} is not clean. Commit the task changes before verification.`);
	if (!gitOk(wt, "merge-base", "--is-ancestor", baseSha, "HEAD")) fail("Include current main before verification.");
	requireFreeMigrationNumbers(wt, baseSha, task);
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
		EVF_SHA: sha,
		EVF_EVIDENCE_DIR: dir,
		EVF_ROLE: role,
		EVF_MODE: mode,
		EVF_BASE_URL: vars.baseUrl,
	};
	const definitions = task.kind === "ops" ? withCiParity(maintenanceScope(wt, task).checks, cfg.checks) : cfg.checks;
	if (task.kind !== "ops" && cfg.stack?.usesPaidProviders) requireSpend(root);
	const reports: string[] = [];
	const inputsUnchanged = () => git(wt, "rev-parse", "HEAD") === sha && isClean(wt);
	let treeUnchanged = true;
	for (const [index, c] of definitions.filter((c) => !c.modes || c.modes.includes(mode)).entries()) {
		// Each check writes its own report, so one check can never overwrite another's results.
		// The index keeps names that slug alike ("package cases", "package_cases") in separate files.
		const file = `${index + 1}-${c.name.replace(/[^\w.-]+/g, "_")}`,
			testReport = join(dir, `${file}.tests.json`);
		if (existsSync(testReport)) unlinkSync(testReport);
		reports.push(testReport);
		const argv = command(fill(c.run, { ...vars, testReport }));
		console.error(`evf verify: running ${c.name}.`);
		let result = run(argv[0], argv.slice(1), { cwd: wt, env: { ...env, EVF_TEST_REPORT: testReport } });
		let output = `${result.stdout}\n${result.stderr}`;
		for (
			let retry = 1;
			result.code !== 0 &&
			retry <= 3 &&
			/Another next build process is already running\./i.test(
				stripVTControlCharacters(`${result.stdout}\n${result.stderr}`),
			) &&
			inputsUnchanged();
			retry++
		) {
			const notice = `Retry ${retry}/3: held Next build lock; waiting 10 seconds.`;
			console.error(notice);
			sleep(10_000);
			if (!inputsUnchanged()) break;
			if (existsSync(testReport)) unlinkSync(testReport);
			result = run(argv[0], argv.slice(1), { cwd: wt, env: { ...env, EVF_TEST_REPORT: testReport } });
			output += `\n${notice}\n${result.stdout}\n${result.stderr}`;
		}
		console.error(`evf verify: ${c.name} ${result.code === 0 ? "passed" : "failed"}.`);
		const log = join(dir, `${file}.log`);
		writeFileSync(log, `$ ${argv.join(" ")}\n\n${output}`);
		checks.push({ name: c.name, command: argv, exitCode: result.code, log, passed: result.code === 0 });
		if (!inputsUnchanged()) {
			treeUnchanged = false;
			break;
		}
	}
	if (treeUnchanged && task.kind !== "ops" && mode === "full" && existsSync(join(wt, "package.json"))) {
		console.error("evf verify: running fresh-checkout-typecheck.");
		checks.push(freshCheckoutTypecheck(root, wt, sha, dir, role));
		treeUnchanged = inputsUnchanged();
	}
	// Coverage runs only when some report carries AC: markers; tooling-only reports never opt a task in (D19).
	// Real acceptance remains the verifier's job.
	const results = treeUnchanged
		? reports.filter(existsSync).map((path) => JSON.parse(readFileSync(path, "utf8")) as unknown)
		: [];
	if (results.some(hasCaseMarkers)) {
		const coverage = caseCoverage(cases, { tests: results.flatMap((r) => testsOf(r)) }),
			log = join(dir, "case-coverage.log");
		writeFileSync(log, JSON.stringify(coverage, null, 2));
		checks.push({
			name: "case-coverage",
			command: ["evf", "coverage"],
			exitCode: coverage.missing.length ? 1 : 0,
			log,
			passed: coverage.missing.length === 0,
		});
	}
	// Advisory: the verifier reviews paths outside the owning paths and the narrow D14/D16 rulings.
	const scope = task.kind === "wp" ? wpScope(wt, baseSha, task.wp, task.part) : undefined;
	if (scope) {
		writeFileSync(join(dir, "scope.json"), JSON.stringify(scope, null, 2) + "\n");
		console.log(formatScope(scope));
	}
	const unchanged = treeUnchanged && inputsUnchanged() && git(root, "rev-parse", ref) === baseSha;
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
		checks,
		passed: unchanged && checks.length > 0 && checks.every((c) => c.passed),
		evidenceDir: dir,
		finishedAt: new Date().toISOString(),
		...(scope ? { scope } : {}),
	};
	writeFileSync(join(dir, "checks.json"), JSON.stringify(report, null, 2) + "\n");
	console.log(
		`${!unchanged ? "INVALIDATED: checked tree or base changed during verification; rerun on stable inputs." : report.passed ? "PASSED" : "FAILED"} local ${report.kind} checks: ${join(dir, "checks.json")}. Independent real verification and GitHub CI are separate.`,
	);
	return report;
}

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
			const result = run(argv[0], argv.slice(1), { cwd: fresh });
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
