import "server-only";
import {
	closesFence,
	isDiagramInfo,
	openFence,
	parseDiagram,
	type Diagram,
	type HierarchyNode,
} from "@everyfield/contracts/wiki";

export type PdfRenderMeta = { filename: string; source: string };
export type PdfRenderer = (title: string, body: string, meta?: PdfRenderMeta) => Uint8Array;

const BODY_LINES = 46;
const WRAP = 90;
/** Courier at 10pt is 6pt a character, so 78 characters fill the 468pt text width. Code lines break there. */
const CODE_WIDTH = 78;

function escapePdf(text: string): string {
	return text
		.replace(/[^\n\x20-\x7e]/g, "?")
		.replace(/\\/g, "\\\\")
		.replace(/\(/g, "\\(")
		.replace(/\)/g, "\\)");
}

export function escapeHtml(text: string): string {
	return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

export function pdfFilename(slug: string): string {
	const clean = slug.replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "");
	return `${clean || "article"}.pdf`;
}

type Block =
	| { kind: "heading"; level: number; text: string }
	| { kind: "paragraph"; text: string }
	| { kind: "list"; items: string[] }
	| { kind: "table"; rows: string[][] }
	| { kind: "callout"; text: string }
	| { kind: "code"; text: string }
	| { kind: "diagram"; diagram: Diagram };

function cells(line: string): string[] {
	return line
		.split("|")
		.map((cell) => cell.trim())
		.filter((cell) => cell.length > 0 && !/^:?-+:?$/.test(cell));
}

