import {
	attrsOf,
	columnWidths,
	formatNumber,
	parseAmount,
	type ColumnSpec,
	type TableNode,
} from "@everyfield/contracts/documents";
import { Extension, mergeAttributes, Node as TiptapNode, type Editor } from "@tiptap/core";
import { closeHistory } from "@tiptap/pm/history";
import { Fragment, Slice, type Node as PMNode } from "@tiptap/pm/model";
import { NodeSelection, Plugin, PluginKey, TextSelection, type EditorState } from "@tiptap/pm/state";
import { Decoration, DecorationSet, type EditorView, type ViewMutationRecord } from "@tiptap/pm/view";
import { attrsOfSpec, BLOCKS, px } from "./attrs.ts";
import {
	newTyping,
	noteCell,
	noteFocus,
	selectIn,
	tableContext,
	tableFocusPlugin,
	tableOf,
	typeInto,
	type TableContext,
} from "./table-actions.ts";
import { tableView } from "./table-model.ts";

// The table the editor draws and edits. It is the format's own `table`, not Tiptap's general table. A text column holds
// typed text in `cell` nodes. Every other column holds `valueCell` leaves that this file draws: an amount field, a check
// box, or a number the table computes. The header and the blank write-in rows are drawn by the table, since the format
// stores them as the column list and a count.

// ---------------------------------------------------------------- nodes

export const EfTable = TiptapNode.create({
	name: "table",
	group: BLOCKS,
	content: "row*",
	isolating: true,
	selectable: true,
	draggable: false,
	addAttributes() {
		return attrsOfSpec({
			columns: "json",
			style: "string",
			header: "boolean",
			headerFill: "string",
			zebra: "boolean",
			writeInRows: "number",
			rowHeight: "number",
			source: "string",
			sheet: "string",
		});
	},
	parseHTML: () => [{ tag: 'div[data-ef-node="table"]' }],
	renderHTML: ({ HTMLAttributes }) => [
		"div",
		mergeAttributes(HTMLAttributes, { "data-ef-node": "table", role: "table" }),
		0,
	],
	addNodeView() {
		return ({ node, editor, getPos, decorations }) => tableNodeView(node, editor, getPos, decorations);
	},
});

export const EfRow = TiptapNode.create({
	name: "row",
	content: "(cell | valueCell)+",
	isolating: true,
	selectable: false,
	addAttributes() {
		return attrsOfSpec({ role: "string", sign: "string" });
	},
	parseHTML: () => [{ tag: 'div[data-ef-node="row"]' }],
	renderHTML: ({ node, HTMLAttributes }) => [
		"div",
		mergeAttributes(HTMLAttributes, {
			"data-ef-node": "row",
			role: "row",
			"data-role": String(node.attrs.role ?? "item"),
		}),
		0,
	],
});

/** A cell of a text column: typed text and nothing else. Enter makes no paragraph here, since a cell is one line. */
export const EfCell = TiptapNode.create({
	name: "cell",
	content: "inline*",
	isolating: true,
	selectable: false,
	addAttributes() {
		return attrsOfSpec({ value: "number", checked: "boolean" });
	},
	parseHTML: () => [{ tag: 'div[data-ef-node="cell"]:not([data-ef-cell="value"])' }],
	renderHTML: ({ HTMLAttributes }) => [
		"div",
		mergeAttributes(HTMLAttributes, { "data-ef-node": "cell", "data-ef-cell": "text", role: "cell" }),
		0,
	],
});

/** A cell of any other column: an amount, a check box, a row number or a computed number. */
export const EfValueCell = TiptapNode.create({
	name: "valueCell",
	atom: true,
	isolating: true,
	selectable: true,
	draggable: false,
	addAttributes() {
		return attrsOfSpec({ value: "number", checked: "boolean" });
	},
	parseHTML: () => [{ tag: 'div[data-ef-node="cell"][data-ef-cell="value"]' }],
	renderHTML: ({ HTMLAttributes }) => [
		"div",
		mergeAttributes(HTMLAttributes, { "data-ef-node": "cell", "data-ef-cell": "value", role: "cell" }),
	],
	addNodeView() {
		return ({ node, editor, getPos, decorations }) => valueCellView(node, editor, getPos, decorations);
	},
});

