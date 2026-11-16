import assert from "node:assert/strict";
import { test } from "node:test";
import { MERGE_TOO_LONG, mergeTooLong } from "../../../apps/web/src/features/documents/model.ts";
import { cleanOverrides } from "../../../packages/domain/src/documents/merge.ts";

test("BUG-PR551: the merge-size refusal shows the 16 KB text", () => {
	const refusal = cleanOverrides({ tagline: "x".repeat(16 * 1024 + 1) });
	assert.equal(refusal.ok, false);
	assert.ok(!refusal.ok);
	assert.equal(mergeTooLong("invalid_input", refusal.path), true);
	assert.equal(MERGE_TOO_LONG, "Shorten the fields. Together they must stay under 16 KB.");
});

test("BUG-PR551: another invalid input whose words mention 16 does not show the size text", () => {
	assert.equal(mergeTooLong("invalid_input", "overrides.row_16"), false);
	assert.equal(mergeTooLong("invalid_input", undefined), false);
	assert.equal(mergeTooLong("unavailable", "overrides"), false);
});
