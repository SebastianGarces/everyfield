// WP-036 slice 4: the table rules the editor and the renderers share (packages/contracts) and the table actions the
// editor runs on them (apps/web). No browser, no database.
import assert from "node:assert/strict";
import test from "node:test";
import {
	attrIssue,
	columnWidths,
	computeTable,
	exportsFor,
	formatNumber,
	everyfieldDoc,
	parseAmount,
	type TableNode,
} from "../../../packages/contracts/src/documents/index.ts";
import {
	addCategory,
	addColumn,
	addLineItem,
	availability,
	categoryAt,
	newBudget,
	newChecklist,
	newGrid,
	removeCategory,
	removeColumn,
	setKind,
	setSign,
} from "../../../apps/web/src/features/documents/church/editor/table-ops.ts";
import { blankRows, tableView } from "../../../apps/web/src/features/documents/church/editor/table-model.ts";
import { docTemplateById } from "../../../packages/domain/src/documents/doc-templates.ts";

const budgetTemplate = () =>
	structuredClone(docTemplateById("budget-worksheet")!.body.content!.find((n) => n.type === "table")) as TableNode;
/** The first fault the format finds in a table, in a document that holds it alone. */
const tableIssue = (table: TableNode) => {
	const template = {
		...docTemplateById("budget-worksheet")!,
		exports: ["pdf"],
		body: { type: "doc", content: [table] },
	};
	return everyfieldDoc.safeParse(template).error?.issues[0]?.message ?? null;
};
const roles = (t: TableNode) => (t.content ?? []).map((r) => r.attrs?.role ?? "item");

test("formatNumber rounds money to cents, so 0.20 + 0.70 + 0.10 prints $1 and 100.50 keeps its cents", () => {
	assert.equal(formatNumber(0.2 + 0.7 + 0.1, "money"), "$1");
	assert.equal(formatNumber(0.2 + 0.7 + 0.1, "number"), "1");
	assert.equal(formatNumber(100.5, "money"), "$100.50");
	assert.equal(formatNumber(-1234.5, "money"), "-$1,234.50");
	assert.equal(formatNumber(1234.5, "number"), "1,234.5");
	assert.equal(formatNumber(-0.001, "money"), "$0");
});

test("parseAmount reads $3,000, 3000.50 and -20, rounds money to cents, stores blank as null and refuses the rest", () => {
	for (const [text, kind, value] of [
		["$3,000", "money", 3000],
		["3000.50", "money", 3000.5],
		["-20", "money", -20],
		["-$20", "money", -20],
		["10.126", "money", 10.13],
		["10.126", "number", 10.126],
		["  ", "money", null],
	] as const)
		assert.deepEqual(parseAmount(text, kind), { ok: true, value }, text);
	for (const text of ["abc", "12abc", "1,00", "--5", "$", "1e5", "1.2.3", "$-$5"])
		assert.equal(parseAmount(text, "money").ok, false, text);
});

test("columnWidths shares the free width among the columns with width 0, as the PDF does", () => {
	assert.deepEqual(columnWidths([{ width: 100 }, { width: 0 }, { width: 0 }], 500), [100, 200, 200]);
	assert.deepEqual(columnWidths([{ width: 0 }, { width: 0 }], 30), [24, 24]);
});

test("exports follow the body: Excel only with a budget table, and an unchanged list keeps its order", () => {
	const withBudget = { type: "doc", content: [{ type: "table", attrs: { style: "ledger", columns: [] } }] } as never;
	const without = { type: "doc", content: [{ type: "paragraph" }] } as never;
	assert.deepEqual(exportsFor(["xlsx", "pdf", "docx"], withBudget), ["xlsx", "pdf", "docx"]);
	assert.deepEqual(exportsFor(["pdf", "docx"], withBudget), ["pdf", "docx", "xlsx"]);
	assert.deepEqual(exportsFor(["xlsx", "pdf", "docx"], without), ["pdf", "docx"]);
	assert.deepEqual(exportsFor(["pdf", "docx"], without), ["pdf", "docx"]);
});

test("the format's own words refuse a blank row count outside 0 to 200", () => {
	assert.equal(attrIssue("table", "writeInRows", 250), "250 is outside 0 to 200");
	assert.equal(attrIssue("table", "writeInRows", 2.5), "must be a whole number");
	assert.equal(attrIssue("table", "writeInRows", 200), null);
});

test("every new table of Insert parses, and a column or row action leaves the table valid", () => {
	for (const make of [newGrid, newChecklist, newBudget]) assert.equal(tableIssue(make()), null);
	let grid = newGrid();
	for (let i = 0; i < 13; i++) grid = addColumn(grid, 0);
	assert.equal(grid.attrs.columns.length, 16);
	assert.equal(new Set(grid.attrs.columns.map((c) => c.id)).size, 16, "every column id is unique");
	assert.match(availability(grid, { row: null, col: 0 }).addColumnLeft ?? "", /at most 16 columns/);
	assert.equal(tableIssue(removeColumn(grid, 3)), null);
});

