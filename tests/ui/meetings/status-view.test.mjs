// T-46 (Nora QA 2026-11-04): a past team meeting still planning or ready read "Planning". It now reads "Not closed";
// every other meeting reads its stored status, and nothing changes the stored status (REQ-MTG-002).
import assert from "node:assert/strict";
import { test } from "node:test";
import { statusView } from "../../../apps/web/src/features/meetings/model.ts";

const now = "2026-11-04T18:00:00.000Z";
const past = "2026-10-28T23:30:00.000Z";
const upcoming = "2026-11-11T23:30:00.000Z";

test("T-46: a past planning or ready meeting reads Not closed in the attention tone", () => {
	assert.deepEqual(statusView("planning", past, now), { label: "Not closed", tone: "attention" });
	assert.deepEqual(statusView("ready", past, now), { label: "Not closed", tone: "attention" });
});

test("T-46: past in-progress, completed and cancelled meetings keep their stored status", () => {
	assert.deepEqual(statusView("in_progress", past, now), { label: "In progress", tone: "attention" });
	assert.deepEqual(statusView("completed", past, now), { label: "Completed", tone: "unknown" });
	assert.deepEqual(statusView("cancelled", past, now), { label: "Cancelled", tone: "risk" });
});

test("T-46: a meeting that has not started, or starts exactly now, keeps its stored status", () => {
	assert.deepEqual(statusView("planning", upcoming, now), { label: "Planning", tone: "measured" });
	assert.deepEqual(statusView("ready", upcoming, now), { label: "Ready", tone: "positive" });
	assert.deepEqual(statusView("planning", now, now), { label: "Planning", tone: "measured" });
});
