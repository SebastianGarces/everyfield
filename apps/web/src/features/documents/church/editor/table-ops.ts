import {
	formatNumber,
	formulaDeps,
	parseAmount,
	TABLE_LIMITS,
	type CellNode,
	type ColumnSpec,
	type ColumnType,
	type RowNode,
	type RowRole,
	type TableNode,
} from "@everyfield/contracts/documents";

export type Kind = "text" | "number" | "money" | "check" | "index";
export const KINDS: { kind: Kind; label: string }[] = [
	{ kind: "text", label: "Text" },
	{ kind: "number", label: "Number" },
	{ kind: "money", label: "Money" },
	{ kind: "check", label: "Check box" },
	{ kind: "index", label: "Row number" },
];

export type Place = { row: number | null; col: number | null; blank?: boolean };

const isLedger = (t: TableNode) => t.attrs.style === "ledger";
const rowsOf = (t: TableNode) => t.content ?? [];
const roleOf = (row: RowNode): RowRole => row.attrs?.role ?? "item";
const withRows = (t: TableNode, content: RowNode[]): TableNode => ({ ...t, content });
export const withAttrs = (t: TableNode, attrs: Partial<TableNode["attrs"]>): TableNode => ({
	...t,
	attrs: { ...t.attrs, ...attrs },
});
const withColumns = (t: TableNode, columns: ColumnSpec[], content: RowNode[]): TableNode => ({
	...withAttrs(t, { columns }),
	content,
});

const emptyCell = (): CellNode => ({ type: "cell" });
const textCell = (text: string): CellNode => (text ? { type: "cell", content: [{ type: "text", text }] } : emptyCell());
const emptyRow = (t: TableNode, role?: RowRole, label = ""): RowNode => {
	const at = labelColumn(t);
	return {
		type: "row",
		...(role && role !== "item" ? { attrs: { role } } : {}),
		content: t.attrs.columns.map((_, ci) => (ci === at && label ? textCell(label) : emptyCell())),
	};
};

export const labelColumn = (t: TableNode) =>
	Math.max(
		0,
		t.attrs.columns.findIndex((c) => c.type === "text"),
	);

type Category = { start: number; end: number };

function categories(t: TableNode): Category[] {
	const out: Category[] = [];
	let open: Category | null = null;
	rowsOf(t).forEach((row, i) => {
		const role = roleOf(row);
		if (role === "total") {
			open = null;
			return;
		}
		if (role === "group" || !open) {
			open = { start: i, end: i };
			out.push(open);
		}
		open.end = i;
	});
	return out;
}

export const categoryAt = (t: TableNode, row: number | null) =>
	row === null ? null : (categories(t).find((c) => row >= c.start && row <= c.end) ?? null);

function readerOf(t: TableNode, index: number): ColumnSpec | null {
	const id = t.attrs.columns[index]?.id;
	return formulaDeps(t.attrs.columns).find((dep) => id !== undefined && dep.reads.includes(id))?.column ?? null;
}

const joinsASum = (t: TableNode, at: number) =>
	formulaDeps(t.attrs.columns).some((dep) => dep.spans.some(([a, b]) => at > a && at <= b));

const lastTextColumn = (t: TableNode, index: number) =>
	isLedger(t) &&
	t.attrs.columns[index]?.type === "text" &&
	t.attrs.columns.filter((c) => c.type === "text").length === 1;

const ROW_LIMIT = `A table holds at most ${TABLE_LIMITS.rows} rows.`;
const COLUMN_LIMIT = `A table holds at most ${TABLE_LIMITS.columns} columns.`;
export const LAST_ROW = "A table with no header keeps at least one row.";

