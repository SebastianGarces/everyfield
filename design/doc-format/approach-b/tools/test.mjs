#!/usr/bin/env node
// Regression tests of the approach B format. Run: node --test design/doc-format/approach-b/tools/test.mjs
// node:test and node built-ins only; no install and no network.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { computeLedger, sheetBox } from "../format/model.mjs";
import { blank, fingerprint, fork, wipe } from "../format/ops.mjs";
import { validateDocument } from "../format/validator.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const read = (path) => JSON.parse(readFileSync(join(root, path), "utf8"));
const schema = read("format/schema.json");
const EXAMPLES = [
	"examples/conflict-of-interest-policy.json",
	"examples/commitment-card.json",
	"examples/guest-sign-in-sheet.json",
	"examples/first-year-budget.json",
];
const cli = (...files) => {
	try {
		return { status: 0, out: execFileSync("node", [join(root, "tools/validate.mjs"), ...files], { encoding: "utf8" }) };
	} catch (error) {
		return { status: error.status, out: error.stdout };
	}
};
const errorsOf = (doc) => validateDocument(doc, schema);
const plain = (content) => content.map((n) => n.text ?? `{${n.key ?? n.type}}`).join("");

test("the validation script exits 0 on the four examples", () => {
	const run = cli(...EXAMPLES.map((p) => join(root, p)));
	assert.equal(run.status, 0, run.out);
	assert.equal(run.out.match(/^ok /gm).length, 4);
});

test("the validation script exits 1 on the shipped invalid sample and names each problem", () => {
	const run = cli(join(root, "examples/invalid/broken-budget.json"));
	assert.equal(run.status, 1);
	assert.match(run.out, /field "church\.treasurer" is not declared/);
	assert.match(run.out, /has 11 amounts for 12 periods/);
	assert.match(run.out, /group "costs" is not in this ledger/);
	assert.match(run.out, /ledger "yearly" is not in this document/);
});

test("the validation script exits 2 on a file that is not JSON", () => {
	assert.equal(cli(join(root, "README.md")).status, 2);
});

test("the schema refuses an unknown block, an unknown property and an unsafe link", () => {
	const doc = read(EXAMPLES[0]);
	doc.body.push({ type: "spreadsheet", id: "raw", cells: "A1:N30" });
	assert.deepEqual(errorsOf(doc), [`/body[${doc.body.length - 1}]: is not an allowed value of type "spreadsheet".`]);

	const extra = read(EXAMPLES[0]);
	extra.body[0].color = "#ff0000";
	assert.deepEqual(errorsOf(extra), ['/body[0]: has an unknown property "color".']);

	const link = read(EXAMPLES[0]);
	link.body[1].content[0].marks = [{ type: "link", href: "javascript:alert(1)" }];
	assert.deepEqual(errorsOf(link), ["/body[1]/content[0]/marks[0]/href: does not match ^(https?://|mailto:|tel:)."]);
});

test("the cross rules refuse duplicate ids, a two-row repeating table, a counter in a static table and a page number in the body", () => {
	const doc = read("examples/guest-sign-in-sheet.json");
	const table = doc.body.find((b) => b.type === "table");
	table.rows.push({ ...table.rows[0], id: "guest-2" });
	const headingId = doc.body[2].id;
	doc.body[2].id = "masthead";
	doc.body[3].content.push({ type: "pageNumber" });
	assert.deepEqual(errorsOf(doc), [
		'/body[2]: id "masthead" is already used at /body[0].',
		"/body[3].content[3]: a page number sits only in the header or the footer.",
		"/body[5]: a repeating table has exactly one row, the row it repeats.",
	]);
	delete table.repeat;
	table.rows.pop();
	doc.body[2].id = headingId;
	doc.body[3].content.pop();
	assert.deepEqual(errorsOf(doc), ["/body[5].rows[0].cells[0]: a counter cell needs a repeating table."]);
});

test("the cross rules refuse a legal document with no notice, an imposition that does not fit and a nested ledger", () => {
	const policy = read(EXAMPLES[0]);
	policy.notices = [];
	assert.deepEqual(errorsOf(policy), ['/notices: a formal/legal document carries the "template-not-legal-advice" notice.']);

	const card = read("examples/commitment-card.json");
	card.page.imposition.across = 3;
	assert.deepEqual(errorsOf(card), ["/page/imposition: 3 × 2 pages of this size do not fit on one letter sheet."]);

	const budget = read("examples/first-year-budget.json");
	const ledger = budget.body.splice(2, 1)[0];
	budget.body.unshift({ type: "box", id: "wrap", tone: "none", blocks: [ledger] });
	assert.deepEqual(errorsOf(budget), ["/body[0].blocks[0]: a ledger block sits only at the top level of the body."]);
});

