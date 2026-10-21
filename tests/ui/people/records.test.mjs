// 4 C's, interview and commitment rules (WP-014/ui) that the Person page applies while a save runs or after it. A silent
// break would show a wrong latest record, a demoted stage, a wrong first commitment date or a duplicate save. They run
// in node against the real module the cards use; no browser.
import assert from "node:assert/strict";
import { test } from "node:test";
import {
	advancedStage,
	formClose,
	formDismiss,
	formOpen,
	formRefused,
	formSend,
	formSettled,
	formStart,
	formUnknown,
	sendTwice,
	withCard,
	withRecord,
} from "../../../apps/web/src/features/people/assessments/model.ts";

const rec = (id, occurredOn, recordedAt) => ({ id, occurredOn, recordedAt });

test("AC:TARGET-PPL-012 a late historical record joins history in date order and never becomes the latest", () => {
	const items = [rec("b", "2026-10-10", "2026-10-10T10:00:00Z"), rec("a", "2026-09-01", "2026-09-01T10:00:00Z")];
	const late = rec("c", "2026-09-20", "2026-10-21T09:00:00Z");
	assert.deepEqual(
		withRecord(items, late).map((r) => r.id),
		["b", "c", "a"],
	);
	// Same date: the later recorded instant is the latest. A record already shown keeps one place.
	const same = rec("d", "2026-10-10", "2026-10-11T08:00:00Z");
	assert.deepEqual(
		withRecord(withRecord(items, same), same).map((r) => r.id),
		["d", "b", "a"],
	);
});

test("AC:TARGET-PPL-013 AC:TARGET-PPL-014 a record moves an earlier stage up and never moves a later stage back", () => {
	assert.equal(advancedStage("prospect", "interviewed"), "interviewed");
	assert.equal(advancedStage("interviewed", "interviewed"), "interviewed");
	assert.equal(advancedStage("leader", "interviewed"), "leader");
	assert.equal(advancedStage("following_up", "core_group"), "core_group");
	assert.equal(advancedStage("launch_team", "core_group"), "launch_team");
});

test("AC:TARGET-PPL-026 a new card sets the first commitment only when it is earlier; unknown stays unknown", () => {
	const card = { id: "k2", occurredOn: "2026-09-01" };
	assert.deepEqual(withCard({ status: "none" }, card), { status: "known", occurredOn: "2026-09-01", evidenceId: "k2" });
	const known = { status: "known", occurredOn: "2026-08-15", evidenceId: "k1" };
	assert.equal(withCard(known, card), known);
	assert.deepEqual(withCard({ ...known, occurredOn: "2026-10-01" }, card).evidenceId, "k2");
	assert.deepEqual(withCard({ status: "unknown" }, card), { status: "unknown" });
});

test("INV-request-key: a lost answer is sent once more through the same call; a second loss goes back to the person", async () => {
	const calls = [];
	const replies = [{ status: "lost" }, { status: "ok", value: 1 }];
	const call = () => (calls.push("same-key"), Promise.resolve(replies.shift()));
	assert.deepEqual(await sendTwice(call), { status: "ok", value: 1 });
	assert.equal(calls.length, 2);
	let n = 0;
	const failing = () => (n++, Promise.reject(new Error("network")));
	assert.deepEqual(await sendTwice(failing), { status: "lost" });
	assert.equal(n, 2);
	let refused = 0;
	assert.deepEqual(await sendTwice(() => (refused++, Promise.resolve({ status: "refused", code: "conflict" }))), {
		status: "refused",
		code: "conflict",
	});
	assert.equal(refused, 1);
});