// ---------------------------------------------------------------- what the decorations tell a cell

/** What the cell draws, from its row and column. Numbers and strings only, so a change redraws the cell. */
type CellSpec = { kind: ColumnSpec["type"]; shown: string | null; input: boolean; label: string; row: number };
const cellSpecOf = (decorations: readonly Decoration[]): CellSpec | null => {
	for (const d of decorations) {
		const spec = (d as unknown as { spec?: Partial<CellSpec> }).spec;
		if (spec && typeof spec.kind === "string") return spec as CellSpec;
	}
	return null;
};
type TableSpec = { items: number };
const tableSpecOf = (decorations: readonly Decoration[]): TableSpec => {
	for (const d of decorations) {
		const spec = (d as unknown as { spec?: Partial<TableSpec> }).spec;
		if (spec && typeof spec.items === "number") return spec as TableSpec;
	}
	return { items: 0 };
};

// ---------------------------------------------------------------- DOM helpers

function el<K extends keyof HTMLElementTagNameMap>(tag: K, className: string, attrs: Record<string, string> = {}) {
	const node = document.createElement(tag);
	node.className = className;
	for (const [key, value] of Object.entries(attrs)) node.setAttribute(key, value);
	return node;
}
const alignOf = (c: ColumnSpec) => c.align ?? (c.type === "text" ? "left" : "right");

// ---------------------------------------------------------------- moving between cells

type Stop = { area: "head"; col: number } | { area: "cell"; row: number; col: number };

/** The places a Tab stops in a table, in reading order: the header labels, then every cell that takes input. */
function stopsOf(context: TableContext): Stop[] {
	const table = context.table;
	const a = attrsOf(table);
	const stops: Stop[] = [];
	if (a.header) a.columns.forEach((_, col) => stops.push({ area: "head", col }));
	(table.content ?? []).forEach((row, r) => {
		const role = row.attrs?.role ?? "item";
		a.columns.forEach((c, col) => {
			if (c.type === "text" || (role === "item" && (c.type === "check" || c.type === "number" || c.type === "money")))
				stops.push({ area: "cell", row: r, col });
		});
	});
	return stops;
}

const sameStop = (a: Stop, b: Stop) =>
	a.area === b.area && a.col === b.col && (a.area === "head" || (b.area === "cell" && a.row === b.row));

function focusStop(view: EditorView, context: TableContext, stop: Stop) {
	if (stop.area === "head") {
		const dom = view.nodeDOM(context.pos) as HTMLElement | null;
		(dom?.querySelectorAll<HTMLInputElement>(".ef-head-cell")[stop.col] ?? null)?.focus();
		return;
	}
	const tr = selectIn(view.state.tr.setMeta("addToHistory", false), context.pos, {
		row: stop.row,
		blank: null,
		col: stop.col,
	});
	view.dispatch(tr);
	// A text cell takes the editor's cursor; an amount or check box cell takes its own field.
	if (tr.selection instanceof NodeSelection && tr.selection.node.type.name === "valueCell") {
		const dom = view.nodeDOM(tr.selection.from) as HTMLElement | null;
		dom?.querySelector<HTMLElement>("input, button")?.focus();
	} else view.focus();
}

/** Tab (`1`) or Shift+Tab (`-1`) from `from`. False at either end, so the browser moves on to the next control. */
export function moveFocus(editor: Editor, tablePos: number, from: Stop | null, direction: 1 | -1): boolean {
	const node = editor.state.doc.nodeAt(tablePos);
	if (!node || node.type.name !== "table") return false;
	const context: TableContext = {
		pos: tablePos,
		node,
		table: tableOf(node),
		at: { row: null, blank: null, col: null },
	};
	const stops = stopsOf(context);
	const at = from ? stops.findIndex((s) => sameStop(s, from)) : -1;
	const next = stops[at < 0 ? (direction > 0 ? 0 : stops.length - 1) : at + direction];
	if (!next) return false;
	focusStop(editor.view, context, next);
	return true;
}

