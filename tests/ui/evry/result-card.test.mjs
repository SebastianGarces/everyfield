// What a result card says (WP-051 slice 2). It runs in node against the module the card uses; no browser.
//   AC:EVRY-CONTEXT-BOUNDS INV-households-card: a listHouseholds result is a Households card with household words, a
//     household icon, no link and no person wording.
//   INV-household-detail: getHousehold and getHouseholdMembers name people in the count; member rows show the household
//     role and link to the person; no household row links to /people/.
import assert from "node:assert/strict";
import { test } from "node:test";
import { cardView } from "../../../apps/web/src/features/evry/conversation/resultView.ts";

const H = "11111111-1111-4111-8111-111111111111";
const P1 = "22222222-2222-4222-8222-222222222222";
const P2 = "33333333-3333-4333-8333-333333333333";
const household = (id = H, memberCount = "2", city = "North Ridgeville") => ({
	kind: "household",
	id,
	label: "Okafor household",
	fields: { name: "Okafor household", city, memberCount, revision: "1" },
});
const member = (id, label, role) => ({ kind: "person", id, label, fields: { role, city: null, householdId: H } });
const result = (operation, rows, extra = {}) => ({
	operation,
	status: "available",
	rows,
	total: rows.length,
	page: 1,
	next: null,
	completeness: "complete",
	exclusions: [],
	...extra,
});

test("AC:EVRY-CONTEXT-BOUNDS INV-households-card: one household reads as a Households card with city, member count and no link", () => {
	const view = cardView("people.listHouseholds", result("people.listHouseholds", [household()]), null);
	assert.equal(view.title, "Households");
	assert.equal(view.summary, "1 household");
	assert.equal(view.icon, "household");
	assert.deepEqual(view.facts, []);
	const [row] = view.rows;
	assert.deepEqual(
		[row.name, row.line, row.avatar, row.href, row.mark],
		["Okafor household", "North Ridgeville · 2 members", "household", null, null],
	);
});

test("INV-households-card: the count words, 'N of M', the member word and a missing city", () => {
	const two = cardView(
		"people.listHouseholds",
		result("people.listHouseholds", [household(H, "1"), household(P1, "3", "")]),
		null,
	);
	assert.equal(two.summary, "2 households");
	assert.deepEqual(
		two.rows.map((r) => r.line),
		["North Ridgeville · 1 member", "3 members"],
	);
	const page = cardView(
		"people.listHouseholds",
		result("people.listHouseholds", [household()], { total: 30, completeness: "partial", next: 2 }),
		null,
	);
	assert.equal(page.summary, "1 of 30");
	assert.deepEqual(page.facts, ["More households match. Ask Evry for page 2."]);
});

test("INV-households-card: an empty result says so in household words", () => {
	const view = cardView("people.listHouseholds", result("people.listHouseholds", []), null);
	assert.equal(view.summary, "0 households");
	assert.deepEqual(view.facts, ["No household in this church matches, or you can't see them."]);
	const withheld = cardView(
		"people.listHouseholds",
		result("people.listHouseholds", [], { total: null, completeness: "partial", withheldRows: 1 }),
		null,
	);
	assert.deepEqual(withheld.facts, [
		"No household in this church matches, or you can't see them.",
		"1 row is no longer available and not shown.",
		"Only the first matches are shown.",
	]);
});

test("INV-household-detail: titles, a people count, member roles and links; the household row has none", () => {
	const rows = [household(), member(P1, "James Okafor", "head"), member(P2, "Ruth Allen", "spouse")];
	const one = cardView("people.getHousehold", result("people.getHousehold", rows), null);
	assert.equal(one.title, "Household");
	assert.equal(one.summary, "2 people");
	const members = cardView("people.getHouseholdMembers", result("people.getHouseholdMembers", rows), null);
	assert.equal(members.title, "Household members");
	assert.equal(members.summary, "2 people");
	assert.deepEqual(
		one.rows.map((r) => [r.name, r.line, r.href]),
		[
			["Okafor household", "North Ridgeville · 2 members", null],
			["James Okafor", "Head", `/people/${P1}`],
			["Ruth Allen", "Spouse", `/people/${P2}`],
		],
	);
	assert.ok(one.rows.filter((r) => r.avatar === "household").every((r) => r.href === null));
	assert.equal(
		cardView(
			"people.getHouseholdMembers",
			result("people.getHouseholdMembers", [household(), member(P1, "James Okafor", "head")]),
			null,
		).summary,
		"1 person",
	);
});

test("INV-household-detail: only person rows link; other kinds keep the generic card without a person link", () => {
	const tag = { kind: "tag", id: H, label: "Volunteers", fields: { name: "Volunteers" } };
	const view = cardView("people.listTags", result("people.listTags", [tag]), null);
	assert.equal(view.title, "Records");
	assert.equal(view.rows[0].href, null);
	const person = cardView(
		"people.listPeople",
		result("people.listPeople", [
			{ kind: "person", id: P1, label: "Alex", fields: { city: "Chicago", stage: "prospect" } },
		]),
		null,
	);
	assert.deepEqual(
		[person.title, person.summary, person.rows[0].href, person.rows[0].mark],
		["People", "1 person", `/people/${P1}`, { kind: "stage", stage: "prospect" }],
	);
});
