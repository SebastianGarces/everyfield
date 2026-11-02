import type { DocDocument } from "@everyfield/contracts/documents";

// Between the stored document and the editor. The editor holds the body as ProseMirror JSON and the page header and
// footer as attributes of the root node (so Undo covers them). Nothing else changes: the prose JSON is the format.

type Json = Record<string, unknown>;

/** The content the editor loads: the body, with the header and footer on the root node. */
export function editorContent(doc: DocDocument): Json {
	const { header, footer } = doc.page;
	return {
		type: "doc",
		attrs: { header, footer },
		...(doc.body.content?.length ? { content: doc.body.content } : {}),
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

/** The document the editor holds: the stored envelope with the body, header and footer the editor now has. */
export function documentFrom(base: DocDocument, json: Json): DocDocument {
	const { attrs, ...body } = clean(json) as { attrs?: { header?: unknown; footer?: unknown } } & Json;
	const page = { ...base.page } as Record<string, unknown>;
	for (const region of ["header", "footer"] as const) {
		const value = attrs?.[region];
		if (value === undefined) delete page[region];
		else page[region] = value;
	}
	return { ...base, page, body: body as DocDocument["body"] } as DocDocument;
}
