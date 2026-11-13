// Duplicates review copy (WP-015/ui, T-192) that a silent break would turn back into advice the reviewer cannot act on.
// The registry blocks a merge on any reference of a `block` kind whatever its state, so the refusal names the kinds and
// says the merge is not available yet; it never tells the reviewer to change the records first.
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
