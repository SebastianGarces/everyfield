// WP-036 criteria 8 and 9: the Word file and the ledger workbook are tree walkers over the same document as the PDF.
// LibreOffice headless opens each file independently of the writers; the tests skip that step when it is missing.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { PDFCheckBox, PDFDocument } from "../../../packages/domain/node_modules/pdf-lib/cjs/index.js";
import {
	computeTable,
	docDocument,
	exportsFor,
	forkTemplate,
	ledgerTables,
	type BlockNode,
	type DocDocument,
	type InlineNode,
	type TableNode,
} from "../../../packages/contracts/src/documents/format/index.ts";
import { docFormats, renderDocFile } from "../../../packages/domain/src/documents/doc-render.ts";
import { docTemplateById } from "../../../packages/domain/src/documents/doc-templates.ts";
import { fieldValues } from "../../../packages/domain/src/documents/doc-values.ts";
import { makePalette, NEUTRAL_THEME } from "../../../packages/domain/src/documents/theme.ts";
import { buildLedgerWorkbook } from "../../../packages/domain/src/documents/xlsx.ts";
import {
	addCategory,
	addColumn,
	addLineItem,
	newBudget,
	removeColumn,
	removeRow,
	setSign,
} from "../../../apps/web/src/features/documents/church/editor/table-ops.ts";
import { docxParts, hasSoffice, pdfOperators, pdfPages, sofficeToPdf, wordText } from "./fixtures/readers.mts";

const THEME = {
	render: NEUTRAL_THEME,
	fonts: { heading: "DM Serif Display", body: "DM Sans" },
	kind: "everyfield-neutral" as const,
	primary: null,
};
const SAVED = new Date("2026-11-01T12:00:00Z");
const DATA = { church_name: "Harbor City Church", church_legal_name: "Harbor City Church, Inc." };
const fork = async (id: string) => forkTemplate(docTemplateById(id)!, { data: DATA });
const squash = (text: string) => text.replace(/\s+/g, " ").trim();
const soffice = hasSoffice();

/** The heading and paragraph texts of a body, with field values filled in, in reading order. */
function proseOf(doc: DocDocument) {
	const values = fieldValues(doc);
	const text = (content: readonly InlineNode[] | undefined) =>
		squash(
			(content ?? [])
				.map((n) => (n.type === "text" ? n.text : n.type === "field" ? values[n.attrs.key] : " "))
				.join(""),
		);
	const headings: string[] = [];
	const paragraphs: string[] = [];
	const walk = (nodes: readonly BlockNode[] | undefined) => {
		for (const node of nodes ?? []) {
			if (node.type === "heading") headings.push(text(node.content));
			if (node.type === "paragraph" && node.attrs?.style !== "kicker") paragraphs.push(text(node.content));
			if (node.type === "bulletList" || node.type === "orderedList" || node.type === "quote")
				for (const child of node.content)
					for (const p of "content" in child && child.type === "listItem" ? child.content : [child])
						if (p.type === "paragraph") paragraphs.push(text(p.content));
			if (node.type === "columns") for (const col of node.content) walk(col.content);
		}
	};
	walk(doc.body.content);
	return { headings: headings.filter(Boolean), paragraphs: paragraphs.filter(Boolean) };
}

// pdf.js joins text items with a space, so a shaded placeholder run reads "[date] ." in LibreOffice's PDF.
const words = (text: string) =>
	squash(text)
		.replace(/[‐-―]/g, "-")
		.replace(/ ([.,;:])/g, "$1");

test(
	"AC:CASE-DOC-023 the Word file of the policy opens in LibreOffice with the PDF's headings and paragraph text",
	{ skip: !soffice && "LibreOffice is not installed" },
	async () => {
		const doc = await fork("conflict-of-interest-policy");
		const pdf = words((await pdfPages(await renderDocFile(doc, "pdf", THEME, SAVED))).join(" "));
		const docx = await renderDocFile(doc, "docx", THEME, SAVED);
		const converted = words((await pdfPages(sofficeToPdf(docx))).join(" "));
		const { headings, paragraphs } = proseOf(doc);
		assert.equal(headings.length, 10);
		assert.ok(paragraphs.length >= 15);
		for (const line of [...headings, ...paragraphs]) {
			assert.ok(pdf.includes(words(line)), `the PDF has "${line}"`);
			assert.ok(converted.includes(words(line)), `the Word file has "${line}"`);
		}
		assert.match(converted, /01 Purpose/);
		assert.match(converted, /Page 1 of 2/, "LibreOffice fills PAGE and NUMPAGES");
		assert.equal(
			converted.split("Template, not legal advice").length - 1,
			2,
			"the notice is in the footer of both pages",
		);
	},
);

