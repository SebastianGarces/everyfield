import type { Editor } from "@tiptap/core";
import { closeHistory } from "@tiptap/pm/history";
import { Fragment, type Node as PMNode, type Schema } from "@tiptap/pm/model";
import { NodeSelection, Selection, TextSelection, type EditorState, type Transaction } from "@tiptap/pm/state";
import type { Condition } from "./condition.ts";
import { conditionIssue } from "./condition-extension.ts";
import { focusPlace, nodeFromTable, selectIn } from "./table-actions.ts";
import { newBudget, newChecklist, newGrid } from "./table-ops.ts";

// Whole-block actions: Insert, Move up, Move down and Delete act on the top-level block that holds the cursor or the
// selected block. Each one is one transaction, so one Undo reverses it. A block inside a list, quote, column or box
// moves with its top-level parent.

type BlockRange = { index: number; from: number; to: number; node: PMNode };

/** The children of the document that are body blocks: the page header leads and the page footer ends the list. */
function bodyRange(doc: PMNode) {
	const first = doc.firstChild?.type.name === "pageHeader" ? 1 : 0;
	const footer = doc.lastChild?.type.name === "pageFooter" && doc.childCount > first ? 1 : 0;
	return { first, end: doc.childCount - footer };
}

/** The top-level body block that holds the selection, or null when the body has no blocks or the cursor is in the header or footer. */
export function currentBlock(state: EditorState): BlockRange | null {
	const { doc, selection } = state;
	const { first, end } = bodyRange(doc);
	if (end <= first) return null;
	const $from = selection.$from;
	// A selected top-level block has depth 0; a cursor inside one has depth 1 or more.
	let index: number;
	if (selection instanceof NodeSelection && $from.depth === 0) index = $from.index(0);
	else if ($from.depth === 0) index = Math.min(Math.max($from.index(0), first), end - 1);
	else index = $from.index(0);
	if (index < first || index >= end) return null;
	let from = 0;
	for (let i = 0; i < index; i++) from += doc.child(i).nodeSize;
	return { index, from, to: from + doc.child(index).nodeSize, node: doc.child(index) };
}

// `closeHistory` ends the Undo group before this step, so one Undo reverses exactly this action.
const history = (tr: Transaction) => closeHistory(tr).scrollIntoView();

export type InsertKind =
	| "paragraph"
	| "heading"
	| "bulletList"
	| "orderedList"
	| "quote"
	| "divider"
	| "accentBar"
	| "spacer"
	| "pageBreak"
	| "columns2"
	| "columns3"
	| "columns4"
	| "box"
	| "writeIn"
	| "signature"
	| "dateLine"
	| "logo"
	| "mark"
	| "photo"
	| "table"
	| "checklist"
	| "budget"
	| "if";
type InsertGroup = "text" | "rules" | "layout" | "lines" | "images" | "tables" | "conditions";
export const INSERT_KINDS: { kind: InsertKind; label: string; group: InsertGroup }[] = [
	{ kind: "paragraph", label: "Paragraph", group: "text" },
	{ kind: "heading", label: "Heading", group: "text" },
	{ kind: "bulletList", label: "Bulleted list", group: "text" },
	{ kind: "orderedList", label: "Numbered list", group: "text" },
	{ kind: "quote", label: "Quote", group: "text" },
	{ kind: "divider", label: "Divider", group: "rules" },
	{ kind: "accentBar", label: "Accent bar", group: "rules" },
	{ kind: "spacer", label: "Spacer", group: "rules" },
	{ kind: "pageBreak", label: "Page break", group: "rules" },
	{ kind: "columns2", label: "2 columns", group: "layout" },
	{ kind: "columns3", label: "3 columns", group: "layout" },
	{ kind: "columns4", label: "4 columns", group: "layout" },
	{ kind: "box", label: "Colored box", group: "layout" },
	{ kind: "writeIn", label: "Write-in line", group: "lines" },
	{ kind: "signature", label: "Signature line", group: "lines" },
	{ kind: "dateLine", label: "Date line", group: "lines" },
	{ kind: "logo", label: "Logo", group: "images" },
	{ kind: "mark", label: "Mark", group: "images" },
	{ kind: "photo", label: "Photo", group: "images" },
	{ kind: "table", label: "Table", group: "tables" },
	{ kind: "checklist", label: "Checklist rows", group: "tables" },
	{ kind: "budget", label: "Budget table", group: "tables" },
	{ kind: "if", label: "Conditional text", group: "conditions" },
];

