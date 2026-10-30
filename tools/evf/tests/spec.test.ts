import test from "node:test";
import assert from "node:assert/strict";
import { doneCriteria, specSections } from "../spec.ts";

const body = `## Goal

First slice of the ask.

## Done criteria

1. One.
2. Two.

## Non-goals

- Nothing.
`;

test("Later slices under a heading stay out of the Done criteria", () => {
	const spec = `${body}
## Later slices

1. Slice B: lists. About 8 criteria. Depends on this slice.
2. Slice C: forms. About 10 criteria. Depends on B.
`;
	assert.deepEqual(doneCriteria(spec), ["1", "2"]);
	assert.equal(specSections(spec).at(-1)!.title, "Later slices");
});

test("Later slices as a plain label start their own section", () => {
	const spec = `${body}
Later slices:
1. Slice B: lists. About 8 criteria. Depends on this slice.
2. Slice C: forms. About 10 criteria. Depends on B.
3. Slice D: export. About 5 criteria. Depends on C.
`;
	assert.deepEqual(doneCriteria(spec), ["1", "2"]);
});

test("Later slices placed after Done end the Done list", () => {
	const spec = `Goal: x\nDone when:\n1. A.\nLater slices:\n1. B.\n2. C.\n3. D.\nNon-goals: none.\n`;
	assert.deepEqual(doneCriteria(spec), ["1"]);
});
