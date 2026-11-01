import type {
	BlockNode,
	CellNode,
	ColumnSpec,
	EveryfieldDoc,
	InlineNode,
	ParagraphNode,
	Region,
	TableNode,
} from "@everyfield/contracts/documents";
import { attrsOf, computeTable, pageBox, tileBox } from "@everyfield/contracts/documents";
import { fieldValues, listValues } from "./doc-values.ts";
import { HEAD, NS, border, escape, hex, styles, type DocxCtx } from "./docx.ts";
import { formatNumber } from "./layouts/doc.tsx";
import { LEGAL_NOTICE } from "./layouts/blocks.tsx";
import { SLOT_BLANK_NOTE } from "./templates/church.ts";
import { makePalette, tokenColor, type RenderTheme, type ThemeImage } from "./theme.ts";
import { zip, type ZipEntry } from "./zip.ts";

// The Word file of one everyfield.doc/1 document: a tree walker over the same nodes the PDF renderer walks. Prose maps
// to w:p and w:r. Word has no side-by-side blocks, panels or tiles, so columns and boxes are borderless or shaded
// tables, and a tiled sheet is a table of fixed-height cells. Headers and footers are Word headers and footers with
// PAGE and NUMPAGES fields. Same document, same theme, same bytes.

const TW = 20; // twips per point
const EMU_PER_PT = 12700;
const NUM_BULLET = 1;
const NUM_FIRST_LIST = 10;

type Part = { rels: string[]; images: { name: string; bytes: Uint8Array }[] };
type W = DocxCtx & {
	doc: EveryfieldDoc;
	theme: RenderTheme;
	values: Record<string, string>;
	/** The text width of the current place, in twips. */
	width: number;
	/** The fill under the current place, for text on a colored panel. */
	fill: string | null;
	part: Part;
	lists: number[];
	media: Map<ThemeImage, string>;
	headings: { h2: number; h3: number };
	drawings: { n: number };
};

const onFill = (w: W) =>
	w.fill && w.fill !== w.p.muted ? (w.fill === w.p.primary ? w.p.onPrimary : w.p.onAccent) : null;

type RunStyle = {
	bold?: boolean;
	italic?: boolean;
	underline?: boolean;
	caps?: boolean;
	size?: number;
	color?: string;
	font?: string;
	shade?: string;
};
function rpr(o: RunStyle) {
	const font = o.font
		? `<w:rFonts w:ascii="${escape(o.font)}" w:hAnsi="${escape(o.font)}" w:cs="${escape(o.font)}"/>`
		: "";
	return `<w:rPr>${font}${o.bold ? "<w:b/>" : ""}${o.italic ? "<w:i/>" : ""}${o.caps ? "<w:caps/>" : ""}${o.color ? `<w:color w:val="${hex(o.color)}"/>` : ""}${o.size ? `<w:sz w:val="${o.size * 2}"/><w:szCs w:val="${o.size * 2}"/>` : ""}${o.underline ? '<w:u w:val="single"/>' : ""}${o.shade ? `<w:shd w:val="clear" w:color="auto" w:fill="${hex(o.shade)}"/>` : ""}</w:rPr>`;
}
const run = (text: string, o: RunStyle = {}) =>
	text
		.split("\n")
		.map((piece, i) => `<w:r>${rpr(o)}${i ? "<w:br/>" : ""}<w:t xml:space="preserve">${escape(piece)}</w:t></w:r>`)
		.join("");
const para = (inner: string, ppr = "") => `<w:p>${ppr ? `<w:pPr>${ppr}</w:pPr>` : ""}${inner}</w:p>`;
const fieldRun = (code: string, o: RunStyle) =>
	`<w:fldSimple w:instr=" ${code} "><w:r>${rpr(o)}<w:t>1</w:t></w:r></w:fldSimple>`;
const jc = (align: string) => (align === "left" ? "" : `<w:jc w:val="${align === "center" ? "center" : "right"}"/>`);

