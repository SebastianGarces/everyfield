// Between a table of the format and a table of the editor. The format has one `cell`. The editor has two: `cell` holds
// text (a text column) and `valueCell` is a leaf that draws an amount field, a check box or a computed number (every
// other column). The two share the format's attributes, so the stored cell reads back unchanged. A text cell is the
// only cell a cursor can enter, so no key press can put a cursor into a cell that holds no text.

type Json = Record<string, unknown>;

function mapCells(table: Json, fn: (cell: Json, column: number) => Json): Json {
	if (!table.content) return table;
	return {
		...table,
		content: (table.content as Json[]).map((row) =>
			row.content ? { ...row, content: (row.content as Json[]).map(fn) } : row,
		),
	};
}

/** A table of the format as the editor holds it. */
export function tableToEditor(table: Json): Json {
	const columns = (table.attrs as { columns?: { type: string }[] } | undefined)?.columns ?? [];
	return mapCells(table, (cell, ci) => {
		const type = columns[ci]?.type;
		if (!type || type === "text") return cell;
		const rest: Json = { ...cell, type: "valueCell" };
		delete rest.content;
		return rest;
	});
}

/** A table of the editor as the format stores it. */
export const tableFromEditor = (table: Json) =>
	mapCells(table, (cell) => (cell.type === "valueCell" ? { ...cell, type: "cell" } : cell));

/** `fn` applied to every table in a block, columns and boxes included. A table's rows are not walked. */
function mapTables(node: Json, fn: (table: Json) => Json): Json {
	if (node.type === "table") return fn(node);
	if (!node.content) return node;
	return { ...node, content: (node.content as Json[]).map((child) => mapTables(child, fn)) };
}

export const blocksToEditor = (blocks: readonly unknown[]) =>
	blocks.map((block) => mapTables(block as Json, tableToEditor));
export const blocksFromEditor = (blocks: readonly unknown[]) =>
	blocks.map((block) => mapTables(block as Json, tableFromEditor));
