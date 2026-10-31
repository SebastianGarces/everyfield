// WP-037/ui: the pure rules of the Church Document screen (apps/web/src/features/documents/church-model.ts).
//   AC:CASE-DOC-020-EDIT: a doctrinal slot keeps its place and id through any edit, and a blank slot stays blank.
//   AC:CASE-DOC-022: the template panel offers Create only to an Owner or Admin, and only for an authored template.
//   INV-church-body: an empty or oversized body is refused before any request; blank blocks are not saved.
import assert from "node:assert/strict";
import { test } from "node:test";
import {
	bodyFromRows,
	bodyProblem,
	churchProblem,
	createOffer,
	plantTime,
	rowsFromBody,
	sameBody,
} from "../../../apps/web/src/features/documents/church-model.ts";

const slots = [{ id: "statement-of-faith", label: "Statement of faith" }];
const body = [
	{ kind: "heading", text: "Name" },
	{ kind: "paragraph", text: "Hello" },
	{ kind: "slot", slotId: "statement-of-faith", text: "" },
	{ kind: "bulleted_list", items: ["one", "two"] },
	{ kind: "numbered_list", items: ["first"] },
] as const;

test("AC:CASE-DOC-020-EDIT the body round-trips through the editor rows, and a blank slot stays", () => {
	const rows = rowsFromBody(body, slots);
	assert.deepEqual(bodyFromRows(rows), body);
	assert.equal(sameBody(rows, body), true);
	const slot = rows.find((row) => row.slot);
	assert.equal(slot?.slot?.label, "Statement of faith");
	assert.equal(slot?.key, "slot:statement-of-faith");
	// A blank paragraph and an empty list line are dropped; the blank slot is kept.
	const edited = rows.map((row) => (row.kind === "paragraph" && !row.slot ? { ...row, text: "  " } : row));
	assert.deepEqual(
		bodyFromRows(edited).map((block) => block.kind),
		["heading", "slot", "bulleted_list", "numbered_list"],
	);
	assert.equal(sameBody(edited, body), false);
});

test("INV-church-body an empty or oversized body is refused with a plain message", () => {
	assert.equal(bodyProblem(rowsFromBody(body, slots)), null);
	const blank = rowsFromBody([{ kind: "slot", slotId: "statement-of-faith", text: "" }], slots);
	assert.equal(bodyProblem(blank), "Add some text before you save.");
	assert.equal(bodyProblem(rowsFromBody([], slots)), "Add some text before you save.");
	const huge = rowsFromBody([{ kind: "paragraph", text: "x" }], slots).map((row) => ({
		...row,
		text: "x".repeat(20_001),
	}));
	assert.equal(bodyProblem(huge), "Shorten the document. It is too long to save.");
	// A filled slot counts as text.
	assert.equal(
		bodyProblem(rowsFromBody([{ kind: "slot", slotId: "statement-of-faith", text: "We believe." }], slots)),
		null,
	);
});

test("AC:CASE-DOC-022 the template panel offers Create only to an Owner or Admin for an authored template", () => {
	assert.equal(createOffer({ editable: "ready" }, true), "create");
	assert.equal(createOffer({ editable: "ready" }, false), "owner_only");
	assert.equal(createOffer({ editable: "pending" }, true), "not_ready");
	assert.equal(createOffer({ editable: "pending" }, false), "not_ready");
	assert.equal(createOffer({ editable: null }, true), "none");
});

test("a refusal reads as a plain sentence that names the slot, never a code", () => {
	assert.match(
		churchProblem({ code: "slot_not_deletable", slotIds: ["statement-of-faith"] }, "x", slots),
		/Statement of faith slot cannot be removed.*edits are still here/,
	);
	assert.match(churchProblem({ code: "conflict" }, "x"), /Reload/);
	assert.equal(churchProblem("lost", "Try again."), "Try again.");
});

test("times use the church plant's time zone", () => {
	assert.match(plantTime("2026-10-31T01:30:00.000Z", "America/Chicago"), /Oct 30, 2026, 8:30 PM/);
});
