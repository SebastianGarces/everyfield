// Ministry Edit and template setup (WP-017/ui, T21): a reason is not a change.
//   INV-reason-alone: a save with only a reason sends no request and says nothing was saved; no history row is written.
import assert from "node:assert/strict";
import { test } from "node:test";
import { planTeamEdit } from "../../../apps/web/src/features/teams/model.ts";

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