export function availability(t: TableNode, at: Place) {
	const rows = rowsOf(t);
	const cols = t.attrs.columns;
	const source = t.attrs.source;
	const ledger = isLedger(t);
	const noRows = source ? `This table lists the "${source}" field, so it has no typed rows.` : null;

	const addColumn = (position: number): string | null =>
		cols.length >= TABLE_LIMITS.columns
			? COLUMN_LIMIT
			: joinsASum(t, position)
				? "A formula adds up a range of columns here, so a new column would join the sum."
				: null;

	let removeColumn: string | null = null;
	let kind: string | null = null;
	if (at.col === null) {
		removeColumn = "Put the cursor in a column to remove it.";
		kind = "Put the cursor in a column to change its kind.";
	} else {
		const reader = readerOf(t, at.col);
		const readBy = reader ? `The "${reader.label}" column reads this column.` : null;
		const lastText = lastTextColumn(t, at.col)
			? "A budget table keeps one text column, which holds its category and total labels."
			: null;
		removeColumn = cols.length === 1 ? "A table keeps at least one column." : (readBy ?? lastText);
		kind = cols[at.col]?.type === "formula" ? "A formula column keeps its kind." : (readBy ?? lastText);
	}

	const category = ledger ? categoryAt(t, at.row) : null;
	const inRow = at.row !== null ? rows[at.row] : undefined;
	const noCategory = "Put the cursor in a category.";
	return {
		addRow: ledger ? null : rows.length >= TABLE_LIMITS.rows ? ROW_LIMIT : noRows,
		removeRow:
			at.row === null && !at.blank
				? "Put the cursor in a row to remove it."
				: !t.attrs.header && rows.length + (t.attrs.writeInRows ?? 0) <= 1
					? LAST_ROW
					: null,
		addColumnLeft: addColumn(at.col ?? 0),
		addColumnRight: addColumn(at.col === null ? cols.length : at.col + 1),
		removeColumn,
		kind,
		addItem: rows.length >= TABLE_LIMITS.rows ? ROW_LIMIT : !category ? noCategory : null,
		removeItem: inRow && roleOf(inRow) === "item" ? null : "Put the cursor in a line item.",
		addCategory: rows.length + 3 > TABLE_LIMITS.rows ? ROW_LIMIT : null,
		removeCategory: !category
			? noCategory
			: categories(t).length <= 1
				? "A budget's only category cannot be removed."
				: null,
	};
}

export function addRow(t: TableNode, index: number): TableNode {
	const rows = [...rowsOf(t)];
	rows.splice(index, 0, emptyRow(t));
	return withRows(t, rows);
}

export function removeRow(t: TableNode, at: number): TableNode {
	return withRows(
		t,
		rowsOf(t).filter((_, i) => i !== at),
	);
}

function freeColumnId(columns: readonly ColumnSpec[]) {
	const taken = new Set(columns.map((c) => c.id));
	for (let n = columns.length + 1; ; n++) if (!taken.has(`column_${n}`)) return `column_${n}`;
}

export function addColumn(t: TableNode, at: number): TableNode {
	const columns = [...t.attrs.columns];
	const id = freeColumnId(columns);
	columns.splice(at, 0, { id, label: `Column ${columns.length + 1}`, type: "text", width: 0 });
	const content = rowsOf(t).map((row) => {
		const cells = [...row.content];
		cells.splice(at, 0, emptyCell());
		return { ...row, content: cells };
	});
	return withColumns(t, columns, content);
}

export function removeColumn(t: TableNode, at: number): TableNode {
	const content = rowsOf(t).map((row) => ({ ...row, content: row.content.filter((_, i) => i !== at) }));
	return withColumns(
		t,
		t.attrs.columns.filter((_, i) => i !== at),
		content,
	);
}

const textOf = (cell: CellNode | undefined) =>
	(cell?.content ?? []).map((n) => (n.type === "text" ? n.text : "")).join("");

function convertCell(cell: CellNode | undefined, from: ColumnType, to: Kind, role: RowRole): CellNode {
	const amount = to === "number" || to === "money";
	if (amount && role !== "item") return emptyCell();
	const value = cell?.attrs?.value;
	if (to === "text") {
		if ((from === "number" || from === "money") && typeof value === "number")
			return textCell(formatNumber(value, from));
		return from === "text" && cell ? cell : emptyCell();
	}
	if (amount) {
		if (from === "number" || from === "money") {
			if (typeof value !== "number") return emptyCell();
			const next = to === "money" ? Math.round((value + Number.EPSILON) * 100) / 100 : value;
			return { type: "cell", attrs: { value: next } };
		}
		if (from === "text") {
			const read = parseAmount(textOf(cell), to);
			return read.ok && read.value !== null ? { type: "cell", attrs: { value: read.value } } : emptyCell();
		}
	}
	return emptyCell();
}

