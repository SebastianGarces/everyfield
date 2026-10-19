// People screen rules (WP-011/ui) that a silent break would turn into a double write, a lost draft, a stale overwrite
// or a list link that shows the wrong page. They run in node against the real module the screens use; no browser.
//   INV-one-save: one person runs one save at a time, decided synchronously, so a double click sends one request.
//   INV-draft-kept: a draft clears only when its save succeeds; a refusal or lost answer keeps it and says why.
//   INV-request-key: a retry after a lost answer reuses the key (the server replays); a refusal or a changed payload
//     gets a new key.
//   INV-revision: an older revision never replaces a newer saved person.
//   AC:TARGET-PPL-001 INV-url: filters, search and view live in the address; a change resets the cursor trail and keeps
//     the sibling filters; values outside the closed lists are ignored.
import assert from "node:assert/strict";
import { test } from "node:test";
import {
	changedFields,
	listRequest,
	parseQuery,
	PersonStore,
	querySearch,
	runSave,
	withFilters,
	nextPage,
	previousPage,
	rangeText,
} from "../../../apps/web/src/features/people/model.ts";

const person = (revision, extra = {}) => ({ id: "p1", revision, displayName: "Maria Santos", ...extra });
const keys = () => {
	let n = 0;
	return () => `key-${++n}`;
};
const deferred = () => {
	let resolve;
	const promise = new Promise((r) => (resolve = r));
	return { promise, resolve };
};

test("INV-one-save: a second save for the same person does not start while one runs", async () => {
	const store = new PersonStore(person("4"));
	const answer = deferred();
	const sent = [];
	const call = (key) => {
		sent.push(key);
		return answer.promise;
	};
	const first = runSave(store, "profile", { a: 1 }, call, { fresh: keys(), toPerson: (p) => p });
	// Not awaited: with the guard gone, the second save would wait on the same unanswered server call.
	const second = runSave(store, "stage", { b: 2 }, call, { fresh: keys(), toPerson: (p) => p });
	assert.deepEqual(sent, ["key-1"], "exactly one request went to the server");
	assert.equal(await second, null, "the second save is refused synchronously");
	assert.equal(store.get().pending, "profile");
	answer.resolve({ status: "ok", value: person("5") });
	await first;
	assert.equal(store.get().pending, null);
	assert.equal(store.get().saved.revision, "5");
	// With the first finished, the next save may start.
	const third = await runSave(store, "stage", { b: 2 }, async () => ({ status: "ok", value: person("6") }), {
		fresh: keys(),
		toPerson: (p) => p,
	});
	assert.equal(third.status, "ok");
	assert.equal(store.get().saved.revision, "6");
});

test("INV-draft-kept: refusal and lost answers keep the draft; success clears it; edits during a save are ignored", async () => {
	const store = new PersonStore(person("4"));
	store.dispatch({ type: "edit", slot: "note", draft: { body: "Called on Tuesday" } });

	const refused = await runSave(
		store,
		"note",
		{ body: "Called on Tuesday" },
		async () => ({ status: "refused", code: "conflict" }),
		{
			fresh: keys(),
		},
	);
	assert.equal(refused.status, "refused");
	assert.deepEqual(store.get().drafts.note, { body: "Called on Tuesday" });
	assert.equal(store.get().errors.note, "conflict");

	const lost = await runSave(
		store,
		"note",
		{ body: "Called on Tuesday" },
		async () => {
			throw new Error("network down");
		},
		{ fresh: keys() },
	);
	assert.equal(lost.status, "lost");
	assert.deepEqual(store.get().drafts.note, { body: "Called on Tuesday" });
	assert.equal(store.get().errors.note, "lost");

	const answer = deferred();
	const running = runSave(store, "note", { body: "Called on Tuesday" }, () => answer.promise, {
		fresh: keys(),
		toPerson: (p) => p,
	});
	store.dispatch({ type: "edit", slot: "note", draft: { body: "typed while saving" } });
	store.dispatch({ type: "discard", slot: "note" });
	assert.deepEqual(store.get().drafts.note, { body: "Called on Tuesday" }, "the sent draft stays while it saves");
	answer.resolve({ status: "ok", value: person("5") });
	await running;
	assert.equal(store.get().drafts.note, undefined, "success clears the draft");
	assert.equal(store.get().errors.note, undefined);
});

test("INV-request-key: a lost answer retries with the same key; refusal or a changed payload gets a new key", async () => {
	const store = new PersonStore(person("4"));
	const fresh = keys();
	const sent = [];
	const reply = (status) => async (key) => {
		sent.push(key);
		return status === "lost"
			? { status: "lost" }
			: status === "refused"
				? { status: "refused", code: "conflict" }
				: { status: "ok", value: person("5") };
	};
	await runSave(store, "stage", { stage: "attendee" }, reply("lost"), { fresh });
	await runSave(store, "stage", { stage: "attendee" }, reply("lost"), { fresh });
	assert.deepEqual(sent, ["key-1", "key-1"], "the retry replays the same request");
	await runSave(store, "stage", { stage: "interviewed" }, reply("lost"), { fresh });
	assert.equal(sent[2], "key-2", "a different payload is a different request");
	await runSave(store, "stage", { stage: "interviewed" }, reply("refused"), { fresh });
	assert.equal(sent[3], "key-2", "the retry of the lost request still uses its key");
	await runSave(store, "stage", { stage: "interviewed" }, reply("ok"), { fresh });
	assert.equal(sent[4], "key-3", "after a refusal the key is spent");
});

