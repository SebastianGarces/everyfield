// WP-036 criterion 1: the zod parser for everyfield.doc/1 in packages/contracts ports schema.json and format.js.
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import test from "node:test";
import {
	FORMAT_SCHEMA,
	blankDocument,
	computeTable,
	docDocument,
	docTemplate,
	everyfieldDoc,
	forkTemplate,
	parseFormula,
	templateHash,
	tileBox,
} from "../../../packages/contracts/src/documents/format/index.ts";

const design = new URL("../../../design/doc-format/approach-a/", import.meta.url);
const read = (rel: string) => JSON.parse(readFileSync(new URL(rel, design), "utf8"));
const issues = (doc: unknown) => {
	const parsed = everyfieldDoc.safeParse(doc);
	return parsed.success ? [] : parsed.error.issues.map((issue) => issue.message);
};
const ledgerOf = (doc: any) => doc.body.content.find((b: any) => b.type === "table" && b.attrs.style === "ledger");

test("the schema object is the design schema.json", () => {
	const { $comment: _comment, ...file } = read("schema.json");
	assert.deepEqual(JSON.parse(JSON.stringify(FORMAT_SCHEMA)), file);
});

test("the four examples parse and each invalid sample fails with its exact message", () => {
	const names = readdirSync(new URL("examples/", design)).sort();
	assert.deepEqual(names, [
		"budget-worksheet.json",
		"commitment-card-sheet.json",
		"conflict-of-interest-policy.json",
		"guest-sign-in-sheet.json",
	]);
	for (const name of names) {
		const doc = read(`examples/${name}`);
		assert.deepEqual(issues(doc), [], name);
		assert.deepEqual(docTemplate.parse(doc), doc, name);
	}
	const expected: Record<string, string> = read("invalid/expected.json");
	assert.equal(Object.keys(expected).length, 4);
	for (const [name, message] of Object.entries(expected)) {
		const found = issues(read(`invalid/${name}`));
		assert.ok(found.length > 0, `${name} is refused`);
		assert.ok(
			found.some((issue) => issue.includes(message)),
			`${name}: expected "${message}", got ${JSON.stringify(found)}`,
		);
	}
	assert.deepEqual(issues(read("invalid/sign-in-row-missing-cell.json")), [
		"body.content[0] (table).content[0] (row 1): the row has 4 cells but the table has 5 columns",
	]);
});

test("the card sheet puts four 4.25 x 5.5 in cards on one Letter page", () => {
	const card = read("examples/commitment-card-sheet.json");
	assert.equal(card.page.tile.across * card.page.tile.down, 4);
	assert.deepEqual(tileBox(card.page), { width: 306, height: 396 });
});

test("a changed amount updates its category total and the grand total", () => {
	const budget = structuredClone(read("examples/budget-worksheet.json"));
	const table = ledgerOf(budget);
	const rows = table.content;
	const at = (label: string) => rows.findIndex((r: any) => r.content[0].content?.[0]?.text === label);
	const set = (label: string, value: number) => (rows[at(label)].content[1].attrs = { value });
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
	assert.deepEqual(issues(budget), []);
});

test("formulas follow arithmetic order, sum a column range and name their faults", () => {
	const money = (id: string) => ({ id, label: id, type: "money" as const, width: 0 });
	const table = {
		type: "table" as const,
		attrs: {
			style: "ledger" as const,
			columns: [
				money("m1"),
				money("m2"),
				money("m3"),
				{ id: "year", label: "Year", type: "formula" as const, formula: "sum(m1:m3)", width: 0 },
				{ id: "avg", label: "Average", type: "formula" as const, formula: "year / 3 + 2 * 0", width: 0 },
			],
		},
		content: [
			{
				type: "row" as const,
				content: [10, 20, 30, null, null].map((value) => ({ type: "cell" as const, attrs: { value } })),
			},
		],
	};
	assert.deepEqual(computeTable(table)[0], [10, 20, 30, 60, 20]);
	assert.deepEqual(parseFormula("-(a + 2) * b"), {
		op: "*",
		a: { op: "neg", a: { op: "+", a: { op: "col", id: "a" }, b: { op: "num", v: 2 } } },
		b: { op: "col", id: "b" },
	});
	assert.throws(() => parseFormula("monthly *"), /ends too early/);
	assert.throws(() => parseFormula("monthly $ 2"), /unexpected character at position 8/);
	assert.throws(() => parseFormula("a b"), /extra text after a complete expression/);
});

