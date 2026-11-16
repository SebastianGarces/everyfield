import assert from "node:assert/strict";
import { test } from "node:test";
import { statusMoves, untilText } from "../../../apps/web/src/features/meetings/model.ts";

const chicago = (localDate) => ({ localDate, zone: "America/Chicago" });

test("BUG-58bc5acb8: a meeting 13 h ahead on the same local day reads today", () => {
	assert.equal(untilText(chicago("2026-10-06"), "2026-10-06T13:00:00.000Z"), "today");
});

test("BUG-58bc5acb8: a meeting 13 h ahead on the next local day reads tomorrow", () => {
	assert.equal(untilText(chicago("2026-10-07"), "2026-10-06T23:00:00.000Z"), "tomorrow");
});

test("BUG-58bc5acb8: the day boundary is the meeting's zone, not UTC", () => {
	const now = "2026-10-07T03:30:00.000Z";
	assert.equal(untilText(chicago("2026-10-06"), now), "today");
	assert.equal(untilText(chicago("2026-10-07"), now), "tomorrow");
	assert.equal(untilText({ localDate: "2026-10-07", zone: "Pacific/Auckland" }, now), "today");
	assert.equal(untilText(chicago("2026-10-11"), now), "in 5 days");
	assert.equal(untilText(chicago("2026-10-27"), now), "in 3 weeks");
});

test("BUG-58bc5acb8: a completed practice offers no Start the meeting; a scheduled practice still does", () => {
	assert.deepEqual(statusMoves("prelaunch_practice", "completed"), []);
	assert.equal(statusMoves("prelaunch_practice", "planning").includes("in_progress"), true);
	assert.equal(statusMoves("prelaunch_practice", "ready").includes("in_progress"), true);
	assert.equal(statusMoves("prelaunch_practice", "in_progress").includes("completed"), false);
	assert.deepEqual(statusMoves("vision_meeting", "completed"), ["in_progress"]);
	assert.equal(statusMoves("team_meeting", "in_progress").includes("completed"), true);
});