test("a column kind change converts the cells: text that reads as a number, number to money and back, the rest clears", () => {
	let t = addColumn(newGrid(), 3);
	t = {
		...t,
		content: [
			{
				type: "row",
				content: [
					{ type: "cell", content: [{ type: "text", text: "$1,200" }] },
					{ type: "cell" },
					{ type: "cell" },
					{ type: "cell" },
				],
			},
			{
				type: "row",
				content: [
					{ type: "cell", content: [{ type: "text", text: "n/a" }] },
					{ type: "cell" },
					{ type: "cell" },
					{ type: "cell" },
				],
			},
		],
	};
	const number = setKind(t, 0, "number");
	assert.deepEqual(number.content![0]!.content[0], { type: "cell", attrs: { value: 1200 } });
	assert.deepEqual(number.content![1]!.content[0], { type: "cell" }, "text that is no number clears");
	assert.equal(tableIssue(number), null);
	const money = setKind(number, 0, "money");
	assert.equal(money.content![0]!.content[0]!.attrs?.value, 1200);
	const text = setKind(money, 0, "text");
	assert.equal(
		text.content![0]!.content[0]!.content![0] && (text.content![0]!.content[0]!.content![0] as { text: string }).text,
		"$1,200",
	);
	assert.deepEqual(setKind(money, 0, "check").content![0]!.content[0], { type: "cell" });
	assert.equal(tableIssue(setKind(money, 0, "index")), null);
});

test("a column a formula reads, and a budget's last text column, cannot be removed or change kind", () => {
	const t = budgetTemplate();
	const reads = availability(t, { row: 1, col: 1 });
	assert.equal(reads.removeColumn, 'The "Annual" column reads this column.');
	assert.equal(reads.kind, 'The "Annual" column reads this column.');
	const labels = availability(t, { row: 1, col: 0 });
	assert.match(labels.removeColumn ?? "", /keeps one text column/);
	const formula = availability(t, { row: 1, col: 2 });
	assert.equal(formula.kind, "A formula column keeps its kind.");
	assert.equal(formula.removeColumn, null);
	assert.equal(tableIssue(removeColumn(t, 2)), null);
	// A column added inside a formula's sum range would join the sum: the control says so.
	const summed: TableNode = {
		...newGrid(),
		attrs: {
			...newGrid().attrs,
			columns: [
				{ id: "a", label: "A", type: "number", width: 0 },
				{ id: "b", label: "B", type: "number", width: 0 },
				{ id: "c", label: "C", type: "formula", formula: "sum(a:b)", width: 0 },
			],
		},
	};
	assert.match(availability(summed, { row: null, col: 0 }).addColumnRight ?? "", /adds up a range/);
});

test("a line item goes before its category total, a category before the grand total, and a sign is its own control", () => {
	const t = budgetTemplate();
	const other = (t.content ?? []).findIndex(
		(r) => r.content[0]?.content?.[0] && (r.content[0].content[0] as { text: string }).text === "Other income",
	);
	const item = addLineItem(t, other);
	assert.equal(roles(item)[other + 1], "item");
	assert.equal(roles(item)[other + 2], "subtotal");
	const next = addCategory(t, other);
	// The new category sits right after Income's total and before the Expenses category.
	const group = roles(next).indexOf("group", other);
	assert.deepEqual(roles(next).slice(group, group + 4), ["group", "item", "subtotal", "group"]);
	assert.equal(roles(next).at(-1), "total");
	assert.equal(tableIssue(next), null);
	const signed = setSign(next, group, "subtract");
	assert.equal(signed.content![group]!.attrs?.sign, "subtract");
	assert.equal(computeTable(signed).at(-1)![1], computeTable(next).at(-1)![1]);
	const removed = removeCategory(next, group);
	assert.deepEqual(removed.content, t.content);
	const single = newBudget();
	assert.equal(availability(single, { row: 1, col: 0 }).removeCategory, "A budget's only category cannot be removed.");
	assert.equal(categoryAt(single, 3), null, "the grand total belongs to no category");
});

test("the table view numbers rows and stripes as the PDF does: blank rows count on after the typed ones", () => {
	const t = newGrid();
	t.attrs.zebra = true;
	t.attrs.columns[0] = { id: "no", label: "No.", type: "index", width: 30 };
	t.content = [
		{ type: "row", content: [{ type: "cell" }, { type: "cell" }, { type: "cell" }] },
		{ type: "row", content: [{ type: "cell" }, { type: "cell" }, { type: "cell" }] },
	];
	assert.deepEqual(
		tableView(t).map((r) => [r.stripe, r.shown[0]]),
		[
			[false, "1"],
			[true, "2"],
		],
	);
	assert.deepEqual(blankRows(t), [
		{ index: 3, stripe: false },
		{ index: 4, stripe: true },
		{ index: 5, stripe: false },
		{ index: 6, stripe: true },
		{ index: 7, stripe: false },
	]);
	assert.equal(
		blankRows({ ...t, attrs: { ...t.attrs, source: "names" } }).length,
		0,
		"a table that reads a list has no blank rows",
	);
});