function rel(part: Part, type: string, target: string, external = false) {
	const id = `rId${part.rels.length + 1}`;
	part.rels.push(
		`<Relationship Id="${id}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/${type}" Target="${escape(target)}"${external ? ' TargetMode="External"' : ""}/>`,
	);
	return id;
}

/** Inline nodes as runs. Marks map to Word run properties; a link is a w:hyperlink; a tag is a shaded caps run. */
function runs(w: W, content: readonly InlineNode[] | undefined, base: RunStyle): string {
	return (content ?? [])
		.map((node) => {
			if (node.type === "hardBreak") return `<w:r>${rpr(base)}<w:br/></w:r>`;
			if (node.type === "field") return run(w.values[node.attrs.key] ?? "", base);
			if (node.type === "pageNumber") {
				const format = attrsOf(node).format;
				return `${run("Page ", base)}${fieldRun("PAGE", base)}${format === "page-of-total" ? `${run(" of ", base)}${fieldRun("NUMPAGES", base)}` : ""}`;
			}
			const o: RunStyle = { ...base };
			let href: string | null = null;
			for (const mark of node.marks ?? []) {
				if (mark.type === "bold") o.bold = true;
				if (mark.type === "italic") o.italic = true;
				if (mark.type === "underline") o.underline = true;
				if (mark.type === "link") {
					href = mark.attrs.href;
					o.underline = true;
					o.color = onFill(w) ?? w.p.primaryText;
				}
				if (mark.type === "tag") {
					o.bold = true;
					o.caps = true;
					o.size = 8;
					o.shade = w.p.accent;
					o.color = w.p.onAccent;
				}
			}
			const text = node.marks?.some((m) => m.type === "tag") ? ` ${node.text} ` : node.text;
			if (!href) return run(text, o);
			return `<w:hyperlink r:id="${rel(w.part, "hyperlink", href, true)}">${run(text, o)}</w:hyperlink>`;
		})
		.join("");
}

const PARAGRAPH = {
	body: { size: undefined, bold: false, caps: false, quiet: false, after: 120 },
	lead: { size: undefined, bold: false, caps: false, quiet: true, after: 200 },
	small: { size: 9, bold: false, caps: false, quiet: true, after: 60 },
	kicker: { size: 9, bold: true, caps: true, quiet: true, after: 60 },
} as const;

function paragraph(w: W, node: ParagraphNode) {
	const a = attrsOf(node);
	const s = PARAGRAPH[a.style];
	const color = onFill(w) ?? (s.quiet ? w.p.mutedText : undefined);
	const base: RunStyle = {
		...(s.size ? { size: s.size } : {}),
		bold: s.bold,
		caps: s.caps,
		...(color ? { color } : {}),
	};
	return para(
		runs(w, node.content, base),
		`${a.style === "body" ? '<w:pStyle w:val="BodyText"/>' : ""}<w:spacing w:after="${s.after}"/>${jc(a.align)}`,
	);
}

function heading(w: W, node: Extract<BlockNode, { type: "heading" }>) {
	const a = attrsOf(node);
	const color = onFill(w);
	if (a.level === 1)
		return para(runs(w, node.content, color ? { color } : {}), `<w:pStyle w:val="Title"/>${jc(a.align)}`);
	let number = "";
	if (a.level === 2) {
		w.headings.h2 += 1;
		w.headings.h3 = 0;
		if (a.numbered) number = String(w.headings.h2).padStart(2, "0");
	} else {
		w.headings.h3 += 1;
		if (a.numbered) number = `${w.headings.h2}.${w.headings.h3}`;
	}
	const style = a.level === 2 ? (a.numbered ? "Heading1" : "Heading2") : "Heading3";
	const prefix = number ? run(`${number}  `, { color: color ?? w.p.primaryText }) : "";
	return para(prefix + runs(w, node.content, color ? { color } : {}), `<w:pStyle w:val="${style}"/>${jc(a.align)}`);
}

