// Check-in screen rules (WP-039) that a silent break would turn into a wrong strip or a lost answer. They run in node
// against the module the screen uses; no browser.
//   criterion 10: Evry is off on /me/check-in and nowhere else.
//   criterion 12: a save shows at once in the strip and the confirmed week replaces it; a refusal says why.
//   criterion 5: the strip names what a correction changed.
//   T-64: the primary button says whether it saves, changes or corrects a week.
import assert from "node:assert/strict";
import { test } from "node:test";
import { evryOff } from "../../../apps/web/src/features/intelligence/path.ts";
import {
	complete,
	draftOf,
	missingAreas,
	refusalText,
	submitLabel,
	weekNote,
	weekStartIn,
	withAnswer,
	withResult,
} from "../../../apps/web/src/features/intelligence/model.ts";

const STEADY = { spiritual: "steady", family: "steady", financial: "steady", pace: "steady" };
const STRAINED = { ...STEADY, pace: "strained" };
const week = (ordinal, startsOn, answers, revisions = [], current = false) => ({
	id: answers ? `00000000-0000-4000-8000-00000000000${ordinal}` : null,
	ordinal,
	zone: "America/Chicago",
	startsOn,
	endsOn: startsOn,
	current,
	answer: answers
		? { answers, note: null, revision: revisions.length || 1, answeredAt: "2026-10-06T02:12:00.000Z" }
		: null,
	revisions,
});
const rev = (revision, kind, answers, recordedAt = "2026-09-24T15:00:00.000Z") => ({
	revision,
	kind,
	answers,
	note: null,
	recordedAt,
});
const page = (weeks) => ({ zone: "America/Chicago", revision: "3", page: 1, pageCount: 1, weeks });

test("criterion 10: Evry is off on the private check-in page only", () => {
	assert.equal(evryOff("/me/check-in"), true);
	assert.equal(evryOff("/me/check-in/anything"), true);
	assert.equal(evryOff("/me/check-inbox"), false);
	assert.equal(evryOff("/intelligence"), false);
	assert.equal(evryOff("/people"), false);
});

test("criterion 12: the strip shows a save at once, then the confirmed week; a refusal is explained", () => {
	const open = week(2, "2026-10-12", null, [], true),
		past = week(1, "2026-10-05", STEADY, [rev(1, "save", STEADY)]);
	const before = page([open, past]);
	const optimistic = withAnswer(before, open, STRAINED, "  ");
	assert.deepEqual(optimistic.weeks[0].answer.answers, STRAINED);
	assert.equal(optimistic.weeks[0].answer.note, null);
	assert.deepEqual(optimistic.weeks[1], past);
	// The original page is unchanged, so a refusal can put it back.
	assert.equal(before.weeks[0].answer, null);
	const confirmed = { ...open, id: "00000000-0000-4000-8000-000000000002", answer: optimistic.weeks[0].answer };
	const after = withResult(optimistic, { outcome: "saved", revision: "4", week: confirmed });
	assert.equal(after.revision, "4");
	assert.equal(after.weeks[0].id, confirmed.id);
	assert.match(refusalText({ code: "revision_conflict" }), /another window/);
	assert.match(refusalText(null), /could not be reached/);
});

test("criterion 2: the form needs all four answers and keeps a saved week's answers", () => {
	assert.deepEqual(missingAreas({ answers: { spiritual: "steady" }, note: "" }), ["family", "financial", "pace"]);
	assert.equal(complete({ answers: STEADY, note: "" }), true);
	assert.deepEqual(draftOf(week(1, "2026-10-05", STRAINED)), { answers: STRAINED, note: "" });
	assert.deepEqual(draftOf(week(1, "2026-10-05", null)), { answers: {}, note: "" });
});

test("criterion 5: a corrected week says when and what changed; this week and skipped weeks say so", () => {
	const corrected = week(1, "2026-09-21", STEADY, [rev(1, "save", STRAINED), rev(2, "correction", STEADY)]);
	assert.deepEqual(weekNote(corrected, "America/Chicago"), {
		text: "Corrected Sep 24 · Pace was Strained",
		tone: "amber",
	});
	assert.deepEqual(weekNote(week(2, "2026-09-28", null), "America/Chicago"), { text: "Skipped", tone: "plain" });
	assert.deepEqual(weekNote(week(3, "2026-10-05", null, [], true), "America/Chicago"), {
		text: "this week",
		tone: "plain",
	});
	assert.equal(weekNote(week(1, "2026-09-21", STEADY, [rev(1, "save", STEADY)]), "America/Chicago"), null);
});

test("T-64: the button saves an unsaved week, changes a saved one and corrects an earlier one", () => {
	const open = week(2, "2026-10-12", null, [], true);
	assert.equal(submitLabel(open, false), "Save check-in");
	// While the first save is in flight the strip shows the answer, but the server has no row yet.
	const optimistic = withAnswer(page([open]), open, STEADY, "").weeks[0];
	assert.equal(submitLabel(optimistic, false), "Save check-in");
	const saved = week(2, "2026-10-12", STEADY, [rev(1, "save", STEADY)], true);
	assert.equal(submitLabel(saved, false), "Save changes");
	const past = week(1, "2026-10-05", STEADY, [rev(1, "save", STEADY)]);
	assert.equal(submitLabel(past, true), "Save correction");
	assert.equal(submitLabel(week(1, "2026-10-05", null), true), "Save correction");
});

// T-66: the zone step previews the week the check-in opens on: the Monday of the week that holds now in the chosen zone.
test("T-66: weekStartIn is the Monday of the week that holds the instant in the chosen zone", () => {
	// Sunday 23:30 in Chicago is already Monday in UTC and in Tokyo.
	assert.equal(weekStartIn("2026-11-09T05:30:00.000Z", "America/Chicago"), "2026-11-02");
	assert.equal(weekStartIn("2026-11-09T05:30:00.000Z", "UTC"), "2026-11-09");
	assert.equal(weekStartIn("2026-11-09T05:30:00.000Z", "Asia/Tokyo"), "2026-11-09");
	// A Monday at local midnight is its own week; the instant before it is the week before.
	assert.equal(weekStartIn("2026-11-09T06:00:00.000Z", "America/Chicago"), "2026-11-09");
	assert.equal(weekStartIn("2026-11-09T05:59:59.999Z", "America/Chicago"), "2026-11-02");
	// Across a month and year end.
	assert.equal(weekStartIn("2027-01-01T12:00:00.000Z", "Europe/London"), "2026-12-28");
});
