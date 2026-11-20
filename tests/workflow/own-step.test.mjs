import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { test } from "node:test";
import { OWN_STEP } from "../../scripts/test-workflow.mjs";

const root = new URL("../../", import.meta.url);
const ci = ["ci.yml", "nightly.yml"]
	.map((name) => readFileSync(new URL(`.github/workflows/${name}`, root), "utf8"))
	.join("\n");
const scripts = JSON.parse(readFileSync(new URL("package.json", root), "utf8")).scripts;
const workflowTests = new Set(readdirSync(new URL("tests/workflow/", root)).filter((n) => /\.test\.(mjs|ts)$/.test(n)));

function workflowFiles(command) {
	const named = [...command.matchAll(/tests\/workflow\/([\w.-]+\.test\.(?:mjs|ts))/g)].map((m) => m[1]);
	const script = command.match(/\bpnpm\s+(?:run\s+)?([\w:-]+)/)?.[1];
	return script && scripts[script] ? [...named, ...workflowFiles(scripts[script])] : named;
}

const ownStep = new Set(
	[...ci.matchAll(/^\s*(?:-\s+)?run:\s*(.+)$/gm)]
		.flatMap((m) => workflowFiles(m[1]))
		.filter((n) => workflowTests.has(n)),
);

test("every OWN_STEP name is a workflow test ci.yml or nightly.yml runs as its own step", () => {
	for (const name of OWN_STEP)
		assert.ok(ownStep.has(name), `${name} is in OWN_STEP but neither ci.yml nor nightly.yml runs it as its own step`);
});

test("every workflow test ci.yml or nightly.yml runs as its own step is in OWN_STEP", () => {
	for (const name of ownStep)
		assert.ok(OWN_STEP.has(name), `a workflow runs ${name} as its own step but OWN_STEP lacks it`);
});
