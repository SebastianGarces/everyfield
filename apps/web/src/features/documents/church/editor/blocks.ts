import type { Editor } from "@tiptap/core";
import { Fragment, type Node as PMNode } from "@tiptap/pm/model";
import { NodeSelection, Selection, TextSelection, type EditorState, type Transaction } from "@tiptap/pm/state";

// Whole-block actions: Insert, Move up, Move down and Delete act on the top-level block that holds the cursor or the
// selected block. Each one is one transaction, so one Undo reverses it. A block inside a list, quote, column or box
// moves with its top-level parent.

export type BlockRange = { index: number; from: number; to: number; node: PMNode };

/** The top-level block that holds the selection, or null when the document has no blocks. */
export function currentBlock(state: EditorState): BlockRange | null {
	const { doc, selection } = state;
	if (doc.childCount === 0) return null;
	const $from = selection.$from;
	// A selected top-level block has depth 0; a cursor inside one has depth 1 or more.
	if (selection instanceof NodeSelection && $from.depth === 0) {
		const index = $from.index(0);
		return { index, from: selection.from, to: selection.to, node: doc.child(index) };
	}
	if ($from.depth === 0) {
		const index = Math.min($from.index(0), doc.childCount - 1);
		let from = 0;
		for (let i = 0; i < index; i++) from += doc.child(i).nodeSize;
		return { index, from, to: from + doc.child(index).nodeSize, node: doc.child(index) };
	}
	const index = $from.index(0);
	return { index, from: $from.before(1), to: $from.after(1), node: doc.child(index) };
}

const history = (tr: Transaction) => tr.setMeta("closeHistory", true).scrollIntoView();

export type InsertKind =
	"paragraph" | "heading" | "bulletList" | "orderedList" | "quote" | "divider" | "spacer" | "pageBreak";
export const INSERT_KINDS: { kind: InsertKind; label: string }[] = [
	{ kind: "paragraph", label: "Paragraph" },
	{ kind: "heading", label: "Heading" },
	{ kind: "bulletList", label: "Bulleted list" },
	{ kind: "orderedList", label: "Numbered list" },
	{ kind: "quote", label: "Quote" },
	{ kind: "divider", label: "Divider" },
	{ kind: "spacer", label: "Spacer" },
	{ kind: "pageBreak", label: "Page break" },
];

function build(editor: Editor, kind: InsertKind): PMNode {
	const { schema } = editor.state;
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
		default:
			return type(kind).create();
	}
}

/** Adds a block after the current top-level block (at the start of an empty body). Text blocks take the cursor. */
export function insertBlock(editor: Editor, kind: InsertKind): boolean {
	const { state } = editor;
	const at = currentBlock(state)?.to ?? 0;
	const node = build(editor, kind);
	const tr = history(state.tr);
	const leaf = node.isLeaf;
	// A leaf block at the end of the body gets an empty paragraph after it, so the cursor has somewhere to go.
	const fragment = leaf && at >= state.doc.content.size ? Fragment.from([node, build(editor, "paragraph")]) : node;
	tr.insert(at, fragment);
	if (leaf) {
		const after = at + node.nodeSize;
		const next = tr.doc.resolve(Math.min(after, tr.doc.content.size));
		tr.setSelection(after < tr.doc.content.size ? Selection.near(next, 1) : NodeSelection.create(tr.doc, at));
	} else tr.setSelection(Selection.near(tr.doc.resolve(at + 1), 1));
	editor.view.dispatch(tr);
	editor.view.focus();
	return true;
}

export function canMove(state: EditorState, direction: -1 | 1): boolean {
	const block = currentBlock(state);
	if (!block) return false;
	return direction === -1 ? block.index > 0 : block.index < state.doc.childCount - 1;
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

/**
 * Empties the body, the header and the footer. One Undo brings all three back: the two transactions join one undo event.
 * They stay apart because ProseMirror cannot redraw a document that loses every child in the same update as an attribute
 * of the document node (its view finds nothing changed and leaves the old DOM in place).
 */
export function deleteAllContent(editor: Editor): boolean {
	const { state } = editor;
	const first = history(state.tr);
	const hasBody = state.doc.content.size > 0;
	if (hasBody) {
		first.delete(0, state.doc.content.size);
		editor.view.dispatch(first);
	}
	const { header, footer } = editor.state.doc.attrs;
	if (header === undefined && footer === undefined) return true;
	// With a body, the second step joins the first one's undo event; without one, it starts its own.
	const second = hasBody ? editor.state.tr.setMeta("appendedTransaction", first) : history(editor.state.tr);
	if (header !== undefined) second.setDocAttribute("header", undefined);
	if (footer !== undefined) second.setDocAttribute("footer", undefined);
	editor.view.dispatch(second);
	return true;
}

/** Closes the current undo group, so the next change is its own Undo step. */
export function closeHistory(editor: Editor) {
	editor.view.dispatch(editor.state.tr.setMeta("closeHistory", true).setMeta("addToHistory", false));
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
