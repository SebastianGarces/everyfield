import "server-only";
import type { Diagram, HierarchyNode, WikiBlock as Block } from "@everyfield/contracts/wiki";

/** `credit` is a human credit (see `humanCredit`) or null, and never a source path or digest. */
export type PdfRenderMeta = { filename: string; credit: string | null };
export type PdfRenderer = (title: string, blocks: readonly Block[], meta?: PdfRenderMeta) => Uint8Array;

const BODY_LINES = 46;
/** Helvetica at 11pt across the 468pt text width, in 1/1000 em. */
const TEXT_WIDTH = (468 * 1000) / 11;
/** Courier at 10pt is 6pt a character, so 78 characters fill the 468pt text width. Code lines break there. */
const CODE_WIDTH = 78;
/** Four spaces of Helvetica at 11pt, in 1/1000 em: a quote's indent. */
const QUOTE_INDENT = 4 * 278;

export function escapeHtml(text: string): string {
	return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

export function pdfFilename(slug: string): string {
	const clean = slug.replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "");
	return `${clean || "article"}.pdf`;
}

/** cp1252 bytes 0x80 to 0x9f. NUL marks the five unassigned bytes. */
const CP1252_HIGH = "€\0‚ƒ„…†‡ˆ‰Š‹Œ\0Ž\0\0‘’“”•–—˜™š›œ\0žŸ";
const WIN_ANSI = new Map<string, number>();
for (let byte = 0x20; byte <= 0x7e; byte++) WIN_ANSI.set(String.fromCharCode(byte), byte);
for (let byte = 0xa0; byte <= 0xff; byte++) WIN_ANSI.set(String.fromCharCode(byte), byte);
[...CP1252_HIGH].forEach((char, index) => {
	if (char !== "\0") WIN_ANSI.set(char, 0x80 + index);
});

/**
 * Text as WinAnsi bytes, one char per byte. A letter outside WinAnsi prints as its base letter when it has one
 * (ő as o), anything else as "?".
 */
function winAnsi(text: string): string {
	let out = "";
	for (const char of text.replace(/\t/g, "    ")) {
		const byte = WIN_ANSI.get(char);
		if (byte !== undefined) {
			out += String.fromCharCode(byte);
			continue;
		}
		const base = char.normalize("NFKD").replace(/\p{M}/gu, "");
		const bytes = [...base].map((part) => WIN_ANSI.get(part));
		out += base && bytes.every((part) => part !== undefined) ? String.fromCharCode(...(bytes as number[])) : "?";
	}
	return out;
}

/** A PDF string literal body for WinAnsi bytes. */
function pdfString(text: string): string {
	return winAnsi(text).replace(/\\/g, "\\\\").replace(/\(/g, "\\(").replace(/\)/g, "\\)");
}

/** Helvetica advance widths for bytes 0x20 to 0x7e (Adobe AFM). */
const HELVETICA = [
	278, 278, 355, 556, 556, 889, 667, 191, 333, 333, 389, 584, 278, 333, 278, 278, 556, 556, 556, 556, 556, 556, 556,
	556, 556, 556, 278, 278, 584, 584, 584, 556, 1015, 667, 667, 722, 722, 667, 611, 778, 722, 278, 500, 667, 556, 833,
	722, 778, 667, 778, 722, 667, 611, 722, 667, 944, 667, 667, 611, 278, 278, 278, 469, 556, 333, 556, 556, 500, 556,
	556, 278, 556, 556, 222, 222, 500, 222, 833, 556, 556, 556, 556, 333, 500, 278, 556, 500, 722, 500, 500, 500, 334,
	260, 334, 584,
];
const HIGH_WIDTH: Record<string, number> = {
	"…": 1000,
	"—": 1000,
	"™": 1000,
	"‘": 222,
	"’": 222,
	"“": 333,
	"”": 333,
	"•": 350,
};

function byteWidth(char: string): number {
	const code = char.charCodeAt(0);
	if (code >= 0x20 && code <= 0x7e) return HELVETICA[code - 0x20] ?? 556;
	const decoded = code >= 0x80 && code <= 0x9f ? (CP1252_HIGH[code - 0x80] ?? "") : char;
	const known = HIGH_WIDTH[decoded];
	if (known) return known;
	const base = decoded.normalize("NFD")[0] ?? "";
	const baseCode = base.charCodeAt(0);
	return baseCode >= 0x20 && baseCode <= 0x7e ? (HELVETICA[baseCode - 0x20] ?? 556) : 556;
}