test("AC:CASE-DOC-023 AC:CASE-DOC-019 the Word file has heading styles, a footer with PAGE and NUMPAGES, and the notice only for formal/legal", async () => {
	const policy = docxParts(await renderDocFile(await fork("conflict-of-interest-policy"), "docx", THEME, SAVED));
	const document = policy["word/document.xml"]!;
	assert.equal((document.match(/<w:pStyle w:val="Heading1"\/>/g) ?? []).length, 9, "nine numbered headings");
	assert.equal((document.match(/<w:pStyle w:val="Title"\/>/g) ?? []).length, 1);
	const footer = policy["word/footer1.xml"]!;
	assert.match(footer, /w:instr=" PAGE "/);
	assert.match(footer, /w:instr=" NUMPAGES "/);
	assert.match(
		wordText(footer),
		/Harbor City Church, Inc\. \| Conflict of Interest Policy Page 1 of 1 Template, not legal advice/,
	);
	assert.match(document, /<w:footerReference w:type="default" r:id="rId\d+"\/>/);

	const sign = docxParts(await renderDocFile(await fork("guest-sign-in-sheet"), "docx", THEME, SAVED));
	assert.ok(!wordText(sign["word/footer1.xml"]!).includes("Template, not legal advice"));
	assert.match(sign["word/footer1.xml"]!, /w:instr=" NUMPAGES "/);

	// A wiped formal/legal fork still has the notice in its Word footer.
	const wiped = await fork("conflict-of-interest-policy");
	wiped.body = { type: "doc", content: [] };
	wiped.page.footer = null;
	const parts = docxParts(await renderDocFile(docDocument.parse(wiped), "docx", THEME, SAVED));
	assert.equal(wordText(parts["word/footer1.xml"]!), "Template, not legal advice");

	// A "first" footer and a "rest" header use Word's different-first-page setting.
	const split = await fork("conflict-of-interest-policy");
	split.page.header = {
		pages: "rest",
		content: [{ type: "paragraph", content: [{ type: "text", text: "Continued" }] }],
	};
	split.page.footer = {
		pages: "first",
		content: [{ type: "paragraph", content: [{ type: "text", text: "First only" }] }],
	};
	const splitParts = docxParts(await renderDocFile(docDocument.parse(split), "docx", THEME, SAVED));
	assert.match(splitParts["word/document.xml"]!, /<w:titlePg\/>/);
	assert.equal(wordText(splitParts["word/header1.xml"]!), "Continued");
	assert.equal(wordText(splitParts["word/header2.xml"]!), "");
	assert.equal(wordText(splitParts["word/footer1.xml"]!), "Template, not legal advice");
	assert.equal(wordText(splitParts["word/footer2.xml"]!), "First only Template, not legal advice");

	const again = await renderDocFile(await fork("conflict-of-interest-policy"), "docx", THEME, SAVED);
	assert.deepEqual(again, await renderDocFile(await fork("conflict-of-interest-policy"), "docx", THEME, SAVED));
});

test(
	"AC:CASE-DOC-004 AC:CASE-DOC-006 the card sheet opens in LibreOffice as one sheet and the sign-in sheet with its headings",
	{ skip: !soffice && "LibreOffice is not installed" },
	async () => {
		for (const id of ["commitment-card", "guest-sign-in-sheet"]) {
			const doc = await fork(id);
			const pages = await pdfPages(sofficeToPdf(await renderDocFile(doc, "docx", THEME, SAVED)));
			assert.equal(pages.length, id === "commitment-card" ? 1 : 2, id);
			for (const heading of proseOf(doc).headings)
				assert.ok(words(pages.join(" ")).includes(words(heading)), `${id}: ${heading}`);
		}
	},
);

/** The budget fork with an amount in every line item: 100.5, 200.5, ... */
async function seededBudget() {
	const doc = await fork("budget-worksheet");
	const table = ledgerTables(doc.body)[0]!;
	let n = 0;
	for (const row of table.content!)
		if ((row.attrs?.role ?? "item") === "item") row.content[1] = { type: "cell", attrs: { value: 100 * ++n + 0.5 } };
	return { doc: docDocument.parse(doc), table };
}

function sheetsOf(xlsx: Uint8Array) {
	const parts = docxParts(xlsx);
	return {
		workbook: parts["xl/workbook.xml"]!,
		sheets: Object.keys(parts)
			.filter((name) => /^xl\/worksheets\/sheet\d+\.xml$/.test(name))
			.sort()
			.map((name) => parts[name]!),
	};
}

test("AC:CASE-DOC-013 the ledger workbook has typed inputs, live formulas and SUM totals with fullCalcOnLoad", async () => {
	const { doc } = await seededBudget();
	const { workbook, sheets } = sheetsOf(await renderDocFile(doc, "xlsx", THEME, SAVED));
	assert.match(workbook, /<calcPr calcId="\d+" fullCalcOnLoad="1"\/>/);
	assert.match(workbook, /<sheet name="Budget worksheet" sheetId="1"/);
	assert.equal(sheets.length, 1);
	const sheet = sheets[0]!;
	assert.match(sheet, /<c r="B5" s="\d+"><v>100\.5<\/v><\/c>/, "a money input is a cell with its typed amount");
	assert.match(sheet, /<c r="C5" s="\d+"><f>\(B5\*12\)<\/f><\/c>/, "the formula column is an Excel formula in the row");
	assert.match(sheet, /<c r="B10" s="\d+"><f>SUM\(B5:B9\)<\/f><\/c>/, "the subtotal is a SUM over its category");
	assert.match(sheet, /<c r="B23" s="\d+"><f>B10-B22<\/f><\/c>/, "the total adds each category with its sign");

	// Two ledger tables give two sheets; a document without one offers no Excel and refuses to make one.
	const two = structuredClone(doc);
	const copy = structuredClone(ledgerTables(two.body)[0]!) as TableNode;
	copy.attrs.sheet = "Second budget";
	two.body.content!.push(copy);
	assert.equal(sheetsOf(await renderDocFile(docDocument.parse(two), "xlsx", THEME, SAVED)).sheets.length, 2);
	assert.deepEqual(docFormats(doc), ["pdf", "docx", "xlsx"]);
	const policy = await fork("conflict-of-interest-policy");
	assert.deepEqual(docFormats(policy), ["pdf", "docx"]);
	await assert.rejects(() => renderDocFile(policy, "xlsx", THEME, SAVED), /render_failed/);
});

