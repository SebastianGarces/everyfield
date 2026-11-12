// T-41: the selection tests must catch a selection that skips too much. This breaks a copy of select.ts on purpose,
// so a changed file selects none of the test files that reached it, and runs select.test.ts against the copy.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const SOURCE = fileURLToPath(new URL("../select.ts", import.meta.url));
const SUITE = fileURLToPath(new URL("./select.test.ts", import.meta.url));
const LINE = "for (const test of reached) add(testWhy, test, `reached ${path}`);";

test("INV-ci-select: a selection that drops the tests reaching a changed file fails the selection tests", (t) => {
	const source = readFileSync(SOURCE, "utf8");
	assert.equal(source.split(LINE).length, 2, "select.ts adds each reaching test exactly once");
	const dir = mkdtempSync(join(tmpdir(), "evf-sabotage-"));
	t.after(() => rmSync(dir, { recursive: true, force: true }));
	const broken = join(dir, "select.ts");
	writeFileSync(broken, source.replace(LINE, "/* sabotaged: reaching tests dropped */"));

	// A nested runner that inherits NODE_TEST_CONTEXT reports to this one and exits 0, so drop it.
	const env = Object.fromEntries(
		Object.entries(process.env).filter(([k]) => k !== "CI_SELECT_MODULE" && k !== "NODE_TEST_CONTEXT"),
	);
	const sabotaged = spawnSync(process.execPath, ["--test", "--test-reporter=spec", SUITE], {
		encoding: "utf8",
		env: { ...env, CI_SELECT_MODULE: broken },
	});
	console.log(sabotaged.stdout);
	assert.notEqual(sabotaged.status, 0, "the selection tests pass on a sabotaged selection");
	assert.match(sabotaged.stdout, /✖ INV-ci-select: a tools\/qa source change runs only the tests that reached it/);
	assert.match(sabotaged.stdout, /✖ INV-ci-select: a changed source file selects every test file that reached it/);
	// The same suite passes on the real select.ts, so the failure is the sabotage and nothing else.
	const real = spawnSync(process.execPath, ["--test", "--test-reporter=spec", SUITE], { encoding: "utf8", env });
	assert.equal(real.status, 0, real.stdout);
});
