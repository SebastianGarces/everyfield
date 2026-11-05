import { availableParallelism } from "node:os";
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
