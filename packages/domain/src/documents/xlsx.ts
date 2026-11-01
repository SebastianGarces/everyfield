import type { BlockNode, EveryfieldDoc, Formula, TableNode } from "@everyfield/contracts/documents";
import { parseFormula } from "@everyfield/contracts/documents";
import type { RenderTheme } from "./theme.ts";
import { makePalette } from "./theme.ts";
import { zip } from "./zip.ts";

const xml = (value: string) =>
	value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;");

function column(index: number) {
	let value = index;
	let out = "";
	while (value > 0) {
		const mod = (value - 1) % 26;
		out = String.fromCharCode(65 + mod) + out;
		value = Math.floor((value - 1) / 26);
	}
	return out;
}

/** Cell style ids, in the order of the cellXfs below. */
const S = {
	plain: 0,
	title: 1,
	note: 2,
	head: 3,
	headRight: 4,
	section: 5,
	label: 6,
	input: 7,
	money: 8,
	totalLabel: 9,
	total: 10,
} as const;

/** A cell. `value` is a typed number. A ledger formula has no cached result, so every reader computes it. */
type Cell = { text?: string; formula?: string; value?: number; uncached?: boolean; style: number };
type Sheet = { name: string; widths: number[]; freeze: { x: number; y: number }; rows: Cell[][] };

const argb = (hex: string) => "FF" + hex.replace("#", "").toUpperCase();

