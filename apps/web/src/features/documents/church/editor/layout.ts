import { docDocument, type DocDocument, type Token } from "@everyfield/contracts/documents";
import type { Editor } from "@tiptap/core";
import { closeHistory } from "@tiptap/pm/history";
import { Fragment, type Node as PMNode } from "@tiptap/pm/model";
import { NodeSelection, Selection, type EditorState } from "@tiptap/pm/state";
import { documentFrom, REGION_NODE } from "./document-json.ts";

// Layout actions: the columns count, a block's own settings (box fill and border, divider weight and color, image size
// and alignment) and the page setup. Each is one transaction, so one Undo reverses it, and each one writes only what the
// format stores: the file stays everyfield.doc/1 with no extra keys.

export const TOKENS: readonly Token[] = ["none", "ink", "muted-text", "primary", "accent", "muted", "border"];
/** The name a planter reads for each token: a swatch's accessible name and its tooltip. Primary and Accent match the brand kit. */
export const TOKEN_NAMES: Readonly<Record<Token, string>> = {
	none: "None",
	ink: "Text",
	"muted-text": "Muted text",
	primary: "Primary",
	accent: "Accent",
	muted: "Light shade",
	border: "Border",
};
export const WEIGHTS = ["hairline", "rule", "bar"] as const;
export const ALIGNS = ["left", "center", "right"] as const;

// `closeHistory` ends the Undo group before this step, so one Undo reverses exactly this action.
const history = (editor: Editor) => closeHistory(editor.state.tr);

// ---------------------------------------------------------------- what the selection is in

export type Target = { kind: "columns" | "box" | "divider" | "image" | "writeIn"; pos: number; node: PMNode };
const KINDS = new Set(["columns", "box", "divider", "image", "writeIn"]);

/** The layout blocks the selection is in or on, outermost first: the columns and boxes around the cursor, or the selected block. */
export function layoutTargets(state: EditorState): Target[] {
	const { selection } = state;
	const $from = selection.$from;
	const found: Target[] = [];
	for (let d = 1; d <= $from.depth; d++) {
		const node = $from.node(d);
		if (KINDS.has(node.type.name)) found.push({ kind: node.type.name as Target["kind"], pos: $from.before(d), node });
	}
	if (selection instanceof NodeSelection && KINDS.has(selection.node.type.name))
		found.push({ kind: selection.node.type.name as Target["kind"], pos: selection.from, node: selection.node });
	return found;
}

/** Sets attributes of the block at `pos` and keeps the selection where it was. */
export function setBlockAttrs(editor: Editor, pos: number, patch: Record<string, unknown>): boolean {
	const node = editor.state.doc.nodeAt(pos);
	if (!node) return false;
	const attrs = { ...node.attrs, ...patch };
	if (Object.entries(patch).every(([key, value]) => node.attrs[key] === value)) return false;
	editor.view.dispatch(history(editor).setNodeMarkup(pos, undefined, attrs));
	return true;
}

// ---------------------------------------------------------------- columns

/**
 * Changes the number of columns of the columns block at `pos` to 2, 3 or 4. Going up adds empty columns. Going down moves
 * the blocks of each removed column to the end of the column on its left, so no content is lost. The widths reset to
 * equal; a template's stored widths stay until the count changes.
 */
export function setColumnCount(editor: Editor, pos: number, count: number): boolean {
	const { state } = editor;
	const columns = state.doc.nodeAt(pos);
	if (!columns || columns.type.name !== "columns" || ![2, 3, 4].includes(count) || columns.childCount === count)
		return false;
	const { schema } = state;
	const column = schema.nodes.column;
	const paragraph = schema.nodes.paragraph;
	if (!column || !paragraph) return false;
	const kept: PMNode[] = [];
	columns.forEach((child, _offset, index) => {
		if (index < count) kept.push(child);
	});
	if (columns.childCount > count) {
		// A removed column that holds only the empty paragraph a new column starts with adds nothing to move.
		const moved: PMNode[] = [];
		for (let i = count; i < columns.childCount; i++) {
			const removed = columns.child(i);
			const blank =
				removed.childCount === 1 && removed.child(0).type === paragraph && removed.child(0).content.size === 0;
			if (!blank) removed.forEach((block) => moved.push(block));
		}
		const last = kept[count - 1] as PMNode;
		kept[count - 1] = last.copy(last.content.append(Fragment.from(moved)));
	} else {
		for (let i = columns.childCount; i < count; i++) kept.push(column.create(null, paragraph.create()));
	}
	const reset = kept.map((node) => node.type.create({ ...node.attrs, width: undefined }, node.content, node.marks));
	const next = columns.type.create(columns.attrs, reset);
	const tr = history(editor).replaceWith(pos, pos + columns.nodeSize, next);
	tr.setSelection(Selection.near(tr.doc.resolve(pos + 1), 1));
	editor.view.dispatch(tr);
	return true;
}

