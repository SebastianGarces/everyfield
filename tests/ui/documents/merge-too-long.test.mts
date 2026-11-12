// T-126: the library shows the 16 KB size text only for the server's merge-size refusal. The screen used to look for
// "16" in the refusal's words, so any other invalid input that mentioned 16 showed the size text. It now reads the
// refusal's path. The domain's own refusal is used here, so a change to its path breaks this test.
import assert from "node:assert/strict";
import { test } from "node:test";
import { MERGE_TOO_LONG, mergeTooLong } from "../../../apps/web/src/features/documents/model.ts";
import { cleanOverrides } from "../../../packages/domain/src/documents/merge.ts";

test("the merge-size refusal shows the 16 KB text", () => {
	const refusal = cleanOverrides({ tagline: "x".repeat(16 * 1024 + 1) });
	assert.equal(refusal.ok, false);
	assert.ok(!refusal.ok);
	assert.equal(mergeTooLong("invalid_input", refusal.path), true);
	assert.equal(MERGE_TOO_LONG, "Shorten the fields. Together they must stay under 16 KB.");
});

test("another invalid input whose words mention 16 does not show the size text", () => {
	const refusal = cleanOverrides({ tagline: "short" });
	assert.equal(refusal.ok, true);
	assert.equal(mergeTooLong("invalid_input", "overrides.row_16"), false);
	assert.equal(mergeTooLong("invalid_input", undefined), false);
	assert.equal(mergeTooLong("unavailable", "overrides"), false);
});