test("a fork records its template, version and hash, freezes its data and survives a full wipe", async () => {
	const template = read("examples/conflict-of-interest-policy.json");
	const doc = await forkTemplate(template, { data: { church_name: "Harbor City Church", unknown: "x" } });
	assert.equal(doc.kind, "document");
	assert.deepEqual(doc.origin, {
		template: "conflict-of-interest-policy",
		version: 1,
		hash: await templateHash(template),
	});
	assert.match(doc.origin!.hash, /^sha256:[0-9a-f]{64}$/);
	assert.deepEqual(doc.data, { church_name: "Harbor City Church" });
	assert.deepEqual(docDocument.parse(doc), doc);
	doc.body = { type: "doc", content: [] };
	doc.page.footer = null;
	assert.deepEqual(issues(doc), []);
	assert.ok(template.body.content.length > 0, "the fork is a copy");
	// The hash reads the canonical form: key order and editor-only keys do not change it.
	const reordered = Object.fromEntries(Object.entries(template).reverse());
	assert.equal(await templateHash(reordered as never), await templateHash({ ...template, _editor: 1 }));
	assert.notEqual(await templateHash({ ...template, version: 2 }), doc.origin!.hash);
});

test("the kind parsers refuse the other kind, and a blank document is valid", () => {
	const template = read("examples/guest-sign-in-sheet.json");
	assert.match(docDocument.safeParse(template).error?.issues[0]?.message ?? "", /takes a document, not a template/);
	assert.equal(docDocument.safeParse(blankDocument()).success, true);
	assert.equal(docTemplate.safeParse(blankDocument()).success, false);
	assert.equal(everyfieldDoc.safeParse([{ kind: "paragraph", text: "old body" }]).success, false);
});

test("the validator names each structural fault and each size limit", () => {
	const base = read("examples/guest-sign-in-sheet.json");
	const long = "x".repeat(20_001);
	const cases: [(d: any) => void, RegExp][] = [
		[(d) => (d.data = {}), /a template holds no merge values/],
		[(d) => ((d.kind = "document"), delete d.data), /a document states its origin/],
		[(d) => d.fields.push({ ...d.fields[0] }), /the field key "church_name" is declared twice/],
		[
			(d) => d.body.content.push({ type: "paragraph", content: [{ type: "pageNumber" }] }),
			/a page number can sit only/,
		],
		[
			(d) =>
				d.body.content.push({ type: "writeIn", attrs: { label: "Date", key: "meeting_date", kind: "date", width: 0 } }),
			/the write-in key "meeting_date" is already used/,
		],
		[
			(d) => {
				const t = d.body.content.find((b: any) => b.type === "table");
				t.content = [
					{ type: "row", attrs: { role: "subtotal" }, content: t.attrs.columns.map(() => ({ type: "cell" })) },
				];
			},
			/a subtotal row needs a ledger table/,
		],
		[
			(d) => {
				const t = d.body.content.find((b: any) => b.type === "table");
				t.attrs.columns.push({ id: "late", label: "Late", type: "formula", formula: "later", width: 0 });
				t.attrs.columns.push({ id: "later", label: "Later", type: "number", width: 0 });
			},
			/a formula reads only columns to its left/,
		],
		[(d) => (d.exports = ["xlsx"]), /XLSX export needs at least one ledger table/],
		[(d) => d.body.content.push({ type: "chart" }), /unknown node type "chart"/],
		[(d) => d.body.content.push({ type: "listItem", content: [] }), /a listItem node is not allowed here/],
		[
			(d) => d.body.content.push({ type: "box", content: [{ type: "box" }] }),
			/a box node cannot sit inside this container/,
		],
		[
			(d) => ((d.page.size = "card-4x6"), (d.page.tile = { across: 4, down: 6, padding: 0, cutMarks: false })),
			/a tile needs at least 72 x 72 pt/,
		],
		[
			(d) =>
				d.body.content.push({
					type: "paragraph",
					content: [{ type: "text", text: "x", marks: [{ type: "link", attrs: { href: "javascript:alert(1)" } }] }],
				}),
			/does not match/,
		],
		[(d) => d.body.content.push({ type: "paragraph", content: [{ type: "text", text: long }] }), /longer than 20000/],
		[
			(d) => (d.body.content = Array.from({ length: 5001 }, () => ({ type: "spacer" }))),
			/the document holds 5\d{3} nodes; the limit is 5000/,
		],
		[
			(d) =>
				(d.body.content = Array.from({ length: 120 }, () => ({
					type: "paragraph",
					content: [{ type: "text", text: "y".repeat(19_000) }],
				}))),
			/bytes; the limit is 2000000/,
		],
	];
	for (const [mutate, message] of cases) {
		const doc = structuredClone(base);
		mutate(doc);
		const found = issues(doc);
		assert.ok(
			found.some((e) => message.test(e)),
			`${message}: got ${JSON.stringify(found).slice(0, 400)}`,
		);
	}
});
