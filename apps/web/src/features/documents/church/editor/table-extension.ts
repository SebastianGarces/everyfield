import {
	attrsOf,
	columnWidths,
	formatNumber,
	parseAmount,
	tableIssue,
	tileBox,
	type ColumnSpec,
	type PageSetup,
	type TableNode,
} from "@everyfield/contracts/documents";
import { Extension, mergeAttributes, Node as TiptapNode, type Editor } from "@tiptap/core";
import { closeHistory } from "@tiptap/pm/history";
import { Fragment, Slice, type Node as PMNode } from "@tiptap/pm/model";
import { NodeSelection, Plugin, PluginKey, TextSelection, type EditorState } from "@tiptap/pm/state";
import { Decoration, type EditorView, type ViewMutationRecord } from "@tiptap/pm/view";
import { attrsOfSpec, BLOCKS, px } from "./attrs.ts";
import { docDecorations } from "./doc-decorations.ts";
import {
	focusPlace,
	newTyping,
	noteCell,
	noteFocus,
	samePlace,
	setAttrs,
	tableContext,
	tableFocusPlugin,
	tableOf,
	typeInto,
} from "./table-actions.ts";
import { blankRows, tableView } from "./table-model.ts";
import type { Place } from "./table-ops.ts";

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
		return ({ node, editor, getPos }) => tableNodeView(node, editor, getPos);
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

// ---------------------------------------------------------------- DOM helpers

function el<K extends keyof HTMLElementTagNameMap>(tag: K, className: string, attrs: Record<string, string> = {}) {
	const node = document.createElement(tag);
	node.className = className;
	for (const [key, value] of Object.entries(attrs)) node.setAttribute(key, value);
	return node;
}
const alignOf = (c: ColumnSpec) => c.align ?? (c.type === "text" ? "left" : "right");

// ---------------------------------------------------------------- moving between cells

/** The places a Tab stops in a table, in reading order: the header labels, then every cell that takes input. */
function stopsOf(table: TableNode): Place[] {
	const a = attrsOf(table);
	const stops: Place[] = [];
	if (a.header) a.columns.forEach((_, col) => stops.push({ row: null, col }));
	(table.content ?? []).forEach((row, r) => {
		const role = row.attrs?.role ?? "item";
		a.columns.forEach((c, col) => {
			if (c.type === "text" || (role === "item" && (c.type === "check" || c.type === "number" || c.type === "money")))
				stops.push({ row: r, col });
		});
	});
	// The blank rows are one stop at the end: a person who lands there can remove a blank row.
	if (!a.source && a.writeInRows > 0) stops.push({ row: null, col: null, blank: true });
	return stops;
}

const TABBABLE =
	'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"]), [contenteditable="true"]';

/**
 * Tab past the last cell or Shift+Tab before the first moves on to the control after or before the table, as the
 * browser would. The editor's own element holds the table, so the browser's choice would be the table's first field
 * again: this picks the next one that is neither inside the table nor around it.
 */
function leaveTable(view: EditorView, tablePos: number, direction: 1 | -1): boolean {
	const dom = view.nodeDOM(tablePos) as HTMLElement | null;
	if (!dom) return false;
	const all = [...document.querySelectorAll<HTMLElement>(TABBABLE)].filter(
		(el) => el.offsetParent !== null && getComputedStyle(el).visibility !== "hidden",
	);
	const inside = all.filter((el) => dom.contains(el));
	const edge = direction > 0 ? inside.at(-1) : inside[0];
	if (!edge) return false;
	let at = all.indexOf(edge) + direction;
	while (all[at] && (dom.contains(all[at]!) || all[at]!.contains(dom))) at += direction;
	const next = all[at];
	// Nothing comes after the table: focus leaves the page's controls, as it does at the end of any page.
	if (next) next.focus();
	else (document.activeElement as HTMLElement | null)?.blur();
	return true;
}

/** Tab (`1`) or Shift+Tab (`-1`) from `from`. At either end it moves on to the next control after or before the table. */
function moveFocus(editor: Editor, tablePos: number, from: Place, direction: 1 | -1): boolean {
	const node = editor.state.doc.nodeAt(tablePos);
	if (!node || node.type.name !== "table") return false;
	const stops = stopsOf(tableOf(node));
	const next = stops[stops.findIndex((s) => samePlace(s, from)) + direction];
	if (!next) return leaveTable(editor.view, tablePos, direction);
	focusPlace(editor.view, tablePos, next);
	return true;
}