/** The stop that holds the editor's cursor, if it is in a table cell. */
function stopOfSelection(state: EditorState): { pos: number; stop: Stop } | null {
	const context = tableContext(state);
	if (!context || context.at.row === null || context.at.col === null) return null;
	return { pos: context.pos, stop: { area: "cell", row: context.at.row, col: context.at.col } };
}

// ---------------------------------------------------------------- the amount and check box cell

function valueCellView(
	initial: PMNode,
	editor: Editor,
	getPos: () => number | undefined,
	initialDecorations: readonly Decoration[],
) {
	const dom = el("div", "ef-vcell", { "data-ef-node": "cell", "data-ef-cell": "value", role: "cell" });
	dom.contentEditable = "false";
	let node = initial;
	let spec = cellSpecOf(initialDecorations);
	let field: HTMLInputElement | HTMLButtonElement | HTMLElement | null = null;
	const note = el("span", "ef-vnote", { role: "alert" });
	const typing = newTyping();
	let invalid: string | null = null;

	const amountText = () => {
		const value = node.attrs.value;
		return typeof value === "number" && (spec?.kind === "money" || spec?.kind === "number")
			? formatNumber(value, spec.kind)
			: "";
	};
	const setInvalid = (message: string | null) => {
		invalid = message;
		note.textContent = message ?? "";
		if (field instanceof HTMLInputElement) {
			if (message) {
				field.setAttribute("aria-invalid", "true");
				field.setAttribute("aria-describedby", note.id);
			} else {
				field.removeAttribute("aria-invalid");
				field.removeAttribute("aria-describedby");
			}
		}
	};
	const tablePosOf = () => {
		const pos = getPos();
		if (pos === undefined) return undefined;
		const $pos = editor.state.doc.resolve(pos);
		for (let d = $pos.depth; d >= 1; d--) if ($pos.node(d).type.name === "table") return $pos.before(d);
		return undefined;
	};
	const stopHere = (): Stop | null => {
		const pos = getPos();
		if (pos === undefined) return null;
		const $pos = editor.state.doc.resolve(pos);
		return { area: "cell", row: $pos.index($pos.depth - 1), col: $pos.index($pos.depth) };
	};
	const arrow = (event: KeyboardEvent) => {
		const key = event.key;
		if ((event.metaKey || event.ctrlKey) && !event.altKey && key.toLowerCase() === "z") {
			// One history for the whole document: the field's own Undo would split a typed amount.
			event.preventDefault();
			if (event.shiftKey) editor.commands.redo();
			else editor.commands.undo();
		} else if ((event.metaKey || event.ctrlKey) && !event.altKey && key.toLowerCase() === "y") {
			event.preventDefault();
			editor.commands.redo();
		} else if (key === "Tab") {
			const pos = tablePosOf();
			if (pos !== undefined && moveFocus(editor, pos, stopHere(), event.shiftKey ? -1 : 1)) event.preventDefault();
		}
	};

	function build() {
		const kind = spec?.kind;
		const amount = kind === "money" || kind === "number";
		const wantsInput = !!spec?.input && amount;
		const wantsBox = !!spec?.input && kind === "check";
		const label = spec ? `${spec.label}, row ${spec.row}` : "Cell";
		if (wantsInput) {
			if (!(field instanceof HTMLInputElement)) {
				dom.replaceChildren();
				const input = el("input", "ef-vinput", {
					type: "text",
					inputmode: "decimal",
					autocomplete: "off",
					maxlength: "24",
				});
				note.id = `ef-vnote-${Math.random().toString(36).slice(2)}`;
				input.addEventListener("focus", () => {
					noteCell(editor.view, getPos());
					input.select();
				});
				input.addEventListener("input", () => {
					const read = parseAmount(input.value, kind === "money" ? "money" : "number");
					if (!read.ok) return setInvalid(read.message);
					setInvalid(null);
					const pos = getPos();
					const current = pos === undefined ? null : editor.state.doc.nodeAt(pos);
					if (!current || pos === undefined || (current.attrs.value ?? null) === read.value) return;
					typeInto(editor.view, typing, (tr) =>
						tr.setNodeMarkup(pos, undefined, { ...current.attrs, value: read.value }),
					);
				});
				input.addEventListener("blur", () => {
					setInvalid(null);
					input.value = amountText();
				});
				input.addEventListener("keydown", (event) => {
					arrow(event);
					if (event.key === "Enter") event.preventDefault();
					if (event.key === "Escape") {
						input.value = amountText();
						setInvalid(null);
						input.blur();
						editor.view.focus();
					}
				});
				dom.append(input, note);
				field = input;
			}
			const input = field as HTMLInputElement;
			input.setAttribute("aria-label", label);
			const typed = parseAmount(input.value, kind === "money" ? "money" : "number");
			if (document.activeElement !== input) {
				input.value = amountText();
				if (invalid) setInvalid(null);
			} else if (typed.ok && (typed.value ?? null) !== (node.attrs.value ?? null)) {
				// Undo or Redo changed the amount while the field had focus: the field shows the stored amount.
				input.value = amountText();
				setInvalid(null);
			}
		} else if (wantsBox) {
			if (!(field instanceof HTMLButtonElement)) {
				dom.replaceChildren();
				const box = el("button", "ef-vcheck", { type: "button", role: "checkbox" });
				box.addEventListener("focus", () => noteCell(editor.view, getPos()));
				box.addEventListener("click", () => {
					const pos = getPos();
					const current = pos === undefined ? null : editor.state.doc.nodeAt(pos);
					if (!current || pos === undefined) return;
					editor.view.dispatch(
						closeHistory(editor.state.tr).setNodeMarkup(pos, undefined, {
							...current.attrs,
							checked: current.attrs.checked !== true,
						}),
					);
				});
				box.addEventListener("keydown", arrow);
				dom.append(box);
				field = box;
			}
			const box = field as HTMLButtonElement;
			box.setAttribute("aria-label", label);
			box.setAttribute("aria-checked", String(node.attrs.checked === true));
			box.dataset.checked = String(node.attrs.checked === true);
		} else {
			if (field && (field instanceof HTMLInputElement || field instanceof HTMLButtonElement)) dom.replaceChildren();
			if (!field || field instanceof HTMLInputElement || field instanceof HTMLButtonElement) {
				field = el("span", "ef-computed");
				dom.replaceChildren(field);
			}
			field.textContent = spec?.shown ?? "";
			dom.dataset.shown = spec?.shown ?? "";
		}
	}
	build();
	return {
		dom,
		update(next: PMNode, decorations: readonly Decoration[]) {
			if (next.type !== initial.type) return false;
			node = next;
			spec = cellSpecOf(decorations) ?? spec;
			build();
			return true;
		},
		stopEvent: (event: Event) => event.target instanceof Element && event.target.closest("input, button") !== null,
		ignoreMutation: () => true,
	};
}

