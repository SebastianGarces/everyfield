import { safeLinkAddress } from "@everyfield/contracts/common";
import { FORMAT_SCHEMA, nativeFromText, type DocNode } from "@everyfield/contracts/documents";
import { crc32, inflateRawSync } from "node:zlib";

const UPLOAD_MAX = 10 * 1024 * 1024;
const EXPANDED_MAX = 40 * 1024 * 1024;
const ENTRY_MAX = 2000;
const TEXT_MAX = 2_000_000;
const PARSE_MS = 15_000;
const LOCAL = 0x04034b50;
const CENTRAL = 0x02014b50;
const EOCD = 0x06054b50;

export class ImportRejected extends Error {
	constructor(message: string) {
		super(message);
		this.name = "ImportRejected";
	}
}

/**
 * UTF-8 text or a modern Word document, as a native body: text lands as one paragraph for each line, a Word file keeps
 * its headings, lists and links. Legacy Word, macros and remote targets are refused. The caller still checks the body
 * against the format rules.
 */
export function readImport(bytes: Uint8Array, format: "text" | "docx"): DocNode {
	if (bytes.length > UPLOAD_MAX) throw new ImportRejected("The file must be 10 MiB or smaller.");
	if (isOle(bytes)) throw new ImportRejected("Legacy Word documents are not accepted.");
	if (format === "text") return nativeFromText(readText(bytes));
	return readDocx(bytes);
}

function isOle(bytes: Uint8Array) {
	return bytes.length >= 4 && bytes[0] === 0xd0 && bytes[1] === 0xcf && bytes[2] === 0x11 && bytes[3] === 0xe0;
}

function readText(bytes: Uint8Array) {
	let text: string;
	try {
		text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
	} catch {
		throw new ImportRejected("Text must be UTF-8.");
	}
	if (text.includes("\u0000")) throw new ImportRejected("Text contains a null character.");
	if (!text.trim()) throw new ImportRejected("Imported text is empty.");
	if (text.length > TEXT_MAX) throw new ImportRejected("Imported text is too long.");
	return text;
}

function readDocx(bytes: Uint8Array) {
	const started = Date.now();
	const entries = unzip(bytes, started);
	for (const name of entries.keys()) {
		const folded = name.toLowerCase();
		if (folded.includes("vba") || folded.includes("embeddings") || folded.includes("activex"))
			throw new ImportRejected("Word macros and embedded objects are not accepted.");
	}
	for (const [name, data] of entries) {
		if (!name.toLowerCase().endsWith(".rels")) continue;
		refuseExternal(data.toString("utf8"), sourceDir(name));
	}
	const xml = entries.get("word/document.xml");
	if (!xml) throw new ImportRejected("The Word file has no document text.");
	const part = (name: string) => entries.get(name)?.toString("utf8");
	const styles = readStyles(part("word/styles.xml"));
	return wordBody(xml.toString("utf8"), {
		styles,
		numbering: readNumbering(part("word/numbering.xml"), styles),
		links: readLinks(part("word/_rels/document.xml.rels")),
		deadline: started + PARSE_MS,
	});
}

function unzip(bytes: Uint8Array, started: number) {
	const entries = new Map<string, Buffer>();
	let offset = 0;
	let declared = 0;
	while (offset + 4 <= bytes.length) {
		if (Date.now() - started > PARSE_MS) throw new ImportRejected("The Word file took too long to read.");
		const sig = u32(bytes, offset);
		if (sig === CENTRAL || sig === EOCD) break;
		if (sig !== LOCAL) throw new ImportRejected("The Word file is not a valid document.");
		if (offset + 30 > bytes.length) throw new ImportRejected("The Word file is not a valid document.");
		const flags = u16(bytes, offset + 6);
		const method = u16(bytes, offset + 8);
		const crc = u32(bytes, offset + 14);
		const compressed = u32(bytes, offset + 18);
		const uncompressed = u32(bytes, offset + 22);
		const nameLen = u16(bytes, offset + 26);
		const extraLen = u16(bytes, offset + 28);
		if (flags & 0x1) throw new ImportRejected("Encrypted Word files are not accepted.");
		if (flags & 0x8) throw new ImportRejected("The Word file is not a valid document.");
		if (method !== 0 && method !== 8) throw new ImportRejected("The Word file is not a valid document.");
		const nameAt = offset + 30;
		const dataAt = nameAt + nameLen + extraLen;
		const dataEnd = dataAt + compressed;
		if (dataEnd > bytes.length) throw new ImportRejected("The Word file is not a valid document.");
		const name = Buffer.from(bytes.subarray(nameAt, nameAt + nameLen)).toString("utf8");
		refuseName(name);
		if (entries.has(name)) throw new ImportRejected("The Word file is not a valid document.");
		if (entries.size >= ENTRY_MAX) throw new ImportRejected("The Word file has too many parts.");
		declared += uncompressed;
		if (declared > EXPANDED_MAX) throw new ImportRejected("The Word file expands past 40 MiB.");
		const raw = Buffer.from(bytes.subarray(dataAt, dataEnd));
		const data = method === 0 ? raw : inflate(raw, uncompressed);
		if (data.length !== uncompressed) throw new ImportRejected("The Word file is not a valid document.");
		if (crc32(data) >>> 0 !== crc) throw new ImportRejected("The Word file is not a valid document.");
		entries.set(name, data);
		offset = dataEnd;
	}
	if (entries.size === 0) throw new ImportRejected("The Word file is not a valid document.");
	return entries;
}

