import assert from "node:assert/strict";
import { test } from "node:test";
import { blockerText } from "../../../apps/web/src/features/people/corrections/model.ts";

test("AC:TARGET-PPL-016 a merge blocked by a leadership conflict names the team and both roles and says to end one first", () => {
	const text = blockerText(
		"leadership_conflict",
		{ source: "Avery Stone", survivor: "Avery Stone Keep" },
		{ leadership: [{ team: "Worship", sourceRole: "Vocals", survivorRole: "Guitar" }], invitations: [] },
	);
	assert.equal(
		text,
		"Avery Stone is Vocals and Avery Stone Keep is Guitar on Worship. One person can’t hold two current roles on one team, so end one of those roles first.",
	);
	assert.doesNotMatch(text, /not available in Everyfield yet/);
});