test("INV-revision: server props and answers never move the saved person back to an older revision", async () => {
	const store = new PersonStore(person("9", { displayName: "New" }));
	store.dispatch({ type: "server", person: person("8", { displayName: "Old" }) });
	assert.equal(store.get().saved.displayName, "New");
	store.dispatch({ type: "server", person: person("10", { displayName: "Newer" }) });
	assert.equal(store.get().saved.displayName, "Newer");
	await runSave(store, "profile", {}, async () => ({ status: "ok", value: person("9", { displayName: "Stale" }) }), {
		fresh: keys(),
		toPerson: (p) => p,
	});
	assert.equal(store.get().saved.displayName, "Newer");
	// Decimal revisions compare as numbers: "10" is newer than "9".
	store.dispatch({ type: "server", person: person("9", { displayName: "Nine" }) });
	assert.equal(store.get().saved.revision, "10");
});

test("INV-edit-patch: edit profile sends only the fields that changed", () => {
	const base = { displayName: "Maria", email: "m@example.test", phone: "" };
	assert.deepEqual(changedFields(base, { ...base, phone: "555" }), { phone: "555" });
	assert.deepEqual(changedFields(base, { ...base, email: "" }), { email: "" });
	assert.deepEqual(changedFields(base, base), {});
});

const url = (s) => new URLSearchParams(s);
test("AC:TARGET-PPL-001 INV-url: a filter change resets the cursor trail and keeps the other filters", () => {
	const q = parseQuery(url("q=ana&stage=attendee,leader&source=website&adult=adult&after=c1&after=c2"));
	assert.deepEqual(q.stages, ["attendee", "leader"]);
	assert.deepEqual(q.trail, ["c1", "c2"]);
	const changed = withFilters(q, { sources: ["event"] });
	assert.deepEqual(changed.trail, []);
	assert.equal(changed.search, "ana");
	assert.deepEqual(changed.stages, ["attendee", "leader"]);
	assert.equal(changed.classification, "adult");
	assert.equal(querySearch(changed), "?q=ana&stage=attendee%2Cleader&source=event&adult=adult");
	// The current page's cursor is the last one in the trail; Previous drops it.
	assert.equal(listRequest(q).after, "c2");
	assert.deepEqual(previousPage(q).trail, ["c1"]);
	assert.deepEqual(nextPage(q, "c3").trail, ["c1", "c2", "c3"]);
	assert.equal(rangeText(q, 24, 100), "Showing 49–72 of 100 people");
	assert.equal(rangeText(withFilters(q, {}), 1, 1), "Showing 1 of 1 person");
});

const T1 = "0b0f6a7e-1d6f-4f7e-8c35-5b8f5c0f4d21",
	T2 = "4d3c2b1a-0f9e-4d8c-8b7a-6a5b4c3d2e1f";
test("AC:TARGET-PPL-001 INV-tags: repeated tag ids stay in the address and ask for people with all of them", () => {
	const q = parseQuery(url(`tag=${T1}&tag=${T2.toUpperCase()}&tag=not-a-tag&tag=${T1}&after=c1`));
	assert.deepEqual(q.tags, [T1, T2], "valid, lowercased, once each");
	assert.equal(querySearch(q), `?tag=${T1}&tag=${T2}&after=c1`);
	assert.deepEqual(listRequest(q).tags, [T1, T2]);
	assert.equal(listRequest(q).tagOperator, "all");
	const removed = withFilters(q, { tags: [T2] });
	assert.deepEqual(removed.trail, [], "a tag change goes back to page one");
	assert.equal(querySearch(removed), `?tag=${T2}`);
	assert.equal(querySearch(withFilters(q, { tags: [] })), "");
});

test("AC:TARGET-PPL-001 INV-deep-pages (D50): Next keeps going past the kept cursors; the address stays bounded", () => {
	let q = parseQuery(url(""));
	for (let i = 1; i <= 45; i++) {
		q = nextPage(q, `c${i}`);
		// Ruling D50: at page 41 and 45 the request uses the cursor the server just gave.
		if (i === 40 || i === 44) {
			assert.equal(q.page, i + 1);
			assert.equal(listRequest(q).after, `c${i}`, `page ${i + 1} uses the server cursor`);
		}
	}
	assert.equal(q.page, 46, "45 Next presses reach page 46");
	assert.equal(q.trail.length, 40, "only the newest 40 cursors are kept");
	assert.equal(listRequest(q).after, "c45", "the request uses the newest cursor");
	assert.equal(rangeText(q, 24, 2000), "Showing 1081–1104 of 2000 people");
	// The address carries the page number once cursors were dropped, and reads back the same query.
	const again = parseQuery(url(querySearch(q).slice(1)));
	assert.equal(again.page, 46);
	assert.deepEqual(again.trail, q.trail);
	// Back one page while its cursor is kept.
	const back = previousPage(q);
	assert.equal(back.page, 45);
	assert.equal(listRequest(back).after, "c44");
	// Beyond the kept window the earlier cursor is gone, so Previous goes to page one.
	let edge = q;
	for (let i = 0; i < 40; i++) edge = previousPage(edge);
	assert.equal(edge.page, 1);
	assert.equal(listRequest(edge).after, undefined);
	assert.equal(withFilters(q, {}).page, 1, "a filter change goes back to page one");
});