function list(w: W, items: { content: ParagraphNode[] }[], ordered: boolean) {
	const id = ordered ? NUM_FIRST_LIST + w.lists.length : NUM_BULLET;
	if (ordered) w.lists.push(id);
	return items
		.flatMap((item) =>
			item.content.map((p, i) =>
				para(
					runs(w, p.content, onFill(w) ? { color: onFill(w)! } : {}),
					`<w:pStyle w:val="ListParagraph"/>${i === 0 ? `<w:numPr><w:ilvl w:val="0"/><w:numId w:val="${id}"/></w:numPr>` : ""}`,
				),
			),
		)
		.join("");
}

/** A table with given column widths (twips) and rows of cell XML. */
function grid(
	widths: number[],
	rows: {
		cells: string[];
		header?: boolean;
		height?: number;
		exact?: boolean;
		shade?: (string | null)[];
		topRule?: boolean;
	}[],
	o: {
		borders: string;
		caption: string;
		/** A full-page sheet: the paragraph after the table takes no room. */ sheet?: boolean;
	},
) {
	const total = widths.reduce((s, x) => s + x, 0);
	const body = rows
		.map((r) => {
			const trPr = `<w:trPr>${r.header ? "<w:tblHeader/>" : "<w:cantSplit/>"}${r.height ? `<w:trHeight w:val="${r.height}" w:hRule="${r.exact ? "exact" : "atLeast"}"/>` : ""}</w:trPr>`;
			const cells = r.cells
				.map((inner, i) => {
					const shade = r.shade?.[i];
					const top = r.topRule
						? `<w:tcBorders><w:top w:val="single" w:sz="8" w:space="0" w:color="181D19"/></w:tcBorders>`
						: "";
					return `<w:tc><w:tcPr><w:tcW w:w="${widths[i] ?? 0}" w:type="dxa"/>${top}${shade ? `<w:shd w:val="clear" w:color="auto" w:fill="${hex(shade)}"/>` : ""}</w:tcPr>${inner || para("")}</w:tc>`;
				})
				.join("");
			return `<w:tr>${trPr}${cells}</w:tr>`;
		})
		.join("");
	const after = o.sheet
		? para("", '<w:spacing w:before="0" w:after="0" w:line="20" w:lineRule="exact"/><w:rPr><w:sz w:val="2"/></w:rPr>')
		: para("", '<w:spacing w:before="0" w:after="0"/>');
	return `<w:tbl><w:tblPr><w:tblW w:w="${total}" w:type="dxa"/><w:tblBorders>${o.borders}</w:tblBorders><w:tblLayout w:type="fixed"/><w:tblCellMar><w:left w:w="100" w:type="dxa"/><w:right w:w="100" w:type="dxa"/></w:tblCellMar><w:tblLook w:val="0420" w:firstRow="1" w:noHBand="0" w:noVBand="1"/><w:tblCaption w:val="${escape(o.caption)}"/></w:tblPr><w:tblGrid>${widths.map((x) => `<w:gridCol w:w="${x}"/>`).join("")}</w:tblGrid>${body}</w:tbl>${after}`;
}
const NO_BORDERS = ["top", "left", "bottom", "right", "insideH", "insideV"]
	.map((s) => `<w:${s} w:val="nil"/>`)
	.join("");
const lines = (color: string) =>
	`${border(color)}<w:insideH w:val="single" w:sz="4" w:space="0" w:color="${hex(color)}"/><w:insideV w:val="single" w:sz="4" w:space="0" w:color="${hex(color)}"/>`;

function label(w: W, text: string) {
	return para(
		run(text, { bold: true, caps: true, size: 8, color: onFill(w) ?? w.p.mutedText }),
		'<w:spacing w:before="0" w:after="20"/>',
	);
}

