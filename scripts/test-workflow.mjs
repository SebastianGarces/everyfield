import { run } from "node:test";
import { spec } from "node:test/reporters";
import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const tests = [];
const stream = run({
	files: ["stack", "server-logs"].map((name) =>
		fileURLToPath(new URL(`../tests/workflow/${name}.test.mjs`, import.meta.url)),
	),
});
stream.on("test:pass", ({ name }) => tests.push({ name, status: "passed" }));
stream.on("test:fail", ({ name }) => {
	tests.push({ name, status: "failed" });
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
