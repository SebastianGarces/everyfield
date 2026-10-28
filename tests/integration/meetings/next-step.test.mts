// The meeting page's next step (WP-020/ui): the primary action, the header's secondary buttons, the tab the page opens
// on and the lifecycle stepper, for every row of the spec's next-step table. They run in node against the real module
// the page uses; no browser.
import assert from "node:assert/strict";
import { test } from "node:test";
import { defaultTab, nextStep, pickTab, stepper } from "../../../apps/web/src/features/meetings/next-step.ts";

const base = {
	status: "planning",
	canWrite: true,
	checkIn: true,
	guestCount: 3,
	final: false,
	canSettle: true,
	attendedWithoutCard: 0,
	evaluationSaved: false,
	vision: true,
};
const ask = (over) => nextStep({ ...base, ...over });

// [name, input, primary, secondary, toolbarInvites]
const TABLE = [
	["cancelled", { status: "cancelled", checkIn: false }, null, [], false],
	["planning, no guests", { guestCount: 0 }, "add-guest", ["check-in"], false],
	["planning, with guests", {}, "send-invites", ["check-in"], false],
	["ready, with guests", { status: "ready" }, "send-invites", ["check-in"], false],
	["in progress", { status: "in_progress" }, "check-in", ["finalize"], true],
	["completed, not final", { status: "completed" }, "finalize", ["check-in"], false],
	[
		"final, vision, a card is missing",
		{ status: "completed", final: true, checkIn: false, attendedWithoutCard: 2 },
		"cards",
		[],
		false,
	],
	[
		"final, vision, cards in, no evaluation",
		{ status: "completed", final: true, checkIn: false },
		"evaluation",
		[],
		false,
	],
	["final, vision, done", { status: "completed", final: true, checkIn: false, evaluationSaved: true }, null, [], false],
	["final, orientation", { status: "completed", final: true, checkIn: false, vision: false }, null, [], false],
	// A viewer without write access sees only Start check-in, where main's rule shows it.
	["read-only, planning, marker", { canWrite: false }, null, ["check-in"], false],
	["read-only, planning, not a marker", { canWrite: false, checkIn: false }, null, [], false],
	["read-only, in progress, marker", { canWrite: false, status: "in_progress" }, "check-in", [], false],
	[
		"read-only, final, vision",
		{ canWrite: false, status: "completed", final: true, checkIn: false, attendedWithoutCard: 2 },
		null,
		[],
		false,
	],
	// Voided or not yet settable: no Finalize, and no Start check-in without the marker rule.
	["completed and voided", { status: "completed", canSettle: false, checkIn: false }, null, [], false],
];
for (const [name, input, primary, secondary, toolbarInvites] of TABLE) {
	test(`AC:TARGET-MTG-001 next step: ${name}`, () => {
		assert.deepEqual(ask(input), { primary, secondary, toolbarInvites });
	});
}

test("AC:TARGET-MTG-001 Start check-in is primary only in progress and at most one primary shows", () => {
	for (const status of ["planning", "ready", "in_progress", "completed"]) {
		const n = ask({ status });
		assert.equal(n.secondary.length <= 2, true);
		assert.equal(n.secondary.includes("check-in") || n.primary === "check-in", true, status);
	}
	assert.equal(ask({ status: "in_progress" }).primary, "check-in");
	assert.equal(ask({ status: "planning" }).primary, "send-invites");
});

test("AC:TARGET-MTG-001 the default tab follows the primary action's target", () => {
	const cases = [
		[{ guestCount: 0 }, "guests"],
		[{}, "guests"],
		[{ status: "in_progress" }, "guests"],
		[{ status: "completed" }, "results"],
		[{ status: "completed", final: true, checkIn: false, attendedWithoutCard: 1 }, "guests"],
		[{ status: "completed", final: true, checkIn: false }, "results"],
		[{ status: "completed", final: true, checkIn: false, evaluationSaved: true }, "results"],
		[{ status: "cancelled", checkIn: false }, "guests"],
	];
	for (const [input, tab] of cases) {
		const i = { ...base, ...input };
		assert.equal(defaultTab(nextStep(i).primary, i.status, i.final), tab, JSON.stringify(input));
	}
});

test("AC:TARGET-MTG-001 an unknown or unavailable ?tab= falls back to the default", () => {
	const vision = ["guests", "kit", "results"];
	assert.equal(pickTab("results", vision, "guests"), "results");
	assert.equal(pickTab("kit", vision, "guests"), "kit");
	assert.equal(pickTab("kit", ["guests", "results"], "results"), "results");
	assert.equal(pickTab("agenda", vision, "guests"), "guests");
	assert.equal(pickTab(null, vision, "results"), "results");
});

const people = { invited: 6, yes: 2, no: 1, pending: 3 };
const step = (over) =>
	stepper({
		status: "planning",
		final: false,
		vision: true,
		guests: people,
		attended: 0,
		cardsIn: 0,
		evaluationSaved: false,
		followUpDone: false,
		...over,
	}).map((s) => [s.id, s.state, s.line]);

test("AC:TARGET-MTG-001 stepper: every meeting state", () => {
	const invite = "6 invited · 2 yes · 1 no · 3 pending";
	assert.deepEqual(step({}), [
		["invite", "current", invite],
		["checkin", "later", "Not started"],
		["followup", "later", "Opens when attendance is final"],
	]);
	assert.deepEqual(step({ status: "ready" })[0][1], "current");
	assert.deepEqual(step({ status: "in_progress", attended: 4 }), [
		["invite", "done", invite],
		["checkin", "current", "4 attended"],
		["followup", "later", "Opens when attendance is final"],
	]);
	assert.deepEqual(step({ status: "completed", attended: 4 })[1], ["checkin", "current", "4 attended"]);
	assert.deepEqual(step({ status: "completed", final: true, attended: 4, cardsIn: 3 }), [
		["invite", "done", invite],
		["checkin", "done", "4 attended · final"],
		["followup", "current", "3 of 4 cards · evaluation open"],
	]);
	assert.deepEqual(
		step({ status: "completed", final: true, attended: 4, cardsIn: 4, evaluationSaved: true, followUpDone: true })[2],
		["followup", "done", "4 of 4 cards · evaluation recorded"],
	);
	assert.deepEqual(step({ status: "completed", final: true, attended: 4, vision: false, followUpDone: true })[2], [
		"followup",
		"done",
		"Attendance final",
	]);
	// Cancelled has no current step and nothing started.
	assert.deepEqual(
		step({ status: "cancelled" }).map((s) => s[1]),
		["later", "later", "later"],
	);
	assert.equal(step({ status: "cancelled" })[1][2], "Not started");
	// A guest list that did not load says so and does not claim zero.
	assert.equal(step({ guests: null })[0][2], "Did not load");
});
