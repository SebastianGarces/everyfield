import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { findPlanIds } from "../test-names.ts";

const tool = resolve(import.meta.dirname, "../test-names.ts");

/** A git repository holding the given tracked files. */
function repo(files: Record<string, string>) {
	const root = mkdtempSync(join(tmpdir(), "test-names-"));
	execFileSync("git", ["init", "--quiet", root]);
	for (const [file, source] of Object.entries(files)) {
		mkdirSync(dirname(join(root, file)), { recursive: true });
		writeFileSync(join(root, file), source);
	}
	execFileSync("git", ["add", "."], { cwd: root });
	return { root, close: () => rmSync(root, { recursive: true, force: true }) };
}

const cli = (root: string) => spawnSync(process.execPath, [tool], { cwd: root, encoding: "utf8" });

test("a test, it, describe, subtest or template-literal name citing a plan id is flagged at its line", () => {
	const source = [
		'test("T-190 library templates follow the brand kit", () => {});',
		"it('WP-033 criterion 10: an empty store gets the seed', () => {});",
		'describe("RT-4 the review list", () => {',
		'\tit("D-82 a ruling", async (t) => {',
		'\t\tawait t.test("AC:T151-4 an unknown handoff is replayed", () => {});',
		"\t});",
		"});",
		"test(`T-7 ${engine} reads once`, () => {});",
		'test.skip("T-8 skipped", () => {});',
	].join("\n");
	assert.deepEqual(
		findPlanIds("tests/ui/a.test.mts", source).map(({ line, id }) => ({ line, id })),
		[
			{ line: 1, id: "T-190" },
			{ line: 2, id: "WP-033" },
			{ line: 3, id: "RT-4" },
			{ line: 4, id: "D-82" },
			{ line: 5, id: "T151-4" },
			{ line: 8, id: "T-7" },
			{ line: 9, id: "T-8" },
		],
	);
});

test("catalog and invariant markers, comments, other strings and regexes in test files pass", () => {
	const source = [
		"// T-37 asked for this test; D-82 is the ruling.",
		"/* WP-036 */",
		'const label = "T-5 is a plan id, but not a test name";',
		'assert.match(out, /test\\("T-9/);',
		'test("AC:TARGET-PPL-016 INV-tenancy BUG-3b7185b67 AC:CASE-DOC-016 a dismissed pair leaves the list", () => {',
		'\tassert.equal(read("T-6"), "WP-1");',
		"});",
		"test(\n\t`AC:TARGET-IDN-006: a ${kind} photo shows`,\n\t() => {},\n);",
	].join("\n");
	assert.deepEqual(findPlanIds("tests/ui/a.test.mts", source), []);
});

test("the command fails with file, line, id and fix outside tests/workflow/, and passes tooling ids inside it", () => {
	const f = repo({
		"tests/workflow/evf.test.mts": 'test("T-37 evf runs three slots, per D-82", () => {});\n',
		"tests/integration/people/a.test.mts": '\ntest("AC:TARGET-PPL-016 a pair leaves the list", () => {});\n',
		"README.md": 'test("T-1 not a test file", () => {});\n',
	});
	try {
		let result = cli(f.root);
		assert.equal(result.status, 0, result.stderr);
		writeFileSync(
			join(f.root, "tests/integration/people/a.test.mts"),
			'\ntest("AC:TARGET-PPL-016 T-263 a pair leaves the list", () => {});\n',
		);
		result = cli(f.root);
		assert.equal(result.status, 1);
		assert.match(
			result.stderr,
			/^tests\/integration\/people\/a\.test\.mts:2: test name cites T-263: name the behavior, not the plan item\.$/m,
		);
		assert.doesNotMatch(result.stderr, /evf\.test|README/);
	} finally {
		f.close();
	}
});
