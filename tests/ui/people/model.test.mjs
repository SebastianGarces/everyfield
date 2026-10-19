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
	skippedStages,
	leavesCommitted,
	withFilters,
	nextPage,
	previousPage,
	rangeText,
	moveInOrder,
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

test("AC:TARGET-PPL-006 stage guidance names skipped stages and leaving the committed stages", () => {
	assert.deepEqual(skippedStages("prospect", "leader"), [
		"attendee",
		"following_up",
		"interviewed",
		"core_group",
		"launch_team",
	]);
	assert.deepEqual(skippedStages("leader", "attendee"), []);
	assert.deepEqual(skippedStages("prospect", "attendee"), []);
	assert.equal(leavesCommitted("leader", "attendee"), true);
	assert.equal(leavesCommitted("core_group", "launch_team"), false);
	assert.equal(leavesCommitted("interviewed", "prospect"), false);
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

test("AC:TARGET-PPL-001 INV-url: unknown values are ignored and the pipeline has no list cursor", () => {
	const q = parseQuery(url("view=board&stage=friend,attendee&adult=teen&commitment=maybe&retired=all"));
	assert.equal(q.view, "list");
	assert.deepEqual(q.stages, ["attendee"]);
	assert.equal(q.classification, null);
	assert.equal(q.commitment, "any");
	assert.equal(q.archived, "exclude");
	assert.equal(querySearch(q), "?stage=attendee");
	const pipeline = parseQuery(url("view=pipeline&after=c1&retired=only"));
	assert.equal(querySearch(pipeline), "?view=pipeline&retired=only");
	assert.equal(listRequest(pipeline).after, undefined);
	assert.equal(listRequest(pipeline).archived, "exclude", "the pipeline shows active people only");
	assert.equal(listRequest(parseQuery(url(""))).limit, 24);
});

test("AC:TARGET-PPL-007 INV-reorder: a move sends the whole column with one person moved one place", () => {
	assert.deepEqual(moveInOrder(["a", "b", "c"], "c", "up"), ["a", "c", "b"]);
	assert.deepEqual(moveInOrder(["a", "b", "c"], "a", "down"), ["b", "a", "c"]);
	assert.deepEqual(moveInOrder(["a", "b", "c"], "a", "up"), ["a", "b", "c"]);
	assert.deepEqual(moveInOrder(["a", "b", "c"], "c", "down"), ["a", "b", "c"]);
});