function styles(theme: RenderTheme) {
	const p = makePalette(theme);
	const font = (extra: string) => `<font>${extra}<sz val="11"/><name val="DM Sans"/></font>`;
	const fonts = [
		font(""),
		font(`<b/><color rgb="${argb(p.primaryText)}"/>`).replace('<sz val="11"/>', '<sz val="16"/>'),
		font(`<color rgb="${argb(p.mutedText)}"/>`),
		font(`<b/><color rgb="${argb(p.onPrimary)}"/>`),
		font("<b/>"),
	];
	const fills = [
		'<fill><patternFill patternType="none"/></fill>',
		'<fill><patternFill patternType="gray125"/></fill>',
		`<fill><patternFill patternType="solid"><fgColor rgb="${argb(p.primary)}"/></patternFill></fill>`,
		`<fill><patternFill patternType="solid"><fgColor rgb="${argb(p.muted)}"/></patternFill></fill>`,
	];
	const edge = (side: string, color: string, style = "thin") =>
		`<${side} style="${style}"><color rgb="${argb(color)}"/></${side}>`;
	const borders = [
		"<border><left/><right/><top/><bottom/><diagonal/></border>",
		`<border>${edge("left", p.fieldBorder)}${edge("right", p.fieldBorder)}${edge("top", p.fieldBorder)}${edge("bottom", p.fieldBorder)}<diagonal/></border>`,
		`<border><left/><right/>${edge("top", p.ink)}<bottom/><diagonal/></border>`,
		`<border><left/><right/><top/>${edge("bottom", p.border)}<diagonal/></border>`,
	];
	const xf = (font: number, fill: number, border: number, num = 0, align = "") =>
		`<xf numFmtId="${num}" fontId="${font}" fillId="${fill}" borderId="${border}" xfId="0" applyFont="1" applyFill="1" applyBorder="1"${num ? ' applyNumberFormat="1"' : ""}${align ? ' applyAlignment="1">' + align + "</xf>" : "/>"}`;
	const left = '<alignment horizontal="left" vertical="center"/>';
	const right = '<alignment horizontal="right" vertical="center"/>';
	const cellXfs = [
		xf(0, 0, 0),
		xf(1, 0, 0, 0, left),
		xf(2, 0, 0, 0, left),
		xf(3, 2, 0, 0, left),
		xf(3, 2, 0, 0, right),
		xf(4, 3, 0, 0, left),
		xf(0, 0, 3, 0, left),
		xf(0, 0, 1, 164, right),
		xf(0, 0, 3, 164, right),
		xf(4, 3, 2, 0, left),
		xf(4, 3, 2, 164, right),
	];
	return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><numFmts count="1"><numFmt numFmtId="164" formatCode="&quot;$&quot;#,##0;[Red]\\-&quot;$&quot;#,##0"/></numFmts><fonts count="${fonts.length}">${fonts.join("")}</fonts><fills count="${fills.length}">${fills.join("")}</fills><borders count="${borders.length}">${borders.join("")}</borders><cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs><cellXfs count="${cellXfs.length}">${cellXfs.join("")}</cellXfs></styleSheet>`;
}

function sheetXml(sheet: Sheet) {
	const cols = sheet.widths.map((w, i) => `<col min="${i + 1}" max="${i + 1}" width="${w}" customWidth="1"/>`).join("");
	const rows = sheet.rows
		.map((cells, r) => {
			const rowNo = r + 1;
			const body = cells
				.map((cell, c) => {
					const ref = `${column(c + 1)}${rowNo}`;
					if (cell.formula !== undefined)
						return `<c r="${ref}" s="${cell.style}"><f>${xml(cell.formula)}</f>${cell.uncached ? "" : "<v>0</v>"}</c>`;
					if (cell.value !== undefined) return `<c r="${ref}" s="${cell.style}"><v>${cell.value}</v></c>`;
					if (cell.text !== undefined)
						return `<c r="${ref}" s="${cell.style}" t="inlineStr"><is><t xml:space="preserve">${xml(cell.text)}</t></is></c>`;
					return `<c r="${ref}" s="${cell.style}"/>`;
				})
				.join("");
			const height = rowNo === 1 ? ' ht="28" customHeight="1"' : "";
			return `<row r="${rowNo}"${height}>${body}</row>`;
		})
		.join("");
	const { x, y } = sheet.freeze;
	const top = `${column(x + 1)}${y + 1}`;
	const pane = `<pane${x ? ` xSplit="${x}"` : ""}${y ? ` ySplit="${y}"` : ""} topLeftCell="${top}" activePane="${x && y ? "bottomRight" : y ? "bottomLeft" : "topRight"}" state="frozen"/>`;
	return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetPr><pageSetUpPr fitToPage="1"/></sheetPr><sheetViews><sheetView workbookViewId="0" showGridLines="0">${pane}</sheetView></sheetViews><sheetFormatPr defaultRowHeight="20"/><cols>${cols}</cols><sheetData>${rows}</sheetData><pageMargins left="0.5" right="0.5" top="0.5" bottom="0.5" header="0.3" footer="0.3"/><pageSetup orientation="landscape" fitToWidth="1" fitToHeight="0"/></worksheet>`;
}

function workbook(sheets: Sheet[], theme: RenderTheme) {
	const n = sheets.length;
	const names = sheets.map((s, i) => `<sheet name="${xml(s.name)}" sheetId="${i + 1}" r:id="rId${i + 1}"/>`).join("");
	const rels = [
		...sheets.map(
			(_, i) =>
				`<Relationship Id="rId${i + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet${i + 1}.xml"/>`,
		),
		`<Relationship Id="rId${n + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>`,
	].join("");
	const head = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n';
	const entries = [
		{
			name: "[Content_Types].xml",
			data: Buffer.from(
				`${head}<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>${sheets.map((_, i) => `<Override PartName="/xl/worksheets/sheet${i + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`).join("")}<Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/></Types>`,
			),
		},
		{
			name: "_rels/.rels",
			data: Buffer.from(
				`${head}<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>`,
			),
		},
		{
			name: "xl/workbook.xml",
			data: Buffer.from(
				`${head}<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets>${names}</sheets><calcPr calcId="191029" fullCalcOnLoad="1"/></workbook>`,
			),
		},
		{
			name: "xl/_rels/workbook.xml.rels",
			data: Buffer.from(
				`${head}<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${rels}</Relationships>`,
			),
		},
		...sheets.map((sheet, i) => ({ name: `xl/worksheets/sheet${i + 1}.xml`, data: Buffer.from(sheetXml(sheet)) })),
		{ name: "xl/styles.xml", data: Buffer.from(styles(theme)) },
	];
	return zip(entries.map((entry) => ({ ...entry, store: true })));
}

