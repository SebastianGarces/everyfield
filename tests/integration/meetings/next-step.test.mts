// The meeting page's next step (WP-020/ui): the primary action, the header's secondary buttons, the tab the page opens
// for every row of the spec's next-step table. They run in node against the real module
// the page uses; no browser.
import assert from "node:assert/strict";
import { test } from "node:test";
import { defaultTab, nextStep, pickTab } from "../../../apps/web/src/features/meetings/next-step.ts";

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

test("AC:TARGET-MTG-001 the default tab follows the meeting state: Results once completed, Guests before", () => {
	const cases = [
		[{ guestCount: 0 }, "guests"],
		[{}, "guests"],
		[{ status: "in_progress" }, "guests"],
		[{ status: "completed" }, "results"],
		[{ status: "completed", final: true, checkIn: false, attendedWithoutCard: 1 }, "results"],
		[{ status: "completed", final: true, checkIn: false }, "results"],
		[{ status: "completed", final: true, checkIn: false, evaluationSaved: true }, "results"],
		[{ status: "cancelled", checkIn: false }, "guests"],
	];
	for (const [input, tab] of cases) {
		const i = { ...base, ...input };
		assert.equal(defaultTab(i.status, i.final), tab, JSON.stringify(input));
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
