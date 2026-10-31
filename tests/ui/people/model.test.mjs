// People screen rules (WP-011/ui) that a silent break would turn into a double write, a lost draft, a stale overwrite
// or a list link that shows the wrong page. They run in node against the real module the screens use; no browser.
//   INV-one-save: one person runs one save at a time, decided synchronously, so a double click sends one request.
//   INV-draft-kept: a draft clears only when its save succeeds; a refusal or lost answer keeps it and says why.
//   INV-request-key: a retry after a lost answer reuses the key (the server replays); a refusal or a changed payload
//     gets a new key.
//   INV-revision: an older revision never replaces a newer saved person.
//   INV-activity-entry: a saved change shows in Activity from its answer: a new entry joins the end of a fully loaded
//     list, a known entry is replaced in place, and while later pages are unloaded the loaded pages stay as they are.
//   AC:TARGET-PPL-001 INV-url (D67): filters, search, view and page number live in the address; a change goes back to
//     page one and keeps the sibling filters; values outside the closed lists are ignored.
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
	pageCount,
	rangeText,
	columnCards,
	withEntry,
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
test("AC:TARGET-PPL-001 INV-url (D67): the page number lives in the address; a filter change goes back to page one", () => {
	const q = parseQuery(url("q=ana&stage=attendee,leader&source=website&adult=adult&page=3"));
	assert.equal(q.page, 3);
	assert.equal(listRequest(q).page, 3);
	assert.equal(querySearch(q), "?q=ana&stage=attendee%2Cleader&source=website&adult=adult&page=3");
	assert.equal(rangeText(q, 24, 100), "Showing 49–72 of 100 people");
	const changed = withFilters(q, { sources: ["event"] });
	assert.equal(changed.page, 1);
	assert.deepEqual([changed.search, changed.stages, changed.classification], ["ana", ["attendee", "leader"], "adult"]);
	assert.equal(querySearch(changed), "?q=ana&stage=attendee%2Cleader&source=event&adult=adult");
	assert.equal(rangeText(changed, 1, 1), "Showing 1 of 1 person");
	// The pipeline has no page number; each column loads its own pages.
	assert.equal(
		querySearch({ ...q, view: "pipeline" }),
		"?view=pipeline&q=ana&stage=attendee%2Cleader&source=website&adult=adult",
	);
	assert.equal(listRequest({ ...q, view: "pipeline" }).page, 1);
	for (const bad of ["0", "-2", "1.5", "two", ""]) assert.equal(parseQuery(url(`page=${bad}`)).page, 1, bad);
	assert.equal(parseQuery(url("page=999999999")).page, 100_000, "the contract's highest page");
	assert.deepEqual([0, 24, 25, 48, 49].map(pageCount), [1, 1, 2, 2, 3]);
});

const T1 = "0b0f6a7e-1d6f-4f7e-8c35-5b8f5c0f4d21",
	T2 = "4d3c2b1a-0f9e-4d8c-8b7a-6a5b4c3d2e1f";
test("AC:TARGET-PPL-001 INV-tags: repeated tag ids stay in the address and ask for people with all of them", () => {
	const q = parseQuery(url(`tag=${T1}&tag=${T2.toUpperCase()}&tag=not-a-tag&tag=${T1}&page=2`));
	assert.deepEqual(q.tags, [T1, T2], "valid, lowercased, once each");
	assert.equal(querySearch(q), `?tag=${T1}&tag=${T2}&page=2`);
	assert.deepEqual(listRequest(q).tags, [T1, T2]);
	assert.equal(listRequest(q).tagOperator, "all");
	const removed = withFilters(q, { tags: [T2] });
	assert.equal(removed.page, 1, "a tag change goes back to page one");
	assert.equal(querySearch(removed), `?tag=${T2}`);
	assert.equal(querySearch(withFilters(q, { tags: [] })), "");
});

test("AC:TARGET-PPL-007 INV-move-revisions (D68): after reorder, away and back, a card keeps its newest revision and the saved order", () => {
	const card = (id, stage, revision) => ({ person: { id, stage, revision } });
	// The server copy: A and B follow up, C attends.
	const following = [card("A", "following_up", "1"), card("B", "following_up", "1")];
	const attending = [card("C", "attendee", "1")];
	const view = (column, loaded, moved, answer) =>
		columnCards(column, loaded, moved, answer).map((c) => `${c.person.id}@${c.person.revision}`);
	// 1. Reorder: B up. The answer gives both people revision 2.
	let answer = { revision: "2", personIds: ["B", "A"], personRevisions: { A: "2", B: "2" } };
	const moved = new Map();
	assert.deepEqual(view("following_up", following, moved, answer), ["B@2", "A@2"]);
	// 2. B to attendee: the stage answer is B at 3, in the attendee column's saved order.
	moved.set("B", card("B", "attendee", "3"));
	const attendee = { revision: "1", personIds: ["C", "B"], personRevisions: { C: "1", B: "3" } };
	assert.deepEqual(view("following_up", following, moved, answer), ["A@2"]);
	assert.deepEqual(view("attendee", attending, moved, attendee), ["C@1", "B@3"]);
	// 3. B back: B is at 4. The reorder answer still says B@2; the newer revision wins.
	moved.set("B", card("B", "following_up", "4"));
	answer = { revision: "2", personIds: ["A", "B"], personRevisions: { A: "2", B: "4" } };
	assert.deepEqual(view("following_up", following, moved, answer), ["A@2", "B@4"]);
	assert.deepEqual(view("following_up", following, moved, { ...answer, personRevisions: { A: "2", B: "2" } }), [
		"A@2",
		"B@4",
	]);
	// 4. The next move of B sends revision 4, not the reorder's 2 (the verifier's false "changed" refusal).
	const b = columnCards("following_up", following, moved, answer).find((c) => c.person.id === "B");
	assert.equal(b.person.revision, "4");
	// A pending reorder shows its own order first; people it does not list keep their place after it.
	assert.deepEqual(
		columnCards("following_up", following, moved, answer, ["B"]).map((c) => c.person.id),
		["B", "A"],
	);
});

test("INV-activity-entry: a saved change joins the top, replaces its own entry, and stays on top over unloaded pages", () => {
	const note = { id: "n1", kind: "note", body: "First" };
	const loaded = (next, items = [note]) => ({ status: "ok", value: { items, next } });
	const added = { id: "a1", kind: "activity", action: "updated" };
	assert.deepEqual(withEntry(loaded(null), added).value.items, [added, note]);
	assert.deepEqual(withEntry(loaded(null), { ...note, body: "Edited" }).value.items, [{ ...note, body: "Edited" }]);
	assert.deepEqual(withEntry(loaded(2), added), loaded(2, [added, note]));
	assert.deepEqual(withEntry(loaded(2), { ...note, body: "Edited" }).value.items, [{ ...note, body: "Edited" }]);
	assert.deepEqual(withEntry({ status: "lost" }, added), { status: "lost" });
});