/** The keys every field of a table shares: one Undo history for the whole document, and Tab between the stops. */
export function fieldKey(editor: Editor, event: KeyboardEvent, tablePos?: number, stop?: Place | null) {
	const key = event.key.toLowerCase();
	if ((event.metaKey || event.ctrlKey) && !event.altKey && (key === "z" || key === "y")) {
		// The field's own Undo would split a typed amount.
		event.preventDefault();
		if (key === "y" || event.shiftKey) editor.commands.redo();
		else editor.commands.undo();
	} else if (event.key === "Tab" && tablePos !== undefined && stop) {
		if (moveFocus(editor, tablePos, stop, event.shiftKey ? -1 : 1)) event.preventDefault();
	}
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
	let field: HTMLElement | null = null;
	const note = el("span", "ef-vnote", { role: "alert" });
	const typing = newTyping();

	const amountText = () => {
		const value = node.attrs.value;
		return typeof value === "number" && (spec?.kind === "money" || spec?.kind === "number")
			? formatNumber(value, spec.kind)
			: "";
	};
	const setInvalid = (message: string | null) => {
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
	const amountKind = () => (spec?.kind === "money" ? "money" : "number");
	const onKey = (event: KeyboardEvent) => {
		const pos = getPos();
		if (pos === undefined) return;
		// The cell's parent is its row, and the row's parent is the table.
		const $pos = editor.state.doc.resolve(pos);
		fieldKey(editor, event, $pos.before($pos.depth - 1), { row: $pos.index($pos.depth - 1), col: $pos.index() });
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
					const read = parseAmount(input.value, amountKind());
					if (!read.ok) return setInvalid(read.message);
					setInvalid(null);
					const pos = getPos();
					const current = pos === undefined ? null : editor.state.doc.nodeAt(pos);
					if (!current || pos === undefined || (current.attrs.value ?? null) === read.value) return;
					typeInto(editor.view, typing, (tr) => setAttrs(tr, pos, { ...current.attrs, value: read.value }));
				});
				input.addEventListener("blur", () => {
					// The next keystroke is a new Undo step.
					typing.doc = null;
					setInvalid(null);
					input.value = amountText();
				});
				input.addEventListener("keydown", (event) => {
					onKey(event);
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
			const typed = parseAmount(input.value, amountKind());
			// Undo or Redo can change the amount while the field has focus: the field shows the stored amount then too.
			if (document.activeElement !== input || (typed.ok && typed.value !== (node.attrs.value ?? null))) {
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
						setAttrs(closeHistory(editor.state.tr), pos, {
							...current.attrs,
							checked: current.attrs.checked !== true,
						}),
					);
				});
				box.addEventListener("keydown", onKey);
				dom.append(box);
				field = box;
			}
			const box = field as HTMLButtonElement;
			box.setAttribute("aria-label", label);
			box.setAttribute("aria-checked", String(node.attrs.checked === true));
			box.dataset.checked = String(node.attrs.checked === true);
		} else {
			if (!field || field instanceof HTMLInputElement || field instanceof HTMLButtonElement) {
				field = el("span", "ef-computed");
				dom.replaceChildren(field);
			}
			field.textContent = spec?.shown ?? "";
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

/** The width in points the PDF gives a block at the top of the page, or of a card on a sheet of cards. */
function textWidth(page: PageSetup) {
	return (tileBox(page)?.width ?? 0) - (page.tile ? 2 * page.tile.padding : 0);
}

function tableNodeView(initial: PMNode, editor: Editor, getPos: () => number | undefined) {
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
	const typing = newTyping();
	let headKey = "";
	let blankKey = "";

	const table = () => attrsOf(tableOf(node));

	function widths() {
		// The columns have the PDF's widths on any screen: the page's text width, or the share of it a block inside a column
		// or a box has. The table scrolls inside its own area when the screen is narrower than that.
		const paper = dom.closest<HTMLElement>(".ProseMirror")?.clientWidth;
		const share = paper && scroll.clientWidth ? Math.min(1, scroll.clientWidth / paper) : 1;
		const points = columnWidths(table().columns, textWidth(editor.state.doc.attrs.page as PageSetup) * share);
		grid.style.setProperty("--ef-cols", points.map((pt) => px(pt)).join(" "));
		grid.style.minWidth = `${points.reduce((s, pt) => s + pt, 0) * (4 / 3)}px`;
	}

	function drawHead() {
		const a = table();
		const key = JSON.stringify([a.columns.map((c) => [c.type, c.align ?? null]), a.header]);
		if (key === headKey) {
			// The inputs stay while a person types in one. Only Undo and Redo make a value differ from its label.
			a.columns.forEach((c, i) => {
				const cell = head.children[i] as HTMLElement | undefined;
				const input = cell?.firstElementChild as HTMLInputElement | null | undefined;
				if (input && input.value !== c.label) input.value = c.label;
				cell?.setAttribute("aria-label", c.label);
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
			});
			const cell = el("div", "ef-head-wrap", { role: "columnheader", "aria-label": c.label });
			cell.append(input);
			input.value = c.label;
			input.style.textAlign = alignOf(c);
			input.addEventListener("focus", () => noteFocus(editor.view, getPos(), { row: null, col: i }));
			input.addEventListener("blur", () => {
				typing.doc = null;
			});
			input.addEventListener("input", () => {
				const pos = getPos();
				const current = pos === undefined ? null : editor.state.doc.nodeAt(pos);
				if (!current || pos === undefined) return;
				const columns = (current.attrs.columns as ColumnSpec[]).map((col, ci) =>
					ci === i ? { ...col, label: input.value } : col,
				);
				typeInto(editor.view, typing, (tr) => setAttrs(tr, pos, { ...current.attrs, columns }));
			});
			input.addEventListener("keydown", (event) => {
				fieldKey(editor, event, getPos(), { row: null, col: i });
				if (event.key === "Enter") event.preventDefault();
			});
			head.append(cell);
		});
	}

	function drawBlanks() {
		const a = table();
		const rows = blankRows(tableOf(node));
		const count = rows.length;
		const key = JSON.stringify([rows, a.columns.map((c) => [c.type, c.align ?? null])]);
		if (key === blankKey) return;
		blankKey = key;
		blanks.replaceChildren();
		blanks.hidden = count === 0;
		blanks.setAttribute("aria-label", `${count} blank row${count === 1 ? "" : "s"} to write in by hand`);
		for (const blank of rows) {
			const row = el("div", "ef-blank-row", { role: "row", "data-role": "item" });
			if (blank.stripe) row.classList.add("ef-stripe");
			a.columns.forEach((c) => {
				const cell = el("div", "ef-blank-cell", { role: "cell", "data-kind": c.type });
				cell.style.textAlign = alignOf(c);
				if (c.type === "index") cell.textContent = String(blank.index);
				else if (c.type === "check") cell.append(el("span", "ef-blank-box"));
				row.append(cell);
			});
			blanks.append(row);
		}
	}

	function draw() {
		const a = table();
		dom.dataset.headerFill = a.headerFill;
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
	// A change of the table's width lays the columns out again, in the next frame so the observer never loops on itself.
	let seen = scroll.clientWidth;
	const observer = new ResizeObserver(() => {
		if (scroll.clientWidth === seen) return;
		seen = scroll.clientWidth;
		requestAnimationFrame(widths);
	});
	observer.observe(scroll);
	blanks.addEventListener("focus", () => noteFocus(editor.view, getPos(), { row: null, col: 0, blank: true }));
	blanks.addEventListener("keydown", (event) => {
		fieldKey(editor, event, getPos(), { row: null, col: null, blank: true });
	});
	// A change of the page setup changes the widths, also on a screen too narrow for the paper to change.
	let page = editor.state.doc.attrs.page;
	const onTransaction = () => {
		if (editor.state.doc.attrs.page === page) return;
		page = editor.state.doc.attrs.page;
		widths();
	};
	editor.on("transaction", onTransaction);
	return {
		dom,
		contentDOM: body,
		update(next: PMNode) {
			if (next.type !== initial.type) return false;
			node = next;
			const owned = head.contains(document.activeElement) || blanks.contains(document.activeElement);
			draw();
			// Undo or Redo can redraw the header under the person's focus. The focus stays in the table, after this update.
			if (owned && !dom.contains(document.activeElement))
				queueMicrotask(() => {
					const pos = getPos();
					const here = tableContext(editor.state);
					if (dom.contains(document.activeElement)) return;
					if (pos !== undefined && here?.pos === pos && here.at.row === null && here.at.col !== null)
						focusPlace(editor.view, pos, here.at);
					else editor.view.focus();
				});
			return true;
		},
		// Events in the header and the blank rows belong to the table, not to the document's cursor.
		stopEvent: (event: Event) => event.target instanceof Node && !body.contains(event.target),
		ignoreMutation: (mutation: ViewMutationRecord) =>
			mutation.type === "selection" ? false : !body.contains(mutation.target),
		destroy: () => {
			observer.disconnect();
			editor.off("transaction", onTransaction);
		},
	};
}

// ---------------------------------------------------------------- decorations: what each row and cell shows

function decorationsFor(node: PMNode, pos: number): Decoration[] {
	const table = tableOf(node);
	const a = attrsOf(table);
	const view = tableView(table);
	const list: Decoration[] = [];
	let rowPos = pos + 1;
	node.forEach((row, _offset, r) => {
		const shown = view[r];
		if (shown?.stripe) list.push(Decoration.node(rowPos, rowPos + row.nodeSize, { class: "ef-stripe" }));
		let cellPos = rowPos + 1;
		row.forEach((cell, _o, ci) => {
			const column = a.columns[ci];
			if (column) {
				const align = `text-align:${alignOf(column)}`;
				list.push(
					Decoration.node(cellPos, cellPos + cell.nodeSize, { style: align }, {
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
	return list;
}

// ---------------------------------------------------------------- keeping a table valid

/** True when the format accepts the table, and every cell is the editor's node for its column. */
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
	return ok && tableIssue(tableOf(node)) === null;
}

const tablesIn = (doc: PMNode) => {
	const found: { node: PMNode; pos: number }[] = [];
	doc.descendants((node, pos) => {
		if (node.type.name !== "table") return true;
		found.push({ node, pos });
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
	return new Slice(Fragment.from(out), 0, 0);
}

const inCell = (state: EditorState) => cellAt(state.doc, state.selection.from) !== null;

declare module "@tiptap/core" {
	interface EditorEvents {
		tableChangeRefused: void;
	}
}

export const TableRules = Extension.create({
	name: "tableRules",
	addProseMirrorPlugins() {
		return [
			tableFocusPlugin(),
			docDecorations("efTableDisplay", (doc) => tablesIn(doc).flatMap(({ node, pos }) => decorationsFor(node, pos))),
			new Plugin({
				key: new PluginKey("efTableRules"),
				props: {
					// A selection inside a table stays in one cell: a drag or Shift+arrows cannot span cells.
					createSelectionBetween: (_view, $anchor, $head) => {
						const doc = $anchor.doc;
						const start = cellAt(doc, $anchor.pos);
						if (!start) return null;
						if ($head.pos >= start.start && $head.pos <= start.end) return null;
						const head = Math.min(Math.max($head.pos, start.start), start.end);
						return TextSelection.create(doc, $anchor.pos, head);
					},
					// A key typed while the whole table is selected, as Undo or Redo can leave it, would replace the table. It goes to
					// the table's first field instead.
					handleTextInput: (view, _from, _to, text) => {
						const { selection } = view.state;
						if (!(selection instanceof NodeSelection) || selection.node.type.name !== "table") return false;
						const first = stopsOf(tableOf(selection.node))[0];
						if (!first) return true;
						focusPlace(view, selection.from, first);
						const active = document.activeElement;
						if (active instanceof HTMLInputElement) {
							active.setRangeText(text, active.selectionStart ?? 0, active.selectionEnd ?? 0, "end");
							active.dispatchEvent(new Event("input", { bubbles: true }));
						} else if (view.state.selection instanceof TextSelection) view.dispatch(view.state.tr.insertText(text));
						return true;
					},
					transformPastedText: (text, _plain, view) => (inCell(view.state) ? flat(text) : text),
					transformPasted: (slice, view) => (inCell(view.state) ? oneLine(slice) : slice),
				},
				// No change leaves a table the format refuses. A selection can run across a table's edge or its rows, and
				// deleting it must not cost the person a document they cannot save. The editor says why nothing happened.
				filterTransaction: (tr, state) => {
					if (!tr.docChanged) return true;
					const before = new Set(tablesIn(state.doc).map((table) => table.node));
					const fits = tablesIn(tr.doc).every(({ node }) => before.has(node) || validTable(node));
					if (!fits) this.editor.emit("tableChangeRefused");
					return fits;
				},
			}),
		];
	},
	addKeyboardShortcuts() {
		const { editor } = this;
		const swallowInCell = () => inCell(editor.state);
		const atCellEdge = (edge: "start" | "end") => {
			const { selection } = editor.state;
			if (!selection.empty) return false;
			const { $from } = selection;
			if ($from.parent.type.name !== "cell") return false;
			return edge === "start" ? $from.parentOffset === 0 : $from.parentOffset === $from.parent.content.size;
		};
		const selectedAmountCell = () => {
			const { selection } = editor.state;
			return selection instanceof NodeSelection && selection.node.type.name === "valueCell";
		};
		const tab = (direction: 1 | -1) => () => {
			const context = tableContext(editor.state);
			if (!context || context.at.row === null || context.at.col === null) return false;
			return moveFocus(editor, context.pos, { row: context.at.row, col: context.at.col }, direction);
		};
		return {
			// Select all in a cell selects the cell, as in any field: the next key would otherwise replace the whole document.
			"Mod-a": () => {
				const cell = cellAt(editor.state.doc, editor.state.selection.from);
				if (!cell) return false;
				return editor.commands.setTextSelection({ from: cell.start, to: cell.end });
			},
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
