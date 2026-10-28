// Ministry Edit and template setup (WP-017/ui, T21): a reason is not a change.
//   INV-reason-alone: a save with only a reason sends no request and says nothing was saved; no history row is written.
import assert from "node:assert/strict";
import { test } from "node:test";
import { NEW_SETUP, planTeamEdit, reopened } from "../../../apps/web/src/features/teams/model.ts";

const was = { name: "Hospitality", description: "Greeters", icon: "heart", state: "active" };
const now = (extra = {}) => ({ ...was, reason: "", ...extra });

test("INV-reason-alone: only a reason sends nothing and says so", () => {
	assert.equal(planTeamEdit(was, now({ reason: "Fixing a typo" })), "close-and-say");
	assert.equal(planTeamEdit(was, now({ reason: "   " })), "close");
});

test("INV-reason-alone: an untouched Edit closes quietly", () => {
	assert.equal(planTeamEdit(was, now()), "close");
	assert.equal(planTeamEdit(was, now({ name: "  Hospitality " })), "close");
});

test("INV-reason-alone: a real change is sent, with or without a reason", () => {
	assert.equal(planTeamEdit(was, now({ name: "Welcome" })), "send");
	assert.equal(planTeamEdit(was, now({ state: "paused", reason: "Summer" })), "send");
	assert.equal(planTeamEdit(was, now({ description: "" })), "send");
});

// Template setup dialog (WP-017/ui): both screens open it with the one shared NEW_SETUP object.
test("INV-setup-reopen: closing and reopening with the shared NEW_SETUP starts a fresh form", () => {
	// Open: the dialog starts from NEW_SETUP, the person advances to review.
	let wasOpen = false;
	let f = reopened(wasOpen, NEW_SETUP);
	assert.equal(f, NEW_SETUP);
	wasOpen = true;
	f = { chosen: { volunteers: ["greeter"] }, step: "review" };
	// Still open and re-rendered: the person's progress is kept.
	assert.equal(reopened(wasOpen, NEW_SETUP), null);
	// Close: nothing is reset yet.
	assert.equal(reopened(wasOpen, null), null);
	wasOpen = false;
	// Reopen with the same shared object: the form is fresh, not the review step.
	const fresh = reopened(wasOpen, NEW_SETUP);
	assert.deepEqual(fresh, { chosen: null, step: "choose" });
	assert.notEqual(fresh, f);
});
