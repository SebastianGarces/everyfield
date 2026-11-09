// WP-036 slice 4: what a table becomes in the PDF, the Word file and the Excel file. The browser tests edit a document and
// download its files; the Excel format test builds workbooks from documents directly. LibreOffice (`soffice`) opens the
// Excel files and computes their live formulas. Seed People, then Settings, as tables.test.mjs says.
//   AC:WP-036-10 the Excel download after an edit     AC:WP-036-11 Excel shows what the table shows
//   AC:WP-036-13 the PDF and the Word file
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { PDFDocument } from "../../../packages/domain/node_modules/pdf-lib/cjs/index.js";
import {
	computeTable,
	docDocument,
	forkTemplate,
	formatNumber,
} from "../../../packages/contracts/src/documents/index.ts";
import { fieldValues } from "../../../packages/domain/src/documents/doc-values.ts";
import { buildLedgerWorkbook } from "../../../packages/domain/src/documents/xlsx.ts";
import { docTemplateById } from "../../../packages/domain/src/documents/doc-templates.ts";
import { makePalette, NEUTRAL_THEME, tokenColor } from "../../../packages/domain/src/documents/theme.ts";
import { clean, editorContent } from "../../../apps/web/src/features/documents/church/editor/document-json.ts";
import { docxParts, pdfPages, wordText } from "../../integration/documents/fixtures/readers.mts";
import { ENGINES } from "../setup.mjs";
import { baseOf, onFork, PAPER, textOf } from "./tables-support.mjs";

const sha = (bytes) => createHash("sha256").update(bytes).digest("hex");
const palette = makePalette(NEUTRAL_THEME);

/** Opens an Excel file in LibreOffice and returns its first sheet as rows of cells (raw values, formulas computed). */
function excelRows(bytes) {
	const dir = mkdtempSync(join(tmpdir(), "wp036-xlsx-"));
	try {
		writeFileSync(join(dir, "budget.xlsx"), bytes);
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
			{ stdio: "ignore", timeout: 120_000 },
		);
		return readFileSync(join(dir, "budget.csv"), "utf8")
			.trim()
			.split("\n")
			.map((line) => line.split(","));
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
}

/** Puts the cursor at the end of the first heading, so typing edits the title. */
const inHeading = (page) =>
	page.locator(PAPER).evaluate((el) => {
		const ed = el.editor;
		let at = null;
		ed.state.doc.descendants((node, pos) => {
			if (at === null && node.type.name === "heading") at = pos + 1 + node.content.size;
			return at === null;
		});
		ed.chain().focus().setTextSelection(at).run();
		// A key typed straight after a cursor move can be dropped: wait for two frames.
		return new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(() => done())));
	});

const headFocus = (page, col) => page.locator(".ef-head-cell").nth(col).focus();

