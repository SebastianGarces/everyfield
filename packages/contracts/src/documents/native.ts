import { z } from "zod";
import { safeLinkAddress } from "../common/links.ts";
import { computeTable, validate } from "./format/rules.ts";
import { formatNumber, TABLE_LIMITS } from "./format/table.ts";
import type { AnyNode, CellNode, ColumnSpec, DocNode, InlineNode, RowNode, TableNode } from "./format/types.ts";

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
	table: ["columns", "style", "header", "zebra", "writeInRows"],
	row: ["role"],
	cell: ["value", "checked"],
};
const MARKS = new Set(["bold", "italic", "underline", "link"]);

type Rec = Record<string, unknown>;
const isRec = (value: unknown): value is Rec => !!value && typeof value === "object" && !Array.isArray(value);

const DEPTH_MAX = 64;

const PLAIN_KINDS = new Set(["text", "number", "money", "check", "index"]);
const PLAIN_COLUMN_KEYS = new Set(["id", "label", "type", "width"]);

function tableFaults(node: Rec, path: string, faults: string[]) {
	const attrs = isRec(node.attrs) ? node.attrs : {};
	if (attrs.style !== undefined && attrs.style !== "grid" && attrs.style !== "rows")
		faults.push(`${path}: a plain document holds no budget table`);
	if (attrs.writeInRows !== undefined && attrs.writeInRows !== 0)
		faults.push(`${path}: a plain document has no write-in rows`);
	if (Array.isArray(attrs.columns))
		attrs.columns.forEach((column, i) => {
			if (!isRec(column)) return;
			if (!PLAIN_KINDS.has(String(column.type)))
				faults.push(`${path}.columns[${i}]: a plain document cannot hold a ${String(column.type)} column`);
			for (const key of Object.keys(column))
				if (!PLAIN_COLUMN_KEYS.has(key)) faults.push(`${path}.columns[${i}]: a plain document does not set "${key}"`);
		});
	if (Array.isArray(node.content))
		node.content.forEach((row, r) => {
			if (!isRec(row)) return;
			if (Array.isArray(row.content))
				row.content.forEach((cell, c) => {
					if (!isRec(cell) || !Array.isArray(cell.content)) return;
					cell.content.forEach((child, k) => {
						if (isRec(child) && child.type !== "text")
							faults.push(`${path}.content[${r}].content[${c}].content[${k}]: a table cell holds text only`);
					});
				});
		});
}

function nativeFaults(node: unknown, path: string, faults: string[], depth = 0) {
	if (faults.length >= 20) return;
	if (!isRec(node)) return;
	if (depth > DEPTH_MAX) {
		faults.push(`${path}: a plain document cannot nest this deep`);
		return;
	}
	const type = String(node.type);
	const attrs = NODE_ATTRS[type];
	if (!attrs || !Object.hasOwn(NODE_ATTRS, type)) {
		faults.push(`${path}: a plain document cannot hold a ${type} node`);
		return;
	}
	if (isRec(node.attrs))
		for (const key of Object.keys(node.attrs))
			if (!attrs.includes(key)) faults.push(`${path} (${type}): a plain document does not set "${key}"`);
	if (type === "table") tableFaults(node, path, faults);
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
		node.content.forEach((child, i) => nativeFaults(child, `${path}.content[${i}]`, faults, depth + 1));
}

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

export function nativeFromText(text: string): DocNode {
	const lines = text.replace(/\r\n?/g, "\n").split("\n");
	return {
		type: "doc",
		content: lines.map((line) =>
			line ? { type: "paragraph", content: [{ type: "text", text: line }] } : { type: "paragraph" },
		),
	};
}

export function readNative(stored: string): { body: DocNode; text: boolean } {
	if (stored.startsWith("{")) {
		try {
			const parsed = nativeBody.safeParse(JSON.parse(stored));
			if (parsed.success) return { body: parsed.data, text: false };
		} catch {}
	}
	return { body: nativeFromText(stored), text: true };
}

const inline = (node: AnyNode): string =>
	node.type === "text"
		? node.text
		: node.type === "hardBreak"
			? "\n"
			: "content" in node
				? (node.content ?? []).map(inline).join("")
				: "";

