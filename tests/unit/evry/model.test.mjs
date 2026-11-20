import assert from "node:assert/strict";
import { test } from "node:test";
import {
	answerText,
	EMPTY,
	endNotice,
	merge,
	opened,
	pageReferences,
	retryable,
	turnsOf,
} from "../../../apps/web/src/features/evry/conversation/model.ts";

const T = "11111111-1111-4111-8111-111111111111";
const at = "2026-10-21T00:00:00Z";
const ask = (sequence, text = "Find Alex", turnId = T) => ({
	sequence,
	turnId,
	kind: "user_message",
	body: { text, references: [] },
	createdAt: at,
});
const say = (sequence, text, extra = {}) => ({
	sequence,
	turnId: T,
	kind: "assistant_text",
	body: { text, ...extra },
	createdAt: at,
});
const card = (sequence) => ({
	sequence,
	turnId: T,
	kind: "tool_result",
	body: {
		operation: "people.listPeople",
		result: {
			operation: "people.listPeople",
			status: "available",
			rows: [{ kind: "person", id: "p1", label: "Alex Doe", fields: {} }],
			total: 1,
			page: 1,
			next: null,
			completeness: "complete",
			exclusions: [],
		},
	},
	createdAt: at,
});
const end = (sequence, body) => ({ sequence, turnId: T, kind: "status", body, createdAt: at });
const conversation = { id: "c", title: "t", context: "plant", lastSequence: 0, activeTurnId: null, updatedAt: at };

test("AC:EVRY-RETRY-CANCEL INV-merge: overlapping reads show each event once, and the final status ends the run", () => {
	let s = opened({ conversation, run: { turnId: T, state: "running" }, events: [ask(1), say(2, "Look")], more: false });
	assert.equal(s.activeTurnId, T);
	s = merge(s, [say(2, "Look"), card(3), say(4, "ing.")]);
	s = merge(s, [card(3), end(5, { state: "completed", reason: "completed" })]);
	assert.deepEqual(
		s.events.map((e) => e.sequence),
		[1, 2, 3, 4, 5],
	);
	assert.equal(s.activeTurnId, null);
	assert.equal(
		opened({ conversation, run: { turnId: T, state: "lost" }, events: [ask(1)], more: false }).activeTurnId,
		T,
	);
	assert.equal(
		opened({ conversation, run: null, events: [ask(1), end(2, { state: "completed" })], more: false }).activeTurnId,
		null,
	);
});

test("INV-optimistic: a sent message falls away when its saved event arrives, before or after the confirmation", () => {
	const send = { key: "k", text: "Find Alex", references: [], state: "sending", error: null, sequence: null };
	const pending = { ...EMPTY, conversation, sends: [send] };
	assert.equal(merge(pending, [ask(1)]).sends.length, 1);
	const confirmed = { ...pending, sends: [{ ...send, sequence: 1 }] };
	const after = merge(confirmed, [ask(1)]);
	assert.equal(after.sends.length, 0);
	assert.equal(after.activeTurnId, T);
});

test("AC:GAP-EVR-405 INV-turns: text and cards keep their saved order and a withheld text shows no words", () => {
	const [turn] = turnsOf([
		ask(1),
		say(2, "Here "),
		say(3, "they are."),
		card(4),
		say(5, "secret", { withheld: true }),
		say(6, "more", { withheld: true }),
	]);
	assert.deepEqual(
		turn.blocks.map((b) => [b.kind, b.kind === "text" ? b.text : b.result.rows.length]),
		[
			["text", "Here they are."],
			["result", 1],
			["text", ""],
		],
	);
	assert.equal(turn.blocks[2].withheld, true);
});

test("INV-retry: only the last turn that did not complete, with no run active and no final refusal", () => {
	const failed = (code, retry) =>
		end(2, { state: "failed", reason: "failed", error: { code, correlationId: "x", retry, outcome: "refused" } });
	const check = (events, active = null) => retryable({ ...EMPTY, events, activeTurnId: active }, turnsOf(events));
	assert.equal(check([ask(1), failed("model_unavailable", "new_turn")]), true);
	assert.equal(check([ask(1), failed("access_denied", "never")]), false);
	assert.equal(check([ask(1), end(2, { state: "stopped", reason: "cancelled" })]), true);
	assert.equal(check([ask(1), end(2, { state: "completed", reason: "completed" })]), false);
	assert.equal(check([ask(1)], T), false);
	assert.equal(check([ask(1), failed("model_unavailable", "new_turn")], T), false);
	assert.equal(endNotice({ state: "failed", reason: "failed", error: { code: "model_unavailable" } }).tone, "neutral");
});

test("AC:UI45-006 INV-page: only a person page offers a reference", () => {
	const id = "0E0B6B0C-1A2B-4C3D-8E4F-5A6B7C8D9E0F";
	assert.deepEqual(pageReferences(`/people/${id}`), [{ kind: "person", id: id.toLowerCase() }]);
	assert.deepEqual(pageReferences("/people"), []);
	assert.deepEqual(pageReferences(`/people/${id}/edit`), []);
	assert.deepEqual(pageReferences(null), []);
});

test("INV-turns: live text of a turn with a withheld text is never shown", () => {
	const [turn] = turnsOf([ask(1), say(2, "x", { withheld: true })], { [T]: "secret words so far" });
	assert.deepEqual(
		turn.blocks.map((b) => [b.kind, b.text]),
		[["text", ""]],
	);
});

test("INV-announce: the spoken answer has no markdown symbols", () => {
	const [turn] = turnsOf([
		ask(1),
		say(2, "There are **19 prospects**, *3 new*. Run `pnpm test` or see [people](/people).\n\n- **Alex**\n- Sam\n"),
		say(3, "5 * 3 = 15", { withheld: true }),
		end(4, { state: "completed", reason: "completed" }),
	]);
	assert.equal(answerText(turn), "There are 19 prospects, 3 new. Run pnpm test or see people.\n\nAlex\nSam");
});
