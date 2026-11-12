// S2 batch 2 F06: a refused evaluation or correction names its fields; the modal shows each issue where it belongs.
import assert from "node:assert/strict";
import { test } from "node:test";
import { evaluationIssues } from "../../../apps/web/src/features/meetings/model.ts";
import { applyChange } from "../../../apps/web/src/features/meetings/page-state.ts";

test("BUG-01aca6707: each issue maps to its factor, notes, reason or the dialog", () => {
	const shown = evaluationIssues([
		{ path: "input.scores.agendaScore", problem: "Invalid input: expected number, received undefined" },
		{ path: "input.changes.nextStepsScore", problem: "Too big" },
		{ path: "input.reason", problem: "Too small" },
		{ path: "input.notes", problem: "Too big" },
		{ path: "input.evaluatedOn", problem: "outside_meeting_to_today" },
	]);
	assert.deepEqual(shown.scores, {
		agendaScore: "Choose a score for Agenda.",
		nextStepsScore: "Choose a score for Next steps.",
	});
	assert.equal(shown.reason, "Enter a reason.");
	assert.equal(shown.notes, "Shorten the notes, or leave them empty.");
	assert.equal(shown.dialog.length, 1);
	assert.match(shown.dialog[0], /evaluation date must fall between the meeting date and today/);
});

test("BUG-01aca6707: no issues maps to nothing, and an unknown path still says something", () => {
	assert.deepEqual(evaluationIssues([]), { scores: {}, dialog: [] });
	assert.deepEqual(evaluationIssues([{ path: "input.extra", problem: "Unrecognized key" }]).dialog, [
		"Some details are not valid. Check them and try again.",
	]);
});

// WP-017: a reviewed update from the ministry shows at once: the people it adds join, the guests it removes leave.
test("INV-roster-projection: the update adds its people and removes guests by Person, keeping everyone else", () => {
	const g = (id, personId, name) => ({ id, revision: "1", person: { personId, displayName: name, state: "live" } });
	const view = {
		guests: [g("a", "p1", "Ann"), g("b", "p2", "Ben"), g("c", "p3", "Cy")],
		cards: [],
		own: null,
		agenda: [],
		attendance: null,
	};
	const added = { id: "pending-p4", revision: null, person: { personId: "p4", displayName: "Dee", state: "live" } };
	const next = applyChange(view, { kind: "roster", add: [added], removePersonIds: ["p2"] });
	assert.deepEqual(
		next.guests.map((x) => x.person.displayName),
		["Ann", "Cy", "Dee"],
	);
	assert.deepEqual(
		applyChange({ ...view, guests: null }, { kind: "roster", add: [added], removePersonIds: [] }).guests,
		null,
	);
});
