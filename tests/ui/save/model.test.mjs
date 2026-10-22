// The shared save lane every card uses (components/save, C58, C65, C68, C69). A silent break would save a change
// twice after a lost answer, say "not saved" for a change the server kept, or let two saves on one card race. These
// tests drive the real lane in node with a fake server: each `send` records the request key it was given.
import assert from "node:assert/strict";
import { test } from "node:test";
import { SaveLane } from "../../../apps/web/src/components/save/model.ts";

/** A lane with numbered keys and the lines it reports, plus a fake server answering from `replies` in order. */
function setup({ busy = () => false } = {}) {
	let n = 0;
	const reports = [];
	const lane = new SaveLane({
		explain: (code) => `reason:${code}`,
		busy,
		fresh: () => `k${++n}`,
		report: (line) => reports.push(line),
	});
	const sent = [];
	const server = (replies) => (key) => {
		sent.push(key);
		const r = replies.shift();
		return r === "throw" ? Promise.reject(new Error("network")) : Promise.resolve(r);
	};
	return { lane, sent, reports, server };
}
const lost = { status: "lost" };
const ok = (value) => ({ status: "ok", value });

test("INV-request-key (C58) BUG-31d611e R1-1: a lost answer is replayed once with the same key, and a saved replay is shown as saved", async () => {
	const { lane, sent, server } = setup();
	const saved = [];
	await lane.save({ what: "Piano", send: server(["throw", ok("row-1")]), ok: (v) => saved.push(v) });
	assert.deepEqual(sent, ["k1", "k1"]);
	assert.deepEqual(saved, ["row-1"]);
	assert.equal(lane.get().notice, null);
	assert.equal(lane.get().editing, null, "a lost answer never reopens the form with a retry button");
});

test("INV-request-key (C58, C97): Check again sends the same key; a new intent with the same values gets its own key", async () => {
	const { lane, sent, server } = setup();
	const replies = [lost, lost, ok("row-1")];
	const saved = [];
	const spec = { what: "Piano", done: "added", send: server(replies), ok: (v, checked) => saved.push([v, checked]) };
	await lane.save(spec);
	const notice = lane.get().notice;
	assert.equal(notice.tone, "unknown");
	assert.equal(notice.done, "added");
	notice.check();
	assert.equal(lane.get().notice.checking, true);
	await new Promise((r) => setTimeout(r, 0));
	assert.deepEqual(saved, [["row-1", true]]);
	assert.equal(lane.get().notice, null);
	await lane.save({ ...spec, send: server([ok("row-2")]) });
	assert.deepEqual(sent, ["k1", "k1", "k1", "k2"]);
	// An upload that replays on its own (C97) is sent once per attempt by the lane.
	const upload = setup();
	await upload.lane.save({ what: "Card", replay: false, send: upload.server([lost]), ok: () => {} });
	assert.deepEqual(upload.sent, ["k1"]);
});

test("INV-no-false-refusal (C58, C65) BUG-31d611e R1-2: only a server answer says not saved; a blocked Check again stays unknown", async () => {
	const { lane, server } = setup();
	await lane.save({ what: "Leaders", done: "added", send: server([lost, lost]), ok: () => {} });
	assert.equal(lane.get().notice.tone, "unknown");
	// Check again while another save to the person runs: the shared lane refuses to start it, so nothing was sent.
	const shared = setup();
	let first = true;
	await shared.lane.save({
		what: "Photo",
		send: shared.server([lost, lost]),
		through: (_key, send) => (first ? ((first = false), send()) : Promise.resolve(null)),
		ok: () => {},
	});
	shared.lane.get().notice.check();
	await new Promise((r) => setTimeout(r, 0));
	assert.equal(shared.lane.get().notice.tone, "unknown", "nothing was sent, so the first request may be saved");
	// A server refusal is the only way to "not saved"; the reason is in words and the notice can be dismissed.
	const refused = setup();
	const codes = [];
	await refused.lane.save({
		what: "Piano",
		done: "removed",
		send: refused.server([{ status: "refused", code: "conflict" }]),
		refused: (c) => codes.push(c),
		ok: () => {},
	});
	assert.deepEqual(refused.lane.get().notice, {
		tone: "refused",
		id: "k1",
		what: "Piano",
		done: "removed",
		reason: "reason:conflict",
	});
	assert.deepEqual(codes, ["conflict"], "a conflict reaches the card, which reads the latest values");
	refused.lane.dismiss();
	assert.equal(refused.lane.get().notice, null);
});

test("INV-form-intent (C58): a refusal reopens its form with the values only while it is the latest form", async () => {
	const { lane, server } = setup();
	lane.open({ draft: "A" });
	await lane.save({
		what: "A",
		form: { draft: "A" },
		send: server([{ status: "refused", code: "invalid_input" }]),
		code: () => "future_date",
		ok: () => {},
	});
	assert.deepEqual(lane.get().editing, { draft: "A", problem: "future_date" });
	assert.equal(lane.get().notice, null);
	// A newer form opened while A was saving: A's refusal never replaces it; the card says why A was not saved.
	let answer;
	const slow = () => new Promise((r) => (answer = r));
	const pending = lane.save({ what: "A", form: { draft: "A" }, send: slow, ok: () => {} });
	lane.open({ draft: "B" });
	answer({ status: "refused", code: "conflict" });
	await pending;
	assert.equal(lane.get().editing.draft, "B");
	assert.equal(lane.get().notice.tone, "refused");
});

test("INV-one-save-per-card (C68, C69): nothing starts while a save is in flight or unknown, and nothing is queued", async () => {
	let busy = false;
	const { lane, sent, reports, server } = setup({ busy: () => busy });
	let answer;
	const first = lane.save({
		what: "A",
		send: (key) => (sent.push(key), new Promise((r) => (answer = r))),
		ok: () => {},
	});
	assert.equal(lane.wait(), "saving");
	await lane.save({ what: "B", send: server([ok(1)]), ok: () => {} });
	assert.deepEqual(sent, ["k1"], "B sent nothing");
	assert.equal(reports.length, 1, "a save that starts while the card waits is reported");
	answer(lost);
	await new Promise((r) => setTimeout(r, 0));
	answer(lost);
	await first;
	assert.equal(lane.wait(), "unknown");
	await lane.save({ what: "C", send: server([ok(1)]), ok: () => {} });
	assert.deepEqual(sent, ["k1", "k1"], "C sent nothing while A is unknown");
	// Another card's save to the same person (the person store) also holds this card.
	const shared = setup({ busy: () => busy });
	busy = true;
	assert.equal(shared.lane.wait(), "saving");
	busy = false;
	assert.equal(shared.lane.wait(), null);
});
