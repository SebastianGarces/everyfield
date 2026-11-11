// Journey screen rules (WP-038) that a silent break would turn into a wrong card or a lost message. They run in node
// against the module the screen uses; no browser.
//   AC:PHASE-CASE-002 a refused move rolls back to the journey before it, and a conflict names the new phase.
//   AC:PHASE-CASE-003 the same phase shows no pending move.
//   AC:PHASE-CASE-009 each reason problem has its own message next to the field.
import assert from "node:assert/strict";
import { test } from "node:test";
import {
	entryTitle,
	isPending,
	pendingDeclaration,
	pendingMove,
	refusalMessage,
	requestKeys,
	sent,
	withEntry,
} from "../../../apps/web/src/features/phases/model.ts";

const actor = { accountId: "6f1c1f43-6c3d-4a7b-9f5e-2b0f4f0c9a11", displayName: "Daniel Reyes" };
const created = {
	kind: "creation",
	id: "0b6f4c0e-6a0a-4c1c-9a59-6a8f8f3f2b10",
	fromPhase: null,
	toPhase: 1,
	actor,
	occurredAt: "2026-11-02T10:00:00.000Z",
};
const journey = { state: { phase: 2, revision: "7", declarable: false }, entries: [created] };
const error = (code, details = {}) => ({ code, details, correlationId: actor.accountId, retry: "never" });

test("a move shows at once with its direction, and the server's entry replaces it", () => {
	const pending = pendingMove(journey, 4, "  Training wrapped early  ", actor, "2026-11-02T11:00:00.000Z");
	assert.deepEqual(pending.state, { phase: 4, revision: "7", declarable: false });
	const shown = pending.entries.at(-1);
	assert.equal(isPending(shown), true);
	assert.deepEqual(
		[shown.fromPhase, shown.toPhase, shown.direction, shown.reason],
		[2, 4, "skip_forward", "Training wrapped early"],
	);
	assert.equal(entryTitle(shown), "Skipped ahead");
	const confirmed = { ...shown, id: "4d1f5a7e-1d1e-4d0e-8e3b-0f6c1c2b3a44" };
	const after = withEntry(journey, { phase: 4, revision: "8", declarable: false }, confirmed);
	assert.deepEqual(after.entries, [created, confirmed]);
	assert.equal(after.entries.some(isPending), false);
	assert.equal(entryTitle(pendingMove(journey, 1, "Back", actor, shown.occurredAt).entries.at(-1)), "Moved back");
	assert.equal(entryTitle(pendingMove(journey, 3, "On", actor, shown.occurredAt).entries.at(-1)), "Moved forward");
});

test("the same phase adds no pending move", () => {
	assert.equal(pendingMove(journey, 2, "Still here", actor, created.occurredAt), journey);
});

test("a declaration shows as Declared at setup and closes the offer", () => {
	const fresh = { ...journey, state: { phase: 1, revision: "2", declarable: true } };
	const pending = pendingDeclaration(fresh, 3, actor, created.occurredAt);
	assert.deepEqual(pending.state, { phase: 3, revision: "2", declarable: false });
	assert.equal(entryTitle(pending.entries.at(-1)), "Declared at setup");
	assert.equal(entryTitle(created), "Church created");
});

test("each refusal has a clear message", () => {
	const refused = (e) => refusalMessage({ status: "refused", error: e });
	assert.equal(refused(error("invalid_reason", { problem: "empty" })), "Write a short reason for the move.");
	assert.equal(
		refused(error("invalid_reason", { problem: "too_long" })),
		"Keep the reason to 2,000 characters or fewer.",
	);
	assert.match(refused(error("invalid_reason", { problem: "reserved" })), /kept for setup declarations/);
	assert.match(
		refused(error("revision_conflict", { state: { phase: 3, revision: "9", declarable: false } })),
		/It is now Phase 3\./,
	);
	assert.match(refused(error("already_declared")), /already has its starting phase/);
	assert.match(refusalMessage({ status: "lost" }), /did not come back/);
});

test("a rejected write reads as lost, and the lost message promises no double change (com-17)", async () => {
	const offline = () => Promise.reject(new TypeError("Failed to fetch"));
	assert.deepEqual(await sent(offline), { status: "lost" });
	const ok = { status: "ok", value: 1 };
	assert.deepEqual(await sent(async () => ok), ok);
	const text = refusalMessage({ status: "lost" });
	assert.doesNotMatch(text, /Nothing changed/);
	assert.match(text, /did not come back/);
	assert.match(text, /will not apply twice/);
});

test("a retry of the same intent replays its request key; a new intent or a settled one gets a fresh key (com-17)", () => {
	let n = 0;
	const keys = requestKeys(() => `key-${++n}`);
	const move = ["move", "7", 3, "Core group formed"];
	const first = keys.keyFor(move);
	assert.equal(keys.keyFor([...move]), first, "a retry after a lost answer replays the first key");
	assert.notEqual(keys.keyFor(["move", "7", 4, "Core group formed"]), first, "another target is a new intent");
	assert.notEqual(keys.keyFor(["move", "7", 3, "Another reason"]), first, "another reason is a new intent");
	assert.notEqual(keys.keyFor(["move", "8", 3, "Core group formed"]), first, "another revision is a new intent");
	assert.notEqual(keys.keyFor(["declare", "7", 3]), first);
	keys.settle(move);
	assert.notEqual(keys.keyFor(move), first, "an ok or refused answer drops the key");
});
