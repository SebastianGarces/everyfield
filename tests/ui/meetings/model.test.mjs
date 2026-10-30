// S2 batch 2 F06: a refused evaluation or correction names its fields; the modal shows each issue where it belongs.
import assert from "node:assert/strict";
import { test } from "node:test";
import { evaluationIssues } from "../../../apps/web/src/features/meetings/model.ts";

test("F06-issues: each issue maps to its factor, notes, reason or the dialog", () => {
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

test("F06-issues: no issues maps to nothing, and an unknown path still says something", () => {
	assert.deepEqual(evaluationIssues([]), { scores: {}, dialog: [] });
	assert.deepEqual(evaluationIssues([{ path: "input.extra", problem: "Unrecognized key" }]).dialog, [
		"Some details are not valid. Check them and try again.",
	]);
});
