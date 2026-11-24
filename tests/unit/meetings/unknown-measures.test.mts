import "../runs-in/domain.mjs";
import assert from "node:assert/strict";
import test from "node:test";
import {
	evaluationComparison,
	growth,
	meetingAnalytics,
	summaryStats,
} from "../../../packages/contracts/src/meetings/attendance.ts";

test("INV-counts: an unknown meeting measure holds no number, and a measured 0 is known", () => {
	const measures = {
		attended: meetingAnalytics.shape.attended,
		averageAttendance: summaryStats.shape.averageAttendance,
		averageEvaluation: summaryStats.shape.averageEvaluation,
		current: evaluationComparison.shape.current,
		baseline: evaluationComparison.shape.baseline,
		delta: evaluationComparison.shape.delta,
	};
	for (const [name, measure] of Object.entries(measures)) {
		assert.deepEqual(measure.parse({ status: "unknown" }), { status: "unknown" }, name);
		for (const bad of [0, null, { status: "unknown", value: 0 }, { status: "known" }, { status: "known", value: null }])
			assert.equal(measure.safeParse(bad).success, false, `${name} ${JSON.stringify(bad)}`);
		const zero = { status: "known", value: 0, ...(name === "baseline" ? { count: 1 } : {}) };
		assert.deepEqual(measure.parse(zero), zero, name);
	}
});

test("INV-counts: growth has a percent only against a previous meeting somebody attended", () => {
	for (const bad of [
		{ status: "unavailable", difference: 2, percent: 0 },
		{ status: "unknown", difference: 0 },
		{ status: "unknown", percent: 0 },
		0,
	])
		assert.equal(growth.safeParse(bad).success, false, JSON.stringify(bad));
	assert.equal(growth.safeParse({ status: "unavailable", difference: 2 }).success, true);
	assert.equal(growth.safeParse({ status: "known", difference: 0, percent: 0 }).success, true);
});
