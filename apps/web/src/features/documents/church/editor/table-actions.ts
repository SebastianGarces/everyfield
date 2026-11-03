import { attrsOf, type TableNode } from "@everyfield/contracts/documents";
import type { Editor } from "@tiptap/core";
import { closeHistory } from "@tiptap/pm/history";
import type { Node as PMNode, Schema } from "@tiptap/pm/model";
import { NodeSelection, Plugin, PluginKey, TextSelection, type EditorState, type Transaction } from "@tiptap/pm/state";
import type { EditorView } from "@tiptap/pm/view";
import { clean } from "./document-json.ts";
import { asFormatTable, tableToEditor } from "./table-json.ts";
import type { Place } from "./table-ops.ts";

// The editor side of a table: where the cursor is in it, how a table of the format becomes a node and back, and how an
// action reaches the document. An action replaces the table in one transaction, so one Undo reverses it.

// ---------------------------------------------------------------- the table as a format table

const cache = new WeakMap<PMNode, TableNode>();

/** The table of the format that an editor `table` node holds. Cached for the life of the node. */
export function tableOf(node: PMNode): TableNode {
	let table = cache.get(node);
	if (!table) {
		table = clean(asFormatTable(node.toJSON() as Record<string, unknown>));
		cache.set(node, table);
	}
	return table;
}

/** An editor `table` node for a table of the format. */
export function nodeFromTable(schema: Schema, table: TableNode): PMNode {
	return schema.nodeFromJSON(tableToEditor(table as unknown as Record<string, unknown>));
}

// ---------------------------------------------------------------- where the person is

/**
 * Where the person is when no cell holds the cursor: the column header, or the blank write-in rows. Those are drawn by
 * the table itself, not by the document, so they set this by a transaction note. A move of the selection clears it.
 */
export type TableFocus = { pos: number; area: "head" | "blank"; col: number };
export const tableFocusKey = new PluginKey<TableFocus | null>("efTableFocus");

export function tableFocusPlugin() {
	return new Plugin<TableFocus | null>({
		key: tableFocusKey,
		state: {
			init: () => null,
			apply(tr, value) {
				const set = tr.getMeta(tableFocusKey) as TableFocus | null | undefined;
				if (set !== undefined) return set;
				if (!value) return null;
				if (tr.selectionSet) return null;
				return tr.docChanged ? { ...value, pos: tr.mapping.map(value.pos, -1) } : value;
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

/** The table that holds the selection, with the row and column of the cursor. */
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
	if (!node || node.type.name !== "table") return null;
	let at: Place = { row: null, blank: null, col: null };
	if (depth >= 1 && $from.depth > depth) {
		// A cursor in a text cell has the row and cell above it; a selected amount cell sits in its row.
		const row = $from.index(depth);
		const col =
			$from.depth >= depth + 2
				? $from.index(depth + 1)
				: selection instanceof NodeSelection
					? $from.index(depth + 1)
					: null;
		at = { row, blank: null, col };
	} else {
		const focus = tableFocusKey.getState(state);
		if (focus && focus.pos === pos) at = { row: null, blank: focus.area === "blank" ? 0 : null, col: focus.col };
	}
	return { pos, node, table: tableOf(node), at };
}

// ---------------------------------------------------------------- selections

/** Where the cursor goes in a table: the end of a text cell, or the selected amount cell, else the table itself. */
export function selectIn(tr: Transaction, tablePos: number, place: Place, area: "head" | "blank" = "head") {
	const table = tr.doc.nodeAt(tablePos);
	if (!table) return tr;
	if (place.row !== null && place.row < table.childCount) {
		const row = table.child(place.row);
		let cellPos = tablePos + 1;
		for (let i = 0; i < place.row; i++) cellPos += table.child(i).nodeSize;
		cellPos += 1;
		const index = Math.min(Math.max(place.col ?? 0, 0), row.childCount - 1);
		for (let i = 0; i < index; i++) cellPos += row.child(i).nodeSize;
		const cell = row.child(index);
		return cell.type.name === "valueCell"
			? tr.setSelection(NodeSelection.create(tr.doc, cellPos))
			: tr.setSelection(TextSelection.create(tr.doc, cellPos + 1 + cell.content.size));
	}
	const col = Math.min(Math.max(place.col ?? 0, 0), Math.max(0, attrsOf(tableOf(table)).columns.length - 1));
	return tr
		.setSelection(NodeSelection.create(tr.doc, tablePos))
		.setMeta(tableFocusKey, { pos: tablePos, area: place.blank !== null ? "blank" : area, col } satisfies TableFocus);
}

// ---------------------------------------------------------------- actions

/**
 * Replaces the table by `next` in one transaction and puts the cursor at `place`. When only the attributes changed, the
 * node keeps its rows, so its cells keep their text and their focus.
 */
export function applyTable(
	editor: Editor,
	context: TableContext,
	next: TableNode,
	place: Place,
	area?: "head" | "blank",
) {
	const { state } = editor;
	const tr = closeHistory(state.tr);
	const replacement = nodeFromTable(state.schema, next);
	const end = context.pos + context.node.nodeSize;
	if (replacement.content.eq(context.node.content)) {
		// Only attributes changed: the rows stay, and so does the cursor.
		tr.setNodeMarkup(context.pos, undefined, replacement.attrs);
	} else {
		tr.replaceWith(context.pos, end, replacement);
		selectIn(tr, context.pos, place, area);
	}
	editor.view.dispatch(tr.scrollIntoView());
}

// ---------------------------------------------------------------- typing into a field of the table

/** One stretch of typing into a field: its transactions share one Undo step. */
export type Typing = { time: number; doc: PMNode | null };
export const newTyping = (): Typing => ({ time: 0, doc: null });

/**
 * Dispatches one keystroke of a field. The first keystroke after focus (or after any other change to the document,
 * Undo included) starts an Undo step; the next ones join it, so one typed amount is one Undo step.
 */
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

/** Notes that the cursor is in the table's own header or blank rows, so the table controls know the column. */
export function noteFocus(view: EditorView, pos: number | undefined, area: "head" | "blank", col: number) {
	if (pos === undefined) return;
	const node = view.state.doc.nodeAt(pos);
	if (!node || node.type.name !== "table") return;
	const tr = view.state.tr
		.setSelection(NodeSelection.create(view.state.doc, pos))
		.setMeta("addToHistory", false)
		.setMeta(tableFocusKey, { pos, area, col } satisfies TableFocus);
	view.dispatch(tr);
}

/** Selects the amount or check box cell at `pos` so the table controls know its row and column. */
export function noteCell(view: EditorView, pos: number | undefined) {
	if (pos === undefined) return;
	const node = view.state.doc.nodeAt(pos);
	if (!node || node.type.name !== "valueCell") return;
	const { selection } = view.state;
	if (selection instanceof NodeSelection && selection.from === pos) return;
	view.dispatch(view.state.tr.setSelection(NodeSelection.create(view.state.doc, pos)).setMeta("addToHistory", false));
}
