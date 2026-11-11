// The 100-person cap as the composer shows it: the Who step's line and the refusal after Schedule or Send now.
import assert from "node:assert/strict";
import { test } from "node:test";
import { capText, outcomeText } from "../../../apps/web/src/features/communication/model.ts";

test("the Who step names the count and the cap, and says what to do over it", () => {
	assert.deepEqual(capText(100), { text: "100 people · messages go to at most 100", over: false });
	assert.deepEqual(capText(1), { text: "1 person · messages go to at most 100", over: false });
	assert.deepEqual(capText(101), {
		text: "101 people · messages go to at most 100. Remove 1 to schedule or send it.",
		over: true,
	});
});

test("an audience_too_large refusal names the count and the 100-person limit", () => {
	assert.equal(
		outcomeText({ status: "refused", code: "audience_too_large", details: { limit: 100, recipients: 101 } }),
		"This message would go to 101 people. Messages go to at most 100 people. Remove people in Who, then try again. Nothing was sent.",
	);
});
