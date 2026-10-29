// Merge review and record correction rules (WP-015/ui) that a silent break would turn into lost data or a wrong write.
// They run in node against the real module the screens use; no browser.
//   INV-merge-choices: a merge never drops a known value by default, and the request names only fields taken from
//     the source, so a field left out keeps the survivor's value.
//   INV-survivor: without an explicit choice the person with an account stays, otherwise the person added first.
//   BUG-217-F3: an edit made through Edit a record stays on its record card after a correction to another
//     record; a newer save on the card itself still wins.
//   INV-correction-patch: a correction sends only the changed fields, a cleared note as null, nothing when nothing
//     changed, and the shown total is the sum the server computes.
import assert from "node:assert/strict";
import { test } from "node:test";
import {
	assessmentChanges,
	commitmentChanges,
	defaultChoices,
	defaultSurvivor,
	interviewChanges,
	sourceChoices,
	totalOf,
} from "../../../apps/web/src/features/people/corrections/model.ts";
import { withCorrections } from "../../../apps/web/src/features/people/assessments/model.ts";

test("AC:TARGET-PPL-017 AC:TARGET-PPL-025 INV-merge-choices: an empty survivor value takes the source's; only source picks are sent", () => {
	const fields = [
		{ field: "email", source: { email: "j.okafor@outlook.test" }, survivor: { email: "james@example.test" } },
		{ field: "phone", source: { phone: "(512) 555-0188" }, survivor: { phone: null } },
		{
			field: "household",
			source: { household_id: null, household_role: null },
			survivor: { household_id: "h1", household_role: "head" },
		},
		{ field: "summaryNotes", source: { notes: "  " }, survivor: { notes: null } },
	];
	const choices = defaultChoices(fields);
	assert.deepEqual(choices, { email: "survivor", phone: "source", household: "survivor", summaryNotes: "survivor" });
	assert.deepEqual(sourceChoices(choices), { phone: "source" });
	assert.deepEqual(sourceChoices({ ...choices, email: "source", phone: "survivor" }), { email: "source" });
});

test("AC:TARGET-PPL-017 INV-survivor: the linked person stays; otherwise the one added first", () => {
	const a = { id: "a", createdAt: "2026-08-20T10:00:00.000Z", linked: false };
	const b = { id: "b", createdAt: "2026-10-02T10:00:00.000Z", linked: false };
	assert.equal(defaultSurvivor(a, b), "a");
	assert.equal(defaultSurvivor(b, a), "a");
	assert.equal(defaultSurvivor(a, { ...b, linked: true }), "b");
});

test("AC:TARGET-PPL-015 INV-correction-patch: only changed fields are sent, a cleared note as null, none when unchanged", () => {
	const lens = (score, notes = null) => ({ score, notes });
	const base = {
		occurredOn: "2026-10-01",
		committed: lens(4, "Shows up every week."),
		compelled: lens(3),
		contagious: lens(5),
		courageous: lens(2),
	};
	assert.deepEqual(assessmentChanges(base, { ...base }), {});
	assert.deepEqual(assessmentChanges(base, { ...base, committed: lens(4, "  "), courageous: lens(4) }), {
		committed: lens(4, null),
		courageous: lens(4),
	});
	assert.equal(totalOf({ ...base, courageous: lens(4) }), 16);

	const rating = (r, notes = null) => ({ rating: r, notes });
	const interview = {
		occurredOn: "2026-10-07",
		maturity: rating("pass"),
		gifted: rating("pass"),
		chemistry: rating("concern", "Quiet in groups."),
		rightReasons: rating("pass"),
		season: rating("pass"),
		result: "qualified_with_notes",
		nextSteps: "Meet the worship lead.",
	};
	assert.deepEqual(interviewChanges(interview, { ...interview, result: "qualified", nextSteps: "" }), {
		result: "qualified",
		nextSteps: null,
	});
	assert.deepEqual(commitmentChanges({ notes: "Signed at dinner." }, { notes: "Signed at dinner. " }), {});
	assert.deepEqual(commitmentChanges({ notes: null }, { notes: "Witnessed by the pastor." }), {
		notes: "Witnessed by the pastor.",
	});
});

test("AC:TARGET-PPL-015 BUG-217-F3: every correction stays on its card; a newer save on the card still wins", () => {
	const rec = (id, revision, total, occurredOn = "2026-10-01") => ({
		id,
		revision,
		total,
		occurredOn,
		recordedAt: `${occurredOn}T10:00:00.000Z`,
	});
	const card = [rec("a1", "3", 14), rec("a2", "1", 12, "2026-09-01")];
	// Two edits made through Edit a record, then a correction to another record type (not in this card).
	const corrections = [rec("a1", "4", 17), rec("a2", "2", 13, "2026-09-01")];
	assert.deepEqual(
		withCorrections(card, corrections).map((r) => [r.id, r.total]),
		[
			["a1", 17],
			["a2", 13],
		],
	);
	// The card later saves a1 itself (revision 5): the older correction no longer replaces it.
	const saved = [rec("a1", "5", 18), rec("a2", "1", 12, "2026-09-01")];
	assert.deepEqual(
		withCorrections(saved, corrections).map((r) => [r.id, r.total]),
		[
			["a1", 18],
			["a2", 13],
		],
	);
	// A correction for a record this card has not loaded adds nothing.
	assert.equal(withCorrections(card, [rec("zz", "9", 20)]).length, 2);
});

test("AC:TARGET-PPL-015 INV-optional-reason: an edit saved with no reason stays on the card", () => {
	// The edited record shows on its card as saved now, with no reason needed.
	const rec = (revision, total) => ({
		id: "a1",
		revision,
		total,
		occurredOn: "2026-10-01",
		recordedAt: "2026-10-01T10:00:00.000Z",
	});
	assert.deepEqual(
		withCorrections([rec("3", 14)], [rec("4", 17)]).map((r) => r.total),
		[17],
	);
});