function picture(w: W, image: ThemeImage, width: number, height: number, cover: boolean) {
	const scale = cover ? Math.max(width / image.aspect, height) : Math.min(width / image.aspect, height);
	const cx = Math.round(scale * image.aspect * EMU_PER_PT);
	const cy = Math.round(scale * EMU_PER_PT);
	const ext = image.mediaType === "image/jpeg" ? "jpeg" : "png";
	let name = w.media.get(image);
	if (!name) {
		name = `image${w.media.size + 1}.${ext}`;
		w.media.set(image, name);
	}
	w.part.images.push({ name, bytes: image.bytes });
	const id = rel(w.part, "image", `media/${name}`);
	w.drawings.n += 1;
	const n = w.drawings.n;
	const alt = escape(image.alt);
	return `<w:r><w:drawing><wp:inline distT="0" distB="0" distL="0" distR="0"><wp:extent cx="${cx}" cy="${cy}"/><wp:docPr id="${n}" name="Picture ${n}" descr="${alt}" title="${alt}"/><wp:cNvGraphicFramePr><a:graphicFrameLocks noChangeAspect="1"/></wp:cNvGraphicFramePr><a:graphic><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/picture"><pic:pic><pic:nvPicPr><pic:cNvPr id="${n}" name="Picture ${n}" descr="${alt}"/><pic:cNvPicPr/></pic:nvPicPr><pic:blipFill><a:blip r:embed="${id}"/><a:stretch><a:fillRect/></a:stretch></pic:blipFill><pic:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="${cx}" cy="${cy}"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom></pic:spPr></pic:pic></a:graphicData></a:graphic></wp:inline></w:drawing></w:r>`;
}

function image(w: W, node: Extract<BlockNode, { type: "image" }>) {
	const a = attrsOf(node);
	const width = Math.min(a.width, w.width / TW);
	const source = a.source === "photo" ? w.theme.photo : w.theme.logo;
	if (source && source.mediaType !== "image/svg+xml")
		return para(picture(w, source, width, a.height, a.source === "photo"), jc(a.align));
	if (a.source === "photo") return "";
	// No logo: the church name is set in type, as in the PDF logo slot.
	return para(
		run(w.values.church_name ?? "", { font: w.fonts.heading, size: 18, color: onFill(w) ?? w.p.ink }),
		jc(a.align),
	);
}

function writeIn(w: W, node: Extract<BlockNode, { type: "writeIn" }>) {
	const a = attrsOf(node);
	const width = a.width > 0 ? Math.min(a.width * TW, w.width) : w.width;
	const height = a.kind === "signature" ? 560 : 400;
	return (
		label(w, a.label) +
		grid([width], [{ cells: [para("")], height }], { borders: lines(w.p.fieldBorder), caption: a.label })
	);
}

function slot(w: W, node: Extract<BlockNode, { type: "slot" }>) {
	const a = attrsOf(node);
	const inner = { ...w, width: w.width - 200 };
	const content = node.content?.length
		? blocks(inner, node.content)
		: para(run(SLOT_BLANK_NOTE, { size: 10, color: w.p.mutedText })) + para("");
	return grid([w.width], [{ cells: [label(w, a.label) + content], height: 1200 }], {
		borders: lines(w.p.fieldBorder),
		caption: `${a.label} (doctrinal slot)`,
	});
}

function columns(w: W, node: Extract<BlockNode, { type: "columns" }>) {
	const shares = node.content.map((c) => attrsOf(c).width);
	const total = shares.reduce((s, x) => s + x, 0);
	const widths = shares.map((s) => Math.floor((w.width * s) / total));
	const cells = node.content.map((col, i) => blocks({ ...w, width: (widths[i] ?? 0) - 200 }, col.content ?? []));
	return grid(widths, [{ cells }], { borders: NO_BORDERS, caption: "Columns" });
}

function box(w: W, node: Extract<BlockNode, { type: "box" }>) {
	const a = attrsOf(node);
	const fill = tokenColor(w.p, a.fill);
	const line = a.border === "none" ? null : tokenColor(w.p, a.border);
	const inner: W = { ...w, fill: fill ?? w.fill, width: w.width - 200 - a.padding * 2 * TW };
	return grid([w.width], [{ cells: [blocks(inner, node.content ?? [])], shade: [fill] }], {
		borders: line ? border(line) : NO_BORDERS,
		caption: "Panel",
	});
}

