// Ministry Edit and template setup (WP-017/ui, T21): a reason is not a change.
//   INV-reason-alone: a save with only a reason sends no request and says nothing was saved; no history row is written.
import assert from "node:assert/strict";
import { test } from "node:test";
import { historyTitle, planTeamEdit, shownValue } from "../../../apps/web/src/features/teams/model.ts";

const was = { name: "Hospitality", description: "Greeters", icon: "heart", state: "active" };
const now = (extra = {}) => ({ ...was, reason: "", ...extra });

test("INV-reason-alone: a reason is not a change", () => {
	const cases = [
		[now({ reason: "Fixing a typo" }), "close-and-say"],
		[now({ reason: "   " }), "close"],
		[now(), "close"],
		[now({ name: "  Hospitality " }), "close"],
		[now({ name: "Welcome" }), "send"],
		[now({ state: "paused", reason: "Summer" }), "send"],
		[now({ description: "" }), "send"],
	];
	for (const [edit, plan] of cases) assert.equal(planTeamEdit(was, edit), plan);
});

// WP-017: the ministry history names a role date correction and a leader who left; old Corrected entries still read.
test("INV-history-titles: role date corrections, removed leaders and old corrections read in words", () => {
	const entry = (kind, extra = {}) => ({
		id: "x",
		kind,
		occurredAt: "",
		reason: null,
		before: null,
		after: null,
		...extra,
	});
	const about = { personName: "Alex", roleName: "Greeter" };
	assert.equal(historyTitle(entry("correct", { about })), "Role dates corrected");
	assert.equal(
		historyTitle(entry("correct", { about: null, before: { name: "A" }, after: { name: "B" } })),
		"Corrected",
	);
	assert.equal(historyTitle(entry("leader_change", { after: null })), "Leader removed");
	assert.equal(historyTitle(entry("leader_change", { after: { leaderPersonId: "p" } })), "Leader appointed");
	assert.equal(shownValue("startedOn", "2026-01-04"), "Jan 4, 2026");
	assert.equal(shownValue("endedOn", null), "None");
});