// ---------------------------------------------------------------- the table

function tableNodeView(
	initial: PMNode,
	editor: Editor,
	getPos: () => number | undefined,
	initialDecorations: readonly Decoration[],
) {
	const dom = el("div", "ef-table", { "data-ef-node": "table" });
	const scroll = el("div", "ef-table-scroll");
	const grid = el("div", "ef-table-grid", { role: "table" });
	const head = el("div", "ef-table-head", { role: "row" });
	const body = el("div", "ef-table-body", { role: "rowgroup" });
	const blanks = el("div", "ef-table-blanks", { role: "rowgroup", tabindex: "0" });
	const note = el("p", "ef-table-note");
	head.contentEditable = "false";
	blanks.contentEditable = "false";
	note.contentEditable = "false";
	grid.append(head, body, blanks);
	scroll.append(grid);
	dom.append(scroll, note);
	let node = initial;
	let items = tableSpecOf(initialDecorations).items;
	const typing = newTyping();
	let headKey = "";
	let blankKey = "";

	const table = () => formatAttrs(node);

	function widths() {
		const cols = table().columns;
		// The editor lays the columns out by the same rule as the PDF, over the width the table has here.
		const available = Math.max(0, scroll.clientWidth) * 0.75;
		const points = columnWidths(cols, available);
		grid.style.setProperty("--ef-cols", points.map((pt) => px(pt)).join(" "));
		grid.style.minWidth = `${points.reduce((s, pt) => s + pt, 0) * (4 / 3)}px`;
	}

	function drawHead() {
		const a = table();
		const key = JSON.stringify([a.columns.map((c) => [c.label, c.type, c.align ?? null]), a.header]);
		if (key === headKey) {
			// Labels are not rewritten while a person types in one.
			a.columns.forEach((c, i) => {
				const input = head.children[i] as HTMLInputElement | undefined;
				if (input && document.activeElement !== input && input.value !== c.label) input.value = c.label;
			});
			return;
		}
		headKey = key;
		head.replaceChildren();
		head.hidden = !a.header;
		a.columns.forEach((c, i) => {
			const input = el("input", "ef-head-cell", {
				type: "text",
				maxlength: "80",
				"aria-label": `Label of column ${i + 1}`,
				role: "columnheader",
			});
			input.value = c.label;
			input.style.textAlign = alignOf(c);
			input.addEventListener("focus", () => noteFocus(editor.view, getPos(), "head", i));
			input.addEventListener("input", () => {
				const pos = getPos();
				const current = pos === undefined ? null : editor.state.doc.nodeAt(pos);
				if (!current || pos === undefined) return;
				const columns = (current.attrs.columns as ColumnSpec[]).map((col, ci) =>
					ci === i ? { ...col, label: input.value } : col,
				);
				typeInto(editor.view, typing, (tr) => tr.setNodeMarkup(pos, undefined, { ...current.attrs, columns }));
			});
			input.addEventListener("keydown", (event) => {
				if ((event.metaKey || event.ctrlKey) && !event.altKey && event.key.toLowerCase() === "z") {
					event.preventDefault();
					if (event.shiftKey) editor.commands.redo();
					else editor.commands.undo();
				} else if ((event.metaKey || event.ctrlKey) && !event.altKey && event.key.toLowerCase() === "y") {
					event.preventDefault();
					editor.commands.redo();
				} else if (event.key === "Tab") {
					const pos = getPos();
					if (pos !== undefined && moveFocus(editor, pos, { area: "head", col: i }, event.shiftKey ? -1 : 1))
						event.preventDefault();
				} else if (event.key === "Enter") event.preventDefault();
			});
			head.append(input);
		});
	}

	function drawBlanks() {
		const a = table();
		const count = a.source ? 0 : a.writeInRows;
		const key = JSON.stringify([count, items, a.zebra, a.columns.map((c) => [c.type, c.align ?? null])]);
		if (key === blankKey) return;
		blankKey = key;
		blanks.replaceChildren();
		blanks.hidden = count === 0;
		blanks.setAttribute("aria-label", `${count} blank row${count === 1 ? "" : "s"} to write in by hand`);
		for (let k = 1; k <= count; k++) {
			const row = el("div", "ef-blank-row", { role: "row", "data-role": "item" });
			if (a.zebra && (items + k) % 2 === 0) row.classList.add("ef-stripe");
			a.columns.forEach((c) => {
				const cell = el("div", "ef-blank-cell", { role: "cell", "data-kind": c.type });
				cell.style.textAlign = alignOf(c);
				if (c.type === "index") cell.textContent = String(items + k);
				else if (c.type === "check") cell.append(el("span", "ef-blank-box"));
				row.append(cell);
			});
			blanks.append(row);
		}
	}

	function draw() {
		const a = table();
		dom.dataset.style = a.style;
		dom.dataset.headerFill = a.headerFill;
		dom.dataset.header = String(a.header);
		dom.dataset.zebra = String(a.zebra);
		grid.setAttribute("aria-label", a.sheet ?? "Table");
		grid.setAttribute("aria-rowcount", String(node.childCount + (a.source ? 0 : a.writeInRows) + (a.header ? 1 : 0)));
		if (a.rowHeight) grid.style.setProperty("--ef-row-h", px(a.rowHeight));
		else grid.style.removeProperty("--ef-row-h");
		note.textContent = a.source ? `The rows of this table come from the "${a.source}" field.` : "";
		note.hidden = !a.source;
		drawHead();
		drawBlanks();
		widths();
	}
	draw();
	const observer = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(() => widths());
	observer?.observe(scroll);
	blanks.addEventListener("focus", () => noteFocus(editor.view, getPos(), "blank", 0));
	return {
		dom,
		contentDOM: body,
		update(next: PMNode, decorations: readonly Decoration[]) {
			if (next.type !== initial.type) return false;
			node = next;
			items = tableSpecOf(decorations).items;
			draw();
			return true;
		},
		// Events in the header and the blank rows belong to the table, not to the document's cursor.
		stopEvent: (event: Event) => event.target instanceof Node && !body.contains(event.target),
		ignoreMutation: (mutation: ViewMutationRecord) =>
			mutation.type === "selection" ? false : !body.contains(mutation.target),
		destroy: () => observer?.disconnect(),
	};
}

