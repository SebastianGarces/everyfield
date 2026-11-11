// scripts/test-workflow.mjs leaves out the tests ci.yml runs as their own steps. If the two lists drift, a test either
// runs twice or never runs in CI.
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { test } from "node:test";
import { OWN_STEP } from "../../scripts/test-workflow.mjs";

const root = new URL("../../", import.meta.url);
const ci = readFileSync(new URL(".github/workflows/ci.yml", root), "utf8");
const scripts = JSON.parse(readFileSync(new URL("package.json", root), "utf8")).scripts;
const workflowTests = new Set(readdirSync(new URL("tests/workflow/", root)).filter((n) => /\.test\.(mjs|ts)$/.test(n)));

/** The tests/workflow files named by a command, following `pnpm <script>` into package.json once. */
function workflowFiles(command) {
	const named = [...command.matchAll(/tests\/workflow\/([\w.-]+\.test\.(?:mjs|ts))/g)].map((m) => m[1]);
	const script = command.match(/\bpnpm\s+(?:run\s+)?([\w:-]+)/)?.[1];
	return script && scripts[script] && script !== "test:workflow"
		? [...named, ...workflowFiles(scripts[script])]
		: named;
}

// Each `run:` line of ci.yml is one step's command.
const ownStep = new Set(
	[...ci.matchAll(/^\s*(?:-\s+)?run:\s*(.+)$/gm)]
		.flatMap((m) => workflowFiles(m[1]))
		.filter((n) => workflowTests.has(n)),
);

test("every OWN_STEP name is a workflow test ci.yml runs as its own step", () => {
	for (const name of OWN_STEP) {
		assert.ok(workflowTests.has(name), `${name} is not in tests/workflow`);
		assert.ok(ownStep.has(name), `${name} is in OWN_STEP but ci.yml does not run it as its own step`);
	}
});

test("every workflow test ci.yml runs as its own step is in OWN_STEP", () => {
	for (const name of ownStep)
		assert.ok(OWN_STEP.has(name), `ci.yml runs ${name} as its own step but OWN_STEP lacks it`);
});
