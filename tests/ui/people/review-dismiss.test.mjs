// T-268: "Not a duplicate" on the side-by-side review of a listed pair. It sends the listed direction, once more when the
// answer is lost; a saved answer (also one another tab already saved) returns to the list, a refusal keeps the reviewer
// on the review and reads it again, a second lost answer says it may have saved, and a double click sends one dismiss.
// Run in node against the real module the review uses; no browser.
import assert from "node:assert/strict";
import { test } from "node:test";
import {
	notDuplicateText,
	reviewDismiss,
	reviewDismissed,
} from "../../../apps/web/src/features/people/corrections/model.ts";

const listed = { personId: "imported", withPersonId: "existing" };
/** A send that answers each call from `answers` in turn and records what it was sent. */
function sender(...answers) {
	const sent = [];
	const send = async (input) => {
		sent.push(input);
		const a = answers.shift();
		if (a instanceof Error) throw a;
		return a;
	};
	return { sent, send };
}

test("T-268 a saved dismiss returns to the list, also when another tab already dismissed the pair", async () => {
	for (const outcome of ["changed", "noop"]) {
		const { sent, send } = sender({ status: "ok", value: { outcome } });
		assert.deepEqual(await reviewDismiss(send)(listed), { next: "list" });
		assert.deepEqual(sent, [listed], "the listed direction, imported person first, once");
	}
	assert.equal(
		notDuplicateText("Iris Imported", "Iris Existing"),
		"Iris Imported and Iris Existing marked not a duplicate.",
	);
});

test("T-268 a lost answer is sent once more as it is; a second lost answer keeps the review and says it may have saved", async () => {
	const once = sender({ status: "lost" }, { status: "ok", value: { outcome: "noop" } });
	assert.deepEqual(await reviewDismiss(once.send)(listed), { next: "list" });
	assert.deepEqual(once.sent, [listed, listed]);

	const twice = sender(Error("network"), { status: "lost" });
	const r = await reviewDismiss(twice.send)(listed);
	assert.equal(twice.sent.length, 2, "one retry, no more");
	assert.equal(r.next, "review");
	assert.equal(r.reread, false);
	assert.match(r.text, /may have been marked not a duplicate/);
	assert.match(r.text, /Reload the page/);
});

test("T-268 a refused dismiss keeps the review, says nothing changed and reads the pair again", async () => {
	const stale = reviewDismissed({ status: "refused", code: "pair_unavailable" });
	assert.deepEqual(stale, {
		next: "review",
		reread: true,
		text: "Nothing changed. One of them was merged or retired, or the pair is no longer on the list. The page now shows where they stand.",
	});
	const denied = reviewDismissed({ status: "refused", code: "forbidden" });
	assert.equal(denied.next, "review");
	assert.equal(denied.reread, true);
	assert.match(denied.text, /^Nothing changed\./);
	const { sent, send } = sender({ status: "refused", code: "pair_unavailable" });
	assert.deepEqual(await reviewDismiss(send)(listed), stale);
	assert.equal(sent.length, 1, "a refusal is not sent again");
});

test("T-268 while a dismiss is pending a second one sends nothing, and after it ends a new one may start", async () => {
	let answer;
	const sent = [];
	const run = reviewDismiss((input) => {
		sent.push(input);
		return new Promise((resolve) => (answer = resolve));
	});
	const first = run(listed);
	assert.equal(await run(listed), null, "the double click answers null");
	assert.equal(sent.length, 1);
	answer({ status: "refused", code: "pair_unavailable" });
	assert.equal((await first).next, "review");
	const again = run(listed);
	assert.equal(sent.length, 2, "a new dismiss after the first ended");
	answer({ status: "ok", value: { outcome: "changed" } });
	assert.deepEqual(await again, { next: "list" });
});
