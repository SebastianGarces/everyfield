import assert from "node:assert/strict";
import { test } from "node:test";
import { BLOCK_CHARS, MESSAGE_CHARS, behaviorFailure } from "./failures.mjs";

const evidence = "/tmp/census/behaviors.log";

function failure(file, line, name, error) {
	return [`test at ${file}:${line}:3`, `✖ ${name} (1.2ms)`, ...error.map((text) => "  " + text), ""];
}

const deep = failure("../../tests/integration/people/fields.test.mts", 191, "renames a field", [
	"AssertionError [ERR_ASSERTION]: Expected values to be strictly deep-equal:",
	"+ actual - expected",
	"",
	"  [",
	"+   'welcome',",
	"-   'Welcome',",
	"    0",
	"  ]",
	"",
	"    at TestContext.<anonymous> (file:///repo/tests/integration/people/fields.test.mts:191:10)",
	"    at Test.runInAsyncScope (node:async_hooks:226:14)",
	"    at Test.run (node:internal/test_runner/test:1402:25) {",
	"  generatedMessage: true,",
	"  code: 'ERR_ASSERTION',",
	"  actual: [ 'welcome', 0 ],",
	"  expected: [ 'Welcome', 0 ],",
	"  operator: 'deepStrictEqual'",
	"}",
]);

const thrown = failure("../../tests/integration/meetings/notes.test.mts", 40, "saves notes", [
	"Error: boom in notes",
	"    at save (file:///repo/packages/domain/src/meetings/notes.ts:12:9)",
	"    at TestContext.<anonymous> (file:///repo/tests/integration/meetings/notes.test.mts:41:3)",
	"    at Test.runInAsyncScope (node:async_hooks:226:14)",
]);

function log(...blocks) {
	return [
		"✔ passes (3ms)",
		"✖ renames a field (1.2ms)",
		"✖ saves notes (1.2ms)",
		"ℹ fail 2",
		"",
		"✖ failing tests:",
		"",
		...blocks.flat(),
	].join("\n");
}

test("INV-census: a behavior failure message names each failing test's assertion, diff and test-file frame", () => {
	const message = behaviorFailure(evidence, log(deep, thrown));
	assert.equal(
		message.split("\n\nFailing tests' errors:")[0],
		[
			`Behavior suites failed; evidence: ${evidence}`,
			"✖ renames a field (1.2ms)",
			"✖ saves notes (1.2ms)",
			"✖ failing tests:",
			"✖ renames a field (1.2ms)",
			"✖ saves notes (1.2ms)",
		].join("\n"),
	);
	assert.ok(
		message.includes(
			[
				"✖ renames a field (1.2ms)",
				"AssertionError [ERR_ASSERTION]: Expected values to be strictly deep-equal:",
				"+ actual - expected",
				"  [",
				"+   'welcome',",
				"-   'Welcome',",
				"    0",
				"  ]",
				"    at TestContext.<anonymous> (file:///repo/tests/integration/people/fields.test.mts:191:10)",
			].join("\n") + "\n\n",
		),
		message,
	);
	assert.ok(
		message.endsWith(
			[
				"✖ saves notes (1.2ms)",
				"Error: boom in notes",
				"    at TestContext.<anonymous> (file:///repo/tests/integration/meetings/notes.test.mts:41:3)",
			].join("\n"),
		),
		message,
	);
	assert.ok(!message.includes("runInAsyncScope") && !message.includes("generatedMessage"), message);
});

test("INV-census: a behavior failure message cuts long errors and many failures, pointing to the evidence log", () => {
	const long = failure("../../tests/integration/a.test.mts", 1, "long", [
		"Error: " + "x".repeat(BLOCK_CHARS * 2),
		"    at TestContext.<anonymous> (file:///repo/tests/integration/a.test.mts:1:1)",
	]);
	const many = Array.from({ length: 40 }, (_, index) =>
		failure("../../tests/integration/b.test.mts", index + 1, `case ${index}`, [
			"Error: " + "y".repeat(BLOCK_CHARS / 2),
			`    at TestContext.<anonymous> (file:///repo/tests/integration/b.test.mts:${index + 1}:1)`,
		]),
	);
	const message = behaviorFailure(evidence, log(long, ...many));
	assert.ok(message.length <= MESSAGE_CHARS, String(message.length));
	assert.ok(message.includes(`✖ long (1.2ms)\nError: xxx`));
	assert.ok(message.includes(`\n  … error cut; full log: ${evidence}\n`), message.slice(0, 3000));
	assert.ok(message.includes("✖ case 0 (1.2ms)\nError: yyy"));
	assert.ok(message.endsWith(`\n\n… more failing tests cut; full log: ${evidence}`), message.slice(-300));
	assert.ok(!message.includes("✖ case 39 (1.2ms)\nError"));
});

test("INV-census: a behavior log with no failing-tests summary keeps today's message", () => {
	const plain = "✖ crashed.test.mts\nsome stderr\n";
	assert.equal(behaviorFailure(evidence, plain), `Behavior suites failed; evidence: ${evidence}\n✖ crashed.test.mts`);
});
