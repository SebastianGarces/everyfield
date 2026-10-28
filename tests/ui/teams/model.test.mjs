// Ministry Edit (WP-017/ui, T21): a reason is not a change.
//   INV-reason-alone: a save with only a reason sends no request and says nothing was saved; no history row is written.
import assert from "node:assert/strict";
import { test } from "node:test";
import { planTeamEdit } from "../../../apps/web/src/features/teams/model.ts";

const was = { name: "Hospitality", description: "Greeters", icon: "heart", state: "active" };
const now = (extra = {}) => ({ ...was, reason: "", ...extra });

test("INV-reason-alone: only a reason sends nothing and says so", () => {
	assert.equal(planTeamEdit(was, now({ reason: "Fixing a typo" })), "close-and-say");
	assert.equal(planTeamEdit(was, now({ reason: "   " })), "close");
});

test("an untouched Edit closes quietly", () => {
	assert.equal(planTeamEdit(was, now()), "close");
	assert.equal(planTeamEdit(was, now({ name: "  Hospitality " })), "close");
});

test("a real change is sent, with or without a reason", () => {
	assert.equal(planTeamEdit(was, now({ name: "Welcome" })), "send");
	assert.equal(planTeamEdit(was, now({ state: "paused", reason: "Summer" })), "send");
	assert.equal(planTeamEdit(was, now({ description: "" })), "send");
});
