// Person field rules (WP-012/ui) that run in node against the module the screens use.
//   AC:TARGET-PPL-009: a household join, leave or role change reads in Activity with the household name recorded then,
//     so a person's history still names a household after it is renamed or deleted; the current membership of the
//     viewed person comes only from the members list, so after leaving the card shows no household.
import assert from "node:assert/strict";
import { test } from "node:test";
import {
	householdChange,
	membershipOf,
	photoProblem,
	takeFile,
} from "../../../apps/web/src/features/people/fields/model.ts";

const santos = (role) => ({ householdId: "h1", name: "Santos household", role });

test("AC:TARGET-PPL-009 household changes in Activity name the household as recorded", () => {
	const rows = [
		[{ from: null, to: santos("spouse") }, "Joined Santos household as spouse"],
		[{ from: santos("spouse"), to: null }, "Left Santos household"],
		[{ from: santos("spouse"), to: santos("other") }, "Role in Santos household changed to other"],
		[
			{ from: santos("head"), to: { householdId: "h2", name: "Lee household", role: "head" } },
			"Moved from Santos household to Lee household",
		],
	];
	for (const [change, text] of rows) assert.equal(householdChange(change), text);
});

test("AC:TARGET-PPL-009 a person who left reads as in no household, even though the answer names the household left", () => {
	const left = {
		status: "available",
		household: { id: "h1", name: "Santos household" },
		members: [{ personId: "maria", role: "head" }],
	};
	assert.deepEqual(membershipOf(left, "maria"), santos("head"));
	assert.equal(membershipOf(left, "james"), null);
	assert.equal(membershipOf({ status: "none" }, "maria"), null);
});

test("BUG-58bc5acb8: choosing the same refused photo twice reaches the check twice", () => {
	// A browser picker fires change only when its value differs from the one it holds.
	const picker = { files: null, value: "" };
	const checked = [];
	const choose = (file) => {
		const value = `C:\\fakepath\\${file.name}`;
		if (picker.value === value) return;
		picker.value = value;
		picker.files = [file];
		const taken = takeFile(picker);
		if (taken) checked.push(photoProblem(taken));
	};
	const big = { name: "big.jpg", size: 4 * 1024 * 1024, type: "image/jpeg" };
	choose(big);
	choose(big);
	assert.deepEqual(checked, ["Choose a photo smaller than 3 MB.", "Choose a photo smaller than 3 MB."]);
	assert.equal(picker.value, "");
});
