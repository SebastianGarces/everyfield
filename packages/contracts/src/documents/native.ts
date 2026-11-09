import { z } from "zod";
import { safeLinkAddress } from "../common/links.ts";
import { validate } from "./format/rules.ts";
import type { DocNode } from "./format/types.ts";

// A plain native document (kind native or core_values) stores the body node of everyfield.doc/1 (D-209): the same
// tree the Church Document editor writes, limited to the safe-editor set. No page, no merge fields, no slots, images,
// tables or layout blocks. A revision saved before this format stored plain text; it reads as one paragraph per line.

/** The nodes a native body may hold, and the attributes each may set. */
const NODE_ATTRS: Record<string, readonly string[]> = {
	doc: [],
	paragraph: [],
	heading: ["level"],
	bulletList: [],
	orderedList: [],
	listItem: [],
	quote: [],
	divider: [],
	text: [],
	hardBreak: [],
};
const MARKS = new Set(["bold", "italic", "underline", "link"]);

type Rec = Record<string, unknown>;
const isRec = (value: unknown): value is Rec => !!value && typeof value === "object" && !Array.isArray(value);

/** The faults that keep a node out of the native set: an unknown node, attribute or mark, or an unsafe link. */
function nativeFaults(node: unknown, path: string, faults: string[]) {
	if (faults.length >= 20) return;
	if (!isRec(node)) return;
	const type = String(node.type);
	const attrs = NODE_ATTRS[type];
	if (!attrs || !Object.hasOwn(NODE_ATTRS, type)) {
		faults.push(`${path}: a plain document cannot hold a ${type} node`);
		return;
	}
	if (isRec(node.attrs))
		for (const key of Object.keys(node.attrs))
			if (!attrs.includes(key)) faults.push(`${path} (${type}): a plain document does not set "${key}"`);
	if (Array.isArray(node.marks))
		for (const mark of node.marks) {
			const name = isRec(mark) ? String(mark.type) : String(mark);
			if (!MARKS.has(name)) faults.push(`${path}: a plain document cannot hold a ${name} mark`);
			else if (name === "link") {
				const href = isRec(mark) && isRec(mark.attrs) ? mark.attrs.href : undefined;
				if (typeof href !== "string" || safeLinkAddress(href) !== href)
					faults.push(`${path}: a link must start with https://, http:// or mailto:`);
			}
		}
	if (Array.isArray(node.content))
		node.content.forEach((child, i) => nativeFaults(child, `${path}.content[${i}]`, faults));
}

/** The envelope the format rules need around a body. Nothing of it is stored. */
const frame = (body: unknown) => ({
	format: "everyfield.doc/1",
	kind: "document",
	id: "native",
	version: 1,
	title: "Native",
	class: "operational",
	exports: ["pdf"],
	fields: [],
	origin: null,
	page: { size: "letter", orientation: "portrait", margin: { top: 72, right: 72, bottom: 72, left: 72 } },
	body,
});

/**
 * One native body: an everyfield.doc/1 `doc` node with paragraphs, headings, lists, quotes and dividers, and bold,
 * italic, underline and safe links. Every format rule applies (text length, printable text, node and size limits).
 */
export const nativeBody = z.unknown().transform((value, ctx): DocNode => {
	const faults: string[] = [];
	if (!isRec(value) || value.type !== "doc") faults.push("body: a plain document body is a doc node");
	else {
		nativeFaults(value, "body", faults);
		if (!faults.length) faults.push(...validate(frame(value)).errors);
	}
	for (const message of faults.slice(0, 20)) ctx.addIssue({ code: "custom", message });
	return faults.length ? z.NEVER : (value as DocNode);
});

/** The body a pre-change text revision reads as: each line one paragraph, in order. */
export function nativeFromText(text: string): DocNode {
	const lines = text.replace(/\r\n?/g, "\n").split("\n");
	return {
		type: "doc",
		content: lines.map((line) =>
			line ? { type: "paragraph", content: [{ type: "text", text: line }] } : { type: "paragraph" },
		),
	};
}

/** A stored revision body as a native body: the stored node, or the paragraphs of a pre-change text revision. */
export function readNative(stored: string): { body: DocNode; text: boolean } {
	if (stored.startsWith("{")) {
		try {
			const parsed = nativeBody.safeParse(JSON.parse(stored));
			if (parsed.success) return { body: parsed.data, text: false };
		} catch {
			// Not JSON: a text revision that starts with a brace.
		}
	}
	return { body: nativeFromText(stored), text: true };
}

type Node = { type: string; text?: string; content?: Node[] };
const inline = (node: Node): string =>
	node.type === "text"
		? (node.text ?? "")
		: node.type === "hardBreak"
			? "\n"
			: (node.content ?? []).map(inline).join("");

/**
 * The plain text of a native body in reading order: one line for each paragraph, heading and list item, no markup.
 * A body with only empty blocks is "".
 */
export function nativeText(body: DocNode): string {
	const lines: string[] = [];
	const walk = (node: Node) => {
		if (node.type === "paragraph" || node.type === "heading") lines.push(inline(node));
		else for (const child of node.content ?? []) walk(child);
	};
	walk(body as Node);
	return lines.join("\n").trim();
}