/** The brand-kit sources the image items offer, and what each is called in the brand kit. */
export const IMAGE_KINDS = { logo: "full logo", mark: "mark", photo: "cover photo" } as const;
export type ImageKind = keyof typeof IMAGE_KINDS;

/** Default size in points of a new image: the format's own default for a logo, a square mark, a wide photo. */
const IMAGE_SIZE: Record<ImageKind, { width: number; height: number } | undefined> = {
	logo: undefined,
	mark: { width: 48, height: 48 },
	photo: { width: 360, height: 140 },
};

/** The condition a probe node carries, to ask the schema where conditional text may go. */
const PROBE: Condition = { field: "field", test: "has-value" };

function build(schema: Schema, kind: InsertKind, alt = "", condition: Condition = PROBE): PMNode {
	const type = (name: string) => {
		const found = schema.nodes[name];
		if (!found) throw new Error(`the schema has no ${name}`);
		return found;
	};
	const paragraph = () => type("paragraph").create();
	switch (kind) {
		case "heading":
			return type("heading").create({ level: 2 });
		case "bulletList":
		case "orderedList":
			return type(kind).create(null, type("listItem").create(null, paragraph()));
		case "quote":
			return type("quote").create(null, paragraph());
		case "paragraph":
			return paragraph();
		case "accentBar":
			return type("divider").create({ weight: "bar", color: "accent" });
		case "columns2":
		case "columns3":
		case "columns4": {
			const count = Number(kind.slice(-1));
			return type("columns").create(
				null,
				Array.from({ length: count }, () => type("column").create(null, paragraph())),
			);
		}
		case "box":
			return type("box").create(null, paragraph());
		case "writeIn":
			return type("writeIn").create({ kind: "text", label: "Name", key: "name" });
		case "signature":
			return type("writeIn").create({ kind: "signature", label: "Signature", key: "signature" });
		case "dateLine":
			return type("writeIn").create({ kind: "date", label: "Date", key: "date" });
		case "logo":
		case "mark":
		case "photo":
			return type("image").create({ source: kind, ...IMAGE_SIZE[kind], ...(alt ? { alt } : {}) });
		case "table":
			return nodeFromTable(schema, newGrid());
		case "checklist":
			return nodeFromTable(schema, newChecklist());
		case "budget":
			return nodeFromTable(schema, newBudget());
		case "if":
			return type("if").create(condition, paragraph());
		default:
			return type(kind).create();
	}
}

const CONTAINER_NAMES = new Set(["doc", "column", "box", "pageHeader", "pageFooter", "if"]);

/**
 * Where Insert puts a block: after the block that holds the selection, inside the innermost column, box, conditional
 * text, header or footer. New conditional text goes after the conditional text that holds the selection, not into it.
 */
function insertionPoint(state: EditorState, kind?: InsertKind): { pos: number; parent: PMNode; index: number } {
	const { selection, doc } = state;
	const $from = selection.$from;
	for (let d = $from.depth; d >= 0; d--) {
		const node = $from.node(d);
		if (!CONTAINER_NAMES.has(node.type.name)) continue;
		if (kind === "if" && node.type.name === "if") continue;
		let pos: number;
		if (selection instanceof NodeSelection && d === $from.depth) pos = selection.to;
		else if ($from.depth > d) pos = $from.after(d + 1);
		else pos = $from.pos;
		// The body never reaches into the header or the footer.
		const { first, end } = bodyRange(doc);
		if (node.type.name === "doc") {
			let start = 0;
			for (let i = 0; i < first; i++) start += doc.child(i).nodeSize;
			let stop = start;
			for (let i = first; i < end; i++) stop += doc.child(i).nodeSize;
			pos = Math.min(Math.max(pos, start), stop);
		}
		return { pos, parent: node, index: doc.resolve(pos).index() };
	}
	return { pos: 0, parent: doc, index: 0 };
}

