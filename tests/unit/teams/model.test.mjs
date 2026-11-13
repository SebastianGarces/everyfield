// Ministry Edit and template setup (WP-017/ui, T21): a reason is not a change.
//   INV-reason-alone: a save with only a reason sends no request and says nothing was saved; no history row is written.
import assert from "node:assert/strict";
import { test } from "node:test";
import {
	diffLines,
	historyTitle,
	iconKey,
	planTeamEdit,
	shownValue,
} from "../../../apps/web/src/features/teams/model.ts";
import { apply } from "../../../apps/web/src/features/teams/page-state.ts";

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

// T-45 (Nora QA 2026-11-04): role changes read as role changes, and a field that did not change has no line.
test("INV-history-roles: role entries say what happened to the role", () => {
	const entry = (kind, subject, extra = {}) => ({
		id: "x",
		kind,
		subject,
		occurredAt: "",
		reason: null,
		actorName: null,
		about: null,
		before: null,
		after: null,
		...extra,
	});
	const role = { personName: null, roleName: "Greeter" };
	assert.equal(historyTitle(entry("create", "role", { about: role })), "Role added");
	assert.equal(historyTitle(entry("edit", "role", { about: role })), "Role edited");
	assert.equal(historyTitle(entry("retire", "role", { about: role })), "Role retired");
	assert.equal(historyTitle(entry("assign", "tenure", { about: { ...role, personName: "Alex" } })), "Role filled");
	assert.equal(historyTitle(entry("create", "ministry")), "Created");
	assert.equal(historyTitle(entry("edit", "ministry")), "Edited");
});

test("INV-history-same-value: a Created entry has no Description: None → None line", () => {
	const created = {
		id: "x",
		kind: "create",
		subject: "ministry",
		occurredAt: "",
		reason: null,
		actorName: null,
		about: null,
		before: null,
		after: { name: "Hospitality", description: null, icon: null, state: "forming", archived: false },
	};
	assert.deepEqual(diffLines(created), [
		{ label: "Name", from: "None", to: "Hospitality" },
		{ label: "State", from: "None", to: "Forming" },
		{ label: "Archived", from: "None", to: "No" },
	]);
	// No line reads the same before and after, whatever the field.
	const edited = {
		...created,
		kind: "edit",
		before: { name: "Hospitality", description: "", state: "active", startedOn: null },
		after: { name: "Welcome", description: "", state: "active", startedOn: null },
	};
	assert.deepEqual(diffLines(edited), [{ label: "Name", from: "Hospitality", to: "Welcome" }]);
});

test("BUG-PR551 (people/peo-43): a ministry's chosen icon reaches its chart node, and an edit of it shows there at once", () => {
	const node = { id: "t1", name: "Worship", icon: null, templateKey: "worship", archived: false, leaderName: null };
	const other = { ...node, id: "t2", name: "Prayer", templateKey: "prayer", parentId: null };
	assert.equal(iconKey(node), "music");
	const view = { team: { ...node, revision: "1" }, nodes: [{ ...node, parentId: null }, other] };
	const edited = apply(view, { kind: "team", patch: { icon: "tools" } });
	assert.equal(iconKey(edited.nodes[0]), "tools");
	assert.deepEqual(edited.nodes[1], other);
});