function divider(w: W, node: Extract<BlockNode, { type: "divider" }>) {
	const a = attrsOf(node);
	const color = tokenColor(w.p, a.color) ?? w.p.ink;
	const size = a.weight === "hairline" ? 4 : a.weight === "rule" ? 12 : 32;
	return para(
		"",
		`<w:pBdr><w:bottom w:val="single" w:sz="${size}" w:space="1" w:color="${hex(color)}"/></w:pBdr><w:spacing w:before="0" w:after="120"/>`,
	);
}

function columnWidths(cols: readonly ColumnSpec[], width: number) {
	const fixed = cols.reduce((s, c) => s + c.width * TW, 0);
	const auto = cols.filter((c) => c.width === 0).length;
	const share = auto ? Math.max(480, Math.floor((width - fixed) / auto)) : 0;
	return cols.map((c) => (c.width ? c.width * TW : share));
}

function table(w: W, node: TableNode) {
	const a = attrsOf(node);
	const cols = a.columns;
	const widths = columnWidths(cols, w.width);
	const computed = computeTable(node);
	const anyValue = (node.content ?? []).some((row) =>
		row.content.some((cell) => typeof cell.attrs?.value === "number"),
	);
	const headFill = tokenColor(w.p, a.headerFill);
	const headColor = headFill
		? headFill === w.p.muted
			? w.p.ink
			: headFill === w.p.primary
				? w.p.onPrimary
				: w.p.onAccent
		: w.p.ink;
	const align = (c: ColumnSpec) => c.align ?? (c.type === "text" ? "left" : "right");
	const cellText = (c: ColumnSpec, text: string, bold = false) =>
		para(run(text, { bold, size: 10 }), `<w:spacing w:before="20" w:after="20"/>${jc(align(c))}`);
	const rows: Parameters<typeof grid>[1] = [];
	if (a.header)
		rows.push({
			header: true,
			cells: cols.map((c) =>
				para(
					run(c.label, { bold: true, caps: true, size: 8, color: headColor }),
					`<w:spacing w:before="40" w:after="40"/>${jc(align(c))}`,
				),
			),
			shade: cols.map(() => headFill),
		});
	const source = a.source ? listValues(w.doc, a.source) : [];
	const content: { role: string; cells: (CellNode | null)[]; numbers: (number | null)[] }[] = [
		...(node.content ?? []).map((row, ri) => ({
			role: row.attrs?.role ?? "item",
			cells: row.content as (CellNode | null)[],
			numbers: computed[ri] ?? [],
		})),
		...source.map((entry) => ({
			role: "item",
			numbers: [],
			cells: cols.map((c): CellNode => {
				const v = entry[c.id];
				if (typeof v === "number") return { type: "cell", attrs: { value: v } };
				if (typeof v === "string" && v) return { type: "cell", content: [{ type: "text", text: v }] };
				return { type: "cell" };
			}),
		})),
		...Array.from({ length: source.length ? 0 : a.writeInRows }, () => ({
			role: "item",
			cells: cols.map(() => null),
			numbers: [],
		})),
	];
	let index = 0;
	for (const row of content) {
		const item = row.role === "item";
		if (item) index += 1;
		const strong = row.role === "subtotal" || row.role === "total";
		const zebra = a.zebra && item && index % 2 === 0;
		const shade = row.role === "group" || zebra ? w.p.muted : null;
		const rowInputs = row.cells.some((cell) => typeof cell?.attrs?.value === "number");
		rows.push({
			height: a.rowHeight ? a.rowHeight * TW : undefined,
			topRule: strong,
			shade: cols.map(() => shade),
			cells: cols.map((c, ci) => {
				const cell = row.cells[ci] ?? null;
				const bold = !item;
				if (c.type === "text")
					return cell?.content?.length
						? para(runs(w, cell.content, { bold, size: 10 }), `<w:spacing w:before="20" w:after="20"/>${jc(align(c))}`)
						: "";
				if (c.type === "index") return item ? cellText(c, String(index)) : "";
				if (c.type === "check") return item ? cellText(c, cell?.attrs?.checked ? "☒" : "☐") : "";
				const value = c.type === "formula" || !item ? row.numbers[ci] : cell?.attrs?.value;
				const show = c.type === "formula" ? (item ? rowInputs : row.role !== "group" && anyValue) : item || anyValue;
				if (typeof value !== "number" || !show || row.role === "group") return "";
				const kind = c.type === "formula" ? (c.format ?? "number") : c.type === "money" ? "money" : "number";
				return cellText(c, formatNumber(value, kind), bold);
			}),
		});
	}
	const borders =
		a.style === "grid"
			? lines(w.p.border)
			: `<w:insideH w:val="single" w:sz="4" w:space="0" w:color="${hex(w.p.border)}"/>`;
	return grid(widths, rows, { borders, caption: a.sheet ?? "Table" });
}

