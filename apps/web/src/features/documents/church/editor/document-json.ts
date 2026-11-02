import type { DocDocument } from "@everyfield/contracts/documents";

// Between the stored document and the editor. The editor holds the body as ProseMirror JSON and the page header and
// footer as attributes of the root node (so Undo covers them). Nothing else changes: the prose JSON is the format.

type Json = Record<string, unknown>;

/** A header or footer as the format stores it: which pages it prints on, and its blocks. */
type Region = { pages: string; content?: unknown[] };
const REGIONS = [
	["header", "pageHeader"],
	["footer", "pageFooter"],
] as const;

/**
 * The content the editor loads. The header and the footer are the first and the last child of the document, so they
 * edit on the page and share one Undo history with the body; the rest of the page setup is the `page` attribute of the
 * root node, so a change to it joins that history too. A region the file stores as null stays null in `page`.
 */
export function editorContent(doc: DocDocument): Json {
	const { header: _header, footer: _footer, ...setup } = doc.page as Record<string, unknown>;
	const page: Json = { ...setup };
	const region = (key: "header" | "footer", type: string) => {
		const value = (doc.page as Record<string, unknown>)[key] as Region | null | undefined;
		if (!value) {
			if (value === null) page[key] = null;
			return [];
		}
		return [{ type, attrs: { pages: value.pages }, ...(value.content?.length ? { content: value.content } : {}) }];
	};
	return {
		type: "doc",
		attrs: { page },
		content: [...region("header", "pageHeader"), ...(doc.body.content ?? []), ...region("footer", "pageFooter")],
	};
}

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
	const { attrs, content = [] } = clean(json) as { attrs?: { page?: Json }; content?: Json[] };
	const page: Json = { ...(attrs?.page ?? (base.page as Json)) };
	const body = [...content];
	// A region node left in the page becomes the region; with none, the page keeps a stored null or has no key.
	for (const [key, type] of REGIONS) {
		delete page[key];
		const at = key === "header" ? 0 : body.length - 1;
		const node = body[at];
		if (node?.type === type) {
			body.splice(at, 1);
			const pages = (node.attrs as { pages?: string } | undefined)?.pages ?? "all";
			page[key] = { pages, content: (node.content as unknown[] | undefined) ?? [] };
		} else if ((attrs?.page as Json | undefined)?.[key] === null) page[key] = null;
	}
	return {
		...base,
		page,
		body: { type: "doc", ...(body.length ? { content: body } : {}) },
	} as unknown as DocDocument;
}
