import assert from "node:assert/strict";
import { test } from "node:test";
import { draftOf, emptyDraft, outcomeInput, pickOutcome } from "../../../apps/web/src/features/followups/model.ts";

process.env.TZ = "America/Chicago";
const now = new Date("2026-10-21T15:00:00.000Z");
const earlier = { ...pickOutcome(emptyDraft(), "contacted"), when: "earlier" };
const at = (value) => outcomeInput({ ...earlier, at: value }, { completable: true, now });
const range = { ok: false, errors: { at: "Pick a date between Oct 21, 2025 and today" } };

test("a contact dated year 1, as a typed or arrowed year field gives it, is refused with the range", () => {
	assert.deepEqual(at("0001-10-21T10:00"), range);
});

test("an emptied year field is refused with the range, not saved", () => {
	assert.deepEqual(at(""), range);
});

test("one year ago through today is accepted, and the day before or after is refused", () => {
	assert.equal(at("2025-10-21T00:00").input?.occurredAt, "2025-10-21T05:00:00.000Z");
	assert.equal(at("2026-10-21T09:59").input?.occurredAt, "2026-10-21T14:59:00.000Z");
	assert.deepEqual(at("2025-10-20T23:59"), range);
	assert.deepEqual(at("2026-10-22T09:00"), range);
});

test("a later time today stays a future time, not a range problem", () => {
	assert.deepEqual(at("2026-10-21T11:00"), {
		ok: false,
		errors: { at: "This time is in the future. Choose a time that has passed." },
	});
});

test("editing an older contact without touching its time keeps the stored time", () => {
	const old = draftOf({
		id: "o1",
		outcome: "contacted",
		occurredAt: "2024-03-01T15:00:00.000Z",
		recordedAt: "2024-03-01T15:00:00.000Z",
		channel: null,
		notes: null,
		completedTask: false,
		state: "effective",
	});
	const r = outcomeInput({ ...old, notes: "Fixed the note" }, { completable: false, now });
	assert.equal(r.input?.occurredAt, "2024-03-01T15:00:00.000Z");
});
