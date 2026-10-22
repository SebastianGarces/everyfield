// Follow-up screen rules (WP-023/ui) that decide what a save sends and what the screen says while it runs. A silent
// break would send a guessed contact time, save twice, call a lost answer "not saved" or let a second form submit while
// the first one's result is unknown. They run in node against the real modules the screens use; no browser.
import assert from "node:assert/strict";
import { test } from "node:test";
import {
	idle,
	laneAnswer,
	laneCheck,
	laneDismiss,
	laneStart,
	sendTwice,
	waitOf,
} from "../../../apps/web/src/features/followups/lane.ts";
import {
	emptyDraft,
	keepSelection,
	outcomeInput,
	ownersOf,
	pickOutcome,
	windowAt,
	withOutcome,
} from "../../../apps/web/src/features/followups/model.ts";

const now = new Date("2026-10-21T15:00:00.000Z");

test("AC:TARGET-MTG-022 contacted needs the person to say when; the time is never assumed", () => {
	const d = pickOutcome(emptyDraft(), "contacted");
	const missing = outcomeInput(d, { completable: true, now });
	assert.equal(missing.ok, false);
	assert.deepEqual(Object.keys(missing.errors), ["when"]);
	const justNow = outcomeInput({ ...d, when: "now" }, { completable: true, now });
	assert.deepEqual(justNow, {
		ok: true,
		input: { outcome: "contacted", occurredAt: now.toISOString(), channel: null, notes: null, completeTask: true },
	});
	// Another outcome left blank sends no time: the server records now.
	const tried = outcomeInput(pickOutcome(emptyDraft(), "attempted_no_contact"), { completable: true, now });
	assert.deepEqual(tried, {
		ok: true,
		input: { outcome: "attempted_no_contact", channel: null, notes: null, completeTask: false },
	});
});

test("AC:TARGET-MTG-022 a time in the future is refused before any request; a past time keeps its instant", () => {
	const base = { ...pickOutcome(emptyDraft(), "contacted"), when: "earlier" };
	const future = new Date(now.getTime() + 60_000);
	const p = (n) => String(n).padStart(2, "0");
	const local = (d) =>
		`${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`;
	assert.equal(outcomeInput({ ...base, at: local(future) }, { completable: true, now }).errors.at !== undefined, true);
	const past = new Date("2026-09-01T18:30:00");
	const r = outcomeInput({ ...base, at: local(past) }, { completable: true, now });
	assert.equal(r.ok, true);
	assert.equal(r.input.occurredAt, past.toISOString());
});

test("AC:TARGET-TSK-004 no longer needed never completes, and a standalone contact never completes a task", () => {
	const waived = outcomeInput(
		{ ...pickOutcome(emptyDraft(), "no_longer_needed"), complete: true, channel: "phone" },
		{
			completable: true,
			now,
		},
	);
	assert.deepEqual(waived.input, { outcome: "no_longer_needed", channel: null, notes: null, completeTask: false });
	const standalone = outcomeInput(
		{ ...pickOutcome(emptyDraft(), "administrative_completion") },
		{ completable: false, now },
	);
	assert.equal(standalone.input.completeTask, false);
});

test("INV-request-key: a lost answer is replayed once through the same call; a second loss is unknown, not refused", async () => {
	const calls = [];
	const replies = [{ status: "lost" }, { status: "ok", value: 1 }];
	const call = () => (calls.push("same-key"), Promise.resolve(replies.shift()));
	assert.deepEqual(await sendTwice(call), { status: "ok", value: 1 });
	assert.equal(calls.length, 2);
	// A server that asks for the same request again is not a refusal either.
	const temp = [{ status: "refused", code: "temporary" }, Promise.reject(new Error("network"))];
	const r = await sendTwice(() => Promise.resolve(temp.shift()));
	assert.deepEqual(r, { status: "lost" });
	assert.deepEqual(laneAnswer(idle, "The outcome", r), {
		saving: null,
		unknown: { what: "The outcome", checking: false },
		refused: null,
	});
});

test("C68: one save per card; nothing starts while a save runs or its result is unknown, and unknown cannot be dismissed", () => {
	const saving = laneStart(idle, "The outcome");
	assert.equal(waitOf(saving), "saving");
	assert.equal(laneStart(saving, "The owner"), null);
	const unknown = laneAnswer(saving, "The outcome", { status: "lost" });
	assert.equal(waitOf(unknown), "unknown");
	assert.equal(laneStart(unknown, "The owner"), null);
	assert.deepEqual(laneDismiss(unknown), unknown);
	const checking = laneCheck(unknown);
	assert.equal(checking.unknown.checking, true);
	assert.equal(laneCheck(checking), null);
	// Only a server answer settles it: a refusal says "not saved"; the next save may start.
	const refused = laneAnswer(checking, "The outcome", { status: "refused", code: "conflict" });
	assert.deepEqual(refused.refused, { what: "The outcome", code: "conflict" });
	assert.equal(waitOf(refused), null);
	assert.equal(laneDismiss(refused).refused, null);
});

const entry = (id, occurredAt, recordedAt, state = "effective") => ({ id, occurredAt, recordedAt, state });
test("AC:TARGET-COM-011 a correction shows the new entry in its time place and keeps the replaced one", () => {
	const items = [
		entry("b", "2026-10-12T10:00:00Z", "2026-10-12T10:00:00Z"),
		entry("a", "2026-09-01T10:00:00Z", "2026-09-01T10:00:00Z"),
	];
	const record = entry("c", "2026-09-20T10:00:00Z", "2026-10-21T09:00:00Z");
	const previous = { ...items[0], state: "corrected" };
	const next = withOutcome(items, { record, previous });
	assert.deepEqual(
		next.map((i) => [i.id, i.state]),
		[
			["b", "corrected"],
			["c", "effective"],
			["a", "effective"],
		],
	);
});

test("AC:TARGET-MTG-021 the 48-hour countdown runs from the meeting start and closes at exactly 48 hours", () => {
	const origin = "2026-03-07T15:00:00.000Z";
	assert.deepEqual(windowAt(origin, Date.parse("2026-03-08T15:00:00.000Z")), { open: true, hoursLeft: 24 });
	assert.deepEqual(windowAt(origin, Date.parse("2026-03-09T15:00:00.000Z")), { open: true, hoursLeft: 0 });
	assert.deepEqual(windowAt(origin, Date.parse("2026-03-09T15:00:00.001Z")), { open: false });
});

test("AC:TARGET-TSK-012 AC:TARGET-TSK-013 owners include the viewer only when eligible; a re-read keeps only the person's own choice", () => {
	const plan = (eligible) => ({
		from: { accountId: "me", displayName: "Ana", eligible, protectedOwner: false },
		recipients: [{ accountId: "b", displayName: "Ben" }],
	});
	assert.deepEqual(
		ownersOf(plan(true)).map((o) => o.accountId),
		["me", "b"],
	);
	assert.deepEqual(
		ownersOf(plan(false)).map((o) => o.accountId),
		["b"],
	);
	const kept = keepSelection(new Set(["t1", "t2", "gone"]), [{ taskId: "t1" }, { taskId: "t2" }, { taskId: "new" }]);
	assert.deepEqual([...kept], ["t1", "t2"]);
});
