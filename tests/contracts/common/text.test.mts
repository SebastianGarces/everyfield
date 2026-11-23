import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { test } from "node:test";
import { pathToFileURL } from "node:url";

const contracts = createRequire(new URL("../../../packages/contracts/package.json", import.meta.url));
const { counted, countWord } = (await import(
	pathToFileURL(contracts.resolve("@everyfield/contracts/common")).href
)) as typeof import("../../../packages/contracts/src/common/index.ts");

test("counted writes the number and the word, grouping digits from 1,000", () => {
	assert.deepEqual(
		[0, 1, 2, 1234].map((n) => counted(n, "task")),
		["0 tasks", "1 task", "2 tasks", "1,234 tasks"],
	);
	assert.deepEqual(
		[0, 1, 2, 1234].map((n) => counted(n, "person", "people")),
		["0 people", "1 person", "2 people", "1,234 people"],
	);
});

test("countWord writes only the word for the count", () => {
	assert.deepEqual(
		[0, 1, 2, 1234].map((n) => countWord(n, "task")),
		["tasks", "task", "tasks", "tasks"],
	);
	assert.deepEqual(
		[0, 1, 2, 1234].map((n) => countWord(n, "person", "people")),
		["people", "person", "people", "people"],
	);
});