test("AC:CASE-DOC-023 docFormats offers the export list as the body corrects it: Excel only with a ledger table, nothing it omits", async () => {
	const budget = await fork("budget-worksheet");
	assert.deepEqual(docFormats(budget), ["pdf", "docx", "xlsx"], "a ledger body offers Excel, in a fixed order");
	const policy = await fork("conflict-of-interest-policy");
	assert.deepEqual(
		docFormats({ ...policy, exports: ["pdf", "docx", "xlsx"] }),
		["pdf", "docx"],
		"a body with no ledger table never offers Excel, whatever its list says",
	);
	assert.deepEqual(docFormats({ ...budget, exports: ["pdf", "xlsx"] }), ["pdf", "xlsx"], "Word stays off when omitted");
	assert.deepEqual(docFormats({ ...budget, exports: ["pdf"] }), ["pdf", "xlsx"], "a ledger table adds Excel");
	assert.deepEqual(docFormats({ ...policy, exports: ["docx"] }), ["docx"]);
	await assert.rejects(() => renderDocFile({ ...policy, exports: ["docx"] }, "pdf", THEME, SAVED), /render_failed/);
});

test(
	"AC:CASE-DOC-013 LibreOffice recalculates the seeded budget workbook to the totals computeTable gives",
	{ skip: !soffice && "LibreOffice is not installed" },
	async () => {
		const { doc, table } = await seededBudget();
		const xlsx = await renderDocFile(doc, "xlsx", THEME, SAVED);
		const dir = mkdtempSync(join(tmpdir(), "wp036-xlsx-"));
		writeFileSync(join(dir, "budget.xlsx"), xlsx);
		execFileSync(
			"soffice",
			[
				"--headless",
				`-env:UserInstallation=file://${dir}/profile`,
				"--convert-to",
				"csv",
				"--outdir",
				dir,
				join(dir, "budget.xlsx"),
			],
			{
				stdio: "ignore",
				timeout: 120_000,
			},
		);
		const csv = readFileSync(join(dir, "budget.csv"), "utf8")
			.trim()
			.split("\n")
			.map((line) => line.split(","));
		const expected = computeTable(table);
		const rows = table.content!;
		assert.equal(csv.length, 3 + rows.length);
		rows.forEach((row, ri) => {
			const role = row.attrs?.role ?? "item";
			if (role === "group") return;
			const cells = csv[3 + ri]!;
			assert.equal(Number(cells[1]), expected[ri]![1], `row ${ri + 1} monthly`);
			assert.equal(Number(cells[2]), expected[ri]![2], `row ${ri + 1} annual`);
		});
		assert.deepEqual(csv.at(-1), ["Net (income minus expenses)", "-9002.5", "-108030"]);
		assert.deepEqual(expected.at(-1), [null, -9002.5, -108030]);
	},
);

test("AC:CASE-DOC-023 the PDF paints a fill under each bracketed placeholder and the Word file shades its run", async () => {
	const doc = await fork("conflict-of-interest-policy");
	// A placeholder in a field value prints highlighted too; text outside the brackets does not.
	doc.body.content.push({
		type: "paragraph",
		content: [{ type: "text", text: "Approved for [low amount] to [high amount], not [] or a [bracket" }],
	});
	const pdf = await renderDocFile(doc, "pdf", THEME, SAVED);
	const { findTextRegions } = await import("../../../packages/domain/node_modules/@formepdf/core/dist/index.js");
	const found = await findTextRegions(pdf, [{ pattern: "\\[[^\\[\\]\\n]{1,60}\\]", pattern_type: "Regex" }]);
	assert.equal(found.length, 4, "[number], [date], [low amount] and [high amount]");
	// Each fill is an artifact rectangle in multiply blend, so the text above it keeps its own ink.
	// Each fill is an artifact in the placeholder color (#FDF0A6), painted through a graphics state (the multiply blend).
	const ops = await pdfOperators(pdf);
	const fills = ops.match(/\/Artifact BMC\nq\n\/GS-\d+ gs\n0\.992\d* 0\.941\d* 0\.650\d* rg/g) ?? [];
	assert.equal(fills.length, 4, "one fill for each placeholder");
	assert.match(ops, /\/BM \/Multiply/, "the fills multiply, so the text above keeps its ink");
	const xml = docxParts(await renderDocFile(doc, "docx", THEME, SAVED))["word/document.xml"];
	const shaded = [
		...xml.matchAll(
			/<w:shd w:val="clear" w:color="auto" w:fill="FDF0A6"\/><\/w:rPr><w:t xml:space="preserve">([^<]*)<\/w:t>/g,
		),
	].map((m) => m[1]);
	assert.deepEqual(shaded, ["[number]", "[date]", "[low amount]", "[high amount]"]);
});