test("INV-form-intent (C58, review F2): a refusal reopens its form only while it is the latest form", () => {
	const sent = formSend(formOpen(formStart(), { draft: "A" }));
	const reopened = formRefused(sent.state, sent.token, { draft: "A", problem: "conflict" }, { id: "kA", what: "A" });
	assert.equal(reopened.editing.draft, "A");
	assert.equal(reopened.notice, null);
	// A newer form opened (and then closed): the refusal never replaces it and never opens by itself; the card says why.
	const newer = formOpen(sent.state, { draft: "B" });
	const late = formRefused(newer, sent.token, { draft: "A", problem: "conflict" }, { id: "kA", what: "A" });
	assert.equal(late.editing.draft, "B");
	assert.deepEqual(late.notice, { tone: "refused", id: "kA", what: "A", problem: "conflict" });
	const closed = formRefused(
		formClose(newer),
		sent.token,
		{ draft: "A", problem: "conflict" },
		{ id: "kA", what: "A" },
	);
	assert.equal(closed.editing, null);
	assert.equal(formDismiss(closed).notice, null);
});

test("INV-request-key (C58): an unknown result offers Check again; its answer clears only its own notice", () => {
	const s = formUnknown(formStart(), "kA", "A", () => {});
	assert.equal(s.notice.tone, "unknown");
	assert.equal(formSettled(s, "kB").notice, s.notice, "another save never clears it");
	assert.equal(formSettled(s, "kA").notice, null);
});

test("INV-request-key (C58, review F4): Check again sends the same key; a new intent with the same answers gets its own", async () => {
	const { PersonStore, runSave } = await import("../../../apps/web/src/features/people/model.ts");
	const store = new PersonStore({ id: "p1", revision: "1" });
	const fresh = () => "slot-key";
	const same = { personId: "p1", occurredOn: "2026-10-01", committed: { score: 3, notes: "same" } };
	const sent = [];
	const call = (outcome) => (key) => (sent.push(key), Promise.resolve(outcome));
	const a = { key: "intent-A", body: "" };
	// A is lost; Check again sends A's request with A's key.
	await runSave(store, "assessment", same, call({ status: "lost" }), { fresh, key: a });
	await runSave(store, "assessment", same, call({ status: "ok", value: null }), { fresh, key: a });
	// B is a newly opened form with the same answers and its own key: it is saved, never a replay of A.
	await runSave(store, "assessment", same, call({ status: "ok", value: null }), {
		fresh,
		key: { key: "intent-B", body: "" },
	});
	assert.deepEqual(sent, ["intent-A", "intent-A", "intent-B"]);
	// A caller without its own key keeps the slot rule: a retry of the same payload after a loss replays the lost key.
	await runSave(store, "other", same, call({ status: "lost" }), { fresh: () => "k1" });
	await runSave(store, "other", same, call({ status: "ok", value: null }), { fresh: () => "k2" });
	assert.deepEqual(sent.slice(3), ["k1", "k1"]);
});

test("INV-no-false-refusal (review F4d/F4e, C65): a save waits for the other save, never answers busy", async () => {
	const { PersonStore } = await import("../../../apps/web/src/features/people/model.ts");
	const { runWhenIdle, stillUnknown } = await import("../../../apps/web/src/features/people/assessments/model.ts");
	const store = new PersonStore({ id: "p1", revision: "1" });
	const order = [];
	let release;
	const first = runWhenIdle(
		store,
		"a",
		{ a: 1 },
		() => new Promise((r) => (release = () => (order.push("A done"), r({ status: "ok", value: null })))),
		{
			fresh: () => "kA",
		},
	);
	// B starts while A runs: it waits, sends after A settles, and is never refused as busy.
	const second = runWhenIdle(
		store,
		"b",
		{ b: 1 },
		(key) => (order.push(`B sent ${key}`), Promise.resolve({ status: "ok", value: null })),
		{
			fresh: () => "kB",
		},
	);
	await new Promise((r) => setTimeout(r, 10));
	assert.deepEqual(order, [], "B has not been sent while A runs");
	release();
	assert.deepEqual(await first, { status: "ok", value: null });
	assert.deepEqual(await second, { status: "ok", value: null });
	assert.deepEqual(order, ["A done", "B sent kB"]);
	assert.equal(stillUnknown({ status: "lost" }), true);
	assert.equal(stillUnknown({ status: "refused", code: "conflict" }), false, "only a server answer says not saved");
});
