// Journey screen rules (WP-038) that a silent break would turn into a wrong card or a lost message. They run in node
// against the module the screen uses; no browser.
//   INV-phase-optimistic: a move or declaration shows at once as one pending entry, and the server's entry replaces it.
//   AC:PHASE-CASE-002 a conflict names the phase the church is in now.
//   AC:PHASE-CASE-003 the same phase shows no pending move.
//   AC:PHASE-CASE-009 each reason problem has its own message next to the field.
import assert from "node:assert/strict";
import { test } from "node:test";
import {
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

test("INV-phase-optimistic: a move shows at once as one pending entry, and the server's entry replaces it", () => {
	const at = "2026-11-02T11:00:00.000Z";
	const pending = pendingMove(journey, 4, "  Training wrapped early  ", actor, at);
	assert.deepEqual(pending.state, { phase: 4, revision: "7", declarable: false });
	assert.equal(pending.entries.length, 2);
	assert.deepEqual(pending.entries[0], created);
	const shown = pending.entries[1];
	assert.equal(isPending(shown), true);
	const { id: _, ...entry } = shown;
	assert.deepEqual(entry, {
		kind: "movement",
		fromPhase: 2,
		toPhase: 4,
		direction: "skip_forward",
		reason: "Training wrapped early",
		actor,
		occurredAt: at,
	});
	const confirmed = { ...shown, id: "4d1f5a7e-1d1e-4d0e-8e3b-0f6c1c2b3a44" };
	// The screen applies the server's answer to the journey from before the move, so no pending entry remains.
	const after = withEntry(journey, { phase: 4, revision: "8", declarable: false }, confirmed);
	assert.deepEqual(after, { state: { phase: 4, revision: "8", declarable: false }, entries: [created, confirmed] });
});

test("AC:PHASE-CASE-003 the same phase adds no pending move", () => {
	assert.equal(pendingMove(journey, 2, "Still here", actor, created.occurredAt), journey);
});

test("INV-phase-optimistic: a pending declaration shows the declared phase and closes the offer", () => {
	const fresh = { ...journey, state: { phase: 1, revision: "2", declarable: true } };
	const pending = pendingDeclaration(fresh, 3, actor, created.occurredAt);
	assert.deepEqual(pending.state, { phase: 3, revision: "2", declarable: false });
	const shown = pending.entries.at(-1);
	assert.equal(isPending(shown), true);
	assert.deepEqual(
		[shown.kind, shown.fromPhase, shown.toPhase, shown.actor, shown.occurredAt],
		["initial_declaration", 1, 3, actor, created.occurredAt],
	);
});

test("AC:PHASE-CASE-009 AC:PHASE-CASE-002 each reason problem has its own message; a conflict names the new phase", () => {
	const refused = (e) => refusalMessage({ status: "refused", error: e });
	const fallback = refused(error("unknown_code"));
	const reasons = ["empty", "too_long", "reserved"].map((problem) => refused(error("invalid_reason", { problem })));
	const declared = refused(error("already_declared"));
	assert.equal(new Set([fallback, ...reasons, declared]).size, 5, "each refusal reads differently from the rest");
	const conflict = (phase) =>
		refused(error("revision_conflict", { state: { phase, revision: "9", declarable: false } }));
	assert.match(conflict(3), /Phase 3\b/);
	assert.match(conflict(5), /Phase 5\b/);
});

test("BUG-551 (journey/com-17): a rejected write reads as lost, and the lost message promises no double change", async () => {
	const offline = () => Promise.reject(new TypeError("Failed to fetch"));
	assert.deepEqual(await sent(offline), { status: "lost" });
	const ok = { status: "ok", value: 1 };
	assert.deepEqual(await sent(async () => ok), ok);
	const text = refusalMessage({ status: "lost" });
	assert.doesNotMatch(text, /Nothing changed/);
	assert.match(text, /did not come back/);
	assert.match(text, /will not apply twice/);
});

test("BUG-551 (journey/com-17): a retry of the same intent replays its request key; a new intent or a settled one gets a fresh key", () => {
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
