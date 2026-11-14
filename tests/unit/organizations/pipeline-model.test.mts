// The Pipeline stage review lists exactly what will change before anything saves (REQ-MUL-008), and the board's
// filters live in the address (D67).
import assert from "node:assert/strict";
import { test } from "node:test";
import {
	boardHref,
	formatDay,
	queryFromSearch,
	stageChanges,
} from "../../../apps/web/src/features/organizations/board/model.ts";

const starters = [
	{ id: "a", label: "Potential leader", kind: "potential_leader" },
	{ id: "b", label: "Apprentice", kind: "apprentice" },
	{ id: "c", label: "Resident", kind: "resident" },
	{ id: "d", label: "Commissioned", kind: "commissioned" },
	{ id: "e", label: "Not continuing", kind: "not_continuing" },
];

test("the review lists a rename, a new stage and the new order, and nothing else", () => {
	const [a, ...rest] = starters;
	const edited = [{ ...a!, label: "ICNU conversation had" }, { id: "n", label: "Intern", kind: "apprentice" }, ...rest];
	assert.deepEqual(stageChanges(starters, edited), [
		"Rename “Potential leader” to “ICNU conversation had”",
		"Add “Intern”, counted as Apprentice",
		"New order: 1. ICNU conversation had, 2. Intern, 3. Apprentice, 4. Resident, 5. Commissioned, 6. Not continuing",
	]);
});

test("a stage added at the end and a deletion change no order", () => {
	const edited = [...starters.filter((s) => s.id !== "d"), { id: "n", label: "Intern ", kind: "other" }];
	assert.deepEqual(stageChanges(starters, edited), ["Add “Intern”, counted as Other", "Delete “Commissioned”"]);
});

test("an untouched list has no changes", () => {
	assert.deepEqual(stageChanges(starters, starters), []);
});

test("the board's filters round-trip through the address, and anything unreadable falls back", () => {
	const query = queryFromSearch({ view: "retired", stale: "1", q: " Dallas ", page: "3" });
	assert.deepEqual(query, { view: "retired", stale: true, q: "Dallas", page: 3 });
	assert.equal(boardHref(query), "/organization/pipeline?view=retired&stale=1&q=Dallas&page=3");
	assert.deepEqual(queryFromSearch({ view: "other", page: "-2" }), { view: "board", stale: false, q: "", page: 1 });
	assert.equal(boardHref(queryFromSearch({})), "/organization/pipeline");
	assert.equal(formatDay("2026-10-02"), "Oct 2, 2026");
});