/** Rendered article blocks. Markdown markers become structure. Every content line stays. */
export function articleBlocks(body: string): Block[] {
	const blocks: Block[] = [];
	const lines = body.split(/\n/);
	let index = 0;
	const pushParagraph = (text: string) => {
		if (text.trim()) blocks.push({ kind: "paragraph", text: text.trim() });
	};
	while (index < lines.length) {
		const line = lines[index] ?? "";
		const fence = openFence(line);
		if (fence) {
			// A fence is never markdown. A diagram that does not parse prints its source, like any code.
			let close = index + 1;
			while (close < lines.length && !closesFence(lines[close] ?? "", fence)) close += 1;
			const text = lines.slice(index + 1, close).join("\n");
			const parsed = isDiagramInfo(fence.info) ? parseDiagram(fence.info, text) : null;
			blocks.push(parsed?.ok ? { kind: "diagram", diagram: parsed.diagram } : { kind: "code", text });
			index = close + 1;
			continue;
		}
		const trimmed = line.trim();
		if (!trimmed) {
			index += 1;
			continue;
		}
		const heading = /^(#{1,6})\s+(.+)$/.exec(trimmed);
		if (heading?.[1] && heading[2]) {
			blocks.push({ kind: "heading", level: heading[1].length, text: heading[2].trim() });
			index += 1;
			continue;
		}
		if (/^<Callout\b/.test(trimmed)) {
			const inline = trimmed
				.replace(/^<Callout\b[^>]*>/, "")
				.replace(/<\/Callout>\s*$/, "")
				.trim();
			const inner: string[] = inline ? [inline] : [];
			if (!trimmed.includes("</Callout>")) {
				index += 1;
				while (index < lines.length && !(lines[index] ?? "").includes("</Callout>")) {
					const text = (lines[index] ?? "").trim();
					if (text) inner.push(text);
					index += 1;
				}
			}
			blocks.push({ kind: "callout", text: inner.join("\n") });
			index += 1;
			continue;
		}
		if (trimmed === "</Callout>" || trimmed === "---") {
			index += 1;
			continue;
		}
		if (trimmed.startsWith("|")) {
			const rows: string[][] = [];
			while (index < lines.length && (lines[index] ?? "").trim().startsWith("|")) {
				const row = cells(lines[index] ?? "");
				if (row.length) rows.push(row);
				index += 1;
			}
			if (rows.length) blocks.push({ kind: "table", rows });
			continue;
		}
		const item = /^(?:[-*]|\d+\.)\s+(.+)$/.exec(trimmed);
		if (item?.[1]) {
			const items: string[] = [];
			while (index < lines.length) {
				const next = /^(?:[-*]|\d+\.)\s+(.+)$/.exec((lines[index] ?? "").trim());
				if (!next?.[1]) break;
				items.push(next[1].trim());
				index += 1;
			}
			blocks.push({ kind: "list", items });
			continue;
		}
		pushParagraph(trimmed);
		index += 1;
	}
	return blocks;
}

/** One printed line. Code lines print in Courier, every other line in Helvetica. */
type Line = { text: string; code?: true };

/** A diagram as text: its title, the type name, one line per node, then the loop. Flow steps end with "->". */
export function diagramText(diagram: Diagram): string[] {
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

function visibleLines(title: string, body: string, filename: string): Line[] {
	const lines: Line[] = [{ text: filename }, { text: title }];
	const prose = (text: string) => lines.push(...wrap(text).map((part) => ({ text: part })));
	for (const block of articleBlocks(body)) {
		if (block.kind === "heading" || block.kind === "paragraph" || block.kind === "callout") {
			for (const line of block.text.split("\n")) prose(line);
		} else if (block.kind === "list") {
			for (const item of block.items) prose(item);
		} else if (block.kind === "table") {
			for (const row of block.rows) prose(row.join(" | "));
		} else if (block.kind === "diagram") {
			for (const line of diagramText(block.diagram)) prose(line);
		} else {
			// Code keeps its leading spaces and breaks only at the page width.
			for (const line of block.text.split("\n"))
				for (let i = 0; i === 0 || i < line.length; i += CODE_WIDTH)
					lines.push({ text: line.slice(i, i + CODE_WIDTH), code: true });
		}
	}
	return lines;
}

function wrap(line: string): string[] {
	if (line.length <= WRAP) return [line];
	const parts: string[] = [];
	for (let i = 0; i < line.length; i += WRAP) parts.push(line.slice(i, i + WRAP));
	return parts;
}

function pageStream(lines: Line[], footer: string): string {
	const commands = ["BT", "/F1 11 Tf", "72 740 Td", "14 TL"];
	let code = false;
	lines.forEach((line, index) => {
		if (!!line.code !== code) {
			code = !!line.code;
			commands.push(code ? "/F2 10 Tf" : "/F1 11 Tf");
		}
		const text = `(${escapePdf(line.text)}) Tj`;
		commands.push(index === 0 ? text : `T* ${text}`);
	});
	commands.push("ET", "BT", "/F1 9 Tf", `72 40 Td (${escapePdf(footer)}) Tj`, "ET");
	return commands.join("\n");
}

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
		objects.push(`<< /Length ${Buffer.byteLength(stream)} >>\nstream\n${stream}\nendstream`);
	});
	objects.push("<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>");
	objects.push("<< /Type /Font /Subtype /Type1 /BaseFont /Courier >>");
	objects.push(`<< /Title (${escapePdf(filename)}) /Producer (Everyfield) >>`);
	let pdf = "%PDF-1.4\n";
	const offsets = [0];
	objects.forEach((object, index) => {
		offsets.push(Buffer.byteLength(pdf));
		pdf += `${index + 1} 0 obj\n${object}\nendobj\n`;
	});
	const xref = Buffer.byteLength(pdf);
	pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
	for (let index = 1; index < offsets.length; index += 1)
		pdf += `${String(offsets[index]).padStart(10, "0")} 00000 n \n`;
	pdf += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R /Info ${infoObject} 0 R >>\nstartxref\n${xref}\n%%EOF`;
	return Buffer.from(pdf);
}

/** Paginated PDF. Helvetica and Courier are standard. Each page keeps a filename, the article lines, and a source footer. */
export function helveticaPdf(title: string, body: string, meta?: PdfRenderMeta): Uint8Array {
	const filename = meta?.filename ?? "article.pdf";
	const source = meta?.source ?? "";
	const lines = visibleLines(title, body, filename);
	const streams: string[] = [];
	for (let start = 0; start < lines.length; start += BODY_LINES) {
		const page = Math.floor(start / BODY_LINES) + 1;
		const pages = Math.ceil(lines.length / BODY_LINES);
		streams.push(pageStream(lines.slice(start, start + BODY_LINES), `${source}  ${page}/${pages}`));
	}
	return pdfBytes(streams, filename);
}

function htmlBlock(block: Block): string {
	if (block.kind === "heading") {
		const level = Math.min(Math.max(block.level, 1), 6);
		return `<h${level}>${escapeHtml(block.text)}</h${level}>`;
	}
	if (block.kind === "paragraph") return `<p>${escapeHtml(block.text)}</p>`;
	if (block.kind === "callout")
		return `<aside>${block.text
			.split("\n")
			.map((line) => `<p>${escapeHtml(line)}</p>`)
			.join("")}</aside>`;
	if (block.kind === "list") return `<ul>${block.items.map((item) => `<li>${escapeHtml(item)}</li>`).join("")}</ul>`;
	if (block.kind === "code") return `<pre><code>${escapeHtml(block.text)}</code></pre>`;
	if (block.kind === "diagram") return diagramHtml(block.diagram);
	const rows = block.rows
		.map((row) => `<tr>${row.map((cell) => `<td>${escapeHtml(cell)}</td>`).join("")}</tr>`)
		.join("");
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
export function printHtml(title: string, body: string, meta?: PdfRenderMeta): string {
	const filename = meta?.filename ?? "article.pdf";
	const source = meta?.source ?? "";
	const rendered = articleBlocks(body).map(htmlBlock).join("");
	return `<!doctype html><html><head><meta charset="utf-8"><title>${escapeHtml(title)}</title></head><body><p>${escapeHtml(filename)}</p><h1>${escapeHtml(title)}</h1>${rendered}<footer>${escapeHtml(source)}</footer></body></html>`;
}
