// T-159 (com-23): the meetings Next card and the meeting page's Status menu. The Next card counts civil days in the
// meeting's zone, and a completed practice offers no plain status move.
import assert from "node:assert/strict";
import { test } from "node:test";
import { NEXT_REQUEST, statusMoves, untilText } from "../../../apps/web/src/features/meetings/model.ts";

const chicago = (localDate) => ({ localDate, zone: "America/Chicago" });

test("T-159: a meeting 13 h ahead on the same local day reads today", () => {
	// 08:00 in Chicago (CDT, UTC-5); the meeting is at 21:00 that evening.
	assert.equal(untilText(chicago("2026-10-06"), "2026-10-06T13:00:00.000Z"), "today");
});

test("T-159: a meeting 13 h ahead on the next local day reads tomorrow", () => {
	// 18:00 in Chicago; the meeting is at 07:00 the next morning.
	assert.equal(untilText(chicago("2026-10-07"), "2026-10-06T23:00:00.000Z"), "tomorrow");
});

test("T-159: the day boundary is the meeting's zone, not UTC", () => {
	// 03:30 UTC on Oct 7 is still 22:30 on Oct 6 in Chicago, so an Oct 6 meeting is today and an Oct 7 one tomorrow.
	const now = "2026-10-07T03:30:00.000Z";
	assert.equal(untilText(chicago("2026-10-06"), now), "today");
	assert.equal(untilText(chicago("2026-10-07"), now), "tomorrow");
	// The same instant is already Oct 7 in Auckland, so an Oct 7 meeting there is today.
	assert.equal(untilText({ localDate: "2026-10-07", zone: "Pacific/Auckland" }, now), "today");
	assert.equal(untilText(chicago("2026-10-11"), now), "in 5 days");
	assert.equal(untilText(chicago("2026-10-27"), now), "in 3 weeks");
});

test("T-159: the Next card asks only for meetings still on", () => {
	assert.equal(NEXT_REQUEST.window, "upcoming");
	assert.equal(NEXT_REQUEST.limit, 1);
	assert.deepEqual([...NEXT_REQUEST.statuses].sort(), ["in_progress", "planning", "ready"]);
});

test("T-159: a completed practice offers no Start the meeting; a scheduled practice still does", () => {
	assert.deepEqual(statusMoves("prelaunch_practice", "completed"), []);
	assert.equal(statusMoves("prelaunch_practice", "planning").includes("in_progress"), true);
	assert.equal(statusMoves("prelaunch_practice", "ready").includes("in_progress"), true);
	// A practice is completed by Mark as held, never by a plain move.
	assert.equal(statusMoves("prelaunch_practice", "in_progress").includes("completed"), false);
	// Other meetings keep every move the contract allows.
	assert.deepEqual(statusMoves("vision_meeting", "completed"), ["in_progress"]);
	assert.equal(statusMoves("team_meeting", "in_progress").includes("completed"), true);
});
