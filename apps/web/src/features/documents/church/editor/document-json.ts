import { exportsFor, type DocDocument } from "@everyfield/contracts/documents";
import { blocksFromEditor, blocksToEditor } from "./table-json.ts";

type Json = Record<string, unknown>;

type Region = { pages: string; content?: unknown[] };
export const REGION_NODE = { header: "pageHeader", footer: "pageFooter" } as const;

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
function without(node: Json, key: string): Json {
	const copy = { ...node };
	delete copy[key];
	return copy;
}
function withSlotLines(nodes: Json[]): Json[] {
	return nodes.map((node) => {
		const content = node.content as Json[] | undefined;
		if (isSlot(node)) return content?.length ? node : { ...node, content: [{ type: "paragraph" }] };
		return content ? { ...node, content: withSlotLines(content) } : node;
	});
}
function blankSlotsEmpty(nodes: Json[]): Json[] {
	return nodes.map((node) => {
		const content = node.content as Json[] | undefined;
		if (isSlot(node)) return content && textOf(node).trim() === "" ? without(node, "content") : node;
		return content ? { ...node, content: blankSlotsEmpty(content) } : node;
	});
}
const textOf = (node: Json): string =>
	typeof node.text === "string"
		? node.text
		: node.type === "field"
			? "field"
			: ((node.content as Json[] | undefined) ?? []).map(textOf).join("");

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

export function documentFrom(base: DocDocument, json: Json): DocDocument {
	const { attrs, content = [] } = clean(json) as {
		attrs?: { page?: Json; fields?: unknown[]; data?: Json };
		content?: Json[];
	};
	const page: Json = { ...(attrs?.page ?? (base.page as Json)) };
	const body = blankSlotsEmpty(blocksFromEditor(content) as Json[]);
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
	const data = attrs ? attrs.data : base.data;
	const next = { type: "doc", ...(body.length ? { content: body } : {}) } as DocDocument["body"];
	return {
		...without(base as unknown as Json, "data"),
		fields: attrs?.fields ?? base.fields,
		...(data === undefined ? {} : { data }),
		page,
		body: next,
		exports: exportsFor(base.exports, next),
	} as unknown as DocDocument;
}
