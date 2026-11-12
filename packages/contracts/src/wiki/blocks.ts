// The one wiki block parser. A stored body (organization nodes or markdown) becomes blocks that carry both what a
// reader sees (heading, paragraph, quote, list, table, callout, code, diagram) and the markdown lines each block stands
// for. The reader, the Guide and reference excerpt, the PDF and the print export all read these blocks, so they show
// the same structure. For a markdown body the lines of all blocks, in order, are the input lines.
import { fenceAt, fenceContent, parseDiagram, type Diagram, type FencedBlock } from "./diagram.ts";

export type WikiBlock =
	| { kind: "blank" | "break"; lines: string[] }
	| { kind: "heading"; level: number; text: string; lines: string[] }
	/** `paragraphs` are the paragraphs a reader sees: one per markdown line, or one per organization node. */
	| { kind: "paragraph"; paragraphs: string[]; lines: string[] }
	| { kind: "quote"; text: string; lines: string[] }
	/** `items` are every item's text without its marker; `groups` the lines of each top-level item, nested ones kept. */
	| { kind: "list"; ordered: boolean; items: string[]; groups: string[][]; lines: string[] }
	/** `rows` are the cells of each row, without the separator row; `head` is how many source lines the header takes. */
	| { kind: "table"; rows: string[][]; head: number; lines: string[] }
	| { kind: "callout"; label: string; text: string; lines: string[] }
	/** An MDX component other than a callout: it shows only its text, without tags. */
	| { kind: "component"; text: string; lines: string[] }
	| { kind: "code"; text: string; lines: string[] }
	/** `info` and `source` are the fence as written, so a save keeps the diagram as its author wrote it. */
	| { kind: "diagram"; diagram: Diagram; info: string; source: string; lines: string[] };

export const EDITOR_FORMAT = "everyfield-editor-v1";

