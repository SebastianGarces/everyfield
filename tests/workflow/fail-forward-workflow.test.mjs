import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

const workflow = readFileSync(new URL("../../.github/workflows/fail-forward.yml", import.meta.url), "utf8");

const ON = `on:
  workflow_run:
    workflows: [CI, Nightly]
    types: [completed]
    branches: [main]
  deployment_status:
`;
const PERMISSIONS = `permissions:
  contents: read
  actions: read
  deployments: read
  issues: write
`;
const CONCURRENCY = `concurrency:
  group: fail-forward-\${{ github.event_name }}
  queue: max
  cancel-in-progress: false
`;
const JOBS = new RegExp(
	String.raw`^jobs:
  report:
    if: >-
(?: {6}\S.*\n| {7,}\S.*\n)+    runs-on: ubuntu-[\d.]+
    timeout-minutes: \d+
    steps:
      - name: [\w ,]+
        uses: actions/checkout@v\d+
        with:
          ref: main
          persist-credentials: false
          sparse-checkout: \.github/scripts
      - uses: actions/github-script@v\d+
        id: report
        with:
          script: \|
            const report = require\('\./\.github/scripts/fail-forward\.cjs'\);
            await report\(\{ github, context, core \}\);
$`,
);

function problems(text) {
	const [name, on, permissions, concurrency, jobs, ...more] = text
		.split(/\n(?=\S)/)
		.map((block) => block.trimEnd() + "\n");
	const found = [];
	if (!/^name: [\w ]+\n$/.test(name)) found.push("name");
	if (on !== ON) found.push("on");
	if (permissions !== PERMISSIONS) found.push("permissions");
	if (concurrency !== CONCURRENCY) found.push("concurrency");
	if (!JOBS.test(jobs)) found.push("jobs");
	if (more.length) found.push("another top-level key");
	return found;
}

test("fail-forward runs only the trusted reporter from main and never cancels a report", () => {
	assert.deepEqual(problems(workflow), []);
});

test("each change that could run other code or cancel a report is refused", () => {
	const cases = [
		["  deployment_status:\n", "  deployment_status:\n  pull_request_target:\n", "on"],
		["branches: [main]", "branches: ['**']", "on"],
		["contents: read", "contents: write", "permissions"],
		["  queue: max\n", "", "concurrency"],
		["queue: max", "queue: single", "concurrency"],
		["cancel-in-progress: false", "cancel-in-progress: true", "concurrency"],
		["  cancel-in-progress: false\n", "", "concurrency"],
		["fail-forward-${{ github.event_name }}", "fail-forward", "concurrency"],
		["ref: main", "ref: ${{ github.event.workflow_run.head_sha }}", "jobs"],
		["          ref: main\n", "", "jobs"],
		["          ref: main\n", "          ref: main\n          repository: x/y\n", "jobs"],
		["persist-credentials: false", "persist-credentials: true", "jobs"],
		["sparse-checkout: .github/scripts", "sparse-checkout: .", "jobs"],
		["      - uses: actions/github-script", "      - run: ./x.sh\n      - uses: actions/github-script", "jobs"],
		["fail-forward.cjs", "other.cjs", "jobs"],
		[
			"await report({ github, context, core });",
			"await report({ github, context, core });\n            exec();",
			"jobs",
		],
		["\njobs:\n", "\njobs:\n  other:\n    runs-on: ubuntu-24.04\n    steps:\n      - run: ./x.sh\n", "jobs"],
		["    timeout-minutes: 5\n", "    timeout-minutes: 5\n    container: x\n", "jobs"],
		["\njobs:\n", "\nenv:\n  NODE_OPTIONS: --require ./x.js\n\njobs:\n", "another top-level key"],
	];
	for (const [from, to, problem] of cases) {
		const changed = workflow.replace(from, () => to);
		assert.notEqual(changed, workflow, from);
		assert.ok(problems(changed).includes(problem), `${from} -> ${to}`);
	}
	assert.ok(problems(`${workflow}  other:\n    uses: ./x.yml\n`).includes("jobs"), "a second job at the end");
});
