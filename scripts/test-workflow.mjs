import { run } from "node:test";
import { spec } from "node:test/reporters";
import { readdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

// With no arguments, CI's tooling job set: every test in tests/workflow except the two CI runs as their own steps
// (server-logs needs `next dev` and runs in the app job). With file arguments (bin/dev check), exactly those files.
const OWN_STEP = new Set(["server-logs.test.mjs", "evry-evals-coverage.test.mjs"]);
const workflowDir = fileURLToPath(new URL("../tests/workflow/", import.meta.url));
const files = process.argv.slice(2).length
	? process.argv.slice(2).map((file) => resolve(file))
	: readdirSync(workflowDir)
			.filter((name) => /\.test\.(mjs|ts)$/.test(name) && !OWN_STEP.has(name))
			.sort()
			.map((name) => resolve(workflowDir, name));
const tests = [];
const stream = run({ files });
stream.on("test:pass", ({ name, file }) => tests.push({ name, file, status: "passed" }));
stream.on("test:fail", ({ name, file }) => {
	tests.push({ name, file, status: "failed" });
	process.exitCode = 1;
});
stream.on("error", () => {
	process.exitCode = 1;
});
stream.compose(new spec()).pipe(process.stdout);
stream.on("end", () => {
	if (tests.length === 0) process.exitCode = 1;
	if (process.env.EVF_TEST_REPORT)
		writeFileSync(process.env.EVF_TEST_REPORT, JSON.stringify({ tests }, null, 2) + "\n");
});
