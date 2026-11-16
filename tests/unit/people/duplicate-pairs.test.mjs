import assert from "node:assert/strict";
import { test } from "node:test";
import {
	pairAnswered,
	pairKey,
	pairNotice,
	pairSent,
	pairsAtStart,
	pairsShown,
} from "../../../apps/web/src/features/people/corrections/model.ts";

const pair = (id) => ({
	person: { id: `p${id}`, displayName: `P ${id}` },
	with: { id: `w${id}`, displayName: `W ${id}` },
});
const items = [pair(1), pair(2), pair(3)];
const shown = (s) => pairsShown(items, s).map((p) => p.person.id);
const key = pairKey(items[1]);

test("a saved dismiss keeps the row gone", () => {
	const sent = pairSent(pairsAtStart, key);
	assert.deepEqual(shown(sent), ["p1", "p3"], "the row leaves as soon as the action is sent");
	const saved = pairAnswered(sent, key, "dismiss", { status: "ok", value: { outcome: "changed" } });
	assert.deepEqual(shown(saved), ["p1", "p3"]);
	assert.deepEqual(saved.notices, {});
	assert.deepEqual(shown(pairAnswered(sent, key, "dismiss", { status: "ok", value: { outcome: "noop" } })), [
		"p1",
		"p3",
	]);
});

test("a refused dismiss puts the row back in its place and says nothing changed", () => {
	const s = pairAnswered(pairSent(pairsAtStart, key), key, "dismiss", { status: "refused", code: "pair_unavailable" });
	assert.deepEqual(shown(s), ["p1", "p2", "p3"]);
	assert.equal(
		s.notices[key],
		"Nothing changed. One of them was merged or retired, so this pair is no longer listed. Reload to see the list as it is now.",
	);
	assert.equal(
		pairNotice("restore", { status: "refused", code: "unavailable" }),
		"Nothing changed. The pair was not restored. Try again.",
	);
	assert.deepEqual(pairSent(s, key).notices, {});
});

test("a lost answer puts the row back and says it may have saved", () => {
	const s = pairAnswered(pairSent(pairsAtStart, key), key, "restore", { status: "lost" });
	assert.deepEqual(shown(s), ["p1", "p2", "p3"]);
	assert.equal(s.notices[key], "We could not confirm the restore. It may have saved. Reload to check, or try again.");
	assert.equal(
		pairNotice("dismiss", { status: "lost" }),
		"We could not confirm this. It may have saved. Reload to check, or try again.",
	);
});

test("two rows in flight settle on their own", () => {
	const both = pairSent(pairSent(pairsAtStart, pairKey(items[0])), key);
	assert.deepEqual(shown(both), ["p3"]);
	const one = pairAnswered(both, pairKey(items[0]), "dismiss", { status: "lost" });
	assert.deepEqual(shown(one), ["p1", "p3"]);
	assert.deepEqual(Object.keys(one.notices), [pairKey(items[0])]);
});
