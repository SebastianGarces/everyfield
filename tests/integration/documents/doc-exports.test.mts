// WP-036 criteria 8 and 9: the Word file and the ledger workbook are tree walkers over the same document as the PDF.
// LibreOffice headless opens each file independently of the writers; the tests skip that step when it is missing.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
	computeTable,
	docDocument,
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
import { NEUTRAL_THEME } from "../../../packages/domain/src/documents/theme.ts";
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
	"WP-036 the Word file of the policy opens in LibreOffice with the PDF's headings and paragraph text",
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

test("WP-036 the Word file has heading styles, a footer with PAGE and NUMPAGES, and the notice only for formal/legal", async () => {
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
	"WP-036 the card sheet opens in LibreOffice as one sheet and the sign-in sheet with its headings",
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

test("WP-036 the ledger workbook has typed inputs, live formulas and SUM totals with fullCalcOnLoad", async () => {
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

test(
	"WP-036 LibreOffice recalculates the seeded budget workbook to the totals computeTable gives",
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

test("AC:DOC-EDIT-PLACEHOLDERS the PDF paints a fill under each bracketed placeholder and the Word file shades its run", async () => {
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

test("documents/doc-6 a subtotal after a second run of items sums only item rows, as computeTable does", async () => {
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

test("documents/doc-22 a workbook division by a zero or empty divisor shows 0, as evalTree gives", async () => {
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
