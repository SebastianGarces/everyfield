// T-159 (com-23): correcting a follow-up outcome without touching its time sends the stored instant byte for byte. The
// form shows the time to the minute in the browser's zone, so a round trip through that field would drop the seconds.
import assert from "node:assert/strict";
import { test } from "node:test";
import { draftOf, outcomeInput, recentAfter } from "../../../apps/web/src/features/followups/model.ts";

// A browser far from the church's zone, with a half-hour offset (UTC+5:30).
process.env.TZ = "Asia/Kolkata";
const now = new Date("2026-10-21T15:00:00.000Z");
const item = {
	id: "o1",
	outcome: "contacted",
	occurredAt: "2026-10-12T14:07:45.318Z",
	recordedAt: "2026-10-12T14:08:00.000Z",
	channel: "phone",
	notes: "Talked after church",
	completedTask: false,
	state: "effective",
};

test("BUG-58bc5acb8: an untouched time keeps the stored instant, seconds and all", () => {
	const draft = draftOf(item);
	assert.equal(draft.at, "2026-10-12T19:37", "the field shows the browser's local minute");
	const r = outcomeInput(draft, { completable: false, now });
	assert.equal(r.ok, true);
	assert.equal(r.input.occurredAt, "2026-10-12T14:07:45.318Z");
});

test("BUG-58bc5acb8: a changed time is read from the field in the browser's zone", () => {
	const r = outcomeInput({ ...draftOf(item), at: "2026-10-12T19:40" }, { completable: false, now });
	assert.equal(r.input.occurredAt, "2026-10-12T14:10:00.000Z");
	// Changing it back to what it showed keeps the stored instant again.
	const back = outcomeInput({ ...draftOf(item), at: "2026-10-12T19:37" }, { completable: false, now });
	assert.equal(back.input.occurredAt, "2026-10-12T14:07:45.318Z");
});

test("BUG-58bc5acb8: the call screen's Recent list keeps the contact log's order for out-of-order input", () => {
	const e = (id, occurredAt, recordedAt) => ({ ...item, id, occurredAt, recordedAt });
	// Shown out of order, and the new entry happened before the latest one.
	const shown = [
		e("old", "2026-09-01T10:00:00Z", "2026-09-01T10:00:00Z"),
		e("latest", "2026-10-15T10:00:00Z", "2026-10-15T10:00:00Z"),
	];
	const record = e("late", "2026-10-10T10:00:00Z", "2026-10-21T09:00:00Z");
	assert.deepEqual(
		recentAfter(shown, { record, previous: null }).map((x) => x.id),
		["latest", "late", "old"],
	);
	const more = [...shown, e("older", "2026-08-01T10:00:00Z", "2026-08-01T10:00:00Z")];
	assert.deepEqual(
		recentAfter(more, { record, previous: null }).map((x) => x.id),
		["latest", "late", "old"],
		"at most three, latest first",
	);
});
