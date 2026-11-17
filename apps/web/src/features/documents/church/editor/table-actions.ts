import { attrsOf, type TableNode } from "@everyfield/contracts/documents";
import type { Editor } from "@tiptap/core";
import { closeHistory } from "@tiptap/pm/history";
import type { Attrs, Node as PMNode, Schema } from "@tiptap/pm/model";
import { NodeSelection, Plugin, PluginKey, TextSelection, type EditorState, type Transaction } from "@tiptap/pm/state";
import type { EditorView } from "@tiptap/pm/view";
import { clean } from "./document-json.ts";
import { tableFromEditor, tableToEditor } from "./table-json.ts";
import type { Place } from "./table-ops.ts";

const cache = new WeakMap<PMNode, TableNode>();

export function tableOf(node: PMNode): TableNode {
	let table = cache.get(node);
	if (!table) {
		table = clean(tableFromEditor(node.toJSON() as Record<string, unknown>)) as unknown as TableNode;
		cache.set(node, table);
	}
	return table;
}

export function nodeFromTable(schema: Schema, table: TableNode): PMNode {
	return schema.nodeFromJSON(tableToEditor(table as unknown as Record<string, unknown>));
}

type TableFocus = { pos: number; blank: boolean; col: number };
const tableFocusKey = new PluginKey<TableFocus | null>("efTableFocus");

export function tableFocusPlugin() {
	return new Plugin<TableFocus | null>({
		key: tableFocusKey,
		state: {
			init: () => null,
			apply(tr, value) {
				const set = tr.getMeta(tableFocusKey) as TableFocus | null | undefined;
				if (set !== undefined) return set;
				if (!value) return null;
				const pos = tr.mapping.map(value.pos, -1);
				const { selection } = tr;
				return selection instanceof NodeSelection && selection.from === pos && selection.node.type.name === "table"
					? { ...value, pos }
					: null;
			},
		},
	});
}

export type TableContext = {
	pos: number;
	node: PMNode;
	table: TableNode;
	at: Place;
};

export function tableContext(state: EditorState): TableContext | null {
	const { selection } = state;
	const $from = selection.$from;
	let pos = -1;
	let depth = -1;
	for (let d = $from.depth; d >= 1; d--) {
		if ($from.node(d).type.name === "table") {
			pos = $from.before(d);
			depth = d;
			break;
		}
	}
	if (pos < 0 && selection instanceof NodeSelection && selection.node.type.name === "table") pos = selection.from;
	if (pos < 0) return null;
	const node = state.doc.nodeAt(pos);
	if (!node) return null;
	const table = tableOf(node);
	let at: Place = { row: null, col: null };
	if (depth >= 1 && $from.depth > depth) {
		at = { row: $from.index(depth), col: $from.index(depth + 1) };
	} else {
		const focus = tableFocusKey.getState(state);
		const a = attrsOf(table);
		if (focus && focus.pos === pos)
			at = {
				row: null,
				col: Math.min(focus.col, a.columns.length - 1),
				blank: focus.blank && a.writeInRows > 0,
			};
	}
	return { pos, node, table, at };
}

export function selectIn(tr: Transaction, tablePos: number, place: Place) {
	const table = tr.doc.nodeAt(tablePos);
	if (!table) return tr;
	if (place.row !== null && place.row < table.childCount) {
		const row = table.child(place.row);
		let cellPos = tablePos + 1;
		for (let i = 0; i < place.row; i++) cellPos += table.child(i).nodeSize;
		cellPos += 1;
		const index = Math.min(place.col ?? 0, row.childCount - 1);
		for (let i = 0; i < index; i++) cellPos += row.child(i).nodeSize;
		const cell = row.child(index);
		return cell.type.name === "valueCell"
			? tr.setSelection(NodeSelection.create(tr.doc, cellPos))
			: tr.setSelection(TextSelection.create(tr.doc, cellPos + 1 + cell.content.size));
	}
	const col = Math.min(place.col ?? 0, attrsOf(tableOf(table)).columns.length - 1);
	return tr
		.setSelection(NodeSelection.create(tr.doc, tablePos))
		.setMeta(tableFocusKey, { pos: tablePos, blank: place.blank === true, col } satisfies TableFocus);
}

export function setAttrs(tr: Transaction, pos: number, attrs: Attrs) {
	const selected = tr.selection instanceof NodeSelection && tr.selection.from === pos;
	tr.setNodeMarkup(pos, undefined, attrs);
	return selected ? tr.setSelection(NodeSelection.create(tr.doc, pos)) : tr;
}

export function focusPlace(view: EditorView, tablePos: number, place: Place) {
	const table = view.nodeDOM(tablePos) as HTMLElement | null;
	if (place.row === null) {
		const label = table?.querySelectorAll<HTMLInputElement>(".ef-head-cell")[place.col ?? 0];
		const blanks = table?.querySelector<HTMLElement>(".ef-table-blanks");
		if (label && !place.blank) {
			label.focus();
			label.select();
		} else blanks?.focus();
		return;
	}
	const tr = selectIn(view.state.tr, tablePos, place);
	view.dispatch(tr);
	const field =
		tr.selection instanceof NodeSelection
			? (view.nodeDOM(tr.selection.from) as HTMLElement | null)?.querySelector<HTMLElement>("input, button")
			: null;
	if (field) field.focus();
	else view.focus();
}

export const samePlace = (a: Place, b: Place) => a.row === b.row && a.col === b.col && !a.blank === !b.blank;

export function applyTable(editor: Editor, context: TableContext, next: TableNode, place: Place) {
	const { state, view } = editor;
	const tr = closeHistory(state.tr);
	const replacement = nodeFromTable(state.schema, next);
	const end = context.pos + context.node.nodeSize;
	const rowsChanged = !replacement.content.eq(context.node.content);
	const moved = rowsChanged || !samePlace(place, context.at);
	if (rowsChanged) tr.replaceWith(context.pos, end, replacement);
	else setAttrs(tr, context.pos, replacement.attrs);
	if (moved) selectIn(tr, context.pos, place);
	const inTable = (view.nodeDOM(context.pos) as HTMLElement | null)?.contains(document.activeElement) === true;
	view.dispatch(tr.scrollIntoView());
	if (moved && inTable) focusPlace(view, context.pos, place);
}

export type Typing = { time: number; doc: PMNode | null };
export const newTyping = (): Typing => ({ time: 0, doc: null });

export function typeInto(view: EditorView, typing: Typing, make: (tr: Transaction) => Transaction) {
	const tr = make(view.state.tr);
	if (typing.doc === view.state.doc && typing.time) tr.setTime(typing.time);
	else {
		closeHistory(tr);
		typing.time = tr.time;
	}
	view.dispatch(tr);
	typing.doc = view.state.doc;
}

export function noteFocus(view: EditorView, pos: number | undefined, place: Place) {
	if (pos !== undefined) view.dispatch(selectIn(view.state.tr, pos, place));
}

export function noteCell(view: EditorView, pos: number | undefined) {
	if (pos === undefined) return;
	const { selection } = view.state;
	if (selection instanceof NodeSelection && selection.from === pos) return;
	view.dispatch(view.state.tr.setSelection(NodeSelection.create(view.state.doc, pos)));
}
