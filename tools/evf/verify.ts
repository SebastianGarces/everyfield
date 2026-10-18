import { existsSync, mkdirSync, readFileSync, writeFileSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import {
	baseRef,
	command,
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
	type TaskRef,
} from "./lib.ts";
import { stackEnv, stackInfo } from "./task.ts";
import { cachedTriage } from "./feedback.ts";
import { requireSpend, requireTaskScope, requireMaintenancePaths } from "./policy.ts";
import { caseCoverage, caseGrep, hasCaseMarkers, testsOf } from "./coverage.ts";
import { formatScope, wpScope, type ScopeReport } from "./scope.ts";

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
export function verify(root: string, task: TaskRef, role: Role, mode: Mode): CheckReport {
	const cfg = loadConfig(root),
		wt = requireWorktree(root, cfg, task);
	const wp = task.kind === "wp" ? task.wp : task.kind === "fb" ? cachedTriage(root, task.issue!)?.wp : undefined;
	requireTaskScope(root, task, wp);
	requireMaintenancePaths(root, wt, task);
	if (hasRemote(root, cfg)) git(root, "fetch", "--quiet", cfg.remote, cfg.baseBranch);
	const ref = baseRef(root, cfg),
		baseSha = git(root, "rev-parse", ref),
		sha = git(wt, "rev-parse", "HEAD");
	if (!isClean(wt)) fail("Commit the task changes before verification.");
	if (!gitOk(wt, "merge-base", "--is-ancestor", baseSha, "HEAD")) fail("Include current main before verification.");
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
	const definitions = task.kind === "ops" ? cfg.maintenanceTasks![task.id].checks : cfg.checks;
	if (task.kind !== "ops" && cfg.stack?.usesPaidProviders) requireSpend(root);
	const reports: string[] = [];
	for (const [index, c] of definitions.filter((c) => !c.modes || c.modes.includes(mode)).entries()) {
		// Each check writes its own report, so one check can never overwrite another's results.
		// The index keeps names that slug alike ("package cases", "package_cases") in separate files.
		const file = `${index + 1}-${c.name.replace(/[^\w.-]+/g, "_")}`,
			testReport = join(dir, `${file}.tests.json`);
		if (existsSync(testReport)) unlinkSync(testReport);
		reports.push(testReport);
		const argv = command(fill(c.run, { ...vars, testReport })),
			result = run(argv[0], argv.slice(1), { cwd: wt, env: { ...env, EVF_TEST_REPORT: testReport } });
		const log = join(dir, `${file}.log`);
		writeFileSync(log, `$ ${argv.join(" ")}\n\n${result.stdout}\n${result.stderr}`);
		checks.push({ name: c.name, command: argv, exitCode: result.code, log, passed: result.code === 0 });
	}
	// Coverage runs only when some report carries AC: markers; tooling-only reports never opt a task in (D19).
	// Real acceptance remains the verifier's job.
	const results = reports.filter(existsSync).map((path) => JSON.parse(readFileSync(path, "utf8")) as unknown);
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
	const unchanged = git(wt, "rev-parse", "HEAD") === sha && isClean(wt) && git(root, "rev-parse", ref) === baseSha;
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
		`${report.passed ? "PASSED" : "FAILED"} local ${report.kind} checks: ${join(dir, "checks.json")}. Independent real verification and GitHub CI are separate.`,
	);
	return report;
}
