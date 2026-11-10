// T-41: `bin/dev check` on a throwaway repository. A fake runner stands in for pnpm, python and the test runner, so
// these tests see exactly which commands a selection runs, what the record says, and when the run fails.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { check, type CheckRecord, type Runner } from "../../scripts/check.ts";

const sh = (cwd: string, ...args: string[]) =>
	execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t.invalid", ...args], { cwd, encoding: "utf8" }).trim();

/** A repository whose main has one package, one workflow test and docs; the branch then commits `change`. */
function repo(t: { after(fn: () => void): void }, change: Record<string, string>, extra: Record<string, string> = {}) {
	const root = mkdtempSync(join(tmpdir(), "evf-check-repo-"));
	const home = mkdtempSync(join(tmpdir(), "evf-check-home-"));
	t.after(() => {
		rmSync(root, { recursive: true, force: true });
		rmSync(home, { recursive: true, force: true });
	});
	const write = (files: Record<string, string>) => {
		for (const [path, text] of Object.entries(files)) {
			mkdirSync(dirname(join(root, path)), { recursive: true });
			writeFileSync(join(root, path), text);
		}
	};
	sh(root, "init", "-q", "-b", "main");
	write({
		"docs/a.md": "a\n",
		"packages/ui/package.json": JSON.stringify({
			name: "@everyfield/ui",
			scripts: { lint: "eslint .", "test:unit": "node --test" },
		}),
		"packages/ui/src/button.ts": "export {};\n",
		"scripts/dev.ts": "export {};\n",
		"tests/workflow/dev.test.mjs": "\n",
		"tools/ci/tests/a.test.ts": "\n",
		".github/scripts/a.test.cjs": "\n",
		...extra,
	});
	sh(root, "add", ".");
	sh(root, "commit", "-qm", "main");
	sh(root, "update-ref", "refs/remotes/origin/main", "HEAD");
	const base = sh(root, "rev-parse", "HEAD");
	sh(root, "switch", "-qc", "task");
	write(change);
	sh(root, "add", ".");
	sh(root, "commit", "-qm", "change");
	const map = {
		head: base,
		createdAt: new Date().toISOString(),
		tests: {
			"tests/workflow/dev.test.mjs": ["scripts/dev.ts"],
			"tools/ci/tests/a.test.ts": [],
			".github/scripts/a.test.cjs": [],
			"tools/qa/tests/a.test.ts": [],
		},
	};
	writeFileSync(join(home, "coverage-map.json"), JSON.stringify(map));
	return { root, home, base, head: sh(root, "rev-parse", "HEAD") };
}

/** A runner that passes everything, reports `tests` tests per test file, and records each command. */
function fake({ tests = 3, unitOutput = "ℹ tests 5\nℹ pass 5" } = {}) {
	const commands: string[] = [];
	const run: Runner = (command, args, { cwd, env }) => {
		commands.push([command, ...args].join(" "));
		if (args.includes("ls")) return { status: 0, stdout: JSON.stringify([{ name: "@everyfield/ui" }]), output: "" };
		if (args[0] === "scripts/test-workflow.mjs") {
			const files = args.slice(1);
			const report = files.flatMap((f) =>
				Array.from({ length: tests }, (_, i) => ({ name: `t${i}`, file: join(cwd, f), status: "passed" })),
			);
			writeFileSync(env.EVF_TEST_REPORT!, JSON.stringify({ tests: report }));
			return { status: report.length ? 0 : 1, stdout: "", output: "" };
		}
		if (args.includes("test:unit")) return { status: 0, stdout: unitOutput, output: unitOutput };
		return { status: 0, stdout: "", output: "" };
	};
	return { run, commands };
}

const ran = (record: CheckRecord) => record.checks.filter((c) => c.run).map((c) => c.id);
const read = (path: string) => JSON.parse(readFileSync(path, "utf8")) as CheckRecord;

test("T-41 a one-package change runs its package checks through the merge-base and dependents filter", (t) => {
	const { root, home, base, head } = repo(t, { "packages/ui/src/button.ts": "export const x = 1;\n" });
	const { run, commands } = fake();
	const { record, recordPath } = check({ root, full: false, home, run });
	assert.ok(recordPath.startsWith(home) && !recordPath.startsWith(root), recordPath);
	assert.deepEqual(read(recordPath), record);
	assert.equal(record.head, head);
	assert.equal(record.mergeBase, base);
	assert.equal(record.mode, "selected");
	assert.equal(record.result, "passed");
	assert.deepEqual(ran(record), ["lint", "typecheck", "test:unit"]);
	const filter = `--filter ...[${base}] --filter ...@everyfield/ui`;
	assert.deepEqual(
		record.checks.filter((c) => c.run).map(({ id, command, result, tests }) => ({ id, command, result, tests })),
		[
			{ id: "lint", command: `corepack pnpm ${filter} --if-present run lint`, result: "passed", tests: null },
			// The fixture package defines no typecheck, so pnpm would run nothing: recorded as skipped, not passed.
			{ id: "typecheck", command: null, result: "skipped", tests: null },
			{ id: "test:unit", command: `corepack pnpm ${filter} --if-present run test:unit`, result: "passed", tests: 5 },
		],
	);
	assert.equal(
		record.checks.find((c) => c.id === "typecheck")!.reason,
		"package source: packages/ui/src/button.ts; no selected package defines typecheck",
	);
	assert.deepEqual(
		record.tests.find((x) => x.file === "tests/workflow/dev.test.mjs"),
		{
			file: "tests/workflow/dev.test.mjs",
			check: "workflow",
			run: false,
			reason: "no changed file reached it",
			result: "skipped",
			tests: null,
		},
	);
	assert.ok(!commands.some((c) => c.includes("test-workflow") || c.includes("check-all")), commands.join("\n"));
});

