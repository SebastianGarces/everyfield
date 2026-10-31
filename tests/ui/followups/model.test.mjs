// Follow-up screen rules (WP-023/ui) that decide what a save sends and what the screen says while it runs. A silent
// break would send a guessed contact time or count the wrong owner totals. They run in node against the real modules
// the screens use; no browser. The save lane itself is tested once, in tests/ui/save/model.test.mjs.
import assert from "node:assert/strict";
import { test } from "node:test";
import {
	emptyDraft,
	keepSelection,
	outcomeInput,
	originText,
	ownersOf,
	pickOutcome,
	preferredOwners,
	totalsAfter,
	coverageOf,
	windowAt,
	withOutcome,
} from "../../../apps/web/src/features/followups/model.ts";
import { ownerText } from "../../../apps/web/src/features/tasks/model.ts";

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

test("AC:TARGET-TSK-012 AC:TARGET-TSK-013 owner totals follow confirmed assignments, new follow-ups and handoffs", () => {
	const ruth = { accountId: "r", displayName: "Ruth Allen" };
	const daniel = { accountId: "d", displayName: "Daniel Reyes" };
	const start = { owners: [{ ...ruth, open: 2 }], formerOwners: [], needsOwner: 1, uncovered: 5 };
	const view = (who, eligible = true, reason = null) => ({ ...who, eligible, reason });
	// Needs owner -> Daniel: Daniel appears with one, Needs owner drops to zero.
	assert.deepEqual(totalsAfter(start, [{ before: [], after: [view(daniel)] }]), {
		owners: [
			{ ...daniel, open: 1 },
			{ ...ruth, open: 2 },
		],
		formerOwners: [],
		needsOwner: 0,
		uncovered: 5,
	});
	// A first follow-up for a contact with none, left as Needs owner.
	assert.deepEqual(totalsAfter(start, [{ before: "new", after: [], firstForContact: true }]), {
		...start,
		needsOwner: 2,
		uncovered: 4,
	});
	// Ruth hands both to Daniel: Ruth leaves the tally.
	assert.deepEqual(
		totalsAfter(start, [
			{ before: [view(ruth)], after: [view(daniel)] },
			{ before: [view(ruth)], after: [view(daniel)] },
		]).owners,
		[{ ...daniel, open: 2 }],
	);
	// A follow-up with two owners counts once under each; the totals still count it once (D-a).
	assert.deepEqual(totalsAfter(start, [{ before: "new", after: [view(ruth), view(daniel)] }]).owners, [
		{ ...daniel, open: 1 },
		{ ...ruth, open: 3 },
	]);
	// With one eligible and one ineligible owner it is owned, and the ineligible one stays on the handoff tally.
	const mixed = totalsAfter(start, [{ before: "new", after: [view(daniel), view(ruth, false, "no_seat")] }]);
	assert.deepEqual(
		[mixed.needsOwner, mixed.formerOwners, mixed.owners.map((o) => o.open)],
		[1, [{ ...ruth, open: 1 }], [1, 2]],
	);
	// A departed account's two follow-ups move to Daniel: they leave Needs owner and the former owner's count.
	const sam = { accountId: "s", displayName: "Sam Lee" };
	const left = { owners: [], formerOwners: [{ ...sam, open: 2 }], needsOwner: 2, uncovered: 0 };
	assert.deepEqual(
		totalsAfter(left, [
			{ before: [view(sam, false, "no_seat")], after: [view(daniel)] },
			{ before: [view(sam, false, "no_seat")], after: [view(daniel)] },
		]),
		{ owners: [{ ...daniel, open: 2 }], formerOwners: [], needsOwner: 0, uncovered: 0 },
	);
	assert.equal(coverageOf([]), "uncovered");
	const ready = { ...ruth, eligible: true, reason: null };
	const stuck = { ...sam, eligible: false, reason: "no_person" };
	assert.equal(coverageOf([{ owners: [ready] }, { owners: [] }]), "needs_owner");
	// A follow-up whose only assignee cannot own follow-ups still counts as Needs owner (D-a, REQ-TSK-012).
	assert.equal(coverageOf([{ owners: [ready] }, { owners: [stuck] }]), "needs_owner");
	// One eligible owner is enough, whoever else is on it.
	assert.equal(coverageOf([{ owners: [ready, stuck] }]), "owned");
	assert.equal(coverageOf([{ owners: [ready] }]), "owned");
});

test("AC:TARGET-TSK-012 AC:TARGET-MTG-022 one wording for an owner, an origin and a meeting's preferred follow-up owner", () => {
	const ruth = { accountId: "r", displayName: "Ruth Allen", eligible: true, reason: null };
	const tomas = { accountId: "t", displayName: "Tomas Weaver", eligible: false, reason: "no_person" };
	assert.equal(ownerText(ruth), "Ruth Allen");
	assert.equal(ownerText(tomas), "Tomas Weaver · Can't own follow-ups: no linked Person");
	assert.equal(ownerText({ ...tomas, reason: "no_seat" }), "Tomas Weaver · Can't own follow-ups: no current seat");
	assert.equal(
		ownerText({ ...tomas, reason: "not_committed" }),
		"Tomas Weaver · Can't own follow-ups: Person not in a core group, launch team or leader stage",
	);
	assert.equal(ownerText(null), "Needs owner");
	assert.equal(
		originText({ kind: "meeting", meeting: { id: "m", label: "Vision Meeting #4" } }),
		"After Vision Meeting #4",
	);
	assert.equal(originText({ kind: "added", by: "Ruth Allen" }), "Added by Ruth Allen");
	// Correct attendance offers the set of eligible owners most of the meeting's open follow-ups have (D-e); a tie goes
	// to the newest (the list is newest first); no eligible owner reads Needs owner.
	const open = (...owners) => ({ kind: "first_vision_follow_up", state: "open", owners });
	const dan = { accountId: "d", displayName: "Daniel Reyes", eligible: true, reason: null };
	assert.deepEqual(preferredOwners([open(ruth), open(dan), open(dan)]), ["d"]);
	assert.deepEqual(preferredOwners([open(ruth), open(dan)]), ["r"]);
	assert.deepEqual(preferredOwners([open(ruth, dan), open(ruth, dan), open(dan)]), ["d", "r"]);
	assert.deepEqual(preferredOwners([open(ruth, tomas)]), ["r"], "an ineligible co-owner is left out");
	assert.deepEqual(preferredOwners([open(tomas), open()]), []);
	assert.deepEqual(preferredOwners([]), []);
	assert.deepEqual(preferredOwners([{ ...open(ruth), state: "complete" }]), []);
	assert.deepEqual(preferredOwners([{ ...open(ruth), kind: "meeting_evaluation" }]), []);
});
