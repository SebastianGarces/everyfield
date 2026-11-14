// The GitHub nightly's tests/ui job: the verdict each engine's step gives node:test's output (real node:test runs over
// throwaway files), the seed order, and the job's step conditions in nightly.yml.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { engineVerdict, uiTest } from "../../scripts/nightly-ui.ts";
import { seedsOf } from "../../scripts/nightly.ts";

const root = fileURLToPath(new URL("../..", import.meta.url));

/** node:test over throwaway files with these bodies, in an otherwise empty folder; its output whatever the exit code. */
function nodeTest(t: { after(fn: () => void): void }, bodies: string[]): { files: string[]; output: string } {
	const dir = mkdtempSync(join(tmpdir(), "evf-nightly-ui-"));
	t.after(() => rmSync(dir, { recursive: true, force: true }));
	const files = bodies.map((body, i) => {
		const file = join(dir, `${i}.test.mjs`);
		writeFileSync(file, `import { test } from "node:test";\n${body}\n`);
		return file;
	});
	const { NODE_TEST_CONTEXT: _, ...env } = process.env;
	try {
		return { files, output: execFileSync(process.execPath, ["--test", ...files], { cwd: dir, encoding: "utf8", env }) };
	} catch (error) {
		return { files, output: String((error as { stdout: string }).stdout) };
	}
}

async function step(files: string[], output: string) {
	const lines: string[] = [];
	const ran: string[][] = [];
	const status = await uiTest("webkit", {
		files: () => files,
		test: async (f) => (ran.push(f), output),
		log: (line) => lines.push(line),
	});
	return { status, lines, ran };
}

test("T-301 an engine step passes only when every test ran and none failed", async (t) => {
	const green = nodeTest(t, ['test("a", () => {}); test("b", () => {}); test.skip("c", () => {});']);
	assert.deepEqual(engineVerdict(green.output), {
		run: { tests: 3, passed: 2, failed: 0, cancelled: 0, skipped: 1 },
		reason: null,
	});
	const r = await step(green.files, green.output);
	assert.equal(r.status, 0);
	assert.deepEqual(r.ran, [green.files]);
	assert.deepEqual(r.lines, ["tests/ui webkit over 1 files: 3 tests, 2 passed, 0 failed, 0 cancelled, 1 skipped"]);
});

test("T-301 a failing, all-skipped, empty or crashed run fails its engine step", async (t) => {
	const cases: [string, string][] = [
		[nodeTest(t, ['test("a", () => {}); test("b", () => { throw Error("x"); });']).output, "1 failed"],
		[nodeTest(t, ['test.skip("a", () => {}); test.todo("b");']).output, "no test passed (every test skipped)"],
		// A file with no test counts as one passing test; node:test over no file at all finds none.
		[nodeTest(t, []).output, "no test ran"],
		["Error: Cannot find module\n", "node:test printed no summary"],
	];
	for (const [output, reason] of cases) {
		assert.equal(engineVerdict(output).reason, reason);
		const r = await step(["tests/ui/x.test.mjs"], output);
		assert.equal(r.status, 1);
		assert.match(r.lines[0]!, new RegExp(`\\(failed: ${reason.replace(/[()]/g, "\\$&")}\\)$`));
	}
});

test("T-301 the last node:test summary counts, so a nested run's summary does not hide the outer failure", () => {
	const output = "ℹ tests 4\nℹ pass 4\nℹ fail 0\n...\nℹ tests 6\nℹ pass 5\nℹ fail 1\nℹ cancelled 0\n";
	assert.deepEqual(engineVerdict(output).run, { tests: 6, passed: 5, failed: 1, cancelled: 0, skipped: 0 });
});

test("T-301 an empty tests/ui file list fails the step without starting node:test", async () => {
	const r = await step([], "");
	assert.equal(r.status, 1);
	assert.deepEqual(r.ran, []);
	assert.deepEqual(r.lines, ["tests/ui webkit: no tests/ui/**/*.test.mjs file found"]);
});

test("T-301 the People seed runs first, since the Evry and Meetings seeds read its fixture", () => {
	const seeds = seedsOf(root);
	assert.equal(seeds[0]!.name, "people");
	assert.deepEqual(seeds.map((s) => s.name).sort(), [
		"evry",
		"invitation",
		"meetings",
		"oversight",
		"people",
		"pipeline",
	]);
});

test("T-301 the nightly ui job runs webkit after a failed chromium run and uses no secret", () => {
	const workflow = readFileSync(join(root, ".github/workflows/nightly.yml"), "utf8");
	const job = workflow.slice(workflow.indexOf("\n  ui:\n"));
	assert.doesNotMatch(workflow, /secrets\./);
	for (const engine of ["chromium", "webkit"]) {
		const at = job.indexOf(`- name: tests/ui ${engine}\n`);
		assert.ok(at > 0, `${engine} step`);
		const stepText = job.slice(at, job.indexOf("\n      - ", at + 1));
		assert.match(stepText, /if: \$\{\{ !cancelled\(\) && steps\.up\.outcome == 'success' \}\}/);
		assert.match(stepText, new RegExp(`run: node scripts/nightly-ui\\.ts test ${engine} "\\$UI_DIR"`));
	}
	// Every step reads UI_DIR, which the job's first step writes to GITHUB_ENV under the runner's temp directory.
	assert.match(
		job,
		/\n    steps:\n(?:\s+#.*\n)*      - name: tests\/ui directory\n        run: echo "UI_DIR=\$RUNNER_TEMP\/nightly-ui" >> "\$GITHUB_ENV"\n/,
	);
	assert.match(
		job,
		/path: \|\n\s+\$\{\{ runner\.temp \}\}\/nightly-ui\n\s+!\$\{\{ runner\.temp \}\}\/nightly-ui\/fixtures\n/,
	);
	assert.match(job, /- name: tests\/ui logs\n\s+if: failure\(\)[\s\S]*retention-days: \d+/);
	assert.doesNotMatch(workflow, /pull_request/);
});