test("T-41 a changed source file runs the test files that reached it, with their counts", (t) => {
	const { root, home } = repo(t, { "scripts/dev.ts": "export const y = 2;\n" });
	const { record } = check({ root, full: false, home, run: fake().run });
	assert.equal(record.result, "passed");
	assert.deepEqual(ran(record), ["workflow"]);
	assert.deepEqual(record.tests, [
		{
			file: ".github/scripts/a.test.cjs",
			check: "github-scripts",
			run: false,
			reason: "no changed file reached it",
			result: "skipped",
			tests: null,
		},
		{
			file: "tests/workflow/dev.test.mjs",
			check: "workflow",
			run: true,
			reason: "reached scripts/dev.ts",
			result: "passed",
			tests: 3,
		},
		{
			file: "tools/ci/tests/a.test.ts",
			check: "tools-ci",
			run: false,
			reason: "no changed file reached it",
			result: "skipped",
			tests: null,
		},
	]);
	assert.equal(record.checks.find((c) => c.id === "workflow")!.tests, 3);
});

test("T-41 a non-empty diff that selects no checks fails, and so does a check that reports 0 tests", async (t) => {
	await t.test("no check selected", (t) => {
		// bin/qa selects the QA tool suite, which this repository does not have.
		const { root, home } = repo(t, { "bin/qa": "#!/bin/sh\n" });
		const { run, commands } = fake();
		const { record } = check({ root, full: false, home, run });
		assert.equal(record.mode, "selected");
		assert.deepEqual(ran(record), []);
		assert.deepEqual(commands, []);
		assert.equal(record.result, "failed");
		assert.deepEqual(record.failures, ["the diff selected no checks, so nothing proves it; run bin/dev check --full"]);
	});
	await t.test("a test file that reports 0 tests", (t) => {
		const { root, home } = repo(t, { "scripts/dev.ts": "export const y = 2;\n" });
		const { record } = check({ root, full: false, home, run: fake({ tests: 0 }).run });
		assert.equal(record.result, "failed");
		assert.deepEqual(record.failures, ["workflow reported 0 tests", "tests/workflow/dev.test.mjs reported 0 tests"]);
	});
	await t.test("test:unit that reports 0 tests", (t) => {
		const { root, home } = repo(t, { "packages/ui/src/button.ts": "export const x = 1;\n" });
		const { record } = check({ root, full: false, home, run: fake({ unitOutput: "nothing ran" }).run });
		assert.equal(record.result, "failed");
		assert.deepEqual(record.failures, ["test:unit reported 0 tests"]);
	});
	await t.test("a pnpm filter that selects no package", (t) => {
		const { root, home } = repo(t, { "packages/ui/src/button.ts": "export const x = 1;\n" });
		const run: Runner = (command, args, options) =>
			args.includes("ls") ? { status: 0, stdout: "[]", output: "" } : fake().run(command, args, options);
		const { record } = check({ root, full: false, home, run });
		assert.equal(record.result, "failed");
		assert.deepEqual(record.failures, ["lint failed", "typecheck failed", "test:unit failed"]);
	});
});

test("T-41 --full, the verifier mode, ignores selection: a docs-only diff runs every check", (t) => {
	const { root, home } = repo(t, { "docs/a.md": "b\n" }, { "tools/qa/tests/a.test.ts": "\n" });
	const selected = check({ root, full: false, home, run: fake().run }).record;
	assert.deepEqual(ran(selected), ["docs"]);
	const { run, commands } = fake();
	const { record } = check({ root, full: true, home, run });
	assert.equal(record.mode, "full");
	assert.deepEqual(record.fullReasons, ["verifier run (--full) ignores selection"]);
	assert.deepEqual(ran(record), [
		"lint",
		"typecheck",
		"test:unit",
		"docs",
		"ci-coverage",
		"workflow",
		"tools-ci",
		"tools-qa",
		"github-scripts",
	]);
	assert.ok(commands.includes("corepack pnpm -r --if-present run lint"), commands.join("\n"));
	assert.ok(
		commands.some((c) => c.endsWith("scripts/test-workflow.mjs tests/workflow/dev.test.mjs")),
		commands.join("\n"),
	);
	assert.equal(record.result, "passed", record.failures.join("\n"));
	assert.deepEqual(
		record.tests.map((x) => [x.file, x.run, x.result]),
		[
			[".github/scripts/a.test.cjs", true, "passed"],
			["tests/workflow/dev.test.mjs", true, "passed"],
			["tools/ci/tests/a.test.ts", true, "passed"],
			["tools/qa/tests/a.test.ts", true, "passed"],
		],
	);
});

test("T-41 an unreadable diff runs everything", (t) => {
	const { root, home } = repo(t, { "docs/a.md": "b\n" });
	sh(root, "update-ref", "-d", "refs/remotes/origin/main");
	const { record } = check({ root, full: false, home, run: fake().run });
	assert.equal(record.mergeBase, null);
	assert.equal(record.mode, "full");
	assert.deepEqual(record.fullReasons, ["the diff could not be read"]);
});