const INCOME_ROWS = [
	"Tithes and offerings",
	"Sending church support",
	"Network or denominational support",
	"Grants",
	"Other income",
] as const;
const EXPENSE_ROWS = [
	"Pastor and staff pay",
	"Payroll taxes and benefits",
	"Rent or facility",
	"Utilities and internet",
	"Insurance",
	"Worship and sound",
	"Kids ministry",
	"Outreach and marketing",
	"Office and supplies",
	"Giving to the network and missions",
] as const;

const text = (value: string, style: number): Cell => ({ text: value, style });
const blank = (style: number): Cell => ({ style });
const formula = (f: string, style: number): Cell => ({ formula: f, style });

/** Rows of the monthly block: labels in column A, `inputs` input columns, then a formula column. Data starts below row 3. */
function block(inputs: number, totalFormula: (row: number) => string) {
	const rows: Cell[][] = [];
	let next = 4; // the sheet row of the next pushed row
	const add = (cells: Cell[]) => {
		rows.push(cells);
		return next++;
	};
	const width = inputs + 2;
	const section = (label: string) => [
		text(label, S.section),
		...Array.from({ length: width - 1 }, () => blank(S.section)),
	];
	const sum = (label: string, first: number, last: number) => [
		text(label, S.totalLabel),
		...Array.from({ length: width - 1 }, (_, i) =>
			formula(`SUM(${column(i + 2)}${first}:${column(i + 2)}${last})`, S.total),
		),
	];
	const line = (label: string) => [
		text(label, S.label),
		...Array.from({ length: inputs }, () => blank(S.input)),
		formula(totalFormula(next), S.money),
	];
	add(section("Income"));
	const incomeFirst = next;
	for (const label of INCOME_ROWS) add(line(label));
	const incomeTotal = add(sum("Total income", incomeFirst, next - 1));
	add([]);
	add(section("Expenses"));
	const expenseFirst = next;
	for (const label of EXPENSE_ROWS) add(line(label));
	const expenseTotal = add(sum("Total expenses", expenseFirst, next - 1));
	add([]);
	const net = add([
		text("Net (income minus expenses)", S.totalLabel),
		...Array.from({ length: width - 1 }, (_, i) =>
			formula(`${column(i + 2)}${incomeTotal}-${column(i + 2)}${expenseTotal}`, S.total),
		),
	]);
	return { rows, incomeFirst, incomeTotal, expenseFirst, expenseTotal, net };
}

function firstYear(church: string): Sheet[] {
	const months = Array.from({ length: 12 }, (_, i) => `Month ${i + 1}`);
	const head: Cell[] = [
		text("Category", S.head),
		...months.map((m) => text(m, S.headRight)),
		text("Year total", S.headRight),
	];
	const b = block(12, (row) => `SUM(B${row}:M${row})`);
	const monthly: Sheet = {
		name: "Monthly budget",
		widths: [36, ...Array(12).fill(12), 14],
		freeze: { x: 1, y: 3 },
		rows: [
			[text(`${church} First-Year Budget`, S.title)],
			[text("Enter each amount in a boxed cell. The totals add up on their own.", S.note)],
			head,
			...b.rows,
		],
	};
	const rows: Cell[][] = [];
	let next = 4;
	const link = (label: string, source: number, total: boolean) => {
		rows.push([
			text(label, total ? S.totalLabel : S.label),
			formula(`'Monthly budget'!N${source}`, total ? S.total : S.money),
			formula(`B${next}/12`, total ? S.total : S.money),
		]);
		next += 1;
	};
	const gap = () => {
		rows.push([]);
		next += 1;
	};
	const section = (label: string) => {
		rows.push([text(label, S.section), blank(S.section), blank(S.section)]);
		next += 1;
	};
	section("Income");
	INCOME_ROWS.forEach((label, i) => link(label, b.incomeFirst + i, false));
	link("Total income", b.incomeTotal, true);
	gap();
	section("Expenses");
	EXPENSE_ROWS.forEach((label, i) => link(label, b.expenseFirst + i, false));
	link("Total expenses", b.expenseTotal, true);
	gap();
	link("Net (income minus expenses)", b.net, true);
	const summary: Sheet = {
		name: "Annual summary",
		widths: [36, 16, 16],
		freeze: { x: 0, y: 3 },
		rows: [
			[text(`${church} Annual Summary`, S.title)],
			[text("This sheet reads the Monthly budget sheet. Type amounts there, not here.", S.note)],
			[text("Category", S.head), text("Year total", S.headRight), text("Monthly average", S.headRight)],
			...rows,
		],
	};
	return [monthly, summary];
}

