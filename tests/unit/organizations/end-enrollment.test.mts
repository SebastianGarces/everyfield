import "../runs-in/render.mjs";
import assert from "node:assert/strict";
import { test } from "node:test";
import { endProblem } from "../../../apps/web/src/features/organizations/programs/model.ts";
import { removedLines } from "../../../apps/web/src/features/organizations/data/model.ts";

const refused = (code: "conflict" | "enrollment_ended" | "unavailable") => ({
	status: "refused" as const,
	refusal: { code },
});
const now = (status: "active" | "completed" | "withdrawn", director = true) => ({
	status,
	viewer: { administrator: false, director },
});

test("a failed end says what happened: stale, already ended, no longer director or a lost reply", () => {
	assert.match(endProblem(refused("conflict"), now("active")), /changed since you opened it.*Check it below/);
	assert.match(endProblem(refused("conflict"), null), /Reload the page/);
	assert.equal(
		endProblem(refused("enrollment_ended"), now("withdrawn")),
		"This enrollment has already ended, so nothing was saved.",
	);
	assert.match(endProblem(refused("enrollment_ended"), null), /already ended.*Reload the page/);
	assert.match(endProblem(refused("unavailable"), now("active", false)), /no longer direct this program/);
	assert.match(endProblem(refused("unavailable"), null), /don’t have access/);
	assert.match(endProblem({ status: "lost" }, now("active")), /still active. Try again/);
	assert.match(endProblem({ status: "lost" }, now("completed")), /has ended as Completed/);
	assert.match(endProblem({ status: "lost" }, null), /can’t tell if this was saved/);
});

test("a removal counts withdrawn enrollments apart from those in progress", () => {
	const removed = {
		stageMoves: 0,
		notes: 0,
		conversations: 0,
		enrollments: 1,
		withdrawnEnrollments: 2,
		milestoneMarks: 0,
		feedback: 0,
		residencyLinkEnded: false,
		invitationsRevoked: 0,
		mergedRecords: 0,
	};
	const lines = removedLines({ removed } as Parameters<typeof removedLines>[0]);
	assert.deepEqual(lines.slice(2), ["1 enrollment in progress", "2 withdrawn enrollments"]);
});
