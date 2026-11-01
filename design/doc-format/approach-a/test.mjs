// Tests for the format module. Run: node --test design/doc-format/approach-a/test.mjs (Node 22+, no install step).
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { blankDocument, computeTable, forkTemplate, parseFormula, tileBox, validate } from "./format.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const schema = JSON.parse(fs.readFileSync(path.join(here, "schema.json"), "utf8"));
const read = (rel) => JSON.parse(fs.readFileSync(path.join(here, rel), "utf8"));
const errorsOf = (doc) => validate(doc, schema).errors;
const ledgerOf = (doc) => doc.body.content.find((b) => b.type === "table" && b.attrs.style === "ledger");

test("the one-command validator passes the examples and rejects each invalid sample with its message", () => {
	const out = execFileSync(process.execPath, [path.join(here, "validate.mjs")], { encoding: "utf8" });
	assert.match(out, /All checks passed\./);
	assert.equal((out.match(/^pass {2}examples\//gm) ?? []).length, 4);
	assert.equal((out.match(/^pass {2}invalid\//gm) ?? []).length, Object.keys(read("invalid/expected.json")).length);
});

test("each example is valid and exactly one example of each kind exists", () => {
	const names = fs.readdirSync(path.join(here, "examples")).sort();
	assert.deepEqual(names, [
		"budget-worksheet.json",
		"commitment-card-sheet.json",
		"conflict-of-interest-policy.json",
		"guest-sign-in-sheet.json",
	]);
	for (const name of names) assert.deepEqual(errorsOf(read(`examples/${name}`)), [], name);
});

test("the card sheet puts four 4.25 x 5.5 in cards on one Letter page", () => {
	const card = read("examples/commitment-card-sheet.json");
	assert.equal(card.page.tile.across * card.page.tile.down, 4);
	assert.deepEqual(tileBox(card.page, schema), { width: 306, height: 396 });
});

test("a changed amount updates its category total and the grand total", () => {
	const budget = structuredClone(read("examples/budget-worksheet.json"));
	const table = ledgerOf(budget);
	const rows = table.content;
	const at = (label) => rows.findIndex((r) => r.content[0].content?.[0]?.text === label);
	const set = (label, value) => (rows[at(label)].content[1].attrs.value = value);
	set("Tithes and offerings", 4000);
	set("Grants", 1000);
	set("Rent or facility", 1500);
	let out = computeTable(table);
	assert.deepEqual(out[at("Tithes and offerings")], [null, 4000, 48000]);
	assert.deepEqual(out[at("Total income")], [null, 5000, 60000]);
	assert.deepEqual(out[at("Total expenses")], [null, 1500, 18000]);
	assert.deepEqual(out[at("Net (income minus expenses)")], [null, 3500, 42000]);
	set("Rent or facility", 2000);
	out = computeTable(table);
	assert.deepEqual(out[at("Total expenses")], [null, 2000, 24000]);
	assert.deepEqual(out[at("Net (income minus expenses)")], [null, 3000, 36000]);
	assert.deepEqual(errorsOf(budget), []);
});

test("formulas follow arithmetic order and sum a column range", () => {
	const table = {
		type: "table",
		attrs: {
			style: "ledger",
			columns: [
				{ id: "m1", label: "1", type: "money", width: 0 },
				{ id: "m2", label: "2", type: "money", width: 0 },
				{ id: "m3", label: "3", type: "money", width: 0 },
				{ id: "year", label: "Year", type: "formula", formula: "sum(m1:m3)", width: 0 },
				{ id: "avg", label: "Average", type: "formula", formula: "year / 3 + 2 * 0", width: 0 },
			],
		},
		content: [
			{
				type: "row",
				content: [10, 20, 30, null, null].map((value) => ({ type: "cell", attrs: { value } })),
			},
		],
	};
	assert.deepEqual(computeTable(table)[0], [10, 20, 30, 60, 20]);
	assert.throws(() => parseFormula("monthly *"), /ends too early/);
	assert.throws(() => parseFormula("monthly $ 2"), /unexpected character/);
});

test("a forked template is a document that records its origin and survives a full wipe", async () => {
	const template = read("examples/conflict-of-interest-policy.json");
	const doc = await forkTemplate(template, { data: { church_name: "Harbor City Church" } });
	assert.equal(doc.kind, "document");
	assert.equal(doc.origin.template, "conflict-of-interest-policy");
	assert.match(doc.origin.hash, /^sha256:[0-9a-f]{64}$/);
	assert.deepEqual(doc.data, { church_name: "Harbor City Church" });
	assert.deepEqual(errorsOf(doc), []);
	doc.body.content = [];
	doc.page.footer = null;
	assert.deepEqual(errorsOf(doc), []);
	// The fork is a copy: editing it leaves the template alone.
	assert.equal(template.body.content.length > 0, true);
});

test("a blank document is valid", () => {
	assert.deepEqual(errorsOf(blankDocument()), []);
});

test("the validator names each structural fault", () => {
	const base = read("examples/guest-sign-in-sheet.json");
	const cases = [
		[(d) => (d.data = {}), /a template holds no merge values/],
		[(d) => ((d.kind = "document"), delete d.data), /a document states its origin/],
		[(d) => d.body.content.push({ type: "paragraph", content: [{ type: "pageNumber" }] }), /a page number can sit only/],
		[
			(d) =>
				d.body.content.push({ type: "writeIn", attrs: { label: "Date", key: "meeting_date", kind: "date", width: 0 } }),
			/the write-in key "meeting_date" is already used/,
		],
		[
			(d) => {
				const t = d.body.content.find((b) => b.type === "table");
				t.content = [{ type: "row", attrs: { role: "subtotal" }, content: t.attrs.columns.map(() => ({ type: "cell" })) }];
			},
			/a subtotal row needs a ledger table/,
		],
		[(d) => (d.exports = ["xlsx"]), /XLSX export needs at least one ledger table/],
		[(d) => d.body.content.push({ type: "chart" }), /unknown node type "chart"/],
		[(d) => d.body.content.push({ type: "listItem", content: [] }), /a listItem node is not allowed here/],
		[(d) => ((d.page.size = "card-4x6"), (d.page.tile = { across: 4, down: 6, padding: 0, cutMarks: false })), /a tile needs at least 72 x 72 pt/],
		[
			(d) => d.body.content.push({ type: "paragraph", content: [{ type: "text", text: "x", marks: [{ type: "link", attrs: { href: "javascript:alert(1)" } }] }] }),
			/does not match/,
		],
	];
	for (const [mutate, message] of cases) {
		const doc = structuredClone(base);
		mutate(doc);
		const errors = errorsOf(doc);
		assert.ok(errors.some((e) => message.test(e)), `${message}: got ${JSON.stringify(errors)}`);
	}
});
