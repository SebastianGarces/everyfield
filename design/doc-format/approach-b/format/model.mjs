// Shared pure helpers of the approach B format: page geometry and ledger arithmetic.
// The validator, the tests and the prototype import this module. It has no dependencies and runs in node and in a browser.

/** Page presets in PDF points (72 per inch), portrait. */
export const PAGE_PRESETS = {
	letter: { width: 612, height: 792, label: "Letter 8.5 × 11 in" },
	legal: { width: 612, height: 1008, label: "Legal 8.5 × 14 in" },
	a4: { width: 595.28, height: 841.89, label: "A4 210 × 297 mm" },
	"half-letter": { width: 396, height: 612, label: "Half letter 5.5 × 8.5 in" },
	card: { width: 306, height: 396, label: "Card 4.25 × 5.5 in" },
};

/** The trimmed page of a document after orientation, in points. */
export function pageBox(page) {
	const preset = page.size === "custom" ? { width: page.width, height: page.height } : PAGE_PRESETS[page.size];
	const { width, height } = preset;
	const landscape = page.orientation === "landscape";
	return landscape ? { width: Math.max(width, height), height: Math.min(width, height) } : { width, height };
}

/**
 * The printed sheet when the page setup imposes copies (for example 4 cards on one Letter sheet). The sheet takes the
 * orientation that fits the grid; null when the grid does not fit either way.
 */
export function sheetBox(page) {
	if (!page.imposition) return null;
	const trim = pageBox(page);
	const { across, down } = page.imposition;
	const sheet = PAGE_PRESETS[page.imposition.sheet];
	const need = { width: trim.width * across, height: trim.height * down };
	const eps = 0.5;
	for (const box of [
		{ width: sheet.width, height: sheet.height },
		{ width: sheet.height, height: sheet.width },
	])
		if (need.width <= box.width + eps && need.height <= box.height + eps) return box;
	return null;
}

const add = (a, b) => Math.round((a + b) * 100) / 100;
const value = (amount) => (typeof amount === "number" ? amount : 0);

/**
 * Every computed number of a ledger. A line's total is the sum of its periods (rule `sum`) or its first period times
 * the factor (rule `times`, the monthly-to-annual worksheet). A group subtotal sums its lines in each period. A result
 * adds the `plus` groups and subtracts the `minus` groups. Empty amounts count as zero.
 */
export function computeLedger(ledger) {
	const n = ledger.periods.count;
	const lineTotal = (amounts) =>
		ledger.total.rule === "times"
			? Math.round(value(amounts[0]) * (ledger.total.factor ?? 12) * 100) / 100
			: amounts.reduce((sum, a) => add(sum, value(a)), 0);
	const lines = {};
	const groups = {};
	for (const group of ledger.groups) {
		const periods = Array(n).fill(0);
		for (const line of group.lines) {
			const amounts = Array.from({ length: n }, (_, i) => line.amounts[i] ?? null);
			lines[line.id] = { periods: amounts.map(value), total: lineTotal(amounts) };
			amounts.forEach((a, i) => (periods[i] = add(periods[i], value(a))));
		}
		groups[group.id] = { periods, total: group.lines.reduce((sum, l) => add(sum, lines[l.id].total), 0) };
	}
	const results = {};
	for (const result of ledger.results) {
		const periods = Array(n).fill(0);
		let total = 0;
		for (const [ids, sign] of [
			[result.plus, 1],
			[result.minus, -1],
		])
			for (const id of ids) {
				const g = groups[id];
				if (!g) continue;
				g.periods.forEach((p, i) => (periods[i] = add(periods[i], sign * p)));
				total = add(total, sign * g.total);
			}
		results[result.id] = { periods, total };
	}
	return { lines, groups, results };
}

/** Walks every block of a document (header, body, footer and nested blocks), calling visit(block, path). */
export function walkBlocks(doc, visit) {
	const walk = (blocks, path) =>
		(blocks ?? []).forEach((block, i) => {
			const here = `${path}[${i}]`;
			visit(block, here);
			if (block.type === "slot" || block.type === "box") walk(block.blocks, `${here}.blocks`);
			if (block.type === "columns")
				block.columns.forEach((col, c) => walk(col.blocks, `${here}.columns[${c}].blocks`));
		});
	for (const part of ["header", "body", "footer"]) walk(doc[part], `/${part}`);
}

/** Every inline node list a block holds, with its path. */
export function inlineListsOf(block, path) {
	const out = [];
	if (Array.isArray(block.content)) out.push([block.content, `${path}.content`]);
	if (block.type === "list") block.items.forEach((item, i) => out.push([item.content, `${path}.items[${i}].content`]));
	if (block.type === "table")
		block.rows.forEach((row, r) =>
			row.cells.forEach((cell, c) => {
				if (cell.type === "text") out.push([cell.content, `${path}.rows[${r}].cells[${c}].content`]);
			}),
		);
	return out;
}