function block(w: W, node: BlockNode): string {
	switch (node.type) {
		case "paragraph":
			return paragraph(w, node);
		case "heading":
			return heading(w, node);
		case "bulletList":
			return list(w, node.content, false);
		case "orderedList":
			return list(w, node.content, true);
		case "quote":
			return node.content.map((p) => para(runs(w, p.content, {}), '<w:pStyle w:val="Quote"/>')).join("");
		case "divider":
			return divider(w, node);
		case "spacer":
			return para("", `<w:spacing w:before="0" w:after="${Math.round(attrsOf(node).size * TW)}"/>`);
		case "pageBreak":
			return '<w:p><w:r><w:br w:type="page"/></w:r></w:p>';
		case "columns":
			return columns(w, node);
		case "box":
			return box(w, node);
		case "image":
			return image(w, node);
		case "writeIn":
			return writeIn(w, node);
		case "slot":
			return slot(w, node);
		case "table":
			return table(w, node);
	}
}
const blocks = (w: W, nodes: readonly BlockNode[]) => nodes.map((n) => block(w, n)).join("");

function numbering(w: W) {
	const lvl = (fmt: string, text: string) =>
		`<w:lvl w:ilvl="0"><w:start w:val="1"/><w:numFmt w:val="${fmt}"/><w:suff w:val="tab"/><w:lvlText w:val="${text}"/><w:lvlJc w:val="left"/><w:pPr><w:ind w:left="720" w:hanging="360"/></w:pPr></w:lvl>`;
	const nums = [
		`<w:num w:numId="${NUM_BULLET}"><w:abstractNumId w:val="1"/></w:num>`,
		...w.lists.map(
			(id) =>
				`<w:num w:numId="${id}"><w:abstractNumId w:val="3"/><w:lvlOverride w:ilvl="0"><w:startOverride w:val="1"/></w:lvlOverride></w:num>`,
		),
	];
	return `${HEAD}<w:numbering ${NS}><w:abstractNum w:abstractNumId="1"><w:multiLevelType w:val="singleLevel"/>${lvl("bullet", "•")}</w:abstractNum><w:abstractNum w:abstractNumId="3"><w:multiLevelType w:val="singleLevel"/>${lvl("decimal", "%1.")}</w:abstractNum>${nums.join("")}</w:numbering>`;
}

