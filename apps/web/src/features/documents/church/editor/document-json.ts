import {
	exportsFor,
	type BlockNode,
	type BulletListNode,
	type CellNode,
	type ColumnNode,
	type ColumnSpec,
	type DocDocument,
	type DocNode,
	type FieldDecl,
	type InlineNode,
	type ListItemNode,
	type Mark,
	type OrderedListNode,
	type PageSetup,
	type ParagraphNode,
	type Region,
	type RowNode,
	type TableNode,
	type Token,
} from "@everyfield/contracts/documents";
import { blocksFromEditor, blocksToEditor } from "./table-json.ts";

type Json = Record<string, unknown>;

export const REGION_NODE = { header: "pageHeader", footer: "pageFooter" } as const;

export function editorContent(doc: DocDocument): Json {
	const page: Json = { ...doc.page };
	delete page.header;
	delete page.footer;
	const region = (key: keyof typeof REGION_NODE) => {
		const value = doc.page[key];
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
			...blocksToEditor(withSlotLines(doc.body.content ?? [])),
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

class EditorJsonError extends Error {
	constructor(path: string, expected: string) {
		super(`${path} is not ${expected}`);
		this.name = "EditorJsonError";
	}
}

type Read<T> = (value: unknown, path: string) => T;
const fail = (path: string, expected: string): never => {
	throw new EditorJsonError(path, expected);
};
const isJson = (value: unknown): value is Json => typeof value === "object" && value !== null && !Array.isArray(value);
const json: Read<Json> = (v, p) => (isJson(v) ? v : fail(p, "an object"));
const str: Read<string> = (v, p) => (typeof v === "string" ? v : fail(p, "a string"));
const num: Read<number> = (v, p) => (typeof v === "number" ? v : fail(p, "a number"));
const bool: Read<boolean> = (v, p) => (typeof v === "boolean" ? v : fail(p, "a boolean"));
const oneOf =
	<const T extends string | number>(...values: T[]): Read<T> =>
	(v, p) =>
		values.find((value) => value === v) ?? fail(p, `one of ${values.join(", ")}`);
const opt =
	<T>(read: Read<T>): Read<T | undefined> =>
	(v, p) =>
		v === undefined ? undefined : read(v, p);
const orNull =
	<T>(read: Read<T>): Read<T | null> =>
	(v, p) =>
		v === null ? null : read(v, p);
const list =
	<T>(read: Read<T>): Read<T[]> =>
	(v, p) =>
		Array.isArray(v) ? v.map((item, i) => read(item, `${p}[${i}]`)) : fail(p, "a list");

const align = opt(oneOf("left", "center", "right"));
const token = opt(oneOf("none", "ink", "muted-text", "primary", "accent", "muted", "border") satisfies Read<Token>);

function partsOf(v: unknown, p: string) {
	const node = json(v, p);
	const attrs = node.attrs === undefined ? {} : json(node.attrs, `${p}.attrs`);
	return {
		type: node.type,
		attr: <T>(key: string, read: Read<T>) => read(attrs[key], `${p}.attrs.${key}`),
		content: <T>(read: Read<T>) => list(read)(node.content ?? [], `${p}.content`),
		text: () => str(node.text, `${p}.text`),
		marks: () => opt(list(mark))(node.marks, `${p}.marks`),
	};
}
type Parts = ReturnType<typeof partsOf>;
const kind =
	<T>(type: string, build: (n: Parts) => T): Read<T> =>
	(v, p) => {
		const n = partsOf(v, p);
		return n.type === type ? build(n) : fail(`${p}.type`, type);
	};

const mark: Read<Mark> = (v, p) => {
	const n = partsOf(v, p);
	switch (n.type) {
		case "bold":
		case "italic":
		case "underline":
		case "tag":
			return { type: n.type };
		case "link":
			return { type: "link", attrs: { href: n.attr("href", str) } };
		default:
			return fail(`${p}.type`, "a mark");
	}
};
const inline: Read<InlineNode> = (v, p) => {
	const n = partsOf(v, p);
	switch (n.type) {
		case "text":
			return { type: "text", text: n.text(), marks: n.marks() };
		case "field":
			return { type: "field", attrs: { key: n.attr("key", str) } };
		case "hardBreak":
			return { type: "hardBreak" };
		case "pageNumber":
			return { type: "pageNumber", attrs: { format: n.attr("format", opt(oneOf("page", "page-of-total"))) } };
		default:
			return fail(`${p}.type`, "an inline node");
	}
};

const paragraph = kind("paragraph", (n): ParagraphNode => ({
	type: "paragraph",
	attrs: { align: n.attr("align", align), style: n.attr("style", opt(oneOf("body", "lead", "small", "kicker"))) },
	content: n.content(inline),
}));
const listItem = kind("listItem", (n): ListItemNode => ({ type: "listItem", content: n.content(paragraph) }));
const bulletList = kind("bulletList", (n): BulletListNode => ({ type: "bulletList", content: n.content(listItem) }));
const orderedList = kind("orderedList", (n): OrderedListNode => ({
	type: "orderedList",
	content: n.content(listItem),
}));
const slotLine: Read<ParagraphNode | BulletListNode | OrderedListNode> = (v, p) => {
	const type = json(v, p).type;
	return type === "bulletList" ? bulletList(v, p) : type === "orderedList" ? orderedList(v, p) : paragraph(v, p);
};

const column: Read<ColumnSpec> = (v, p) => {
	const c = json(v, p);
	return {
		id: str(c.id, `${p}.id`),
		label: str(c.label, `${p}.label`),
		type: oneOf("text", "number", "money", "check", "index", "formula")(c.type, `${p}.type`),
		width: num(c.width, `${p}.width`),
		align: align(c.align, `${p}.align`),
		formula: opt(str)(c.formula, `${p}.formula`),
		format: opt(oneOf("number", "money"))(c.format, `${p}.format`),
	};
};
const cell = kind("cell", (n): CellNode => ({
	type: "cell",
	attrs: { value: n.attr("value", opt(orNull(num))), checked: n.attr("checked", opt(bool)) },
	content: n.content(inline),
}));
const row = kind("row", (n): RowNode => ({
	type: "row",
	attrs: {
		role: n.attr("role", opt(oneOf("item", "group", "subtotal", "total"))),
		sign: n.attr("sign", opt(oneOf("add", "subtract"))),
	},
	content: n.content(cell),
}));
const table = kind("table", (n): TableNode => ({
	type: "table",
	attrs: {
		columns: n.attr("columns", list(column)),
		style: n.attr("style", opt(oneOf("grid", "rows", "ledger"))),
		header: n.attr("header", opt(bool)),
		headerFill: n.attr("headerFill", token),
		zebra: n.attr("zebra", opt(bool)),
		writeInRows: n.attr("writeInRows", opt(num)),
		rowHeight: n.attr("rowHeight", opt(num)),
		source: n.attr("source", opt(orNull(str))),
		sheet: n.attr("sheet", opt(orNull(str))),
	},
	content: n.content(row),
}));
export const tableFrom = (value: Json): TableNode => clean(table(value, "table"));

const columnBlock = kind("column", (n): ColumnNode => ({
	type: "column",
	attrs: { width: n.attr("width", opt(num)), align: n.attr("align", align) },
	content: n.content(block),
}));
const BLOCKS = new Map<string, Read<BlockNode>>([
	["paragraph", paragraph],
	[
		"heading",
		kind("heading", (n) => ({
			type: "heading",
			attrs: {
				level: n.attr("level", opt(oneOf(1, 2, 3))),
				numbered: n.attr("numbered", opt(bool)),
				align: n.attr("align", align),
			},
			content: n.content(inline),
		})),
	],
	["bulletList", bulletList],
	["orderedList", orderedList],
	["quote", kind("quote", (n) => ({ type: "quote", content: n.content(paragraph) }))],
	[
		"divider",
		kind("divider", (n) => ({
			type: "divider",
			attrs: { weight: n.attr("weight", opt(oneOf("hairline", "rule", "bar"))), color: n.attr("color", token) },
		})),
	],
	["spacer", kind("spacer", (n) => ({ type: "spacer", attrs: { size: n.attr("size", opt(num)) } }))],
	["pageBreak", kind("pageBreak", () => ({ type: "pageBreak" }))],
	[
		"columns",
		kind("columns", (n) => ({
			type: "columns",
			attrs: { gap: n.attr("gap", opt(num)), valign: n.attr("valign", opt(oneOf("top", "center", "bottom"))) },
			content: n.content(columnBlock),
		})),
	],
	[
		"box",
		kind("box", (n) => ({
			type: "box",
			attrs: {
				fill: n.attr("fill", token),
				border: n.attr("border", token),
				padding: n.attr("padding", opt(num)),
				keepTogether: n.attr("keepTogether", opt(bool)),
			},
			content: n.content(block),
		})),
	],
	[
		"image",
		kind("image", (n) => ({
			type: "image",
			attrs: {
				source: n.attr("source", opt(oneOf("logo", "mark", "photo"))),
				width: n.attr("width", opt(num)),
				height: n.attr("height", opt(num)),
				align: n.attr("align", align),
				alt: n.attr("alt", opt(str)),
			},
		})),
	],
	[
		"writeIn",
		kind("writeIn", (n) => ({
			type: "writeIn",
			attrs: {
				label: n.attr("label", opt(str)),
				key: n.attr("key", opt(str)),
				kind: n.attr("kind", opt(oneOf("text", "signature", "date"))),
				width: n.attr("width", opt(num)),
			},
		})),
	],
	[
		"slot",
		kind("slot", (n) => ({
			type: "slot",
			attrs: { label: n.attr("label", opt(str)), key: n.attr("key", opt(str)) },
			content: n.content(slotLine),
		})),
	],
	["table", table],
	[
		"if",
		kind("if", (n) => ({
			type: "if",
			attrs: {
				field: n.attr("field", str),
				test: n.attr("test", oneOf("has-value", "is-empty", "more-than")),
				value: n.attr("value", opt(num)),
			},
			content: n.content(block),
		})),
	],
]);
function block(v: unknown, p: string): BlockNode {
	const type = json(v, p).type;
	const read = typeof type === "string" ? BLOCKS.get(type) : undefined;
	return read ? read(v, p) : fail(`${p}.type`, "a block node");
}
const blocks = (v: unknown, p: string): BlockNode[] => clean(list(block)(v, p));

const pageSetup = (v: unknown, p: string): Omit<PageSetup, "header" | "footer"> => {
	const page = json(v, p);
	const margin = json(page.margin, `${p}.margin`);
	const tile = (t: unknown, at: string) => {
		const o = json(t, at);
		return {
			across: num(o.across, `${at}.across`),
			down: num(o.down, `${at}.down`),
			padding: num(o.padding, `${at}.padding`),
			cutMarks: bool(o.cutMarks, `${at}.cutMarks`),
		};
	};
	return clean({
		size: oneOf("letter", "legal", "a4", "half-letter", "card-4x6", "custom")(page.size, `${p}.size`),
		width: opt(num)(page.width, `${p}.width`),
		height: opt(num)(page.height, `${p}.height`),
		orientation: oneOf("portrait", "landscape")(page.orientation, `${p}.orientation`),
		margin: {
			top: num(margin.top, `${p}.margin.top`),
			right: num(margin.right, `${p}.margin.right`),
			bottom: num(margin.bottom, `${p}.margin.bottom`),
			left: num(margin.left, `${p}.margin.left`),
		},
		tile: opt(orNull(tile))(page.tile, `${p}.tile`),
	});
};
const fieldDecl: Read<FieldDecl> = (v, p) => {
	const f = json(v, p);
	return {
		key: str(f.key, `${p}.key`),
		label: str(f.label, `${p}.label`),
		type: oneOf("text", "date", "number", "list")(f.type, `${p}.type`),
		source: opt(orNull(str))(f.source, `${p}.source`),
		required: opt(bool)(f.required, `${p}.required`),
		sample: f.sample,
		fallback: opt(str)(f.fallback, `${p}.fallback`),
	};
};

export function documentFrom(base: DocDocument, editorJson: Json): DocDocument {
	const doc = json(clean(editorJson), "doc");
	const attrs = doc.attrs === undefined ? undefined : json(doc.attrs, "doc.attrs");
	const editorPage = attrs?.page === undefined ? undefined : json(attrs.page, "doc.attrs.page");
	const body = blankSlotsEmpty(blocksFromEditor(list(json)(doc.content ?? [], "doc.content")));
	const regionAt = (key: keyof typeof REGION_NODE): Region | null | undefined => {
		const at = key === "header" ? 0 : body.length - 1;
		const node = body[at];
		if (node?.type === REGION_NODE[key]) {
			body.splice(at, 1);
			const n = partsOf(node, `doc.${REGION_NODE[key]}`);
			return {
				pages: n.attr("pages", opt(oneOf("all", "first", "rest"))) ?? "all",
				content: blocks(node.content ?? [], `doc.${REGION_NODE[key]}.content`),
			};
		}
		return editorPage?.[key] === null ? null : undefined;
	};
	const header = regionAt("header");
	const footer = regionAt("footer");
	const page: PageSetup = {
		...pageSetup(editorPage ?? base.page, "doc.attrs.page"),
		...(header === undefined ? {} : { header }),
		...(footer === undefined ? {} : { footer }),
	};
	const { data: baseData, ...envelope } = base;
	const fields = attrs?.fields;
	const data = attrs ? opt(json)(attrs.data, "doc.attrs.data") : baseData;
	const next: DocNode = clean({ type: "doc", content: blocks(body, "doc.content") });
	return {
		...envelope,
		fields: fields === undefined ? base.fields : clean(list(fieldDecl)(fields, "doc.attrs.fields")),
		...(data === undefined ? {} : { data }),
		page,
		body: next,
		exports: exportsFor(base.exports, next),
	};
}