/** The attributes of a table node with the format's defaults, for drawing. */
function formatAttrs(node: PMNode) {
	const json = {
		type: "table",
		attrs: Object.fromEntries(Object.entries(node.attrs).filter(([, v]) => v !== undefined)),
	} as unknown as TableNode;
	return attrsOf(json);
}

// ---------------------------------------------------------------- decorations: what each row and cell shows

type Cached = { pos: number; list: Decoration[] };
const decorationCache = new WeakMap<PMNode, Cached>();

function decorationsFor(node: PMNode, pos: number, lists: Record<string, number>): Decoration[] {
	const hit = decorationCache.get(node);
	if (hit && hit.pos === pos) return hit.list;
	const table = tableOf(node);
	const a = attrsOf(table);
	const sourceRows = a.source ? (lists[a.source] ?? 0) : 0;
	const view = tableView(table, sourceRows);
	const list: Decoration[] = [];
	const typedItems = view.rows.filter((r) => r.role === "item").length;
	list.push(Decoration.node(pos, pos + node.nodeSize, {}, { items: typedItems + sourceRows }));
	let rowPos = pos + 1;
	node.forEach((row, _offset, r) => {
		const shown = view.rows[r];
		const attrs: Record<string, string> = {};
		if (shown?.stripe) attrs.class = "ef-stripe";
		if (a.rowHeight) attrs.style = `min-height:${px(a.rowHeight)}`;
		if (Object.keys(attrs).length) list.push(Decoration.node(rowPos, rowPos + row.nodeSize, attrs));
		let cellPos = rowPos + 1;
		row.forEach((cell, _o, ci) => {
			const column = a.columns[ci];
			if (column) {
				const align = `text-align:${alignOf(column)}`;
				list.push(
					Decoration.node(cellPos, cellPos + cell.nodeSize, { style: align, "data-col": String(ci) }, {
						kind: column.type,
						shown: shown?.shown[ci] ?? null,
						input: (shown?.role ?? "item") === "item",
						label: column.label,
						row: r + 1,
					} satisfies CellSpec),
				);
			}
			cellPos += cell.nodeSize;
		});
		rowPos += row.nodeSize;
	});
	decorationCache.set(node, { pos, list });
	return list;
}