/** True when the schema lets this block sit at the place Insert would put it. Hidden in the menu when it cannot. */
export function canInsert(state: EditorState, kind: InsertKind): boolean {
	// A budget table sits in the body: the page header and footer print no Excel file.
	if (kind === "budget" && regionAt(state)) return false;
	const { pos, parent, index } = insertionPoint(state, kind);
	const node = build(state.schema, kind);
	if (!parent.canReplaceWith(index, index, node.type)) return false;
	// Conditional text, or a block going into it: the format's rules for where it sits and what it holds.
	if (kind === "if" || insideCondition(state)) return conditionIssue(state.tr.insert(pos, node).doc) === null;
	return true;
}

/** True when the selection is inside conditional text. */
function insideCondition(state: EditorState) {
	const $from = state.selection.$from;
	for (let d = $from.depth; d > 0; d--) if ($from.node(d).type.name === "if") return true;
	return state.selection instanceof NodeSelection && state.selection.node.type.name === "if";
}

/** The page header or footer that holds the selection, or null. */
export function regionAt(state: EditorState): "pageHeader" | "pageFooter" | null {
	const $from = state.selection.$from;
	for (let d = $from.depth; d >= 0; d--) {
		const name = $from.node(d).type.name;
		if (name === "pageHeader" || name === "pageFooter") return name;
	}
	return null;
}

const labelPlace = { row: null, col: 0 };

/**
 * Adds a block after the current block. Text blocks take the cursor. `alt` is the asset's alternative text for an image;
 * `condition` is what new conditional text tests. Conditional text holds one empty paragraph, which takes the cursor.
 */
export function insertBlock(editor: Editor, kind: InsertKind, alt = "", condition?: Condition): boolean {
	const { state } = editor;
	if (!canInsert(state, kind) || (kind === "if" && !condition)) return false;
	const { pos: at, parent, index } = insertionPoint(state, kind);
	const node = build(state.schema, kind, alt, condition);
	const tr = history(state.tr);
	const textual = ["paragraph", "heading", "bulletList", "orderedList", "quote"].includes(node.type.name);
	const next = parent.maybeChild(index);
	const atEnd = !next || next.type.name === "pageFooter";
	// A block with no text of its own at the end of its container gets an empty paragraph after it, so the cursor has
	// somewhere to go.
	const addParagraph = !textual && atEnd;
	tr.insert(at, addParagraph ? Fragment.from([node, build(state.schema, "paragraph")]) : node);
	if (node.isLeaf) {
		const after = at + node.nodeSize;
		const near = tr.doc.resolve(Math.min(after, tr.doc.content.size));
		tr.setSelection(
			addParagraph || after < tr.doc.content.size ? Selection.near(near, 1) : NodeSelection.create(tr.doc, at),
		);
	} else if (node.type.name === "table") {
		// The cursor goes into the first text cell; a table with no typed row yet takes its first header label below.
		let firstText: number | null = null;
		node.descendants((child, offset) => {
			if (firstText === null && child.type.name === "cell") firstText = at + 1 + offset;
			return firstText === null;
		});
		if (firstText !== null) tr.setSelection(TextSelection.create(tr.doc, firstText + 1));
		else selectIn(tr, at, labelPlace);
	} else tr.setSelection(Selection.near(tr.doc.resolve(at + 1), 1));
	editor.view.dispatch(tr);
	editor.view.focus();
	if (tr.selection instanceof NodeSelection && tr.selection.node.type.name === "table")
		focusPlace(editor.view, at, labelPlace);
	return true;
}

/** Adds a page number at the cursor. It works only in the page header or footer. */
export function insertPageNumber(editor: Editor, format: "page" | "page-of-total"): boolean {
	if (!regionAt(editor.state)) return false;
	const type = editor.state.schema.nodes.pageNumber;
	if (!type) return false;
	const { selection } = editor.state;
	if (!selection.$from.parent.inlineContent) return false;
	const tr = history(editor.state.tr).replaceSelectionWith(type.create({ format }), false);
	editor.view.dispatch(tr);
	editor.view.focus();
	return true;
}

