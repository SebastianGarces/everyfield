import { attrsOf, computeTable, formatNumber, type RowRole, type TableNode } from "@everyfield/contracts/documents";

type RowView = {
	role: RowRole;
	stripe: boolean;
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

export function blankRows(table: TableNode): { index: number; stripe: boolean }[] {
	const a = attrsOf(table);
	const typed = (table.content ?? []).filter((row) => (row.attrs?.role ?? "item") === "item").length;
	return Array.from({ length: a.source ? 0 : a.writeInRows }, (_, k) => ({
		index: typed + k + 1,
		stripe: a.zebra && (typed + k + 1) % 2 === 0,
	}));
}