function tableDecorations(doc: PMNode, lists: Record<string, number>) {
	const found: Decoration[] = [];
	doc.descendants((node, pos) => {
		if (node.type.name !== "table") return true;
		found.push(...decorationsFor(node, pos, lists));
		return false;
	});
	return DecorationSet.create(doc, found);
}

// ---------------------------------------------------------------- keeping a table valid

/** True when every row has one cell for each column, and a cell of the kind its column needs. */
function validTable(node: PMNode): boolean {
	const columns = node.attrs.columns as { type: string }[] | undefined;
	if (!Array.isArray(columns) || columns.length === 0) return false;
	let ok = true;
	node.forEach((row) => {
		if (row.childCount !== columns.length) ok = false;
		else
			row.forEach((cell, _o, ci) => {
				const text = columns[ci]?.type === "text";
				if (text !== (cell.type.name === "cell")) ok = false;
			});
	});
	return ok;
}

const tablesIn = (doc: PMNode) => {
	const found: PMNode[] = [];
	doc.descendants((node) => {
		if (node.type.name !== "table") return true;
		found.push(node);
		return false;
	});
	return found;
};

/** The cell that holds a position, or null. */
function cellAt(doc: PMNode, pos: number) {
	const $pos = doc.resolve(pos);
	for (let d = $pos.depth; d >= 1; d--)
		if ($pos.node(d).type.name === "cell") return { start: $pos.start(d), end: $pos.end(d) };
	return null;
}