const HEADING = /^ {0,3}(#{1,6})\s+(.*?)\s*$/;
const BREAK = /^ {0,3}([-*_])(?:\s*\1){2,}\s*$/;
const FENCE = /^ {0,3}(`{3,}|~{3,})/;
const COMPONENT = /^\s*<([A-Za-z][\w.]*)/;
const CLOSING_TAG = /^\s*<\/[A-Za-z][\w.]*>\s*$/;
const TABLE_ROW = /^\s*\|/;
const TABLE_SEPARATOR = /^\s*\|?\s*:?-+:?\s*(\|\s*:?-+:?\s*)*\|?\s*$/;
const LIST_ITEM = /^( {0,3})([-*+]|\d{1,9}[.)])\s+/;
const NESTED_ITEM = /^\s*([-*+]|\d{1,9}[.)])\s+/;
const QUOTE = /^ {0,3}>/;

const stripTags = (text: string) => text.replace(/<\/?[A-Za-z][^>]*>/g, "");

function startsBlock(line: string): boolean {
	return (
		line.trim() === "" ||
		HEADING.test(line) ||
		BREAK.test(line) ||
		FENCE.test(line) ||
		COMPONENT.test(line) ||
		CLOSING_TAG.test(line) ||
		TABLE_ROW.test(line) ||
		LIST_ITEM.test(line) ||
		QUOTE.test(line)
	);
}

/** A table row's cells, without empty and separator cells. */
function cells(line: string): string[] {
	return line
		.split("|")
		.map((cell) => cell.trim())
		.filter((cell) => cell.length > 0 && !/^:?-+:?$/.test(cell));
}

function fenceBlock(fence: FencedBlock, lines: string[]): WikiBlock {
	const content = fenceContent(fence);
	return content.kind === "diagram"
		? { kind: "diagram", diagram: content.diagram, info: fence.info, source: fence.body, lines }
		: { kind: "code", text: content.text, lines };
}

function calloutBlock(lines: string[]): WikiBlock {
	const type = /type="([A-Za-z]+)"/.exec(lines[0] ?? "")?.[1] ?? "";
	const inner = lines.map((line, index) => {
		let text = index === 0 ? line.replace(/^\s*<Callout\b[^>]*>/, "") : line;
		if (index === lines.length - 1) text = text.replace(/<\/Callout>\s*$/, "");
		return text.trim();
	});
	return {
		kind: "callout",
		label: type ? type[0]!.toUpperCase() + type.slice(1) : "",
		text: inner.filter(Boolean).join("\n"),
		lines,
	};
}

/** Markdown text as blocks. */
function markdownBlocks(lines: string[]): WikiBlock[] {
	const blocks: WikiBlock[] = [];
	let index = 0;
	const take = (stop: (line: string) => boolean) => {
		const start = index;
		while (index < lines.length && !stop(lines[index] ?? "")) index++;
		return lines.slice(start, index);
	};
	while (index < lines.length) {
		const line = lines[index] ?? "";
		const fence = fenceAt(lines, index);
		const component = COMPONENT.exec(line)?.[1];
		const heading = HEADING.exec(line);
		if (fence) {
			// Fence lines are never markdown.
			blocks.push(fenceBlock(fence, lines.slice(index, fence.end)));
			index = fence.end;
		} else if (line.trim() === "") {
			blocks.push({ kind: "blank", lines: [line] });
			index++;
		} else if (heading) {
			blocks.push({ kind: "heading", level: heading[1]!.length, text: heading[2] ?? "", lines: [line] });
			index++;
		} else if (BREAK.test(line)) {
			blocks.push({ kind: "break", lines: [line] });
			index++;
		} else if (component) {
			// An MDX component is one block, up to its closing line.
			const close = `</${component}>`;
			const start = index++;
			if (!line.includes(close) && !/\/>\s*$/.test(line)) {
				take((text) => text.includes(close));
				if (index < lines.length) index++;
			}
			const own = lines.slice(start, index);
			if (component === "Callout") blocks.push(calloutBlock(own));
			else blocks.push({ kind: "component", text: textLines(own).join("\n"), lines: own });
		} else if (CLOSING_TAG.test(line)) {
			// A stray closing tag shows nothing.
			blocks.push({ kind: "component", text: "", lines: [line] });
			index++;
		} else if (TABLE_ROW.test(line)) {
			const rows = take((next) => !TABLE_ROW.test(next));
			blocks.push({
				kind: "table",
				rows: rows.map(cells).filter((row) => row.length > 0),
				head: TABLE_SEPARATOR.test(rows[1] ?? "") ? 2 : 1,
				lines: rows,
			});
		} else if (QUOTE.test(line)) {
			const rows = take((next) => !QUOTE.test(next));
			blocks.push({
				kind: "quote",
				text: rows.map((row) => row.trim().replace(/^(>\s?)+/, "")).join(" "),
				lines: rows,
			});
		} else if (LIST_ITEM.test(line)) {
			const base = LIST_ITEM.exec(line)?.[1]?.length ?? 0;
			const rows = take((next) => next.trim() === "" || (!LIST_ITEM.test(next) && !/^\s{2,}\S/.test(next)));
			const groups: string[][] = [];
			const items: string[] = [];
			for (const row of rows) {
				const marker = LIST_ITEM.exec(row);
				if (marker && (marker[1]?.length ?? 0) <= base) groups.push([row]);
				else groups.at(-1)?.push(row);
				const nested = NESTED_ITEM.exec(row);
				const text = row.trim().replace(NESTED_ITEM, "").trim();
				if (nested || !items.length) items.push(text);
				else items[items.length - 1] = `${items.at(-1)} ${text}`.trim();
			}
			blocks.push({ kind: "list", ordered: /^\s*\d/.test(line), items, groups, lines: rows });
		} else {
			index++;
			const own = [line, ...take(startsBlock)];
			blocks.push({ kind: "paragraph", paragraphs: textLines(own), lines: own });
		}
	}
	return blocks;
}

/** Lines as a reader sees them: tags dropped, trimmed, empty lines gone. */
function textLines(lines: string[]): string[] {
	return lines.map((line) => stripTags(line).trim()).filter(Boolean);
}

/** A fence around `body` that no line of it closes early. */
function fenceLines(info: string, body: string): string[] {
	const longest = Math.max(2, ...[...body.matchAll(/^ {0,3}(`{3,})/gm)].map((match) => match[1]?.length ?? 0));
	const marker = "`".repeat(longest + 1);
	return [`${marker}${info}`, ...body.split("\n"), marker];
}

