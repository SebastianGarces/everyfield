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

export const tableFromEditor = (table: Json) =>
	mapCells(table, (cell) => (cell.type === "valueCell" ? { ...cell, type: "cell" } : cell));

function mapTables(node: Json, fn: (table: Json) => Json): Json {
	if (node.type === "table") return fn(node);
	if (!node.content) return node;
	return { ...node, content: (node.content as Json[]).map((child) => mapTables(child, fn)) };
}

export const blocksToEditor = (blocks: readonly unknown[]) =>
	blocks.map((block) => mapTables(block as Json, tableToEditor));
export const blocksFromEditor = (blocks: readonly unknown[]) =>
	blocks.map((block) => mapTables(block as Json, tableFromEditor));
