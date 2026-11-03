import type { TableNode } from "@everyfield/contracts/documents";

// Between a table of the format and a table of the editor. The format has one `cell`. The editor has two: `cell` holds
// text (a text column) and `valueCell` is a leaf that draws an amount field, a check box or a computed number (every
// other column). The two share the format's attributes, so the stored cell reads back unchanged. A text cell is the
// only cell a cursor can enter, so no key press can put a cursor into a cell that holds no text.

type Json = Record<string, unknown>;
const isRec = (value: unknown): value is Json => !!value && typeof value === "object" && !Array.isArray(value);
const list = (value: unknown): Json[] => (Array.isArray(value) ? (value as Json[]) : []);

/** True when a column holds typed text. Every other kind is drawn by the editor, not typed into by a cursor. */
export const holdsText = (column: { type: string } | undefined) => !column || column.type === "text";

function columnsOf(table: Json): { type: string }[] {
	const attrs = table.attrs;
	return isRec(attrs) ? (list(attrs.columns) as { type: string }[]) : [];
}

function retype(table: Json, to: "valueCell" | "cell"): Json {
	const columns = columnsOf(table);
	if (!table.content) return table;
	const rows = list(table.content).map((row) => {
		if (!isRec(row) || !row.content) return row;
		return {
			...row,
			content: list(row.content).map((cell, ci) => {
				if (!isRec(cell)) return cell;
				if (to === "valueCell") {
					if (holdsText(columns[ci])) return cell;
					const rest: Json = { ...cell, type: "valueCell" };
					delete rest.content;
					return rest;
				}
				return cell.type === "valueCell" ? { ...cell, type: "cell" } : cell;
			}),
		};
	});
	return { ...table, content: rows };
}

/** A table of the format as the editor holds it. */
export const tableToEditor = (table: Json) => retype(table, "valueCell");
/** A table of the editor as the format stores it. */
export const tableFromEditor = (table: Json) => retype(table, "cell");

/** `fn` applied to every table in a block, columns and boxes included. A table's rows are not walked. */
export function mapTables(node: Json, fn: (table: Json) => Json): Json {
	if (node.type === "table") return fn(node);
	if (!node.content) return node;
	return { ...node, content: list(node.content).map((child) => (isRec(child) ? mapTables(child, fn) : child)) };
}

export const blocksToEditor = (blocks: readonly unknown[]) =>
	blocks.map((block) => (isRec(block) ? mapTables(block, tableToEditor) : block));
export const blocksFromEditor = (blocks: readonly unknown[]) =>
	blocks.map((block) => (isRec(block) ? mapTables(block, tableFromEditor) : block));

/** The format table that an editor `table` node holds, from its JSON. */
export const asFormatTable = (editorTable: Json): TableNode => tableFromEditor(editorTable) as unknown as TableNode;