function filled(cell: CellNode, column: ColumnSpec | undefined): boolean {
	if (column?.type === "text") return inline(cell).trim() !== "";
	if (column?.type === "number" || column?.type === "money") return typeof cell.attrs?.value === "number";
	if (column?.type === "check") return cell.attrs?.checked === true;
	return false;
}

function cellText(cell: CellNode, column: ColumnSpec | undefined, row: number): string {
	const value = cell.attrs?.value;
	switch (column?.type) {
		case "number":
		case "money":
			return typeof value === "number" ? formatNumber(value, column.type) : "";
		case "check":
			return cell.attrs?.checked === true ? "[x]" : "[ ]";
		case "index":
			return String(row);
		default:
			return inline(cell).replace(/\s*\n\s*/g, " ");
	}
}

function tableLines(table: TableNode): string[] {
	const columns = table.attrs.columns;
	const rows = table.content ?? [];
	if (!rows.some((row) => row.content.some((cell, i) => filled(cell, columns[i])))) return [];
	const lines = table.attrs.header === false ? [] : [columns.map((c) => c.label).join(" | ")];
	rows.forEach((row, r) => lines.push(row.content.map((cell, i) => cellText(cell, columns[i], r + 1)).join(" | ")));
	return lines;
}

export function nativeText(body: DocNode): string {
	const lines: string[] = [];
	const walk = (node: AnyNode) => {
		if (node.type === "paragraph" || node.type === "heading") lines.push(inline(node));
		else if (node.type === "table") lines.push(...tableLines(node));
		else if ("content" in node) for (const child of node.content ?? []) walk(child);
	};
	walk(body);
	return lines.join("\n").trim();
}

function plainInline(content: readonly InlineNode[] | undefined): InlineNode[] {
	const out: InlineNode[] = [];
	for (const node of content ?? []) {
		if (node.type === "text") {
			const marks = (node.marks ?? []).filter((m) => MARKS.has(m.type));
			out.push({ type: "text", text: node.text.replace(/[\r\n]+/g, " "), ...(marks.length ? { marks } : {}) });
		} else if (node.type === "hardBreak") out.push({ type: "text", text: " " });
	}
	return out;
}

export function plainTable(table: TableNode): TableNode {
	const a = table.attrs;
	const computed = computeTable(table);
	const rows = table.content ?? [];
	const anyValue = rows.some((row) => (row.content ?? []).some((cell) => typeof cell.attrs?.value === "number"));
	const columns: ColumnSpec[] = a.columns.map((c) => ({
		id: c.id,
		label: c.label,
		type: c.type === "formula" ? (c.format ?? "number") : c.type,
		width: c.width,
	}));
	const cellOf = (cell: CellNode | undefined, ci: number, ri: number, item: boolean): CellNode => {
		const from = a.columns[ci]?.type;
		const to = columns[ci]?.type;
		if (to === "text") {
			const content = plainInline(cell?.content);
			return { type: "cell", ...(content.length ? { content } : {}) };
		}
		if (to === "check")
			return cell?.attrs?.checked === true ? { type: "cell", attrs: { checked: true } } : { type: "cell" };
		if (to === "number" || to === "money") {
			const stored = cell?.attrs?.value;
			const shown = computed[ri]?.[ci];
			const value = item && from !== "formula" ? stored : anyValue && typeof shown === "number" ? shown : undefined;
			return typeof value === "number" ? { type: "cell", attrs: { value } } : { type: "cell" };
		}
		return { type: "cell" };
	};
	const typed: RowNode[] = rows.map((row, ri) => ({
		type: "row",
		content: columns.map((_, ci) => cellOf(row.content?.[ci], ci, ri, (row.attrs?.role ?? "item") === "item")),
	}));
	const blank = (): RowNode => ({ type: "row", content: columns.map(() => ({ type: "cell" })) });
	const header = a.header !== false;
	const writeIns = a.source ? 0 : (a.writeInRows ?? 0);
	const wanted = Math.min(TABLE_LIMITS.rows, typed.length + writeIns);
	while (typed.length < wanted) typed.push(blank());
	if (!header && typed.length === 0) typed.push(blank());
	return {
		type: "table",
		attrs: {
			columns,
			style: a.style === "rows" ? "rows" : "grid",
			...(a.header === undefined ? {} : { header: a.header }),
			...(a.zebra === undefined ? {} : { zebra: a.zebra }),
		},
		...(typed.length ? { content: typed } : {}),
	};
}
