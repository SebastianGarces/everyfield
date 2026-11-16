import assert from "node:assert/strict";
import { test } from "node:test";
import { blockerText } from "../../../apps/web/src/features/people/corrections/model.ts";

test("AC:TARGET-PPL-016 a merge blocked by past history names what blocks it and gives no advice that cannot clear it", () => {
	const text = blockerText("unregistered_reference", { source: "Avery Stone", survivor: "Avery Stone" }, [
		"participation",
		"mail",
		"task",
	]);
	assert.equal(
		text,
		"Avery Stone has meeting attendances, emails and tasks on record. Merging people with this history is not available in Everyfield yet.",
	);
	assert.doesNotMatch(text, /finish|reassign|review again/i);
});