export function canMove(state: EditorState, direction: -1 | 1): boolean {
	const block = currentBlock(state);
	if (!block) return false;
	const { first, end } = bodyRange(state.doc);
	return direction === -1 ? block.index > first : block.index < end - 1;
}

/** Swaps the current top-level block with its neighbor. The cursor or the block selection moves with it. */
export function moveBlock(editor: Editor, direction: -1 | 1): boolean {
	const { state } = editor;
	const block = currentBlock(state);
	if (!block || !canMove(state, direction)) return false;
	const neighbor = state.doc.child(block.index + direction);
	const selectionOffset = state.selection.from - block.from;
	const tr = history(state.tr);
	let start: number;
	if (direction === -1) {
		start = block.from - neighbor.nodeSize;
		tr.delete(block.from, block.to).insert(start, block.node);
	} else {
		start = block.from + neighbor.nodeSize;
		tr.insert(block.to + neighbor.nodeSize, block.node).delete(block.from, block.to);
	}
	if (state.selection instanceof NodeSelection) tr.setSelection(NodeSelection.create(tr.doc, start));
	else
		tr.setSelection(TextSelection.create(tr.doc, Math.min(start + selectionOffset, start + block.node.nodeSize - 1)));
	editor.view.dispatch(tr);
	editor.view.focus();
	return true;
}

/** Deletes the current top-level block. The cursor lands in the block that took its place. */
export function deleteBlock(editor: Editor): boolean {
	const { state } = editor;
	const block = currentBlock(state);
	if (!block) return false;
	const tr = history(state.tr).delete(block.from, block.to);
	if (tr.doc.childCount > 0) {
		const pos = Math.min(block.from, tr.doc.content.size);
		tr.setSelection(Selection.near(tr.doc.resolve(pos), pos >= tr.doc.content.size ? -1 : 1));
	}
	editor.view.dispatch(tr);
	editor.view.focus();
	return true;
}

// ---------------------------------------------------------------- conditional text

/** The block "Make conditional" wraps: the one that holds the selection in the innermost body, column or box. */
function wrapTarget(state: EditorState): { from: number; node: PMNode } | null {
	const { selection } = state;
	const $from = selection.$from;
	for (let d = $from.depth; d >= 0; d--) {
		const name = $from.node(d).type.name;
		if (name === "if" || name === "pageHeader" || name === "pageFooter") return null;
		if (name !== "doc" && name !== "column" && name !== "box") continue;
		if ($from.depth > d) return { from: $from.before(d + 1), node: $from.node(d + 1) };
		if (selection instanceof NodeSelection) return { from: selection.from, node: selection.node };
		return null;
	}
	return null;
}

/** The document with the current block wrapped in conditional text, or null when the format would refuse it there. */
function wrapped(state: EditorState, condition: Condition) {
	const target = wrapTarget(state);
	const type = state.schema.nodes.if;
	if (!target || !type) return null;
	const node = type.create(condition, target.node);
	const tr = state.tr.replaceWith(target.from, target.from + target.node.nodeSize, node);
	return conditionIssue(tr.doc) === null ? { tr, target } : null;
}

/** True when the current block can become conditional text here. The header and the footer never offer it. */
export const canWrap = (state: EditorState) => wrapped(state, PROBE) !== null;

/** Wraps the current block in conditional text that tests `condition`. The cursor stays where it was, one level in. */
export function wrapBlock(editor: Editor, condition: Condition): boolean {
	const { state } = editor;
	const done = wrapped(state, condition);
	if (!done) return false;
	const { tr, target } = done;
	const { selection } = state;
	const inside = selection.from >= target.from && selection.to <= target.from + target.node.nodeSize;
	if (selection instanceof NodeSelection && inside) tr.setSelection(NodeSelection.create(tr.doc, selection.from + 1));
	else if (inside) tr.setSelection(TextSelection.create(tr.doc, selection.from + 1, selection.to + 1));
	else tr.setSelection(Selection.near(tr.doc.resolve(target.from + 2), 1));
	editor.view.dispatch(history(tr));
	editor.view.focus();
	return true;
}