/**
 * The values a sheet's cells compute: typed values, and formulas of cell refs, SUM over ranges, IF and arithmetic,
 * which is all the ledger writer emits. An empty cell is 0. A division by zero is #DIV/0!, as Excel shows it.
 */
function computedCells(sheet: string) {
	const cells = new Map<string, { v?: number; f?: string }>();
	for (const [, ref, body] of sheet.matchAll(/<c r="([A-Z]+\d+)"[^>]*?(?:\/>|>(.*?)<\/c>)/g)) {
		const f = /<f>(.*?)<\/f>/.exec(body ?? "")?.[1];
		const v = /<v>(.*?)<\/v>/.exec(body ?? "")?.[1];
		cells.set(ref!, f ? { f: f.replaceAll("&amp;", "&") } : v !== undefined ? { v: Number(v) } : {});
	}
	const value = (ref: string): number => {
		const cell = cells.get(ref);
		if (!cell?.f) return cell?.v ?? 0;
		const js = cell.f
			.replace(/([A-Z]+)(\d+):\1(\d+)/g, (_, col, a, b) => `range("${col}",${a},${b})`)
			.replace(/\b([A-Z]+\d+)\b/g, (_, r) => `cell("${r}")`)
			.replace(/\bSUM\(/g, "sum(")
			.replace(/\bIF\(/g, "iff(")
			.replace(/=/g, "===");
		const range = (col: string, a: number, b: number) =>
			Array.from({ length: b - a + 1 }, (_, i) => value(`${col}${a + i}`));
		const sum = (...parts: (number | number[])[]) => parts.flat().reduce((s, n) => s + n, 0);
		const iff = (c: boolean, yes: number, no: number) => (c ? yes : no);
		const out = new Function("cell", "range", "sum", "iff", `return ${js};`)(value, range, sum, iff) as number;
		if (!Number.isFinite(out)) throw new Error(`#DIV/0! in ${ref}: ${cell.f}`);
		return out;
	};
	return { formula: (ref: string) => cells.get(ref)?.f, value };
}

/** The budget fork with its ledger rows replaced by `rows`: [role, label, monthly]. */
async function budgetWith(rows: [string, string, number | null][], columns?: TableNode["attrs"]["columns"]) {
	const doc = await fork("budget-worksheet");
	const table = ledgerTables(doc.body)[0]!;
	if (columns) table.attrs.columns = columns;
	table.content = rows.map(([role, label, ...values]) => ({
		type: "row",
		...(role === "item" ? {} : { attrs: role === "group" ? { role, sign: "add" } : { role } }),
		content: [
			{ type: "cell", content: [{ type: "text", text: label }] },
			...table.attrs.columns
				.slice(1)
				.map((c, i) =>
					c.type === "formula" || role !== "item"
						? { type: "cell", content: [] }
						: { type: "cell", attrs: { value: values[i] ?? null }, content: [] },
				),
		],
	})) as TableNode["content"];
	return { doc: docDocument.parse(doc), table: ledgerTables(docDocument.parse(doc).body)[0]! };
}

test("AC:CASE-DOC-013 a subtotal after a second run of items sums only item rows, as computeTable does", async () => {
	const { doc, table } = await budgetWith([
		["group", "Income", null],
		["item", "Tithes", 7],
		["subtotal", "Subtotal so far", null],
		["item", "Grants", 50],
		["subtotal", "Total income", null],
		["total", "Total", null],
	]);
	const sheet = sheetsOf(await renderDocFile(doc, "xlsx", THEME, SAVED)).sheets[0]!;
	const cells = computedCells(sheet);
	// Rows 1 and 2 are the title and note, row 3 the header: the table's rows start at row 4.
	const subtotals = [6, 8];
	assert.equal(cells.formula("B8"), "SUM(B5:B5,B7:B7)");
	assert.equal(cells.value("B8"), 57);
	assert.equal(cells.value("B8"), computeTable(table)[4]![1]);
	assert.equal(cells.value("C8"), 57 * 12);
	assert.equal(cells.value("B9"), 57, "the total adds the whole category once");
	assert.equal(cells.value("B9"), computeTable(table)[5]![1]);
	for (const [, f] of sheet.matchAll(/<f>(.*?)<\/f>/g))
		for (const [, a, b] of f!.matchAll(/[A-Z]+(\d+):[A-Z]+(\d+)/g))
			for (const s of subtotals) assert.ok(!(Number(a) <= s && s <= Number(b)), `${f} spans the subtotal row ${s}`);
});

test("AC:CASE-DOC-013 a workbook division by a zero or empty divisor shows 0, as evalTree gives", async () => {
	const { doc, table } = await budgetWith(
		[
			["group", "Costs", null, null],
			["item", "Zero", 10, 0],
			["item", "Empty", 10, null],
			["item", "Four", 10, 4],
		] as never,
		[
			{ id: "category", label: "Category", type: "text", width: 0 },
			{ id: "amount", label: "Amount", type: "money", width: 110, align: "right" },
			{ id: "count", label: "Count", type: "number", width: 110, align: "right" },
			{
				id: "each",
				label: "Each",
				type: "formula",
				formula: "amount / count",
				format: "money",
				width: 110,
				align: "right",
			},
		] as never,
	);
	const cells = computedCells(sheetsOf(await renderDocFile(doc, "xlsx", THEME, SAVED)).sheets[0]!);
	assert.equal(cells.formula("D5"), "IF((C5)=0,0,(B5)/(C5))");
	const computed = computeTable(table);
	assert.deepEqual(
		[5, 6, 7].map((row) => cells.value(`D${row}`)),
		[1, 2, 3].map((ri) => computed[ri]![3]),
	);
	assert.deepEqual(
		[5, 6, 7].map((row) => cells.value(`D${row}`)),
		[0, 0, 2.5],
	);
});

const textOf = (cell: any) => (cell?.content ?? []).map((n: any) => n.text ?? "").join("");
const textCell = (text: string) => ({ type: "cell", content: [{ type: "text", text }] });
/** The text of one cell of a sheet: its inline string runs. */
function sheetText(sheet: string, ref: string) {
	const body = new RegExp(`<c r="${ref}"[^>]*?(?:/>|>(.*?)</c>)`, "s").exec(sheet)?.[1] ?? "";
	return [...body.matchAll(/<t[^>]*>(.*?)<\/t>/gs)].map((m) => m[1]!.replaceAll("&amp;", "&")).join("");
}

/** The first sheet of an edited ledger: the title above it, its header labels, each label and each computed number. */
function editedSheet(xlsx: Uint8Array, table: TableNode, title: string) {
	const sheet = sheetsOf(xlsx).sheets[0]!;
	const cells = computedCells(sheet);
	const col = (ci: number) => String.fromCharCode(65 + ci);
	const expected = computeTable(table);
	assert.equal(sheetText(sheet, "A1"), title, "the sheet opens with the edited heading");
	assert.deepEqual(
		table.attrs.columns.map((_, ci) => sheetText(sheet, `${col(ci)}3`)),
		table.attrs.columns.map((c) => c.label),
		"the header row holds the saved column labels",
	);
	const rows = table.content!;
	rows.forEach((row, ri) => {
		const role = row.attrs?.role ?? "item";
		table.attrs.columns.forEach((c, ci) => {
			const ref = `${col(ci)}${4 + ri}`;
			if (c.type === "text") assert.equal(sheetText(sheet, ref), textOf(row.content[ci]), ref);
			else if (role !== "group" && expected[ri]![ci] !== null)
				assert.ok(Math.abs(cells.value(ref) - expected[ri]![ci]!) < 1e-9, `${ref} is ${expected[ri]![ci]}`);
		});
	});
	assert.doesNotMatch(sheet, new RegExp(`<row r="${4 + rows.length}"`), "no row after the table's last");
	return { sheet, cells, last: 3 + rows.length };
}

test("AC:CASE-DOC-013 a forked budget, edited, gives an Excel file with the edits and computed totals; so does a budget in a blank document", async () => {
	const doc: any = await forkTemplate(docTemplateById("budget-worksheet")!, { data: { church_name: "Harvest Point" } });
	doc.body.content[0].content[1].text += " 2027";
	let t = ledgerTables(doc.body)[0]!;
	const at = (label: string) => t.content!.findIndex((r) => textOf(r.content[0]) === label);
	const put = (ri: number, ci: number, cell: unknown) => ((t.content![ri]!.content as unknown[])[ci] = cell);
	put(at("Tithes and offerings"), 1, { type: "cell", attrs: { value: 3000 } });
	put(at("Pastor and staff pay"), 1, { type: "cell", attrs: { value: 1500 } });
	t = addLineItem(t, at("Other income"));
	put(at("Other income") + 1, 0, textCell("Online giving"));
	put(at("Online giving"), 1, { type: "cell", attrs: { value: 500 } });
	t = removeRow(t, at("Grants"));
	t = addCategory(t, at("Total expenses"));
	const group = at("Category");
	put(group, 0, textCell("Missions"));
	put(group + 1, 0, textCell("Church plant fund"));
	put(group + 1, 1, { type: "cell", attrs: { value: 250.5 } });
	t = setSign(t, group, "subtract");
	t = addColumn(t, 2);
	t.attrs.columns[2]!.label = "Notes";
	put(1, 2, textCell("weekly"));
	t = removeColumn(t, 3);
	doc.body.content[doc.body.content.findIndex((n: any) => n.type === "table")] = t;
	const edited = docDocument.parse(doc);
	const table = ledgerTables(edited.body)[0]!;
	assert.deepEqual(
		table.attrs.columns.map((c) => c.label),
		["Category", "Monthly", "Notes"],
	);
	const forked = editedSheet(
		await renderDocFile(edited, "xlsx", THEME, SAVED),
		table,
		"Harvest Point Budget Worksheet 2027",
	);
	assert.ok(!forked.sheet.includes(">Grants<"), "the removed line item is gone");
	assert.equal(sheetText(forked.sheet, "C5"), "weekly");
	// The new category subtracts: the net is income minus expenses minus missions.
	assert.equal(forked.cells.value(`B${forked.last}`), 3000 + 500 - 1500 - 250.5);

	// Insert -> Budget table in a blank document, with a second category that subtracts and a text column at the left.
	const blank: any = await fork("guest-sign-in-sheet");
	let b = newBudget();
	const putB = (ri: number, ci: number, cell: unknown) => ((b.content![ri]!.content as unknown[])[ci] = cell);
	putB(1, 0, textCell("Offerings"));
	putB(1, 1, { type: "cell", attrs: { value: 1200.25 } });
	b = addLineItem(b, 1);
	putB(2, 0, textCell("Grants"));
	putB(2, 1, { type: "cell", attrs: { value: 800 } });
	b = addCategory(b, 3);
	putB(4, 0, textCell("Costs"));
	putB(5, 0, textCell("Rent"));
	putB(5, 1, { type: "cell", attrs: { value: 900 } });
	b = setSign(b, 4, "subtract");
	b = addColumn(b, 1);
	b.attrs.columns[1]!.label = "Who";
	blank.body = {
		type: "doc",
		content: [{ type: "heading", attrs: { level: 1 }, content: [{ type: "text", text: "Quarter plan" }] }, b],
	};
	blank.exports = exportsFor(blank.exports, blank.body);
	const inserted = docDocument.parse(blank);
	const plan = editedSheet(
		await renderDocFile(inserted, "xlsx", THEME, SAVED),
		ledgerTables(inserted.body)[0]!,
		"Quarter plan",
	);
	assert.ok(Math.abs(plan.cells.value(`C${plan.last}`) - (1200.25 + 800 - 900)) < 1e-9, "the money is in column C");
});

test("AC:CASE-DOC-023 the PDF and the Word file print a budget's totals rounded to cents: 0.20 + 0.70 + 0.10 is $1", async () => {
	const doc = await fork("budget-worksheet");
	const table = ledgerTables(doc.body)[0]!;
	for (const [label, value] of [
		["Tithes and offerings", 0.2],
		["Sending church support", 0.7],
		["Network or denominational support", 0.1],
	] as const)
		(table.content!.find((r) => textOf(r.content[0]) === label)!.content as unknown[])[1] = {
			type: "cell",
			attrs: { value },
		};
	const parsed = docDocument.parse(doc);
	const pdf = squash((await pdfPages(await renderDocFile(parsed, "pdf", THEME, SAVED))).join(" "));
	const word = wordText(docxParts(await renderDocFile(parsed, "docx", THEME, SAVED))["word/document.xml"]!);
	for (const [label, text] of [
		["PDF", pdf],
		["Word", word],
	]) {
		assert.match(text!, /Total income \$1 \$12\b/, `${label} prints the rounded total`);
		assert.doesNotMatch(text!, /\$0\.\d{3}|0000/, `${label} prints no float residue`);
	}
});

// ---------------------------------------------------------------- Excel shows what the table shows

const palette = makePalette(NEUTRAL_THEME);
/** The Excel file of a document, as the download route builds it. */
const renderXlsx = (doc: DocDocument) => buildLedgerWorkbook(doc, fieldValues(doc), NEUTRAL_THEME);

async function budgetDoc(change: (table: any, items: any[]) => void) {
	const doc = await forkTemplate(docTemplateById("budget-worksheet")!, { data: { church_name: "Harbor City Church" } });
	const table: any = doc.body.content!.find((n) => n.type === "table");
	const items = table.content.filter((r: any) => (r.attrs?.role ?? "item") === "item");
	change(table, items);
	return docDocument.parse(doc);
}

/** Reads a workbook: each part, the number formats, and the style of every cell by reference. */
function workbook(bytes: Uint8Array) {
	const parts = docxParts(bytes);
	const styles = parts["xl/styles.xml"]!;
	const formats = new Map(
		[...styles.matchAll(/<numFmt numFmtId="(\d+)" formatCode="([^"]*)"/g)].map((m) => [
			m[1],
			m[2]!.replaceAll("&quot;", '"'),
		]),
	);
	const fills = [...styles.match(/<fills[^>]*>(.*?)<\/fills>/s)![1]!.matchAll(/<fill>(.*?)<\/fill>/gs)].map(
		(m) => /rgb="FF([0-9A-F]{6})"/.exec(m[1]!)?.[1] ?? null,
	);
	const xfs = [...styles.match(/<cellXfs[^>]*>(.*?)<\/cellXfs>/s)![1]!.matchAll(/<xf ([^>]*?)\/?>/g)].map((m) => ({
		numFmt: /numFmtId="(\d+)"/.exec(m[1]!)![1],
		fill: /fillId="(\d+)"/.exec(m[1]!)![1],
	}));
	const sheet = (n = 1) => parts[`xl/worksheets/sheet${n}.xml`]!;
	const style = (ref: string, n: number) => new RegExp(`<c r="${ref}" s="(\\d+)"`).exec(sheet(n))?.[1];
	return {
		sheets: Object.keys(parts).filter((k) => /^xl\/worksheets\/sheet\d+\.xml$/.test(k)).length,
		names: [...parts["xl/workbook.xml"]!.matchAll(/<sheet name="([^"]*)"/g)].map((m) => m[1]),
		format: (ref: string, n = 1) => {
			const s = style(ref, n);
			return s === undefined ? null : (formats.get(xfs[Number(s)]!.numFmt) ?? "General");
		},
		fill: (ref: string, n = 1) => {
			const s = style(ref, n);
			return s === undefined ? null : fills[Number(xfs[Number(s)]!.fill)];
		},
		cell: (ref: string, n = 1) => new RegExp(`<c r="${ref}"[^>]*?(?:/>|>(.*?)</c>)`, "s").exec(sheet(n))?.[0] ?? null,
	};
}