const flat = (text: string) => text.replace(/\s*[\r\n]+\s*/g, " ");

/** The inline content of a slice as one line: blocks and line breaks become spaces. */
function oneLine(slice: Slice): Slice {
	const out: PMNode[] = [];
	const push = (node: PMNode) => {
		if (node.isText) out.push(node.type.schema.text(flat(node.text ?? ""), node.marks));
		else if (node.type.name === "hardBreak") out.push(node.type.schema.text(" "));
		else if (node.isInline) out.push(node);
	};
	let first = true;
	const walk = (fragment: Fragment) =>
		fragment.forEach((child) => {
			if (child.isInline) push(child);
			else {
				if (child.isTextblock && !first) out.push(child.type.schema.text(" "));
				if (child.isTextblock) first = false;
				walk(child.content);
			}
		});
	walk(slice.content);
	const trimmed = out.filter((n) => !n.isText || (n.text ?? "") !== "");
	return new Slice(Fragment.from(trimmed), 0, 0);
}

const inCell = (state: EditorState) => {
	const $from = state.selection.$from;
	for (let d = $from.depth; d >= 1; d--) if ($from.node(d).type.name === "cell") return true;
	return false;
};

export const TableRules = Extension.create<{ lists: Record<string, number> }>({
	name: "tableRules",
	addOptions: () => ({ lists: {} }),
	addProseMirrorPlugins() {
		const lists = this.options.lists;
		return [
			tableFocusPlugin(),
			new Plugin({
				key: new PluginKey("efTableDisplay"),
				props: {
					decorations: (state) => tableDecorations(state.doc, lists),
					// A selection inside a table stays in one cell: a drag or Shift+arrows cannot span cells.
					createSelectionBetween: (_view, $anchor, $head) => {
						const doc = $anchor.doc;
						const start = cellAt(doc, $anchor.pos);
						if (!start) return null;
						if ($head.pos >= start.start && $head.pos <= start.end) return null;
						const head = Math.min(Math.max($head.pos, start.start), start.end);
						return TextSelection.create(doc, $anchor.pos, head);
					},
					transformPastedText: (text, _plain, view) => (inCell(view.state) ? flat(text) : text),
					transformPasted: (slice, view) => (inCell(view.state) ? oneLine(slice) : slice),
				},
				// No change leaves a row short of a cell or with a cell of the wrong kind: that would not parse.
				filterTransaction: (tr, state) => {
					if (!tr.docChanged) return true;
					const before = new Set(tablesIn(state.doc));
					return tablesIn(tr.doc).every((table) => before.has(table) || validTable(table));
				},
			}),
		];
	},
	addKeyboardShortcuts() {
		const editor = () => this.editor;
		const swallowInCell = () => inCell(editor().state);
		const atCellEdge = (edge: "start" | "end") => {
			const { selection } = editor().state;
			if (!selection.empty) return false;
			const { $from } = selection;
			if ($from.parent.type.name !== "cell") return false;
			return edge === "start" ? $from.parentOffset === 0 : $from.parentOffset === $from.parent.content.size;
		};
		const selectedAmountCell = () => {
			const { selection } = editor().state;
			return selection instanceof NodeSelection && selection.node.type.name === "valueCell";
		};
		const tab = (direction: 1 | -1) => () => {
			const here = stopOfSelection(editor().state);
			return here ? moveFocus(editor(), here.pos, here.stop, direction) : false;
		};
		return {
			// A cell is one line: no paragraph, no line break.
			Enter: swallowInCell,
			"Shift-Enter": swallowInCell,
			"Mod-Enter": swallowInCell,
			// Backspace at the start of a cell and Delete at its end would take the neighbor cell with them.
			Backspace: () => atCellEdge("start") || selectedAmountCell(),
			Delete: () => atCellEdge("end") || selectedAmountCell(),
			Tab: tab(1),
			"Shift-Tab": tab(-1),
		};
	},
});
