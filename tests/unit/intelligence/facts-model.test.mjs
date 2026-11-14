// The measured-facts section's wording (WP-040): Unknown must say what is missing and never read as 29, zero or No.
import assert from "node:assert/strict";
import { test } from "node:test";
import {
	adultsDetail,
	adultsValue,
	adultsVerdict,
	contactLine,
	coverageValue,
	followUpsDetail,
	followUpsValue,
	GROWTH_LABEL,
	trainingValue,
	trainingVerdict,
	VISION_LABEL,
	visionDetail,
} from "../../../apps/web/src/features/intelligence/facts-model.ts";

const person = { id: "00000000-0000-4000-8000-000000000001", name: "Sam" };

test("AC:CA004 an unresolved count reads Unknown with at least 29 and who needs classifying, never 29 or Not met", () => {
	const a = { status: "unknown", known: 29, exact: null, needsClassifying: [person], evidence: [], children: 0 };
	assert.equal(adultsValue(a), "Unknown");
	assert.deepEqual(adultsVerdict(a), { status: "unknown", label: "Unknown" });
	assert.match(adultsDetail(a), /^At least 29 committed adults\. 1 person needs an adult or child classification/);
	const met = { ...a, status: "met", known: 30, exact: 30, needsClassifying: [] };
	assert.deepEqual([adultsValue(met), adultsVerdict(met).label], ["30", "Met"]);
});

test("AC:CA017 AC:PI-CASE-003 growth and Vision labels use the approved words", () => {
	assert.equal(GROWTH_LABEL.slowed.label, "Momentum has slowed");
	assert.equal(GROWTH_LABEL.stalled.label, "Growth has stalled");
	assert.equal(VISION_LABEL.watch.label, "Past the 21-day mark");
	const v = {
		status: "watch",
		reason: null,
		lastHeldOn: "2026-10-23",
		daysSince: 22,
		lastAttendance: [18, 21],
		nextScheduledOn: "2026-11-17",
	};
	assert.equal(
		visionDetail(v),
		"Since the last completed Vision meeting on Oct 23, 2026. 21 then 18 attended. Next scheduled Nov 17, 2026; it counts once it is held.",
	);
	assert.match(visionDetail({ ...v, status: "unknown", reason: "no_attendance" }), /No attendance is recorded yet/);
});

test("AC:PI-TASK-CONTACT-001 AC:B01-002 AC:B01-020 follow-ups, coverage and training read as counts", () => {
	const f = {
		status: "measured",
		onTime: 2,
		measured: 3,
		noLongerNeeded: 1,
		pending: 0,
		unmeasured: 0,
		contacted: 1,
		total: 4,
	};
	assert.equal(followUpsValue(f), "2 of 3 on time");
	assert.equal(
		followUpsDetail(f),
		"Completed within 48 hours of the meeting. 1 left out because it was no longer needed.",
	);
	assert.equal(contactLine(f), "Recorded contact: 1 follow-up. A ticked task is not contact.");
	assert.equal(coverageValue({ filled: 6, slots: 8, people: 4 }), "6 of 8 filled, 4 people");
	const t = { status: "not_met", complete: 9, total: 10, programs: [] };
	assert.deepEqual([trainingValue(t), trainingVerdict(t).label], ["9 of 10", "Not complete"]);
});