test("AC:CASE-DOC-013 Excel shows cents, no dollar sign on a number column, ticks, the header fill, the stripes and a sheet for each table", async () => {
	// Rows of the budget worksheet: row 3 is the header, 4 the first group, 5 and 6 the first two line items.
	const build = async (change: (table: any, items: any[]) => void) => workbook(renderXlsx(await budgetDoc(change)));
	const set = (items: any[], values: number[]) =>
		items.forEach((r, i) => (r.content[1] = { type: "cell", attrs: { value: values[i] ?? null } }));

	// A money column with cents shows them in its amounts and its totals; one with whole amounts shows none.
	const cents = await build((t, items) => set(items, [100.55, 200]));
	assert.match(cents.format("B5")!, /^"\$"#,##0\.00/, "an amount with cents shows the cents");
	assert.match(
		cents.format("B6")!,
		/^"\$"#,##0\.00/,
		"the whole amount beside it shows them too: one format for the column",
	);
	assert.match(cents.format("B10")!, /^"\$"#,##0\.00/, "the category total shows cents");
	assert.match(cents.format("B23")!, /^"\$"#,##0\.00/, "the grand total shows cents");
	assert.match(cents.format("C5")!, /^"\$"#,##0\.00/, "the formula column of a money column shows cents");
	const whole = await build((t, items) => set(items, [100, 200]));
	for (const ref of ["B5", "B10", "B23", "C5"])
		assert.match(whole.format(ref)!, /^"\$"#,##0(;|$)/, `${ref} shows no cents`);
	assert.doesNotMatch(whole.format("B5")!, /0\.00/);

	// A number column shows no dollar sign, in its cells and its totals.
	const number = await build((t, items) => {
		t.attrs.columns[1].type = "number";
		set(items, [100, 2.5]);
	});
	for (const ref of ["B5", "B6", "B10", "B23"])
		assert.doesNotMatch(number.format(ref)!, /\$/, `${ref} shows no dollar sign`);
	assert.match(number.format("B6")!, /#,##0\.0/, "a number with decimals keeps them");

	// A ticked check cell shows ticked; an unticked one shows empty.
	const checks = await build((t, items) => {
		t.attrs.columns.push({ id: "paid", label: "Paid", type: "check", width: 40 });
		t.content.forEach((row: any) => row.content.push({ type: "cell" }));
		items[0].content[3] = { type: "cell", attrs: { checked: true } };
		items[1].content[3] = { type: "cell", attrs: { checked: false } };
	});
	assert.match(checks.cell("D5")!, /☒/, "a ticked cell shows ticked");
	assert.doesNotMatch(checks.cell("D6")!, /<t[ >]|<v>/, "an unticked cell shows empty");

	// The header row uses the table's fill; striped rows are shaded on the rows the PDF shades.
	const striped = await build((t) => {
		t.attrs.headerFill = "accent";
		t.attrs.zebra = true;
	});
	assert.equal(striped.fill("A3"), palette.accent.replace("#", "").toUpperCase(), "the header takes headerFill");
	assert.equal(striped.fill("A5"), null, "the first line item is not striped");
	assert.equal(striped.fill("A6"), palette.muted.replace("#", "").toUpperCase(), "the second line item is striped");
	assert.equal(striped.fill("A7"), null, "the third is not");
	const plain = await build((t) => (t.attrs.zebra = false));
	assert.equal(plain.fill("A6"), null, "with stripes off no line item is shaded");
	const noFill = await build((t) => (t.attrs.headerFill = "none"));
	assert.equal(noFill.fill("A3"), null, "headerFill none paints no fill");

	// Two budget tables give two sheets with different names; `sheet` names each one.
	const twoTables = async (first: string, second: string) => {
		const doc = await budgetDoc((t) => (t.attrs.sheet = first));
		const copy: any = structuredClone(doc.body.content!.find((n) => n.type === "table"));
		copy.attrs.sheet = second;
		doc.body.content!.push(copy);
		return workbook(renderXlsx(docDocument.parse(doc)));
	};
	const two = await twoTables("Plan A", "Plan B");
	assert.equal(two.sheets, 2);
	assert.deepEqual(two.names, ["Plan A", "Plan B"]);
	const same = await twoTables("Plan", "PLAN");
	assert.equal(new Set(same.names.map((n) => n!.toLowerCase())).size, 2, "two sheets never share a name");
});

// ---------------------------------------------------------------- the PDF and the Word file

/** One body with every column kind, blank rows, a header color, stripes, checklist rows and a budget. */
async function everything() {
	const text = (s?: string) => (s ? textCell(s) : { type: "cell" });
	const grid = {
		type: "table",
		attrs: {
			style: "grid",
			header: true,
			headerFill: "accent",
			zebra: true,
			writeInRows: 3,
			columns: [
				{ id: "no", label: "No.", type: "index", width: 30 },
				{ id: "name", label: "Name", type: "text", width: 0 },
				{ id: "qty", label: "Qty", type: "number", width: 50 },
				{ id: "cost", label: "Cost", type: "money", width: 70 },
				{ id: "total", label: "Total", type: "formula", formula: "qty * cost", format: "money", width: 70 },
				{ id: "done", label: "Done", type: "check", width: 40 },
			],
		},
		content: [
			["Chairs", 4, 12.5, true],
			["Tables", 2, 80, false],
			["Banner", 1, 0.3, true],
		].map(([name, qty, cost, done]) => ({
			type: "row",
			content: [
				{ type: "cell" },
				text(name as string),
				{ type: "cell", attrs: { value: qty } },
				{ type: "cell", attrs: { value: cost } },
				{ type: "cell" },
				done ? { type: "cell", attrs: { checked: true } } : { type: "cell" },
			],
		})),
	};
	const checklist = {
		type: "table",
		attrs: {
			style: "rows",
			header: false,
			headerFill: "none",
			columns: [
				{ id: "ok", label: "Done", type: "check", width: 18 },
				{ id: "what", label: "Commitment", type: "text", width: 0 },
			],
		},
		content: [
			{ type: "row", content: [{ type: "cell", attrs: { checked: true } }, text("Pray every day")] },
			{ type: "row", content: [{ type: "cell" }, text("Serve once a month")] },
		],
	};
	const base: any = await fork("budget-worksheet");
	const budget = structuredClone(base.body.content.find((n: any) => n.type === "table"));
	budget.content[1].content[1] = { type: "cell", attrs: { value: 3000.5 } };
	budget.content[2].content[1] = { type: "cell", attrs: { value: 1200 } };
	const body = {
		type: "doc",
		content: [
			{ type: "heading", attrs: { level: 2 }, content: [{ type: "text", text: "Supplies" }] },
			grid,
			checklist,
			budget,
		],
	};
	return docDocument.parse({ ...base, exports: ["xlsx", "pdf", "docx"], body });
}

test("AC:CASE-DOC-023 the PDF and the Word file hold a table's text, numbers, row numbers, header labels and ticks", async () => {
	const doc = await everything();
	const pdfBytes = await renderDocFile(doc, "pdf", THEME, SAVED);
	const pdf = (await pdfPages(pdfBytes)).join(" ");
	const document = docxParts(await renderDocFile(doc, "docx", THEME, SAVED))["word/document.xml"]!;
	const word = wordText(document);
	const head = ["No.", "Name", "Qty", "Cost", "Total", "Done"];
	for (const [label, text] of [
		["PDF", pdf],
		["Word", word],
	] as const) {
		for (const h of head)
			assert.match(
				text.toLowerCase(),
				new RegExp(`\\b${h.toLowerCase().replace(".", "\\.")}`),
				`${label}: header ${h}`,
			);
		for (const piece of [
			...["Chairs", "Tables", "Banner"],
			// The typed inputs, then the row numbers and the computed totals, then the blank rows' numbers.
			...["4", "$12.50", "2", "$80", "1", "$0.30"],
			...["$50", "$160"],
			"Pray every day",
			"Serve once a month",
			"$3,000.50",
			"$4,200.50",
		])
			assert.ok(text.includes(piece), `${label} prints "${piece}"`);
		assert.match(
			text,
			/Banner 1 \$0\.30 \$0\.30\D*\b4\D*\b5\D*\b6\b/,
			`${label}: the blank rows count on after the typed rows`,
		);
	}

	// A ticked cell prints ticked and an unticked one prints empty. The PDF keeps the empty ones as form fields.
	const form = (await PDFDocument.load(pdfBytes)).getForm();
	const checks = form.getFields().filter((f) => f instanceof PDFCheckBox) as InstanceType<typeof PDFCheckBox>[];
	const names = form.getFields().map((f) => f.getName());
	assert.equal(new Set(names).size, names.length, "every form field has a unique name");
	// The grid has two ticked cells and the checklist one; the rest (one typed, three blank, one checklist) are empty fields.
	assert.equal(checks.filter((c) => c.isChecked()).length, 3, "the PDF prints three ticked boxes");
	assert.ok(checks.filter((c) => !c.isChecked()).length >= 5, "the unticked and blank boxes stay fillable fields");
	assert.ok(names.filter((n) => /^row_\d+_/.test(n)).length >= 3 * 2, "the blank rows keep fillable fields");
	assert.equal((word.match(/☒/g) ?? []).length, 3, "the Word file prints three ticked boxes");
	assert.ok((word.match(/☐/g) ?? []).length >= 5, "the Word file prints the unticked boxes empty");
	// One Word row for the header, each typed row and each blank row of the grid, the checklist and the budget.
	const wordRows = (document.match(/<w:tr[ >]/g) ?? []).length;
	assert.ok(wordRows >= 1 + 3 + 3 + 2 + 20, `the Word tables hold the typed rows and the blank rows (${wordRows})`);
});