// ---------------------------------------------------------------- page setup

export type PageWithoutRegions = Omit<DocDocument["page"], "header" | "footer">;

/** The page setup the editor holds, without the header and the footer (those are the first and last child). */
export function readPage(state: EditorState): PageWithoutRegions {
	return state.doc.attrs.page as PageWithoutRegions;
}

export type RegionKey = keyof typeof REGION_NODE;

/** Which pages a region prints on, or null when the page has none. */
export function regionPages(state: EditorState, key: RegionKey): "all" | "first" | "rest" | null {
	const node = regionNode(state.doc, key);
	return node ? ((node.attrs.pages as "all" | "first" | "rest" | undefined) ?? "all") : null;
}

/** The header or the footer node: the first or the last child of the document, or null when the page has none. */
function regionNode(doc: PMNode, key: RegionKey): PMNode | null {
	const edge = key === "header" ? doc.firstChild : doc.lastChild;
	return edge?.type.name === REGION_NODE[key] ? edge : null;
}

/** Turns the header or the footer on (with one empty paragraph) or off, or sets the pages it prints on. One step. */
export function setRegion(
	editor: Editor,
	key: RegionKey,
	on: boolean,
	pages: "all" | "first" | "rest" = "all",
): boolean {
	const { state } = editor;
	const type = state.schema.nodes[REGION_NODE[key]];
	const paragraph = state.schema.nodes.paragraph;
	if (!type || !paragraph) return false;
	const { doc } = state;
	const node = regionNode(doc, key);
	const from = key === "header" ? 0 : doc.content.size - (node?.nodeSize ?? 0);
	const tr = history(editor);
	if (on && !node) tr.insert(from, type.create({ pages }, paragraph.create()));
	else if (!on && node) tr.delete(from, from + node.nodeSize);
	else if (on && node && node.attrs.pages !== pages) tr.setNodeMarkup(from, undefined, { ...node.attrs, pages });
	else return false;
	editor.view.dispatch(tr);
	return true;
}

/** What the format says about a page setup: each fault of `page`, in the format's words, without the path prefix. */
type PageIssue = { path: string; message: string };

/** Checks a page setup against the whole format, with the body and the regions the editor holds now. */
export function pageIssues(editor: Editor, base: DocDocument, candidate: PageWithoutRegions): PageIssue[] {
	const json = { ...editor.getJSON(), attrs: { page: candidate } };
	const parsed = docDocument.safeParse(documentFrom(base, json));
	if (parsed.success) return [];
	const issues: PageIssue[] = [];
	for (const issue of parsed.error.issues) {
		const match = /^(page(?:\.[A-Za-z0-9_.[\]]+)?)\s*(?:\([^)]*\))?:\s*(.*)$/.exec(issue.message);
		if (match) issues.push({ path: match[1] as string, message: match[2] as string });
	}
	return issues;
}

/** Applies a page setup as one step. The caller has checked it with `pageIssues`. */
export function applyPage(editor: Editor, candidate: PageWithoutRegions) {
	editor.view.dispatch(history(editor).setDocAttribute("page", candidate));
}

/** Points per inch: margins and custom sizes show in inches and store points. */
export const POINTS = 72;
export const toInches = (points: number) => Math.round((points / POINTS) * 1000) / 1000;
export const toPoints = (inches: number) => Math.round(inches * POINTS * 100) / 100;
