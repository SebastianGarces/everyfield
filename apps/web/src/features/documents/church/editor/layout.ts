import { docDocument, type DocDocument, type Token } from "@everyfield/contracts/documents";
import type { Editor } from "@tiptap/core";
import { closeHistory } from "@tiptap/pm/history";
import { Fragment, type Node as PMNode } from "@tiptap/pm/model";
import { NodeSelection, Selection, type EditorState } from "@tiptap/pm/state";
import { documentFrom, REGION_NODE } from "./document-json.ts";

export const TOKENS: readonly Token[] = ["none", "ink", "muted-text", "primary", "accent", "muted", "border"];
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

const history = (editor: Editor) => closeHistory(editor.state.tr);

export type Target = {
	kind: "columns" | "box" | "divider" | "image" | "writeIn" | "table" | "if" | "field";
	pos: number;
	node: PMNode;
};
const KINDS = new Set(["columns", "box", "divider", "image", "writeIn", "table", "if", "field"]);

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

export function setBlockAttrs(editor: Editor, pos: number, patch: Record<string, unknown>): boolean {
	const node = editor.state.doc.nodeAt(pos);
	if (!node) return false;
	const attrs = { ...node.attrs, ...patch };
	if (Object.entries(patch).every(([key, value]) => node.attrs[key] === value)) return false;
	editor.view.dispatch(history(editor).setNodeMarkup(pos, undefined, attrs));
	return true;
}

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

export type PageWithoutRegions = Omit<DocDocument["page"], "header" | "footer">;

export function readPage(state: EditorState): PageWithoutRegions {
	return state.doc.attrs.page as PageWithoutRegions;
}

export type RegionKey = keyof typeof REGION_NODE;

export function regionPages(state: EditorState, key: RegionKey): "all" | "first" | "rest" | null {
	const node = regionNode(state.doc, key);
	return node ? ((node.attrs.pages as "all" | "first" | "rest" | undefined) ?? "all") : null;
}

function regionNode(doc: PMNode, key: RegionKey): PMNode | null {
	const edge = key === "header" ? doc.firstChild : doc.lastChild;
	return edge?.type.name === REGION_NODE[key] ? edge : null;
}

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

type PageIssue = { path: string; message: string };

export function pageIssues(editor: Editor, base: DocDocument, candidate: PageWithoutRegions): PageIssue[] {
	const current = editor.getJSON();
	const json = { ...current, attrs: { ...current.attrs, page: candidate } };
	const parsed = docDocument.safeParse(documentFrom(base, json));
	if (parsed.success) return [];
	const issues: PageIssue[] = [];
	for (const issue of parsed.error.issues) {
		const match = /^(page(?:\.[A-Za-z0-9_.[\]]+)?)\s*(?:\([^)]*\))?:\s*(.*)$/.exec(issue.message);
		if (match) issues.push({ path: match[1] as string, message: match[2] as string });
	}
	return issues;
}

export function applyPage(editor: Editor, candidate: PageWithoutRegions) {
	editor.view.dispatch(history(editor).setDocAttribute("page", candidate));
}

export const POINTS = 72;
export const toInches = (points: number) => Math.round((points / POINTS) * 1000) / 1000;
export const toPoints = (inches: number) => Math.round(inches * POINTS * 100) / 100;
