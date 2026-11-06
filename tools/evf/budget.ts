import { availableParallelism, devNull } from "node:os";
import { join } from "node:path";
import { CHECK_CAP } from "./check-queue.ts";

export type TestBudget = {
	testProcesses: number;
	pnpmConcurrency: number;
	packageTestProcesses: number;
	nextWorkers: number;
};

/**
 * The process budget of one full check. Three checks at the cap together stay within the cores. In GitHub CI there is no
 * queue, so the one check gets the whole runner. `pnpm -r` multiplies by the test processes of each package, so the
 * package side stays at 1; a package test script reads that through EVF_NODE_TEST_FLAGS.
 */
export function testBudget(cores: number, cap: number, githubCi: boolean): TestBudget {
	const share = githubCi ? cores : Math.max(1, Math.floor(cores / cap));
	return { testProcesses: share, pnpmConcurrency: share, packageTestProcesses: 1, nextWorkers: share };
}

export const inGitHubCi = () => process.env.GITHUB_ACTIONS === "true";

/** Read once when a command starts: the budget does not change while a check runs. */
export const machineBudget = () => testBudget(availableParallelism(), CHECK_CAP, inGitHubCi());

/** What a check child reads. `NODE_OPTIONS` refuses `--test-concurrency`, so package scripts carry the flag themselves. */
export function budgetEnv(budget: TestBudget): NodeJS.ProcessEnv {
	return {
		npm_config_workspace_concurrency: String(budget.pnpmConcurrency),
		EVF_NODE_TEST_FLAGS: `--test-concurrency=${budget.packageTestProcesses}`,
		EVF_NEXT_WORKERS: String(budget.nextWorkers),
	};
}

/** The checks whose package scripts report failed test names. Any other check keeps the budget flag alone. */
export const NAMED_PACKAGE_CHECKS = new Set(["package-unit-tests", "local-app"]);

/**
 * What a named check adds to EVF_NODE_TEST_FLAGS. Package scripts expand the variable unquoted, so a checkout path that
 * the shell would split or expand gives no flags: that check then records no names, and its tests run as before.
 */
export function failedTestFlags(reporter = join(import.meta.dirname, "failed-tests-reporter.mjs")): string {
	if (!/^[\w./@:+-]+$/.test(reporter)) return "";
	return `--test-reporter=spec --test-reporter-destination=stdout --test-reporter=${reporter} --test-reporter-destination=${devNull}`;
}
