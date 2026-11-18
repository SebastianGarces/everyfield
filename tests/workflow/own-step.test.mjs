import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { test } from "node:test";
import { OWN_STEP } from "../../scripts/test-workflow.mjs";

const root = new URL("../../", import.meta.url);
const ci = readFileSync(new URL(".github/workflows/ci.yml", root), "utf8");
const scripts = JSON.parse(readFileSync(new URL("package.json", root), "utf8")).scripts;
const workflowTests = new Set(readdirSync(new URL("tests/workflow/", root)).filter((n) => /\.test\.(mjs|ts)$/.test(n)));

function workflowFiles(command) {
	const named = [...command.matchAll(/tests\/workflow\/([\w.-]+\.test\.(?:mjs|ts))/g)].map((m) => m[1]);
	const called = [...command.matchAll(/\bpnpm\s+(?:run\s+)?([\w:-]+)/g)].map((m) => m[1]);
	return [...named, ...called.filter((script) => scripts[script]).flatMap((script) => workflowFiles(scripts[script]))];
}

function runCommands(workflow) {
	const lines = workflow.split("\n"),
		commands = [];
	for (let i = 0; i < lines.length; i++) {
		const match = lines[i].match(/^(\s*)(?:-\s+)?run:\s*(.*)$/);
		if (!match) continue;
		let command = match[2];
		if (/^[|>][-+]?\s*$/.test(command)) {
			command = "";
			while (i + 1 < lines.length && (!lines[i + 1].trim() || lines[i + 1].search(/\S/) > match[1].length))
				command += `${lines[++i]}\n`;
		}
		commands.push(command);
	}
	return commands;
}

const ownStep = new Set(
	runCommands(ci)
		.flatMap(workflowFiles)
		.filter((n) => workflowTests.has(n)),
);

test("every OWN_STEP name is a workflow test ci.yml runs as its own step", () => {
	for (const name of OWN_STEP)
		assert.ok(ownStep.has(name), `${name} is in OWN_STEP but ci.yml does not run it as its own step`);
});

test("every workflow test ci.yml runs as its own step is in OWN_STEP", () => {
	for (const name of ownStep)
		assert.ok(OWN_STEP.has(name), `ci.yml runs ${name} as its own step but OWN_STEP lacks it`);
});