/** Removes the condition of the conditional text at `pos`: its blocks stay in place as plain blocks. */
export function removeCondition(editor: Editor, pos: number): boolean {
	const { state } = editor;
	const node = state.doc.nodeAt(pos);
	if (!node || node.type.name !== "if") return false;
	const { selection } = state;
	const end = pos + node.nodeSize;
	const tr = history(state.tr).replaceWith(pos, end, node.content);
	if (selection.from > pos && selection.to < end) {
		if (selection instanceof NodeSelection) tr.setSelection(NodeSelection.create(tr.doc, selection.from - 1));
		else tr.setSelection(TextSelection.create(tr.doc, selection.from - 1, selection.to - 1));
	}
	editor.view.dispatch(tr);
	editor.view.focus();
	return true;
}

/** Empties the body, the header and the footer in one step, so one Undo brings all three back. */
export function deleteAllContent(editor: Editor): boolean {
	const { state } = editor;
	editor.view.dispatch(history(state.tr).delete(0, state.doc.content.size));
	return true;
}

// ---------------------------------------------------------------- text styles

export type TextStyle = "body" | "lead" | "small" | "kicker" | "h1" | "h2" | "h3";
export const TEXT_STYLES: { style: TextStyle; label: string }[] = [
	{ style: "body", label: "Body" },
	{ style: "lead", label: "Lead" },
	{ style: "small", label: "Small" },
	{ style: "kicker", label: "Kicker" },
	{ style: "h1", label: "Heading 1" },
	{ style: "h2", label: "Heading 2" },
	{ style: "h3", label: "Heading 3" },
];

/** The style of the text block that holds the cursor, or null when the selection is not in a paragraph or heading. */
export function currentTextStyle(state: EditorState): TextStyle | null {
	const parent = state.selection.$from.parent;
	if (parent.type.name === "heading") {
		const level = typeof parent.attrs.level === "number" ? parent.attrs.level : 2;
		return `h${level}` as TextStyle;
	}
	if (parent.type.name === "paragraph") return (parent.attrs.style as TextStyle | undefined) ?? "body";
	return null;
}

function styleChain(editor: Editor, style: TextStyle) {
	const parent = editor.state.selection.$from.parent;
	const chain = editor.chain().setMeta("closeHistory", true).focus();
	const align = parent.attrs.align as string | undefined;
	if (style.startsWith("h")) {
		const level = Number(style.slice(1));
		return parent.type.name === "heading"
			? chain.updateAttributes("heading", { level })
			: chain.setNode("heading", { level, align });
	}
	const next = style === "body" ? undefined : style;
	return parent.type.name === "heading"
		? chain.setNode("paragraph", { align, style: next })
		: chain.updateAttributes("paragraph", { style: next });
}

export const canSetTextStyle = (editor: Editor, style: TextStyle) =>
	currentTextStyle(editor.state) !== null && canRun(editor, style);
function canRun(editor: Editor, style: TextStyle) {
	const parent = editor.state.selection.$from.parent;
	if (!style.startsWith("h")) return true;
	if (parent.type.name === "heading") return true;
	return editor.can().setNode("heading", { level: Number(style.slice(1)) });
}

export const setTextStyle = (editor: Editor, style: TextStyle) => styleChain(editor, style).run();

/** Turns heading numbers on or off for the heading that holds the cursor. Only levels 2 and 3 print a number. */
export function canNumber(state: EditorState) {
	const parent = state.selection.$from.parent;
	return parent.type.name === "heading" && (parent.attrs.level ?? 2) !== 1;
}
export const isNumbered = (state: EditorState) => state.selection.$from.parent.attrs.numbered === true;
export function toggleNumbered(editor: Editor) {
	const next = isNumbered(editor.state) ? undefined : true;
	return editor.chain().setMeta("closeHistory", true).focus().updateAttributes("heading", { numbered: next }).run();
}