/** Clicks Download Excel and returns the file's bytes. */
async function downloadExcel(page) {
	const [download] = await Promise.all([
		page.waitForEvent("download"),
		page.getByRole("link", { name: "Download Excel" }).click(),
	]);
	const dir = mkdtempSync(join(tmpdir(), "wp036-dl-"));
	try {
		const path = join(dir, "file.xlsx");
		await download.saveAs(path);
		return new Uint8Array(readFileSync(path));
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
}

/** The saved budget's sheet checked against computeTable: each label, each number, each total. */
function assertSheet(rows, table, title) {
	const expected = computeTable(table);
	const header = table.attrs.header !== false ? 1 : 0;
	assert.equal(rows[0][0], title, "the sheet opens with the edited title");
	assert.equal(rows.length, 2 + header + table.content.length);
	table.content.forEach((row, ri) => {
		const cells = rows[2 + header + ri];
		const role = row.attrs?.role ?? "item";
		table.attrs.columns.forEach((c, ci) => {
			if (c.type === "text") assert.equal(cells[ci], textOf(row.content[ci]), `row ${ri + 1} ${c.label}`);
			else if (role !== "group" && (c.type === "money" || c.type === "number" || c.type === "formula")) {
				const want = expected[ri][ci];
				const typed = row.content[ci]?.attrs?.value;
				if (role === "item" && c.type !== "formula" && typeof typed !== "number") assert.equal(cells[ci], "");
				else assert.ok(Math.abs(Number(cells[ci]) - want) < 1e-9, `row ${ri + 1} ${c.label}: ${cells[ci]} is ${want}`);
			}
		});
	});
}

for (const [name, engine] of ENGINES) {
	test(`AC:WP-036-10 (${name}): a forked budget, edited and saved, downloads as an Excel file with the edits and computed totals`, async () => {
		await onFork(engine, "budget-worksheet", async (page, context, t) => {
			await inHeading(page);
			await page.keyboard.type(" 2027");
			// A line item and its label and amount.
			await t.cell(5, 0);
			await t.button("Add line item").click();
			await t.cell(6, 0, 0, true);
			await page.keyboard.type("Online giving");
			await t.typeAmount("Online giving", "500");
			await t.typeAmount("Tithes and offerings", "3000");
			await t.typeAmount("Pastor and staff pay", "1500");
			// A removed line item.
			await t.cell(4, 0);
			await t.button("Remove line item").click();
			// A new category with its own label and item, and a minus sign.
			const rows = (await t.table()).content;
			const at = rows.findIndex((r) => textOf(r.content[0]) === "Total expenses");
			await t.cell(at, 0);
			await t.button("Add category").click();
			const after = (await t.table()).content;
			const group = after.findIndex((r) => textOf(r.content[0]) === "Category");
			await t.cell(group, 0, 0, true);
			await page.keyboard.type("Missions");
			await t.cell(group + 1, 0, 0, true);
			await page.keyboard.type("Church plant fund");
			await t.typeAmount("Church plant fund", "250.50");
			await t.cell(group, 0);
			await page
				.getByRole("radiogroup", { name: "Category sign" })
				.getByRole("radio", { name: "This category subtracts from the total" })
				.click();
			// An added column (a note) and a removed one (the formula column).
			await headFocus(page, 1);
			await t.button("Add column right").click();
			await headFocus(page, 2);
			await page.locator(".ef-head-cell").nth(2).fill("Notes");
			await t.cell(1, 2);
			await page.keyboard.type("weekly");
			await headFocus(page, 3);
			await t.button("Remove column").click();
			await t.save();
			const saved = await t.table();
			assert.deepEqual(
				saved.attrs.columns.map((c) => c.label),
				["Category", "Monthly", "Notes"],
			);
			const sheet = excelRows(await downloadExcel(page));
			assertSheet(sheet, saved, "Harvest Point Budget Worksheet 2027");
			assert.equal(sheet[2].join(","), "Category,Monthly,Notes");
			assert.ok(sheet.some((r) => r[0] === "Missions") && sheet.some((r) => r[0] === "Church plant fund"));
			assert.ok(!sheet.some((r) => r[0] === "Grants"), "the removed line item is gone");
			assert.ok(sheet.some((r) => r[2] === "weekly"));
			// The minus sign: the net is income minus expenses minus missions, as the editor shows it.
			const net = computeTable(saved).at(-1)[1];
			assert.equal(Number(sheet.at(-1)[1]), net);
			assert.equal(net, 3000 + 500 - 1500 - 250.5);
			assert.equal((await t.computed("Net (income"))[0], formatNumber(net, "money"));
		});
	});

	test(`AC:WP-036-10 (${name}): a budget inserted into a blank document downloads as an Excel file with the edits`, async () => {
		await onFork(
			engine,
			"guest-sign-in-sheet",
			async (page, context, t) => {
				await t.insert("Heading");
				await page.keyboard.type("Quarter plan");
				await t.insert("Budget table");
				await t.cell(1, 0, 0, true);
				await page.keyboard.type("Offerings");
				await t.typeAmount("Offerings", "1200.25");
				await t.cell(1, 0);
				await t.button("Add line item").click();
				await t.cell(2, 0, 0, true);
				await page.keyboard.type("Grants");
				await t.typeAmount("Grants", "800");
				await t.cell(3, 0);
				await t.button("Add category").click();
				await t.cell(4, 0, 0, true);
				await page.keyboard.type("Costs");
				await t.cell(5, 0, 0, true);
				await page.keyboard.type("Rent");
				await t.typeAmount("Rent", "900");
				await t.cell(4, 0);
				await page
					.getByRole("radiogroup", { name: "Category sign" })
					.getByRole("radio", { name: "This category subtracts from the total" })
					.click();
				await headFocus(page, 1);
				await t.button("Add column left").click();
				await headFocus(page, 1);
				await page.locator(".ef-head-cell").nth(1).fill("Who");
				await t.save();
				const saved = await t.table();
				const sheet = excelRows(await downloadExcel(page));
				assertSheet(sheet, saved, "Quarter plan");
				assert.equal(Number(sheet.at(-1)[2]), 1200.25 + 800 - 900);
			},
			{ blank: true },
		);
	});
}

// ---------------------------------------------------------------- Excel shows what the table shows

for (const [name, engine] of ENGINES)
	test(`AC:WP-036-11 (${name}): the Excel file downloaded after an edit shows the cents, the header color and the stripes the editor shows`, async () => {
		await onFork(engine, "budget-worksheet", async (page, context, t) => {
			await t.typeAmount("Tithes and offerings", "100.50");
			await t.typeAmount("Sending church support", "200");
			await page.getByLabel("Striped rows").check();
			await page.getByRole("radio", { name: "Accent", exact: true }).first().click();
			await t.save();
			const sheet = workbook(await downloadExcel(page));
			assert.equal(
				sheet.fill("A3"),
				palette.accent.replace("#", "").toUpperCase(),
				"the header takes the header color",
			);
			assert.equal(sheet.fill("A5"), null, "the first line item is not striped");
			assert.equal(sheet.fill("A6"), palette.muted.replace("#", "").toUpperCase(), "the second line item is striped");
			for (const ref of ["B5", "B6", "B10", "B23"])
				assert.match(sheet.format(ref), /^"\$"#,##0\.00/, `${ref} shows cents, as the editor does`);
			assert.deepEqual(await t.computed("Total income"), ["$300.50", "$3,606"], "the editor shows the same total");
		});
	});

/** The Excel file of a document, as the download route builds it. */
const renderXlsx = (doc) => buildLedgerWorkbook(doc, fieldValues(doc), NEUTRAL_THEME);

async function budgetDoc(change) {
	const doc = await forkTemplate(docTemplateById("budget-worksheet"), { data: { church_name: "Harbor City Church" } });
	const table = doc.body.content.find((n) => n.type === "table");
	const items = table.content.filter((r) => (r.attrs?.role ?? "item") === "item");
	change(table, items);
	return docDocument.parse(doc);
}

/** Reads a workbook: each part, the number formats, and the style of every cell by reference. */
function workbook(bytes) {
	const parts = docxParts(bytes);
	const styles = parts["xl/styles.xml"];
	const formats = new Map(
		[...styles.matchAll(/<numFmt numFmtId="(\d+)" formatCode="([^"]*)"/g)].map((m) => [
			m[1],
			m[2].replaceAll("&quot;", '"'),
		]),
	);
	const fills = [...styles.match(/<fills[^>]*>(.*?)<\/fills>/s)[1].matchAll(/<fill>(.*?)<\/fill>/gs)].map(
		(m) => /rgb="FF([0-9A-F]{6})"/.exec(m[1])?.[1] ?? null,
	);
	const xfs = [...styles.match(/<cellXfs[^>]*>(.*?)<\/cellXfs>/s)[1].matchAll(/<xf ([^>]*?)\/?>/g)].map((m) => ({
		numFmt: /numFmtId="(\d+)"/.exec(m[1])[1],
		fill: /fillId="(\d+)"/.exec(m[1])[1],
	}));
	const sheet = (n = 1) => parts[`xl/worksheets/sheet${n}.xml`];
	return {
		parts,
		sheets: Object.keys(parts).filter((k) => /^xl\/worksheets\/sheet\d+\.xml$/.test(k)).length,
		names: [...parts["xl/workbook.xml"].matchAll(/<sheet name="([^"]*)"/g)].map((m) => m[1]),
		format: (ref, n = 1) => {
			const s = new RegExp(`<c r="${ref}" s="(\\d+)"`).exec(sheet(n))?.[1];
			return s === undefined ? null : (formats.get(xfs[Number(s)].numFmt) ?? "General");
		},
		fill: (ref, n = 1) => {
			const s = new RegExp(`<c r="${ref}" s="(\\d+)"`).exec(sheet(n))?.[1];
			return s === undefined ? null : fills[Number(xfs[Number(s)].fill)];
		},
		cell: (ref, n = 1) => new RegExp(`<c r="${ref}"[^>]*?(?:/>|>(.*?)</c>)`, "s").exec(sheet(n))?.[0] ?? null,
	};
}

