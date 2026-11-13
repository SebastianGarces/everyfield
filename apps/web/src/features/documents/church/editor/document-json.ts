import { exportsFor, type DocDocument } from "@everyfield/contracts/documents";
import { blocksFromEditor, blocksToEditor } from "./table-json.ts";

// Between the stored document and the editor. The editor holds the body as ProseMirror JSON, with the page header and
// footer as its first and last child (so Undo covers them). Nothing else changes: the prose JSON is the format.

type Json = Record<string, unknown>;

/** A header or footer as the format stores it: which pages it prints on, and its blocks. */
type Region = { pages: string; content?: unknown[] };
/** The editor node that holds each region. */
export const REGION_NODE = { header: "pageHeader", footer: "pageFooter" } as const;

/**
 * The content the editor loads. The header and the footer are the first and the last child of the document, so they
 * edit on the page and share one Undo history with the body; the rest of the page setup is the `page` attribute of the
 * root node, so a change to it joins that history too. A region the file stores as null stays null in `page`.
 */
export function editorContent(doc: DocDocument): Json {
	const page: Json = { ...(doc.page as Record<string, unknown>) };
	delete page.header;
	delete page.footer;
	const region = (key: keyof typeof REGION_NODE) => {
		const value = (doc.page as Record<string, unknown>)[key] as Region | null | undefined;
		if (!value) {
			if (value === null) page[key] = null;
			return [];
		}
		return [
			{
				type: REGION_NODE[key],
				attrs: { pages: value.pages },
				...(value.content?.length ? { content: blocksToEditor(value.content) } : {}),
			},
		];
	};
	return {
		type: "doc",
		attrs: { page, fields: doc.fields, ...(doc.data === undefined ? {} : { data: doc.data }) },
		content: [
			...region("header"),
			...blocksToEditor(withSlotLines((doc.body.content ?? []) as Json[])),
			...region("footer"),
		],
	};
}

const isSlot = (node: Json) => node.type === "slot";
/** A copy of `node` without `key`. */
function without(node: Json, key: string): Json {
	const copy = { ...node };
	delete copy[key];
	return copy;
}
/** A stored empty doctrinal section gets one empty paragraph in the editor, so the cursor can go into it. */
function withSlotLines(nodes: Json[]): Json[] {
	return nodes.map((node) => {
		const content = node.content as Json[] | undefined;
		if (isSlot(node)) return content?.length ? node : { ...node, content: [{ type: "paragraph" }] };
		return content ? { ...node, content: withSlotLines(content) } : node;
	});
}
/** A doctrinal section with no text in it is stored empty, so it exports as the marked blank and never as blank lines. */
function blankSlotsEmpty(nodes: Json[]): Json[] {
	return nodes.map((node) => {
		const content = node.content as Json[] | undefined;
		if (isSlot(node)) return content && textOf(node).trim() === "" ? without(node, "content") : node;
		return content ? { ...node, content: blankSlotsEmpty(content) } : node;
	});
}
/** The text of a node; a merge field counts as text, so a section that holds only a field is kept. */
const textOf = (node: Json): string =>
	typeof node.text === "string"
		? node.text
		: node.type === "field"
			? "field"
			: ((node.content as Json[] | undefined) ?? []).map(textOf).join("");

/**
 * The stored form of a tree: what JSON would drop, plus every empty `attrs` and every empty `content` list.
 * ProseMirror writes neither, and the format reads both the same as a missing key.
 */
export function clean<T>(value: T): T {
	const walk = (node: unknown): unknown => {
		if (Array.isArray(node)) return node.map(walk);
		if (node && typeof node === "object") {
			const out: Json = {};
			for (const [key, child] of Object.entries(node)) {
				if (child === undefined) continue;
				const next = walk(child);
				if (key === "attrs" && next && typeof next === "object" && Object.keys(next).length === 0) continue;
				if (key === "content" && Array.isArray(next) && next.length === 0) continue;
				out[key] = next;
			}
			return out;
		}
		return node;
	};
	return walk(value) as T;
}

/** The document the editor holds: the stored envelope with the page setup, header, footer and body the editor now has. */
export function documentFrom(base: DocDocument, json: Json): DocDocument {
	const { attrs, content = [] } = clean(json) as {
		attrs?: { page?: Json; fields?: unknown[]; data?: Json };
		content?: Json[];
	};
	const page: Json = { ...(attrs?.page ?? (base.page as Json)) };
	const body = blankSlotsEmpty(blocksFromEditor(content) as Json[]);
	// A region node left in the page becomes the region; with none, the page keeps a stored null or has no key.
	for (const [key, type] of Object.entries(REGION_NODE) as [keyof typeof REGION_NODE, string][]) {
		delete page[key];
		const at = key === "header" ? 0 : body.length - 1;
		const node = body[at];
		if (node?.type === type) {
			body.splice(at, 1);
			const pages = (node.attrs as { pages?: string } | undefined)?.pages ?? "all";
			page[key] = { pages, content: (node.content as unknown[] | undefined) ?? [] };
		} else if ((attrs?.page as Json | undefined)?.[key] === null) page[key] = null;
	}
	// The merge fields and their values the editor holds; `data` stays out when the document never had any.
	const data = attrs ? attrs.data : base.data;
	const next = { type: "doc", ...(body.length ? { content: body } : {}) } as DocDocument["body"];
	return {
		...without(base as unknown as Json, "data"),
		fields: attrs?.fields ?? base.fields,
		...(data === undefined ? {} : { data }),
		page,
		body: next,
		// Excel follows the body: `exports` lists it only while the body holds a budget table.
		exports: exportsFor(base.exports, next),
	} as unknown as DocDocument;
}