const listLines = (ordered: boolean, items: string[]) =>
	items.map((item, index) => `${ordered ? `${index + 1}.` : "-"} ${item}`);
const tableLines = (rows: string[][]) =>
	rows.map((row) => `| ${row.map((cell) => cell.replaceAll("|", "/")).join(" | ")} |`);
const calloutLines = (label: string, text: string) => {
	const type = label.toLowerCase().replace(/[^a-z]/g, "");
	return [type ? `<Callout type="${type}">` : "<Callout>", ...text.split("\n"), "</Callout>"];
};
const paragraph = (text: string): WikiBlock => ({ kind: "paragraph", paragraphs: [text], lines: text.split("\n") });

/** The text of an editor document's inline runs: text and link labels. */
function runText(value: unknown): string {
	if (!Array.isArray(value)) return "";
	return value
		.map((part) => {
			if (!part || typeof part !== "object") return "";
			const node = part as { type?: string; text?: string; children?: unknown };
			if (node.type === "text" && typeof node.text === "string") return node.text;
			if (node.type === "link") return runText(node.children);
			return "";
		})
		.join("");
}

type EditorNode = {
	type?: string;
	level?: number;
	text?: string;
	ordered?: boolean;
	label?: unknown;
	info?: unknown;
	source?: unknown;
	children?: unknown;
	items?: unknown;
	rows?: unknown;
};

/** One block of an everyfield-editor-v1 document, or null when it shows nothing. */
function editorBlock(value: unknown): WikiBlock | null {
	if (!value || typeof value !== "object") return null;
	const node = value as EditorNode;
	if (node.type === "heading") {
		const text = runText(node.children).trim();
		if (!text) return null;
		if (node.level === 2 || node.level === 3)
			return { kind: "heading", level: node.level, text, lines: [`${"#".repeat(node.level)} ${text}`] };
		return paragraph(text);
	}
	if (node.type === "paragraph" || node.type === "quote") {
		const text = runText(node.children).trim();
		if (!text) return null;
		return node.type === "quote"
			? { kind: "quote", text, lines: text.split("\n").map((l) => `> ${l}`) }
			: paragraph(text);
	}
	if (node.type === "list" && Array.isArray(node.items)) {
		const items = node.items.map((item) => runText(item).trim()).filter(Boolean);
		if (!items.length) return null;
		const ordered = node.ordered === true;
		const lines = listLines(ordered, items);
		return { kind: "list", ordered, items, groups: lines.map((line) => [line]), lines };
	}
	if (node.type === "code" && typeof node.text === "string" && node.text.trim())
		return { kind: "code", text: node.text, lines: fenceLines("", node.text) };
	if (node.type === "callout") {
		const text = runText(node.children).trim();
		if (!text) return null;
		const label = typeof node.label === "string" ? node.label : "";
		return { kind: "callout", label, text, lines: calloutLines(label, text) };
	}
	if (node.type === "diagram" && typeof node.info === "string" && typeof node.source === "string") {
		const parsed = parseDiagram(node.info, node.source);
		const lines = fenceLines(node.info, node.source);
		return parsed.ok
			? { kind: "diagram", diagram: parsed.diagram, info: node.info, source: node.source, lines }
			: { kind: "code", text: node.source, lines };
	}
	if (node.type === "table" && Array.isArray(node.rows)) {
		const rows = node.rows
			.map((row) => (Array.isArray(row) ? row.map((cell) => runText(cell).trim()) : []))
			.filter((row) => row.some(Boolean));
		if (!rows.length) return null;
		return { kind: "table", rows, head: 1, lines: tableLines(rows) };
	}
	return null;
}