export function setKind(t: TableNode, at: number, kind: Kind): TableNode {
	const column = t.attrs.columns[at];
	if (!column) return t;
	const columns = t.attrs.columns.map((c, i) => {
		if (i !== at) return c;
		const next: ColumnSpec = { ...c, type: kind };
		delete next.formula;
		delete next.format;
		return next;
	});
	const content = rowsOf(t).map((row) => ({
		...row,
		content: row.content.map((cell, ci) => (ci === at ? convertCell(cell, column.type, kind, roleOf(row)) : cell)),
	}));
	return withColumns(t, columns, content);
}

const LINE_ITEM = "Line item";
const CATEGORY = "Category";
const CATEGORY_TOTAL = "Category total";

export function addLineItem(t: TableNode, at: number): TableNode {
	const rows = [...rowsOf(t)];
	const row = rows[at];
	if (!row) return t;
	const index = roleOf(row) === "subtotal" ? at : at + 1;
	rows.splice(index, 0, emptyRow(t, "item", LINE_ITEM));
	return withRows(t, rows);
}

export function addCategory(t: TableNode, at: number | null): TableNode {
	const rows = [...rowsOf(t)];
	const after = categoryAt(t, at) ?? categories(t).at(-1);
	const index = after ? after.end + 1 : rows.length;
	rows.splice(
		index,
		0,
		emptyRow(t, "group", CATEGORY),
		emptyRow(t, "item", LINE_ITEM),
		emptyRow(t, "subtotal", CATEGORY_TOTAL),
	);
	return withRows(t, rows);
}

export function removeCategory(t: TableNode, at: number): TableNode {
	const category = categoryAt(t, at);
	if (!category) return t;
	return withRows(
		t,
		rowsOf(t).filter((_, i) => i < category.start || i > category.end),
	);
}

function groupRow(t: TableNode, at: number | null) {
	const start = categoryAt(t, at)?.start;
	return start !== undefined && rowsOf(t)[start]?.attrs?.role === "group" ? start : null;
}

export function setSign(t: TableNode, at: number, sign: "add" | "subtract"): TableNode {
	const group = groupRow(t, at);
	return withRows(
		t,
		rowsOf(t).map((row, i) =>
			i === group ? { ...row, attrs: { role: "group", ...(sign === "subtract" ? { sign } : {}) } } : row,
		),
	);
}

export function signAt(t: TableNode, at: number | null): "add" | "subtract" | null {
	const group = groupRow(t, at);
	if (group === null) return null;
	return rowsOf(t)[group]?.attrs?.sign === "subtract" ? "subtract" : "add";
}

const grid = (n: number): ColumnSpec[] =>
	Array.from({ length: n }, (_, i) => ({ id: `column_${i + 1}`, label: `Column ${i + 1}`, type: "text", width: 0 }));

export const newGrid = (): TableNode => ({
	type: "table",
	attrs: { style: "grid", header: true, columns: grid(3), writeInRows: 5 },
});

export const newChecklist = (): TableNode => ({
	type: "table",
	attrs: {
		style: "rows",
		header: false,
		headerFill: "none",
		columns: [
			{ id: "done", label: "Done", type: "check", width: 18 },
			{ id: "commitment", label: "Commitment", type: "text", width: 0 },
		],
	},
	content: Array.from({ length: 3 }, () => ({ type: "row" as const, content: [emptyCell(), emptyCell()] })),
});

export function newPlainGrid(): TableNode {
	const base: TableNode = { type: "table", attrs: { style: "grid", header: true, columns: grid(3) } };
	return withRows(base, [emptyRow(base), emptyRow(base), emptyRow(base)]);
}

export function newPlainChecklist(): TableNode {
	const table = newChecklist();
	delete table.attrs.headerFill;
	return table;
}

export function newBudget(): TableNode {
	const base: TableNode = {
		type: "table",
		attrs: {
			style: "ledger",
			header: true,
			headerFill: "primary",
			columns: [
				{ id: "item", label: "Item", type: "text", width: 0 },
				{ id: "amount", label: "Amount", type: "money", width: 110 },
			],
		},
	};
	return withRows(base, [
		emptyRow(base, "group", CATEGORY),
		emptyRow(base, "item", LINE_ITEM),
		emptyRow(base, "subtotal", CATEGORY_TOTAL),
		emptyRow(base, "total", "Total"),
	]);
}
