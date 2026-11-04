import { attrsOf, computeTable, formatNumber, type RowRole, type TableNode } from "@everyfield/contracts/documents";

// What a table shows in the places a person does not type: the numbers a subtotal, a total or a formula column computes,
// the row numbers, and the rows the PDF stripes. The numbers come from the format's own `computeTable`. The rules for when
// a number shows, how rows count and which rows stripe repeat those in the PDF (layouts/doc.tsx) and the Word file
// (doc-docx.ts), since each walks its own rows. AC:WP-036-5, -6 and -13 compare the three.

type RowView = {
	role: RowRole;
	/** True on the rows the PDF shades when `zebra` is on. */
	stripe: boolean;
	/** The text of each cell that is computed, formatted as the PDF prints it; null where the cell takes input or is blank. */
	shown: (string | null)[];
};

export function tableView(table: TableNode): RowView[] {
	const a = attrsOf(table);
	const cols = a.columns;
	const computed = computeTable(table);
	const content = table.content ?? [];
	const anyValue = content.some((row) => row.content.some((cell) => typeof cell.attrs?.value === "number"));
	let index = 0;
	return content.map((row, ri): RowView => {
		const role = row.attrs?.role ?? "item";
		const isItem = role === "item";
		if (isItem) index += 1;
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
		return { role, stripe: a.zebra && isItem && index % 2 === 0, shown };
	});
}

/** The blank write-in rows, with the row number and stripe of each: they count on after the typed rows. A list has none. */
export function blankRows(table: TableNode): { index: number; stripe: boolean }[] {
	const a = attrsOf(table);
	const typed = (table.content ?? []).filter((row) => (row.attrs?.role ?? "item") === "item").length;
	return Array.from({ length: a.source ? 0 : a.writeInRows }, (_, k) => ({
		index: typed + k + 1,
		stripe: a.zebra && (typed + k + 1) % 2 === 0,
	}));
}