test("AC:WP-036-11: Excel shows cents, no dollar sign on a number column, ticks, the header fill, the stripes and a sheet for each table", async () => {
	// Rows of the budget worksheet: row 3 is the header, 4 the first group, 5 and 6 the first two line items.
	const build = async (change) => workbook(renderXlsx(await budgetDoc(change)));
	const set = (items, values) =>
		items.forEach((r, i) => (r.content[1] = { type: "cell", attrs: { value: values[i] ?? null } }));

	// A money column with cents shows them in its amounts and its totals; one with whole amounts shows none.
	const cents = await build((t, items) => set(items, [100.55, 200]));
	assert.match(cents.format("B5"), /^"\$"#,##0\.00/, "an amount with cents shows the cents");
	assert.match(
		cents.format("B6"),
		/^"\$"#,##0\.00/,
		"the whole amount beside it shows them too: one format for the column",
	);
	assert.match(cents.format("B10"), /^"\$"#,##0\.00/, "the category total shows cents");
	assert.match(cents.format("B23"), /^"\$"#,##0\.00/, "the grand total shows cents");
	assert.match(cents.format("C5"), /^"\$"#,##0\.00/, "the formula column of a money column shows cents");
	const whole = await build((t, items) => set(items, [100, 200]));
	for (const ref of ["B5", "B10", "B23", "C5"])
		assert.match(whole.format(ref), /^"\$"#,##0(;|$)/, `${ref} shows no cents`);
	assert.doesNotMatch(whole.format("B5"), /0\.00/);

	// A number column shows no dollar sign, in its cells and its totals.
	const number = await build((t, items) => {
		t.attrs.columns[1].type = "number";
		set(items, [100, 2.5]);
	});
	for (const ref of ["B5", "B6", "B10", "B23"])
		assert.doesNotMatch(number.format(ref), /\$/, `${ref} shows no dollar sign`);
	assert.match(number.format("B6"), /#,##0\.0/, "a number with decimals keeps them");

	// A ticked check cell shows ticked; an unticked one shows empty.
	const checks = await build((t, items) => {
		t.attrs.columns.push({ id: "paid", label: "Paid", type: "check", width: 40 });
		t.content.forEach((row) => row.content.push({ type: "cell" }));
		items[0].content[3] = { type: "cell", attrs: { checked: true } };
		items[1].content[3] = { type: "cell", attrs: { checked: false } };
	});
	assert.match(checks.cell("D5"), /☒/, "a ticked cell shows ticked");
	assert.doesNotMatch(checks.cell("D6"), /<t[ >]|<v>/, "an unticked cell shows empty");

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
	const two = workbook(
		renderXlsx(
			await (async () => {
				const doc = await budgetDoc((t) => (t.attrs.sheet = "Plan A"));
				const copy = structuredClone(doc.body.content.find((n) => n.type === "table"));
				copy.attrs.sheet = "Plan B";
				doc.body.content.push(copy);
				return docDocument.parse(doc);
			})(),
		),
	);
	assert.equal(two.sheets, 2);
	assert.deepEqual(two.names, ["Plan A", "Plan B"]);
	const same = workbook(
		renderXlsx(
			await (async () => {
				const doc = await budgetDoc((t) => (t.attrs.sheet = "Plan"));
				const copy = structuredClone(doc.body.content.find((n) => n.type === "table"));
				copy.attrs.sheet = "PLAN";
				doc.body.content.push(copy);
				return docDocument.parse(doc);
			})(),
		),
	);
	assert.equal(new Set(same.names.map((n) => n.toLowerCase())).size, 2, "two sheets never share a name");
});

// ---------------------------------------------------------------- the PDF and the Word file

/** One body with every column kind, blank rows, a header color, stripes, checklist rows and a budget. */
async function everything(base) {
	const text = (s) => (s ? { type: "cell", content: [{ type: "text", text: s }] } : { type: "cell" });
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
			{
				type: "row",
				content: [
					{ type: "cell" },
					text("Chairs"),
					{ type: "cell", attrs: { value: 4 } },
					{ type: "cell", attrs: { value: 12.5 } },
					{ type: "cell" },
					{ type: "cell", attrs: { checked: true } },
				],
			},
			{
				type: "row",
				content: [
					{ type: "cell" },
					text("Tables"),
					{ type: "cell", attrs: { value: 2 } },
					{ type: "cell", attrs: { value: 80 } },
					{ type: "cell" },
					{ type: "cell" },
				],
			},
			{
				type: "row",
				content: [
					{ type: "cell" },
					text("Banner"),
					{ type: "cell", attrs: { value: 1 } },
					{ type: "cell", attrs: { value: 0.3 } },
					{ type: "cell" },
					{ type: "cell", attrs: { checked: true } },
				],
			},
		],
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
	const budget = structuredClone((await baseOf("budget-worksheet")).body.content.find((n) => n.type === "table"));
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
	const doc = { ...base, exports: ["xlsx", "pdf", "docx"], body };
	return { doc, grid, checklist, budget };
}

for (const [name, engine] of ENGINES)
	test(`AC:WP-036-13 (${name}): the PDF and the Word file hold the editor's text, numbers, row numbers, header labels and ticks`, async () => {
		await onFork(
			engine,
			"budget-worksheet",
			async (page, context, t) => {
				const { doc } = await everything(await baseOf("budget-worksheet"));
				assert.ok(docDocument.safeParse(doc).success, "the document under test parses");
				await page
					.locator(PAPER)
					.evaluate((el, json) => el.editor.commands.setContent(json, { emitUpdate: true }), editorContent(doc));
				await t.settle();
				await t.save();
				const stored = await t.snap();
				assert.deepEqual(stored.body, clean(doc.body), "the editor holds the body as built");

				// What the editor shows: header labels, text, amounts, computed numbers and row numbers of the grid.
				const shown = await page
					.locator(`${PAPER} [data-ef-node="table"]`)
					.first()
					.evaluate((el) => ({
						head: [...el.querySelectorAll(".ef-head-cell")].map((i) => i.value),
						inputs: [...el.querySelectorAll(".ef-vinput")].map((i) => i.value).filter(Boolean),
						computed: [...el.querySelectorAll(".ef-computed")].map((c) => c.textContent).filter(Boolean),
						text: [...el.querySelectorAll('[data-ef-cell="text"]')].map((c) => c.textContent).filter(Boolean),
						blanks: [...el.querySelectorAll(".ef-blank-cell[data-kind='index']")].map((c) => c.textContent),
					}));
				assert.deepEqual(shown.head, ["No.", "Name", "Qty", "Cost", "Total", "Done"]);
				assert.deepEqual(shown.inputs, ["4", "$12.50", "2", "$80", "1", "$0.30"]);
				assert.deepEqual(shown.computed.slice(0, 6), ["1", "$50", "2", "$160", "3", "$0.30"]);
				assert.deepEqual(shown.blanks, ["4", "5", "6"], "the blank rows count on after the typed rows");
				assert.deepEqual(shown.text.slice(0, 3), ["Chairs", "Tables", "Banner"]);

				const pdfBytes = (await t.file("pdf")).bytes;
				const pdf = (await pdfPages(pdfBytes)).join(" ");
				const word = wordText(docxParts((await t.file("docx")).bytes)["word/document.xml"]);
				for (const [label, text] of [
					["PDF", pdf],
					["Word", word],
				]) {
					for (const head of shown.head)
						assert.match(
							text.toLowerCase(),
							new RegExp(`\\b${head.toLowerCase().replace(".", "\\.")}`),
							`${label}: header ${head}`,
						);
					for (const piece of [
						...shown.text,
						...shown.inputs,
						...shown.computed.slice(0, 6),
						...shown.blanks,
						"Pray every day",
						"Serve once a month",
						"$3,000.50",
						"$4,200.50",
					])
						assert.ok(text.includes(piece), `${label} prints "${piece}"`);
				}

				// A ticked cell prints ticked and an unticked one prints empty. The PDF keeps the empty ones as form fields.
				const form = (await PDFDocument.load(pdfBytes)).getForm();
				const checks = form.getFields().filter((f) => f.constructor.name === "PDFCheckBox");
				const names = form.getFields().map((f) => f.getName());
				assert.equal(new Set(names).size, names.length, "every form field has a unique name");
				const ticked = checks.filter((c) => c.isChecked());
				// The grid has two ticked cells and the checklist one; the rest (one typed, three blank, one checklist) are empty fields.
				assert.equal(ticked.length, 3, "the PDF prints three ticked boxes");
				assert.ok(checks.length - ticked.length >= 5, "the unticked and blank boxes stay fillable fields");
				assert.ok(names.filter((n) => /^row_\d+_/.test(n)).length >= 3 * 2, "the blank rows keep fillable fields");
				const boxes = (word.match(/☒/g) ?? []).length;
				assert.equal(boxes, 3, "the Word file prints three ticked boxes");
				assert.ok((word.match(/☐/g) ?? []).length >= 5, "the Word file prints the unticked boxes empty");

				// Blank rows print in both files: the grid has 3 blank rows of fields in the PDF and 3 empty rows in Word.
				const wordRows = docxParts((await t.file("docx")).bytes)["word/document.xml"].match(/<w:tr[ >]/g) ?? [];
				assert.ok(
					wordRows.length >= 1 + 3 + 3 + 2 + 20,
					`the Word tables hold the typed rows and the blank rows (${wordRows.length})`,
				);

				// The preview is the file Download gives, byte for byte, for the same revision.
				assert.equal(sha((await t.file("pdf", { download: false })).bytes), sha(pdfBytes));
			},
			{ blank: true },
		);
	});