/** A tiled sheet as one table: each cell is one card at the tile size, with the header, body and footer. */
function tiled(w: W) {
	const page = w.doc.page;
	const tile = page.tile!;
	const tb = tileBox(page)!;
	const cellWidth = Math.floor(tb.width * TW);
	const inner: W = { ...w, width: cellWidth - 2 * tile.padding * TW };
	const card = () =>
		[
			regionBlocks(inner, page.header),
			blocks(
				inner,
				(w.doc.body.content ?? []).filter((n) => n.type !== "pageBreak"),
			),
			regionBlocks(inner, page.footer),
			w.doc.class === "formal/legal" ? noticePara(w) : "",
		].join("");
	const rows = Array.from({ length: tile.down }, () => ({
		cells: Array.from({ length: tile.across }, card),
		// One point under the tile height leaves room for the tiny paragraph Word requires after a table.
		height: Math.floor(tb.height * TW) - TW,
		exact: true,
	}));
	const marks = tile.cutMarks
		? `${border(w.p.fieldBorder, 2)}<w:insideH w:val="dashed" w:sz="2" w:space="0" w:color="${hex(w.p.fieldBorder)}"/><w:insideV w:val="dashed" w:sz="2" w:space="0" w:color="${hex(w.p.fieldBorder)}"/>`
		: NO_BORDERS;
	return grid(
		Array.from({ length: tile.across }, () => cellWidth),
		rows,
		{ borders: marks, caption: "Card sheet", sheet: true },
	);
}

const regionBlocks = (w: W, region: Region | null | undefined) => (region ? blocks(w, region.content) : "");
const noticePara = (w: W) =>
	para(run(LEGAL_NOTICE, { bold: true, size: 9, color: w.p.ink }), '<w:spacing w:before="60" w:after="0"/>');

/** One header or footer part. The footer of a formal/legal document ends with the legal notice. */
function regionPart(w: W, which: "header" | "footer", region: Region | null) {
	const part: Part = { rels: [], images: [] };
	const inner = { ...w, part };
	const content = region ? blocks(inner, region.content) : "";
	const notice = which === "footer" && w.doc.class === "formal/legal" ? noticePara(w) : "";
	const tag = which === "header" ? "hdr" : "ftr";
	return { xml: `${HEAD}<w:${tag} ${NS}>${content}${notice || (content ? "" : para(""))}</w:${tag}>`, part };
}

