// T-126: template compare names each changed block. A heading with no level is the format's level 2, so it must read
// "Heading 2"; it used to read "Heading 1". The paper names come from one map, so Page setup, compare and the library
// cards say the same name.
import assert from "node:assert/strict";
import { test } from "node:test";
import type { BlockNode } from "../../../packages/contracts/src/documents/index.ts";
import { FORMAT_SCHEMA } from "../../../packages/contracts/src/documents/index.ts";
import { blockLabel, paperText } from "../../../apps/web/src/features/documents/church/labels.ts";

const heading = (attrs: Record<string, unknown>) => ({ type: "heading", attrs, content: [] }) as unknown as BlockNode;

test("BUG-PR551: a heading with no level is Heading 2, the format default", () => {
	assert.equal(FORMAT_SCHEMA.nodes.heading?.attrs.level?.default, 2);
	assert.equal(blockLabel(heading({})), "Heading 2");
	assert.equal(blockLabel(heading({ level: 1 })), "Heading 1");
	assert.equal(blockLabel(heading({ level: 3 })), "Heading 3");
});

test("INV-documents-labels: library cards name the paper as Page setup does", () => {
	assert.equal(paperText({ width: 612, height: 792, perSheet: 1 }), "Letter");
	assert.equal(paperText({ width: 432, height: 288, perSheet: 1 }), "4 x 6 card, landscape");
	assert.equal(paperText({ width: 396, height: 612, perSheet: 4 }), "4 cards on one Half Letter sheet");
});