function worksheet(church: string): Sheet[] {
	const b = block(1, (row) => `B${row}*12`);
	return [
		{
			name: "Budget worksheet",
			widths: [36, 16, 16],
			freeze: { x: 1, y: 3 },
			rows: [
				[text(`${church} Budget Worksheet`, S.title)],
				[
					text(
						"Enter the monthly amount in each boxed cell. The annual amount is the monthly amount times 12.",
						S.note,
					),
				],
				[text("Category", S.head), text("Monthly", S.headRight), text("Annual", S.headRight)],
				...b.rows,
			],
		},
	];
}

/** A budget workbook in stored ZIP form. Totals are live formulas. The same inputs give the same bytes. */
export function buildBudget(kind: "first-year" | "worksheet", church: string, theme: RenderTheme) {
	return workbook(kind === "first-year" ? firstYear(church) : worksheet(church), theme);
}

// ---------------------------------------------------------------- everyfield.doc/1 ledgers

/** The ledger tables of a document, in body order (columns and boxes included). */
export function ledgerTables(doc: EveryfieldDoc): TableNode[] {
	const out: TableNode[] = [];
	const walk = (nodes: readonly BlockNode[] | undefined) => {
		for (const node of nodes ?? []) {
			if (node.type === "table" && node.attrs.style === "ledger") out.push(node);
			if (node.type === "columns") for (const col of node.content) walk(col.content);
			if (node.type === "box") walk(node.content);
		}
	};
	walk(doc.body.content);
	return out;
}

/** A column formula as an Excel formula in one sheet row: column ids become letters, sum(a:b) becomes SUM(A5:C5). */
function excelFormula(tree: Formula, letter: (id: string) => string, row: number): string {
	switch (tree.op) {
		case "num":
			return String(tree.v);
		case "col":
			return `${letter(tree.id)}${row}`;
		case "neg":
			return `-(${excelFormula(tree.a, letter, row)})`;
		case "sum":
			return `SUM(${letter(tree.first)}${row}:${letter(tree.last)}${row})`;
		default:
			return `(${excelFormula(tree.a, letter, row)}${tree.op}${excelFormula(tree.b, letter, row)})`;
	}
}

const cellText = (cell: TableNode["content"] extends (infer R)[] | undefined ? R : never, i: number) =>
	(cell.content[i]?.content ?? [])
		.map((n) => (n.type === "text" ? n.text : ""))
		.join("")
		.trim();

/**
 * One sheet per ledger table. Money and number inputs are boxed cells holding the typed values. A formula column is a
 * live Excel formula in each item row. A subtotal row is SUM over its category's item rows; a total row adds each
 * category (its subtotal, or the SUM of its items) with the group's sign. `fullCalcOnLoad` makes every reader compute.
 */
