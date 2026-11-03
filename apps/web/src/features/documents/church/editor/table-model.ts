import { attrsOf, computeTable, formatNumber, type RowRole, type TableNode } from "@everyfield/contracts/documents";

// What a table shows in the places a person does not type: the numbers a subtotal, a total or a formula column computes,
// the row numbers, and the rows the PDF stripes. The rules are the PDF's (layouts/doc.tsx, table) and the numbers come
// from the format's own `computeTable`, so the editor and the PDF cannot differ. The Word file follows the same rules.

export type RowView = {
	role: RowRole;
	/** The row number the PDF prints, for an item row; null for a group, subtotal or total row. */
	index: number | null;
	/** True on the rows the PDF shades when `zebra` is on. */
	stripe: boolean;
	/** The text of each cell that is computed, formatted as the PDF prints it; null where the cell takes input or is blank. */
	shown: (string | null)[];
};

export type TableView = {
	rows: RowView[];
	/** How many blank write-in rows the table prints, and the row number and stripe of each. */
	blanks: { index: number; stripe: boolean }[];
};

/**
 * @param sourceRows how many rows the table's list field supplies. A table with a list prints those rows and no blank ones.
 */
export function tableView(table: TableNode, sourceRows = 0): TableView {
	const a = attrsOf(table);
	const cols = a.columns;
	const computed = computeTable(table);
	const content = table.content ?? [];
	const anyValue = content.some((row) => row.content.some((cell) => typeof cell.attrs?.value === "number"));
	let index = 0;
	let item = 0;
	const rows = content.map((row, ri): RowView => {
		const role = row.attrs?.role ?? "item";
		const isItem = role === "item";
		if (isItem) {
			index += 1;
			item += 1;
		}
		const rowInputs = row.content.some((cell, ci) => {
			const type = cols[ci]?.type;
			return (type === "money" || type === "number") && typeof cell.attrs?.value === "number";
		});
		const shown = cols.map((c, ci): string | null => {
			const value = computed[ri]?.[ci];
			if (c.type === "index") return isItem ? String(index) : null;
			if (c.type === "number" || c.type === "money") {
				if (isItem) return null;
				return typeof value === "number" && anyValue ? formatNumber(value, c.type) : null;
			}
			if (c.type === "formula") {
				const show = isItem ? rowInputs : role !== "group" && anyValue;
				return typeof value === "number" && show ? formatNumber(value, c.format ?? "number") : null;
			}
			return null;
		});
		return { role, index: isItem ? index : null, stripe: a.zebra && isItem && item % 2 === 0, shown };
	});
	// The PDF counts the rows a list supplies, then the blank ones, in the same run.
	index += sourceRows;
	item += sourceRows;
	const blanks = Array.from({ length: sourceRows ? 0 : a.writeInRows }, () => {
		index += 1;
		item += 1;
		return { index, stripe: a.zebra && item % 2 === 0 };
	});
	return { rows, blanks };
}