/** The printed width of text in Helvetica, in 1/1000 em. */
export function helveticaWidth(text: string): number {
	let width = 0;
	for (const char of winAnsi(text)) width += byteWidth(char);
	return width;
}

/** Prose broken at spaces into lines that fit the text width. A word longer than a line breaks inside it. */
function wrapText(text: string, width = TEXT_WIDTH): string[] {
	if (helveticaWidth(text) <= width) return [text];
	const lines: string[] = [];
	let line = "";
	for (const word of text.split(" ")) {
		const joined = line ? `${line} ${word}` : word;
		if (helveticaWidth(joined) <= width) {
			line = joined;
			continue;
		}
		if (line) lines.push(line);
		line = word;
		while (helveticaWidth(line) > width) {
			let cut = 1;
			while (cut < line.length && helveticaWidth(line.slice(0, cut + 1)) <= width) cut++;
			lines.push(line.slice(0, cut));
			line = line.slice(cut);
		}
	}
	if (line) lines.push(line);
	return lines;
}

/**
 * Inline markdown as the words a reader sees: code spans keep their text, links and images keep their label, bold,
 * italic and strike markers and inline tags go.
 */
function plainInline(text: string): string {
	return text
		.split(/(`+[^`]*?`+)/)
		.map((part, index) => {
			if (index % 2 === 1) return part.replace(/^(`+)\s?([\s\S]*?)\s?\1$/, "$2");
			return (
				part
					.replace(/!?\[([^\]]*)\]\([^)]*\)/g, "$1")
					.replace(/<\/?[A-Za-z][^>]*>/g, "")
					.replace(/\*\*(?=\S)([\s\S]*?\S)\*\*/g, "$1")
					.replace(/~~(?=\S)([\s\S]*?\S)~~/g, "$1")
					.replace(/(?<![\w*])\*(?=\S)([\s\S]*?\S)\*(?!\*)/g, "$1")
					// One underscore each side, so fill-in blanks (`____`) and `__dunder__` words stay as written.
					.replace(/(?<![\w_])_(?=[^\s_])([\s\S]*?[^\s_])_(?![\w_])/g, "$1")
					.replace(/\\([!-/:-@[-`{-~])/g, "$1")
			);
		})
		.join("");
}

/** A block as the export shows it. Text keeps its inline markers; each writer strips them. */
type Shown =
	| { kind: "heading"; level: number; text: string }
	| { kind: "paragraph"; lines: string[] }
	| { kind: "quote"; lines: string[] }
	| { kind: "list"; ordered: boolean; items: string[] }
	| { kind: "table"; rows: string[][] }
	| { kind: "callout"; lines: string[] }
	| { kind: "code"; text: string }
	| { kind: "diagram"; diagram: Diagram };

/** The reader's blocks for export: blank lines, breaks and empty components drop out. */
function shown(blocks: readonly Block[]): Shown[] {
	const out: Shown[] = [];
	const lines = (text: string) => text.split("\n").filter((line) => line.trim().length > 0);
	for (const block of blocks) {
		if (block.kind === "heading") out.push({ kind: "heading", level: block.level, text: block.text });
		else if (block.kind === "paragraph") out.push({ kind: "paragraph", lines: block.paragraphs.flatMap(lines) });
		else if (block.kind === "quote") out.push({ kind: "quote", lines: lines(block.text) });
		else if (block.kind === "list") out.push({ kind: "list", ordered: block.ordered, items: block.items });
		else if (block.kind === "table") {
			if (block.rows.length) out.push({ kind: "table", rows: block.rows });
		} else if (block.kind === "callout") {
			if (block.text) out.push({ kind: "callout", lines: lines(block.text) });
		} else if (block.kind === "component") {
			// Any other component prints what it says without its tags.
			if (block.text) out.push({ kind: "paragraph", lines: lines(block.text) });
		} else if (block.kind === "code") out.push({ kind: "code", text: block.text });
		else if (block.kind === "diagram") out.push({ kind: "diagram", diagram: block.diagram });
	}
	return out;
}

/** One printed line. Code lines print in Courier, every other line in Helvetica. */
type Line = { text: string; code?: true };

/** A diagram as text: its title, the type name, one line per node, then the loop. Flow steps end with "->". */
function diagramText(diagram: Diagram): string[] {
	const node = (n: { label: string; detail?: string; note?: string }) =>
		`${n.label}${n.detail ? ` - ${n.detail}` : ""}${n.note ? ` (${n.note})` : ""}`;
	const lines = [diagram.title, `${diagram.type[0]!.toUpperCase()}${diagram.type.slice(1)} diagram`];
	if (diagram.type === "hierarchy") {
		const walk = (nodes: readonly HierarchyNode[], depth: number) => {
			for (const n of nodes) {
				lines.push(`${"  ".repeat(depth)}${node(n)}`);
				walk(n.children, depth + 1);
			}
		};
		walk(diagram.nodes, 0);
	} else
		diagram.nodes.forEach((n, index) => {
			const join = diagram.type === "flow" && index < diagram.nodes.length - 1 ? " ->" : "";
			lines.push(`${index + 1}. ${node(n)}${join}`);
		});
	if (diagram.loop) lines.push(`Repeats: ${diagram.loop}`);
	return lines;
}

function visibleLines(title: string, blocks: readonly Block[], filename: string): Line[] {
	const lines: Line[] = [{ text: filename }, { text: title }];
	const raw = (text: string) => lines.push(...wrapText(text).map((part) => ({ text: part })));
	const prose = (text: string) => raw(plainInline(text));
	for (const block of shown(blocks)) {
		if (block.kind === "heading") prose(block.text);
		else if (block.kind === "paragraph" || block.kind === "callout") block.lines.forEach(prose);
		// A quote is indented under the text around it.
		else if (block.kind === "quote")
			for (const line of block.lines)
				lines.push(...wrapText(plainInline(line), TEXT_WIDTH - QUOTE_INDENT).map((part) => ({ text: `    ${part}` })));
		else if (block.kind === "list")
			block.items.forEach((item, index) => prose(block.ordered ? `${index + 1}. ${item}` : `• ${item}`));
		else if (block.kind === "table") for (const row of block.rows) raw(row.map(plainInline).join(" | "));
		else if (block.kind === "diagram") diagramText(block.diagram).forEach(raw);
		else {
			// Code keeps its leading spaces and breaks only at the page width.
			for (const line of block.text.split("\n"))
				for (let i = 0; i === 0 || i < line.length; i += CODE_WIDTH)
					lines.push({ text: line.slice(i, i + CODE_WIDTH), code: true });
		}
	}
	return lines;
}

function pageStream(lines: Line[], footer: string): string {
	const commands = ["BT", "/F1 11 Tf", "72 740 Td", "14 TL"];
	let code = false;
	lines.forEach((line, index) => {
		if (!!line.code !== code) {
			code = !!line.code;
			commands.push(code ? "/F2 10 Tf" : "/F1 11 Tf");
		}
		const text = `(${pdfString(line.text)}) Tj`;
		commands.push(index === 0 ? text : `T* ${text}`);
	});
	commands.push("ET", "BT", "/F1 9 Tf", `72 40 Td (${pdfString(footer)}) Tj`, "ET");
	return commands.join("\n");
}

/** The file as bytes. Every string holds one char per byte, so it is written as latin1. */
function pdfBytes(streams: string[], filename: string): Uint8Array {
	const fontObject = 3 + streams.length * 2;
	const codeFont = fontObject + 1;
	const infoObject = codeFont + 1;
	const kids = streams.map((_, index) => `${3 + index * 2} 0 R`).join(" ");
	const objects = ["<< /Type /Catalog /Pages 2 0 R >>", `<< /Type /Pages /Count ${streams.length} /Kids [${kids}] >>`];
	streams.forEach((stream, index) => {
		const content = 4 + index * 2;
		objects.push(
			`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents ${content} 0 R /Resources << /Font << /F1 ${fontObject} 0 R /F2 ${codeFont} 0 R >> >> >>`,
		);
		objects.push(`<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`);
	});
	objects.push("<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>");
	objects.push("<< /Type /Font /Subtype /Type1 /BaseFont /Courier /Encoding /WinAnsiEncoding >>");
	objects.push(`<< /Title (${pdfString(filename)}) /Producer (Everyfield) >>`);
	let pdf = "%PDF-1.4\n%\xe2\xe3\xcf\xd3\n";
	const offsets = [0];
	objects.forEach((object, index) => {
		offsets.push(pdf.length);
		pdf += `${index + 1} 0 obj\n${object}\nendobj\n`;
	});
	const xref = pdf.length;
	pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
	for (let index = 1; index < offsets.length; index += 1)
		pdf += `${String(offsets[index]).padStart(10, "0")} 00000 n \n`;
	pdf += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R /Info ${infoObject} 0 R >>\nstartxref\n${xref}\n%%EOF`;
	return Buffer.from(pdf, "latin1");
}

/**
 * Paginated PDF in the standard Helvetica and Courier with WinAnsi text. Each page keeps the filename, the article
 * lines, and a footer with the human credit, when there is one, and the page number.
 */
export function helveticaPdf(title: string, blocks: readonly Block[], meta?: PdfRenderMeta): Uint8Array {
	const filename = meta?.filename ?? "article.pdf";
	const credit = meta?.credit ?? null;
	const lines = visibleLines(title, blocks, filename);
	const pages = Math.ceil(lines.length / BODY_LINES);
	const streams: string[] = [];
	for (let start = 0; start < lines.length; start += BODY_LINES) {
		const page = `${Math.floor(start / BODY_LINES) + 1}/${pages}`;
		streams.push(pageStream(lines.slice(start, start + BODY_LINES), credit ? `${credit}  ${page}` : page));
	}
	return pdfBytes(streams, filename);
}

const text = (value: string) => escapeHtml(plainInline(value));

function htmlBlock(block: Shown): string {
	if (block.kind === "heading") {
		const level = Math.min(Math.max(block.level, 1), 6);
		return `<h${level}>${text(block.text)}</h${level}>`;
	}
	if (block.kind === "paragraph") return block.lines.map((line) => `<p>${text(line)}</p>`).join("");
	if (block.kind === "quote")
		return `<blockquote>${block.lines.map((line) => `<p>${text(line)}</p>`).join("")}</blockquote>`;
	if (block.kind === "callout") return `<aside>${block.lines.map((line) => `<p>${text(line)}</p>`).join("")}</aside>`;
	if (block.kind === "list") {
		const tag = block.ordered ? "ol" : "ul";
		return `<${tag}>${block.items.map((item) => `<li>${text(item)}</li>`).join("")}</${tag}>`;
	}
	if (block.kind === "code") return `<pre><code>${escapeHtml(block.text)}</code></pre>`;
	if (block.kind === "diagram") return diagramHtml(block.diagram);
	const rows = block.rows.map((row) => `<tr>${row.map((cell) => `<td>${text(cell)}</td>`).join("")}</tr>`).join("");
	return `<table>${rows}</table>`;
}

/** A diagram as the app marks it up, without the drawing: a figure named by its title and its nodes as a list. */
function diagramHtml(diagram: Diagram): string {
	type Node = { label: string; detail?: string; note?: string; children?: readonly Node[] };
	const item = (node: Node): string =>
		`<li><strong>${escapeHtml(node.label)}</strong>${node.detail ? ` - ${escapeHtml(node.detail)}` : ""}${
			node.note ? ` (${escapeHtml(node.note)})` : ""
		}${node.children?.length ? `<ul>${node.children.map(item).join("")}</ul>` : ""}</li>`;
	const tag = diagram.type === "hierarchy" ? "ul" : "ol";
	const nodes: readonly Node[] = diagram.nodes;
	const loop = diagram.loop ? `<p>Repeats: ${escapeHtml(diagram.loop)}</p>` : "";
	return `<figure><figcaption>${escapeHtml(diagram.title)}</figcaption><${tag}>${nodes.map(item).join("")}</${tag}>${loop}</figure>`;
}

/** The same rendered article as the PDF, as HTML. The body is not raw MDX in a pre element. */
export function printHtml(title: string, blocks: readonly Block[], meta?: PdfRenderMeta): string {
	const filename = meta?.filename ?? "article.pdf";
	const credit = meta?.credit ?? null;
	const rendered = shown(blocks).map(htmlBlock).join("");
	return `<!doctype html><html><head><meta charset="utf-8"><title>${escapeHtml(title)}</title></head><body><p>${escapeHtml(filename)}</p><h1>${escapeHtml(title)}</h1>${rendered}<footer>${credit ? escapeHtml(credit) : ""}</footer></body></html>`;
}