test("four cards impose on one Letter sheet and the sheet stays portrait", () => {
	const card = read("examples/commitment-card.json");
	assert.deepEqual(sheetBox(card.page), { width: 612, height: 792 });
	assert.equal(sheetBox({ ...card.page, imposition: { ...card.page.imposition, across: 3 } }), null);
});

test("ledger totals recompute from the lines", () => {
	const budget = read("examples/first-year-budget.json");
	const ledger = budget.body.find((b) => b.type === "ledger");
	ledger.groups[0].lines[0].amounts = Array(12).fill(4000);
	ledger.groups[0].lines[1].amounts[0] = 1500.5;
	ledger.groups[1].lines[2].amounts = Array(12).fill(1200);
	const before = computeLedger(ledger);
	assert.equal(before.lines["tithes-and-offerings"].total, 48000);
	assert.deepEqual(before.groups.income.periods.slice(0, 2), [5500.5, 4000]);
	assert.equal(before.groups.income.total, 49500.5);
	assert.equal(before.groups.expenses.total, 14400);
	assert.equal(before.results.net.total, 35100.5);
	ledger.groups[1].lines[2].amounts[11] = 2200;
	assert.equal(computeLedger(ledger).results.net.total, 34100.5);
});

test("the times rule turns one monthly amount into an annual amount", () => {
	const ledger = {
		periods: { count: 1, label: "Monthly" },
		total: { label: "Annual", rule: "times", factor: 12 },
		groups: [{ id: "income", label: "Income", subtotal: "Total income", lines: [{ id: "a", label: "A", amounts: [250] }] }],
		results: [],
	};
	assert.equal(computeLedger(ledger).groups.income.total, 3000);
});

test("a fork is a valid document and leaves its template unchanged; a wipe empties it", () => {
	for (const path of EXAMPLES) {
		const template = read(path);
		const before = fingerprint(template);
		const doc = fork(template, "doc-1");
		doc.body[0].id = "renamed";
		doc.fields.forEach((f) => (f.value = "Grace Church"));
		assert.equal(fingerprint(template), before);
		assert.deepEqual(doc.origin, { templateId: template.id, templateVersion: 1 });
		assert.deepEqual(errorsOf(doc), []);
		const empty = wipe(doc);
		assert.deepEqual([empty.body, empty.fields, empty.header, empty.footer], [[], [], undefined, undefined]);
		assert.deepEqual(empty.notices, template.notices);
		assert.deepEqual(errorsOf(empty), []);
	}
	const twice = fork(fork(read(EXAMPLES[1]), "doc-1"), "doc-2");
	assert.deepEqual(twice.origin, { templateId: "commitment-card", templateVersion: 1, forkedFrom: "doc-1" });
	assert.deepEqual(errorsOf(blank("doc-3")), []);
});

test("the examples carry today's template content", () => {
	const policy = read(EXAMPLES[0]);
	const headings = policy.body.filter((b) => b.type === "heading" && b.level === 2).map((b) => plain(b.content));
	assert.deepEqual(headings, [
		"Purpose",
		"Who this policy covers",
		"What counts as an interest",
		"The duty to disclose",
		"How the board decides",
		"When a conflict exists",
		"Record in the minutes",
		"Yearly statement",
		"If a member breaks this policy",
	]);
	assert.equal(policy.body.find((b) => b.type === "table").repeat.count, 3);

	const card = read("examples/commitment-card.json");
	const tiles = card.body.find((b) => b.id === "commitments").rows.map((r) => r.cells[1].content[0].text);
	assert.deepEqual(tiles, ["GROW", "PRAY", "GIVE"]);

	const signIn = read("examples/guest-sign-in-sheet.json");
	const guests = signIn.body.find((b) => b.type === "table");
	assert.deepEqual(
		[guests.repeat.count, guests.columns.map((c) => c.label)],
		[18, ["#", "Name", "Email", "Phone", "Who invited you?"]],
	);

	const budget = read("examples/first-year-budget.json");
	const ledger = budget.body.find((b) => b.type === "ledger");
	assert.deepEqual(
		ledger.groups.map((g) => g.lines.length),
		[5, 10],
	);
	assert.equal(ledger.groups[1].lines[9].label, "Giving to the network and missions");
});
