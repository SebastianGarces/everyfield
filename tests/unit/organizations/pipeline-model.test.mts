// The Pipeline stage review lists exactly what will change before anything saves (REQ-MUL-008), and the board's
// filters live in the address (D67).
import assert from "node:assert/strict";
import { test } from "node:test";
import {
	boardHref,
	formatDay,
	goalHeadline,
	monthLabel,
	queryFromSearch,
	refusalText,
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

test("a goal reads in words from its own targets and year", () => {
	assert.equal(
		goalHeadline({ leaderTarget: 6, plantTarget: 2, targetYear: 2028 }),
		"Develop 6 leaders to plant 2 churches by 2028",
	);
	assert.equal(
		goalHeadline({ leaderTarget: 1, plantTarget: 1, targetYear: 2030 }),
		"Develop 1 leader to plant 1 church by 2030",
	);
	assert.equal(goalHeadline({ leaderTarget: 3, plantTarget: 0, targetYear: 2027 }), "Develop 3 leaders by 2027");
	assert.equal(goalHeadline({ leaderTarget: 0, plantTarget: 2, targetYear: 2029 }), "Plant 2 churches by 2029");
	assert.equal(goalHeadline({ leaderTarget: 0, plantTarget: 0, targetYear: 2029 }), "Goal for 2029");
});

test("conversation months read as short names, with the year on January", () => {
	assert.deepEqual(["2026-10", "2026-12", "2027-01"].map(monthLabel), ["Oct", "Dec", "Jan 2027"]);
});

test("a refused negative target or future conversation date says why in plain words", () => {
	const refused = (field: string) => refusalText({ status: "refused", refusal: { code: "invalid_input", field } });
	assert.equal(refused("plantTarget"), "Targets can’t be less than 0.");
	assert.equal(refused("occurredOn"), "The date can’t be after today.");
	// A goal's chosen counts: the server names the count's position, which the copy does not need.
	assert.equal(refused("countingFrom"), "The counting-from date can’t be after today.");
	assert.equal(refused("counts"), "A goal can have up to 4 counts.");
	assert.equal(refused("counts.1.kind"), "This goal already counts that stage kind. Choose another kind.");
	assert.equal(refused("counts.0.label"), "Name each count in 1 to 60 characters.");
});