/** The text of any other organization node tree. Scripts and imports never show. */
function textOf(value: unknown): string {
	if (typeof value === "string") return value;
	if (Array.isArray(value)) return value.map(textOf).filter(Boolean).join("");
	if (!value || typeof value !== "object") return "";
	const node = value as { type?: string; text?: string; content?: unknown; children?: unknown };
	if (node.type === "script" || node.type === "import" || node.type === "mdxjsEsm") return "";
	if (typeof node.text === "string" && !node.content && !node.children) return node.text;
	return textOf(node.content ?? node.children ?? "");
}

/** Any other organization node tree as blocks: headings, lists, callouts, quotes and paragraphs. */
function nodeBlocks(value: unknown, blocks: WikiBlock[]): void {
	if (Array.isArray(value)) {
		value.forEach((item) => nodeBlocks(item, blocks));
		return;
	}
	if (!value || typeof value !== "object") return;
	const node = value as { type?: string; level?: number; text?: string; content?: unknown; children?: unknown };
	if (node.type === "script" || node.type === "import" || node.type === "mdxjsEsm") return;
	const kids = node.content ?? node.children;
	const heading =
		node.type === "h2" || node.type === "h3" || node.type === "heading" || node.level === 2 || node.level === 3;
	if (heading && (typeof node.text === "string" || kids)) {
		const level = node.type === "h3" || node.level === 3 ? 3 : 2;
		const text = typeof node.text === "string" ? node.text : textOf(kids);
		if (text) blocks.push({ kind: "heading", level, text, lines: [`${"#".repeat(level)} ${text}`] });
		return;
	}
	if (["bulletList", "orderedList", "list", "ul", "ol"].includes(node.type ?? "")) {
		const items = (Array.isArray(kids) ? kids : []).map((item) => textOf(item).trim()).filter(Boolean);
		const ordered = node.type === "orderedList" || node.type === "ol";
		const lines = listLines(ordered, items);
		if (items.length) blocks.push({ kind: "list", ordered, items, groups: lines.map((line) => [line]), lines });
		return;
	}
	if (node.type === "callout") {
		const text = textOf(kids ?? node.text);
		if (text) blocks.push({ kind: "callout", label: "", text, lines: calloutLines("", text) });
		return;
	}
	if (node.type === "blockquote") {
		const text = textOf(kids ?? node.text);
		if (text) blocks.push({ kind: "quote", text, lines: text.split("\n").map((l) => `> ${l}`) });
		return;
	}
	if (node.type === "paragraph" || node.type === "p") {
		const text = textOf(kids ?? node.text).trim();
		if (text) blocks.push(paragraph(text));
		return;
	}
	if (kids) nodeBlocks(kids, blocks);
}

/** The blocks of an editor document, or null when `value` is not one. */
export function editorDocumentBlocks(value: unknown): WikiBlock[] | null {
	if (!value || typeof value !== "object" || Array.isArray(value)) return null;
	const doc = value as { format?: unknown; blocks?: unknown };
	if (doc.format !== EDITOR_FORMAT || !Array.isArray(doc.blocks)) return null;
	return doc.blocks.map(editorBlock).filter((block) => block !== null);
}

/** Organization nodes as blocks, or null when the body is not a node tree. Raw JSON is never shown. */
function nodeDocument(body: string): WikiBlock[] | null {
	let parsed: unknown;
	try {
		parsed = JSON.parse(body);
	} catch {
		return null;
	}
	const editor = editorDocumentBlocks(parsed);
	if (editor) return editor;
	if (!parsed || typeof parsed !== "object") return null;
	const blocks: WikiBlock[] = [];
	nodeBlocks(parsed, blocks);
	if (blocks.length) return blocks;
	const text = textOf(parsed).trim();
	return text ? [paragraph(text)] : [];
}

/** A stored body as blocks: organization nodes when they parse, else markdown. Older organization text is markdown. */
export function wikiBlocks(contentType: string, body: string): WikiBlock[] {
	if (contentType === "safe_nodes") {
		const nodes = nodeDocument(body);
		if (nodes) return nodes;
	}
	return markdownBlocks(body.split("\n"));
}

/** The markdown fence opener of a line, for a writer that cuts a fence and closes it again. */
export function fenceMarker(line: string): string | null {
	return FENCE.exec(line)?.[1] ?? null;
}
