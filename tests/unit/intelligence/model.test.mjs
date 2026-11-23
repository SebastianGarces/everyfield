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

test("INV-privacy: Evry is off only where a plant Owner or Admin has their private check-in open", () => {
	const owner = { context: "plant", role: "owner" };
	const admin = { context: "plant", role: "admin" };
	assert.equal(evryOff("/me/check-in", owner), true);
	assert.equal(evryOff("/me/check-in/anything", admin), true);
	assert.equal(evryOff("/me/check-inbox", owner), false);
	assert.equal(evryOff("/intelligence", owner), false);
	assert.equal(evryOff("/people", owner), false);
	assert.equal(evryOff("/me/check-in", { context: "organization", role: "owner" }), false);
	assert.equal(evryOff("/me/check-in", { context: "plant", role: "member" }), false);
	assert.equal(evryOff("/me/check-in", { context: "account" }), false);
	assert.equal(evryOff("/me/check-in", null), false);
});

test("INV-checkin: the strip shows a save at once, then the confirmed week; a refusal is explained", () => {
	const open = week(2, "2026-10-12", null, [], true),
		past = week(1, "2026-10-05", STEADY, [rev(1, "save", STEADY)]);
	const before = page([open, past]);
	const optimistic = withAnswer(before, open, STRAINED, "  ", "2026-10-13T15:00:00.000Z");
	assert.deepEqual(optimistic.weeks[0].answer.answers, STRAINED);
	assert.equal(optimistic.weeks[0].answer.answeredAt, "2026-10-13T15:00:00.000Z");
	assert.equal(optimistic.weeks[0].answer.note, null);
	assert.deepEqual(optimistic.weeks[1], past);
	assert.equal(before.weeks[0].answer, null);
	const confirmed = { ...open, id: "00000000-0000-4000-8000-000000000002", answer: optimistic.weeks[0].answer };
	const after = withResult(optimistic, { outcome: "saved", revision: "4", week: confirmed });
	assert.deepEqual(after, { ...optimistic, revision: "4", weeks: [confirmed, past] });
	assert.match(refusalText({ code: "revision_conflict" }), /another window/);
	assert.match(refusalText(null), /could not be reached/);
});

test("INV-checkin: the form needs all four answers and keeps a saved week's answers", () => {
	assert.deepEqual(missingAreas({ answers: { spiritual: "steady" }, note: "" }), ["family", "financial", "pace"]);
	assert.equal(complete({ answers: STEADY, note: "" }), true);
	assert.deepEqual(draftOf(week(1, "2026-10-05", STRAINED)), { answers: STRAINED, note: "" });
	assert.deepEqual(draftOf(week(1, "2026-10-05", null)), { answers: {}, note: "" });
});

test("INV-checkin: a corrected week says when and what changed; this week and skipped weeks say so", () => {
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

test("BUG-58bc5acb8: the button saves an unsaved week, changes a saved one and corrects an earlier one", () => {
	const open = week(2, "2026-10-12", null, [], true);
	assert.equal(submitLabel(open, false), "Save check-in");
	const optimistic = withAnswer(page([open]), open, STEADY, "", "2026-10-13T15:00:00.000Z").weeks[0];
	assert.equal(submitLabel(optimistic, false), "Save check-in");
	const saved = week(2, "2026-10-12", STEADY, [rev(1, "save", STEADY)], true);
	assert.equal(submitLabel(saved, false), "Save changes");
	const past = week(1, "2026-10-05", STEADY, [rev(1, "save", STEADY)]);
	assert.equal(submitLabel(past, true), "Save correction");
	assert.equal(submitLabel(week(1, "2026-10-05", null), true), "Save correction");
});

test("BUG-58bc5acb8: weekStartIn is the Monday of the week that holds the instant in the chosen zone", () => {
	assert.equal(weekStartIn("2026-11-09T05:30:00.000Z", "America/Chicago"), "2026-11-02");
	assert.equal(weekStartIn("2026-11-09T05:30:00.000Z", "UTC"), "2026-11-09");
	assert.equal(weekStartIn("2026-11-09T05:30:00.000Z", "Asia/Tokyo"), "2026-11-09");
	assert.equal(weekStartIn("2026-11-09T06:00:00.000Z", "America/Chicago"), "2026-11-09");
	assert.equal(weekStartIn("2026-11-09T05:59:59.999Z", "America/Chicago"), "2026-11-02");
	assert.equal(weekStartIn("2027-01-01T12:00:00.000Z", "Europe/London"), "2026-12-28");
});