/** Inflates one entry, stopping at the size its header declares: the 40 MiB cap counts declared sizes, so an entry
 * that inflates past its own declaration is refused before the extra bytes are allocated. */
function inflate(raw: Buffer, declared: number) {
	try {
		return inflateRawSync(raw, { maxOutputLength: Math.max(1, declared) });
	} catch {
		throw new ImportRejected("The Word file is not a valid document.");
	}
}

function refuseName(name: string) {
	if (!name || name.includes("\\") || name.includes("\u0000") || name.startsWith("/") || name.startsWith("\\"))
		throw new ImportRejected("The Word file is not a valid document.");
	if (name.split("/").some((part) => part === "" || part === "." || part === ".."))
		throw new ImportRejected("The Word file is not a valid document.");
}

/** The folder of the part a relationships file belongs to: `word/_rels/document.xml.rels` is `word/document.xml`'s, so
 * its targets resolve from `word/`; the package's own `_rels/.rels` resolves from the root. */
function sourceDir(relsName: string) {
	const at = relsName.lastIndexOf("_rels/");
	return relsName.slice(0, Math.max(0, at)).split("/").filter(Boolean);
}

/** Whether a part target stays inside the package once resolved from `dir` (OPC part names, ECMA-376 part 2 9.3). */
function insidePackage(target: string, dir: readonly string[]) {
	const path = target.startsWith("/") ? [] : [...dir];
	for (const part of target.split(/[?#]/, 1)[0]!.split("/")) {
		if (part === "..") {
			if (!path.length) return false;
			path.pop();
		} else if (part && part !== ".") path.push(part);
	}
	return true;
}

function refuseExternal(xml: string, dir: readonly string[]) {
	// Self-closing or not: readLinks reads both forms, so both are checked.
	const tags = xml.match(/<Relationship\b[^>]*>/gi) ?? [];
	for (const tag of tags) {
		const external = attr(tag, "TargetMode")?.toLowerCase() === "external";
		const target = attr(tag, "Target") ?? "";
		const type = (attr(tag, "Type") ?? "").toLowerCase();
		// A part target may climb to a sibling folder (textutil links `../docProps/meta.xml`) but not out of the package.
		// An external target is not a part, so any `..` in it points at the disk around the file.
		const outside = external ? target.split("/").includes("..") : !insidePackage(target, dir);
		if (outside || target.toLowerCase().startsWith("file:"))
			throw new ImportRejected("The Word file points outside the document.");
		if (external && !type.endsWith("/hyperlink"))
			throw new ImportRejected("The Word file points outside the document.");
	}
}

function attr(tag: string, name: string) {
	const found = new RegExp(String.raw`\b${name}\s*=\s*"([^"]*)"`, "i").exec(tag);
	return found?.[1] ?? null;
}

// The Word structure the import keeps (T-99): headings by style name or outline level, bulleted and numbered lists from
// numbering.xml, links to safe addresses and line breaks. Everything else stays a paragraph. Each part is read with
// bounded regular expressions, so a malformed or missing part leaves its paragraphs plain instead of throwing.

type Style = {
	name: string;
	basedOn: string | null;
	outline: number | null;
	numId: string | null;
};
type Numbering = (numId: string) => "bullet" | "ordered" | null;
type Word = {
	styles: Map<string, Style>;
	numbering: Numbering;
	links: Map<string, string>;
	deadline: number;
};
type Inline = { type: "text"; text: string; href: string | null } | { type: "hardBreak" };
type Open = {
	style: string | null;
	numId: string | null;
	outline: number | null;
	plain: boolean;
	inline: Inline[];
	split: boolean;
};
type Node = { type: string; attrs?: Record<string, unknown>; content?: Node[]; text?: string; marks?: unknown[] };

const LIST_MAX = Math.min(
	FORMAT_SCHEMA.nodes.bulletList!.content!.max ?? Infinity,
	FORMAT_SCHEMA.nodes.orderedList!.content!.max ?? Infinity,
);
const CHAIN_MAX = 20;
const val = (body: string, tag: string) => {
	const found = new RegExp(String.raw`<w:${tag}\b[^>]*?\bw:val\s*=\s*"([^"]*)"`).exec(body);
	return found ? decodeEntities(found[1]!) : null;
};
const int = (value: string | null) => {
	const n = value === null ? NaN : Number.parseInt(value, 10);
	return Number.isInteger(n) && n >= 0 ? n : null;
};

/** The paragraph styles by id: name, parent, outline level and the numbering each sets. Drops each style's change record. */
function readStyles(xml: string | undefined) {
	const styles = new Map<string, Style>();
	for (const found of (xml ?? "").matchAll(/<w:style\b([^>]*)>([\s\S]*?)<\/w:style>/g)) {
		const id = attr(found[1]!, "w:styleId");
		const body = found[2]!.replace(/<w:pPrChange\b[\s\S]*?<\/w:pPrChange>/g, "");
		if (id === null || styles.has(id)) continue;
		styles.set(decodeEntities(id), {
			name: (val(body, "name") ?? "").trim().toLowerCase(),
			basedOn: val(body, "basedOn"),
			outline: int(val(body, "outlineLvl")),
			numId: val(body, "numId"),
		});
	}
	return styles;
}

/** A style and the styles it is based on, nearest first, cycle-safe. */
function* chain(styles: Map<string, Style>, id: string | null) {
	const seen = new Set<string>();
	for (let at = id; at !== null && !seen.has(at) && seen.size < CHAIN_MAX;) {
		seen.add(at);
		const style = styles.get(at);
		if (!style) return;
		yield style;
		at = style.basedOn;
	}
}

/** Word levels 1 to 9 by style name ("heading 2") or outline level (0 is level 1); 9 and up read as level 3. */
const capped = (level: number) => Math.min(level, 3) as 1 | 2 | 3;
function headingOf(styles: Map<string, Style>, open: Open): 1 | 2 | 3 | null {
	if (open.outline !== null) return open.outline <= 8 ? capped(open.outline + 1) : null;
	for (const style of chain(styles, open.style)) {
		const named = /^heading\s*([1-9])$/.exec(style.name);
		if (named) return capped(Number(named[1]));
		if (style.outline !== null) return style.outline <= 8 ? capped(style.outline + 1) : null;
	}
	return null;
}

/** Each numbering instance's top-level format: its override, else its abstract definition's level 0. */
function readNumbering(xml: string | undefined, styles: Map<string, Style>): Numbering {
	const levels = (body: string) => {
		const out = new Map<number, string>();
		for (const lvl of body.matchAll(/<w:lvl\b([^>]*)>([\s\S]*?)<\/w:lvl>/g)) {
			const ilvl = int(attr(lvl[1]!, "w:ilvl"));
			const fmt = val(lvl[2]!, "numFmt");
			if (ilvl !== null && fmt !== null && !out.has(ilvl)) out.set(ilvl, fmt);
		}
		return out;
	};
	const abstracts = new Map<string, { levels: Map<number, string>; link: string | null }>();
	for (const found of (xml ?? "").matchAll(/<w:abstractNum\b([^>]*)>([\s\S]*?)<\/w:abstractNum>/g)) {
		const id = attr(found[1]!, "w:abstractNumId");
		if (id !== null && !abstracts.has(id))
			abstracts.set(id, { levels: levels(found[2]!), link: val(found[2]!, "numStyleLink") });
	}
	const nums = new Map<string, { abstract: string | null; overrides: Map<number, string> }>();
	for (const found of (xml ?? "").matchAll(/<w:num\b([^>]*)>([\s\S]*?)<\/w:num>/g)) {
		const id = attr(found[1]!, "w:numId");
		if (id !== null && !nums.has(id))
			nums.set(id, { abstract: val(found[2]!, "abstractNumId"), overrides: levels(found[2]!) });
	}
	const format = (numId: string, hops: number): "bullet" | "ordered" | null => {
		const num = nums.get(numId);
		if (!num) return null;
		const abstract = num.abstract === null ? undefined : abstracts.get(num.abstract);
		// A list defined by a numbering style takes its levels from the numbering that style sets.
		if (abstract && !abstract.levels.size && abstract.link && hops < 2)
			for (const style of chain(styles, abstract.link))
				if (style.numId && style.numId !== numId) return format(style.numId, hops + 1);
		return (num.overrides.get(0) ?? abstract?.levels.get(0)) === "bullet" ? "bullet" : "ordered";
	};
	return (numId) => format(numId, 0);
}

/** The document's hyperlink relationships whose address passes the native link rule. */
function readLinks(xml: string | undefined) {
	const links = new Map<string, string>();
	for (const [tag] of (xml ?? "").matchAll(/<Relationship\b[^>]*>/gi)) {
		const id = attr(tag, "Id");
		const target = attr(tag, "Target");
		if (id === null || target === null || attr(tag, "TargetMode")?.toLowerCase() !== "external") continue;
		if (!(attr(tag, "Type") ?? "").toLowerCase().endsWith("/hyperlink")) continue;
		const href = safeLinkAddress(decodeEntities(target));
		if (href) links.set(id, href);
	}
	return links;
}

/**
 * The list a numbered paragraph belongs to. Its kind is the numbering instance's top level, whatever the paragraph's
 * own level, so numbered steps with bulleted sub-points stay one numbered list.
 */
function listOf(word: Word, open: Open) {
	let numId = open.numId;
	for (const style of chain(word.styles, open.style)) numId ??= style.numId;
	if (numId === null || numId === "0") return null;
	const kind = word.numbering(numId);
	return kind ? { kind, numId } : null;
}

/** Runs of text with the same link join into one text node; a link mark holds its exact address. */
function inlineNodes(inline: Inline[]) {
	const out: Node[] = [];
	let href: string | null = null;
	for (const item of inline) {
		const last = out.at(-1);
		if (item.type === "hardBreak") out.push({ type: "hardBreak" });
		else if (!item.text) continue;
		else if (last?.type === "text" && href === item.href) last.text += item.text;
		else {
			href = item.href;
			out.push({ type: "text", text: item.text, ...(href ? { marks: [{ type: "link", attrs: { href } }] } : {}) });
		}
	}
	return out;
}

/**
 * The body of a Word document. Paragraphs in the body keep their heading level or list; paragraphs in tables and text
 * boxes stay plain. A text box inside a paragraph lands after the paragraph's text before it, so no text moves.
 */
function wordBody(xml: string, word: Word): DocNode {
	const blocks: Node[] = [];
	const stack: Open[] = [];
	let list: { kind: "bullet" | "ordered"; numId: string; node: Node & { content: Node[] } } | null = null;
	let size = 0;
	let printable = false;
	let plainDepth = 0;
	let skipDepth = 0;
	let pPrDepth = 0;
	let inText = false;
	let textFrom = 0;
	let steps = 0;
	const links: (string | null)[] = [];

	const emit = (open: Open) => {
		size += 1;
		const content = inlineNodes(open.inline);
		const paragraph: Node = content.length ? { type: "paragraph", content } : { type: "paragraph" };
		const level = open.plain ? null : headingOf(word.styles, open);
		const kind = open.plain || level !== null ? null : listOf(word, open);
		if (!kind) {
			list = null;
			blocks.push(
				level === null ? paragraph : { type: "heading", attrs: { level }, ...(content.length ? { content } : {}) },
			);
			return;
		}
		if (!list || list.kind !== kind.kind || list.numId !== kind.numId || list.node.content.length >= LIST_MAX) {
			list = { ...kind, node: { type: kind.kind === "bullet" ? "bulletList" : "orderedList", content: [] } };
			blocks.push(list.node);
		}
		list.node.content.push({ type: "listItem", content: [paragraph] });
	};
	const add = (item: Inline) => {
		const open = stack.at(-1);
		if (!open || skipDepth) return;
		open.inline.push(item);
		size += item.type === "text" ? item.text.length : 1;
		if (item.type === "text" && item.text.trim()) printable = true;
		if (size > TEXT_MAX) throw new ImportRejected("Imported text is too long.");
	};

	for (const found of xml.matchAll(/<(\/?)([\w.-]+:)?([\w.-]+)([^>]*?)(\/?)>/g)) {
		if (++steps % 4096 === 0 && Date.now() > word.deadline)
			throw new ImportRejected("The Word file took too long to read.");
		const [, closing, prefix = "", local = "", rest = "", selfClosing] = found;
		const name = prefix + local;
		if (inText) {
			add({ type: "text", text: decodeEntities(xml.slice(textFrom, found.index)), href: links.at(-1) ?? null });
			inText = false;
		}
		// The fallback copy of a drawing repeats its text box, and a change record repeats old properties.
		if (name === "mc:Fallback" || name === "w:pPrChange" || name === "w:rPrChange") {
			if (!selfClosing) skipDepth += closing ? -1 : 1;
			continue;
		}
		if (skipDepth) continue;
		if (closing) {
			if (name === "w:p") {
				const open = stack.pop();
				if (open && !(open.split && !open.inline.length)) emit(open);
			} else if (name === "w:pPr") pPrDepth = Math.max(0, pPrDepth - 1);
			else if (name === "w:tbl" || name === "w:txbxContent") plainDepth = Math.max(0, plainDepth - 1);
			else if (name === "w:hyperlink") links.pop();
			continue;
		}
		const open = stack.at(-1);
		if (name === "w:p") {
			const next: Open = {
				style: null,
				numId: null,
				outline: null,
				plain: plainDepth > 0,
				inline: [],
				split: false,
			};
			if (selfClosing) emit(next);
			else {
				if (open?.inline.length) {
					emit(open);
					open.inline = [];
					open.split = true;
				}
				stack.push(next);
			}
		} else if (name === "w:pPr") {
			if (!selfClosing) pPrDepth += 1;
		} else if (pPrDepth && open) {
			const value = attr(rest, "w:val");
			if (name === "w:pStyle" && value !== null) open.style = decodeEntities(value);
			else if (name === "w:numId") open.numId = value;
			else if (name === "w:outlineLvl") open.outline = int(value);
		} else if (name === "w:tbl" || name === "w:txbxContent") {
			if (!selfClosing) plainDepth += 1;
		} else if (name === "w:hyperlink") {
			if (!selfClosing) {
				const id = attr(rest, "r:id");
				links.push(id === null ? null : (word.links.get(id) ?? null));
			}
		} else if (name === "w:t" && !selfClosing) {
			inText = true;
			textFrom = found.index + found[0].length;
		} else if (name === "w:br" || name === "w:cr") add({ type: "hardBreak" });
		// A tab in a run reads as a space; a tab stop in w:pPr is caught above.
		else if (name === "w:tab") add({ type: "text", text: " ", href: links.at(-1) ?? null });
	}
	// Text and paragraphs the file never closes still land, so no text is lost.
	if (inText) add({ type: "text", text: decodeEntities(xml.slice(textFrom)), href: links.at(-1) ?? null });
	while (stack.length) {
		const open = stack.pop()!;
		if (!(open.split && !open.inline.length)) emit(open);
	}
	if (!printable) throw new ImportRejected("Imported text is empty.");
	while (blocks.length && blocks.at(-1)!.type === "paragraph" && !blocks.at(-1)!.content) blocks.pop();
	return { type: "doc", content: blocks } as DocNode;
}

const NAMED: Record<string, string> = { lt: "<", gt: ">", quot: '"', apos: "'", amp: "&" };
/** A code point XML 1.0 allows in a document (its Char production). */
const xmlChar = (n: number) =>
	n === 0x9 ||
	n === 0xa ||
	n === 0xd ||
	(n >= 0x20 && n <= 0xd7ff) ||
	(n >= 0xe000 && n <= 0xfffd) ||
	(n >= 0x10000 && n <= 0x10ffff);

/** The five named entities and `&#N;` / `&#xN;` references, in one pass so `&amp;#38;` stays `&#38;`. A reference to a
 * character XML forbids stays as written. */
function decodeEntities(value: string) {
	return value.replace(/&(?:#(\d{1,7})|#x([0-9a-fA-F]{1,6})|(lt|gt|quot|apos|amp));/g, (whole, dec, hex, named) => {
		if (named) return NAMED[named]!;
		const n = dec ? Number.parseInt(dec, 10) : Number.parseInt(hex, 16);
		return xmlChar(n) ? String.fromCodePoint(n) : whole;
	});
}

function u16(bytes: Uint8Array, offset: number) {
	return bytes[offset]! | (bytes[offset + 1]! << 8);
}

function u32(bytes: Uint8Array, offset: number) {
	return (bytes[offset]! | (bytes[offset + 1]! << 8) | (bytes[offset + 2]! << 16) | (bytes[offset + 3]! << 24)) >>> 0;
}
