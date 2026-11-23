import assert from "node:assert/strict";
import { test } from "node:test";
import { overviewSubtitle } from "../../../apps/web/src/features/overview/model.ts";

const frame = { plantName: "Grace Church", phase: 2, role: "admin" };

test("with overview-role-subtitle off, the Overview subtitle names the church and phase as before", () => {
	assert.equal(overviewSubtitle(frame, false), "Grace Church · Phase 2 · Launch team");
});

test("with overview-role-subtitle on, the Overview subtitle also names the viewer's role", () => {
	assert.equal(overviewSubtitle(frame, true), "Grace Church · Phase 2 · Launch team · Admin");
	assert.equal(overviewSubtitle({ ...frame, role: "member" }, true), "Grace Church · Phase 2 · Launch team · Member");
});