export function buildLedgerWorkbook(doc: EveryfieldDoc, values: Record<string, string>, theme: RenderTheme) {
	const tables = ledgerTables(doc);
	if (!tables.length) throw new Error("the document holds no ledger table");
	const used = new Set<string>();
	const sheets = tables.map((table, ti): Sheet => {
		const cols = table.attrs.columns;
		const letter = (id: string) => column(cols.findIndex((c) => c.id === id) + 1);
		const numeric = (type: string) => type === "money" || type === "number" || type === "formula";
		const style = (c: (typeof cols)[number], kind: "item" | "total") => {
			const money = c.type === "money" || (c.type === "formula" && c.format === "money");
			if (kind === "total") return S.total;
			if (c.type === "money" || c.type === "number") return S.input;
			return money ? S.money : S.label;
		};
		const church = values.church_name ?? "";
		const rows: Cell[][] = [
			[text(`${church} ${doc.title}`.trim(), S.title)],
			[
				text(
					table.attrs.writeInRows ? "" : "Enter each amount in a boxed cell. The totals add up on their own.",
					S.note,
				),
			],
			cols.map((c) => text(c.label, c.type === "text" ? S.head : S.headRight)),
		];
		const FIRST = rows.length + 1;
		type Group = { sign: 1 | -1; items: number[]; subtotal: number | null };
		const groups: Group[] = [];
		let open: Group | null = null;
		let index = 0;
		(table.content ?? []).forEach((row, ri) => {
			const at = FIRST + ri;
			const role = row.attrs?.role ?? "item";
			if (role === "group") {
				open = { sign: row.attrs?.sign === "subtract" ? -1 : 1, items: [], subtotal: null };
				groups.push(open);
				rows.push(cols.map((c, ci) => (c.type === "text" ? text(cellText(row, ci), S.section) : blank(S.section))));
				return;
			}
			if (role === "item") {
				if (!open) {
					open = { sign: 1, items: [], subtotal: null };
					groups.push(open);
				}
				open.items.push(at);
				index += 1;
				rows.push(
					cols.map((c, ci): Cell => {
						if (c.type === "text") return text(cellText(row, ci), S.label);
						if (c.type === "index") return { value: index, style: S.label };
						if (c.type === "check") return blank(S.label);
						if (c.type === "formula")
							return {
								formula: excelFormula(parseFormula(c.formula ?? "0"), letter, at),
								uncached: true,
								style: style(c, "item"),
							};
						const v = row.content[ci]?.attrs?.value;
						return typeof v === "number" ? { value: v, style: style(c, "item") } : blank(style(c, "item"));
					}),
				);
				return;
			}
			const sum = (L: string, g: Group) =>
				g.subtotal !== null && role === "total"
					? `${L}${g.subtotal}`
					: g.items.length
						? `SUM(${L}${Math.min(...g.items)}:${L}${Math.max(...g.items)})`
						: "0";
			if (role === "subtotal" && open) (open as Group).subtotal = at;
			const parts = role === "subtotal" ? (open ? [open] : []) : groups;
			rows.push(
				cols.map((c, ci): Cell => {
					if (c.type === "text") return text(cellText(row, ci), S.totalLabel);
					if (!numeric(c.type)) return blank(S.totalLabel);
					const L = column(ci + 1);
					// A subtotal adds its category; only a total applies each group's sign.
					const sign = (g: Group, gi: number) => (role === "total" && g.sign < 0 ? "-" : gi === 0 ? "" : "+");
					const terms = parts.map((g, gi) => `${sign(g, gi)}${sum(L, g)}`);
					return { formula: terms.join("") || "0", uncached: true, style: S.total };
				}),
			);
		});
		let name = (table.attrs.sheet ?? `Sheet ${ti + 1}`).replace(/[\\/?*[\]:]/g, " ").slice(0, 31) || `Sheet ${ti + 1}`;
		while (used.has(name)) name = `${name.slice(0, 28)} ${ti + 1}`;
		used.add(name);
		return {
			name,
			widths: cols.map((c) => (c.type === "text" ? 36 : c.type === "index" || c.type === "check" ? 6 : 16)),
			freeze: { x: 1, y: 3 },
			rows,
		};
	});
	return workbook(sheets, theme);
}
