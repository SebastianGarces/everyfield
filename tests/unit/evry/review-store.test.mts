import assert from "node:assert/strict";
import { test } from "node:test";

Object.assign(globalThis, { window: globalThis });
const { createReviewStore, loadOf } = await import("../../../apps/web/src/features/evry/review/ReviewCard.store.ts");

const settled = () => new Promise((resolve) => setImmediate(resolve));

function card(seed: Parameters<typeof createReviewStore>[0]["seed"]) {
	const reads: string[] = [];
	const answer = () => Promise.resolve({ status: "lost" as const });
	const store = createReviewStore({
		id: "p1",
		seed,
		port: {
			readReview: (id: string) => {
				reads.push(id);
				return answer();
			},
			readStagedPhoto: answer,
			approve: answer,
			revise: answer,
			cancel: answer,
			retry: answer,
			check: answer,
			refresh: () => {},
		},
	});
	const follow = store.getState().actions.follow;
	const shown = () => loadOf(store.getState().shown.peek("p1")?.value);
	return { store, follow, reads, shown };
}

test("INV-evry-review: a card that arrives with its review never reads it on show, also through StrictMode's subscribe, unsubscribe, subscribe", async () => {
	const { follow, reads, shown } = card(null);
	follow(() => {})();
	const stop = follow(() => {});
	await settled();
	assert.deepEqual(reads, []);
	assert.equal(shown(), "unavailable");
	stop();
});

test("INV-evry-review: a card shown with no review reads it once, also through StrictMode's subscribe, unsubscribe, subscribe; Try again after a lost read reads once more", async () => {
	const { store, follow, reads, shown } = card(undefined);
	assert.deepEqual(reads, [], "creating the card reads nothing");
	follow(() => {})();
	const stop = follow(() => {});
	assert.equal(shown(), "loading");
	await settled();
	assert.deepEqual(reads, ["p1"]);
	assert.equal(shown(), "lost");
	store.getState().actions.reload();
	await settled();
	assert.deepEqual(reads, ["p1", "p1"]);
	stop();
});