/** The Word file for one document or template. The theme names the fonts and colors; images come from it. */
export function renderDocDocx(
	doc: EveryfieldDoc,
	theme: { render: RenderTheme; fonts: { heading: string; body: string } },
	created: Date,
): Buffer {
	const size = pageBox(doc.page);
	if (!size) throw new Error("the page has no size");
	const m = doc.page.margin;
	const textWidth = Math.round((size.width - m.left - m.right) * TW);
	const documentPart: Part = { rels: [], images: [] };
	const w: W = {
		p: makePalette(theme.render),
		fonts: theme.fonts,
		doc,
		theme: theme.render,
		values: fieldValues(doc),
		width: textWidth,
		fill: null,
		part: documentPart,
		lists: [],
		media: new Map(),
		headings: { h2: 0, h3: 0 },
		drawings: { n: 0 },
	};
	const body = doc.page.tile ? tiled(w) : blocks(w, doc.body.content ?? []);

	// Header and footer parts by `pages`. A "first" or "rest" region turns on Word's different-first-page setting;
	// then each region has a default part (later pages) and a first-page part.
	const regions = { header: doc.page.header ?? null, footer: doc.page.footer ?? null };
	const titlePg = !doc.page.tile && Object.values(regions).some((reg) => reg && reg.pages !== "all");
	const parts: { name: string; type: "header" | "footer"; kind: "default" | "first"; xml: string; part: Part }[] = [];
	if (!doc.page.tile)
		for (const which of ["header", "footer"] as const) {
			const region = regions[which];
			const later = region && region.pages !== "first" ? region : null;
			parts.push({ name: `${which}1.xml`, type: which, kind: "default", ...regionPart(w, which, later) });
			if (titlePg) {
				const first = region && region.pages !== "rest" ? region : null;
				parts.push({ name: `${which}2.xml`, type: which, kind: "first", ...regionPart(w, which, first) });
			}
		}
	const refs = parts
		.map((p) => {
			const id = rel(documentPart, p.type, p.name);
			return `<w:${p.type}Reference w:type="${p.kind}" r:id="${id}"/>`;
		})
		.join("");
	const landscape = size.width > size.height;
	const sect = `<w:sectPr>${refs}<w:pgSz w:w="${Math.round(size.width * TW)}" w:h="${Math.round(size.height * TW)}"${landscape ? ' w:orient="landscape"' : ""}/><w:pgMar w:top="${Math.round(m.top * TW)}" w:right="${Math.round(m.right * TW)}" w:bottom="${Math.round(m.bottom * TW)}" w:left="${Math.round(m.left * TW)}" w:header="${Math.round(Math.min(m.top, 36) * TW * 0.5)}" w:footer="${Math.round(Math.min(m.bottom, 36) * TW * 0.5)}" w:gutter="0"/>${titlePg ? "<w:titlePg/>" : ""}</w:sectPr>`;
	const document = `${HEAD}<w:document ${NS}><w:body>${body || para("")}${sect}</w:body></w:document>`;
	rel(documentPart, "styles", "styles.xml");
	rel(documentPart, "numbering", "numbering.xml");

	const relsXml = (part: Part) =>
		`${HEAD}<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${part.rels.join("")}</Relationships>`;
	const overrides = [
		["/word/document.xml", "wordprocessingml.document.main+xml"],
		["/word/styles.xml", "wordprocessingml.styles+xml"],
		["/word/numbering.xml", "wordprocessingml.numbering+xml"],
		...parts.map((p) => [`/word/${p.name}`, `wordprocessingml.${p.type}+xml`]),
	]
		.map(
			([name, type]) =>
				`<Override PartName="${name}" ContentType="application/vnd.openxmlformats-officedocument.${type}"/>`,
		)
		.join("");
	const church = w.values.church_name ?? "";
	const entries: ZipEntry[] = [
		{
			name: "[Content_Types].xml",
			data: Buffer.from(
				`${HEAD}<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Default Extension="png" ContentType="image/png"/><Default Extension="jpeg" ContentType="image/jpeg"/>${overrides}<Override PartName="/docProps/core.xml" ContentType="application/vnd.openxmlformats-package.core-properties+xml"/><Override PartName="/docProps/app.xml" ContentType="application/vnd.openxmlformats-officedocument.extended-properties+xml"/></Types>`,
			),
		},
		{
			name: "_rels/.rels",
			data: Buffer.from(
				`${HEAD}<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties" Target="docProps/core.xml"/><Relationship Id="rId3" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/extended-properties" Target="docProps/app.xml"/></Relationships>`,
			),
		},
		{
			name: "docProps/core.xml",
			data: Buffer.from(
				`${HEAD}<cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:dcterms="http://purl.org/dc/terms/" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"><dc:title>${escape(`${doc.title}, ${church}`)}</dc:title><dc:creator>${escape(church)}</dc:creator><dc:language>en-US</dc:language><dcterms:created xsi:type="dcterms:W3CDTF">${created.toISOString().replace(/\.\d+Z$/, "Z")}</dcterms:created></cp:coreProperties>`,
			),
		},
		{
			name: "docProps/app.xml",
			data: Buffer.from(
				`${HEAD}<Properties xmlns="http://schemas.openxmlformats.org/officeDocument/2006/extended-properties"><Application>Everyfield</Application></Properties>`,
			),
		},
		{ name: "word/document.xml", data: Buffer.from(document) },
		{ name: "word/styles.xml", data: Buffer.from(styles(w)) },
		{ name: "word/numbering.xml", data: Buffer.from(numbering(w)) },
		{ name: "word/_rels/document.xml.rels", data: Buffer.from(relsXml(documentPart)) },
	];
	for (const p of parts) {
		entries.push({ name: `word/${p.name}`, data: Buffer.from(p.xml) });
		if (p.part.rels.length) entries.push({ name: `word/_rels/${p.name}.rels`, data: Buffer.from(relsXml(p.part)) });
	}
	const written = new Set<string>();
	for (const part of [documentPart, ...parts.map((p) => p.part)])
		for (const img of part.images)
			if (!written.has(img.name)) {
				written.add(img.name);
				entries.push({ name: `word/media/${img.name}`, data: img.bytes, store: true });
			}
	return zip(entries);
}
