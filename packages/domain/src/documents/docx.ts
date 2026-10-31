import type { ChurchBlock } from "@everyfield/contracts/documents";
import { SLOT_BLANK_NOTE, type ChurchTemplate } from "./templates/church.ts";
import { makePalette, type RenderTheme } from "./theme.ts";
import { zip, type ZipEntry } from "./zip.ts";

// A Word file written straight to Office Open XML. Headings use the Word heading styles, lists use Word numbering and
// the signature or adoption block is a Word table. The logo carries its alt text in the picture description.

const NS =
	'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:wp="http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:pic="http://schemas.openxmlformats.org/drawingml/2006/picture"';
const HEAD = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n';
/** US Letter with 0.75 inch margins: the text width in twips. */
const TEXT_WIDTH = 10080;
const EMU_PER_PT = 12700;
const NUM_BULLET = 1;
const NUM_HEADING = 2;
const NUM_FIRST_LIST = 10;

const escape = (value: string) =>
	value
		.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F￾￿]/g, "")
		.replace(/&/g, "&amp;")
		.replace(/</g, "&lt;")
		.replace(/>/g, "&gt;")
		.replace(/"/g, "&quot;");
const hex = (color: string) => color.replace("#", "").toUpperCase();

type DocxInput = {
	template: ChurchTemplate;
	body: readonly ChurchBlock[];
	church: string;
	pastorName: string | null;
	theme: RenderTheme;
	/** Font names Word shows. The PDF embeds DM Sans and DM Serif Display; Word falls back if a font is missing. */
	fonts: { heading: string; body: string };
	/** The saved time of the revision, for the file properties. */
	created: Date;
};

type Ctx = ReturnType<typeof palette> & { fonts: DocxInput["fonts"] };
const palette = (theme: RenderTheme) => ({ p: makePalette(theme) });

const run = (text: string, o: { bold?: boolean; caps?: boolean; size?: number; color?: string; font?: string } = {}) =>
	`<w:r><w:rPr>${o.font ? `<w:rFonts w:ascii="${escape(o.font)}" w:hAnsi="${escape(o.font)}" w:cs="${escape(o.font)}"/>` : ""}${o.bold ? "<w:b/>" : ""}${o.caps ? "<w:caps/>" : ""}${o.color ? `<w:color w:val="${hex(o.color)}"/>` : ""}${o.size ? `<w:sz w:val="${o.size * 2}"/><w:szCs w:val="${o.size * 2}"/>` : ""}</w:rPr><w:t xml:space="preserve">${escape(text)}</w:t></w:r>`;
const para = (inner: string, ppr = "") => `<w:p>${ppr ? `<w:pPr>${ppr}</w:pPr>` : ""}${inner}</w:p>`;
const styled = (style: string, text: string, extra = "", rpr?: Parameters<typeof run>[1]) =>
	para(run(text, rpr), `<w:pStyle w:val="${style}"/>${extra}`);

const border = (color: string, size = 4) =>
	["top", "left", "bottom", "right"]
		.map((side) => `<w:${side} w:val="single" w:sz="${size}" w:space="0" w:color="${hex(color)}"/>`)
		.join("");

function table(
	ctx: Ctx,
	columns: { label: string; width: number }[] | null,
	rows: string[][],
	o: { rowHeight?: number; caption: string },
) {
	const widths = columns?.map((c) => c.width) ?? [];
	const grid = widths.map((w) => `<w:gridCol w:w="${w}"/>`).join("");
	const cell = (width: number, inner: string) =>
		`<w:tc><w:tcPr><w:tcW w:w="${width}" w:type="dxa"/></w:tcPr>${inner}</w:tc>`;
	const head = columns
		? `<w:tr><w:trPr><w:tblHeader/></w:trPr>${columns
				.map((c) =>
					cell(
						c.width,
						para(
							run(c.label, { bold: true, caps: true, size: 9, color: ctx.p.mutedText }),
							'<w:spacing w:before="40" w:after="40"/>',
						),
					),
				)
				.join("")}</w:tr>`
		: "";
	const body = rows
		.map(
			(r) =>
				`<w:tr><w:trPr><w:cantSplit/><w:trHeight w:val="${o.rowHeight ?? 560}" w:hRule="atLeast"/></w:trPr>${r
					.map((inner, i) => cell(widths[i] ?? TEXT_WIDTH, inner))
					.join("")}</w:tr>`,
		)
		.join("");
	return `<w:tbl><w:tblPr><w:tblW w:w="${TEXT_WIDTH}" w:type="dxa"/><w:tblBorders>${border(ctx.p.fieldBorder)}<w:insideH w:val="single" w:sz="4" w:space="0" w:color="${hex(ctx.p.fieldBorder)}"/><w:insideV w:val="single" w:sz="4" w:space="0" w:color="${hex(ctx.p.fieldBorder)}"/></w:tblBorders><w:tblLayout w:type="fixed"/><w:tblCellMar><w:left w:w="100" w:type="dxa"/><w:right w:w="100" w:type="dxa"/></w:tblCellMar><w:tblLook w:val="0420" w:firstRow="1" w:noHBand="0" w:noVBand="1"/><w:tblCaption w:val="${escape(o.caption)}"/></w:tblPr><w:tblGrid>${grid}</w:tblGrid>${head}${body}</w:tbl>${para("", '<w:spacing w:before="0" w:after="0"/>')}`;
}

function blocks(ctx: Ctx, template: ChurchTemplate, body: readonly ChurchBlock[], lists: number[]) {
	const letter = template.style === "letter";
	const firstHeading = body.findIndex((b) => b.kind === "heading");
	const out: string[] = [];
	body.forEach((block, i) => {
		switch (block.kind) {
			case "heading":
				out.push(
					styled(
						"Heading1",
						block.text,
						letter ? "" : `<w:numPr><w:ilvl w:val="0"/><w:numId w:val="${NUM_HEADING}"/></w:numPr>`,
					),
				);
				break;
			case "subheading":
				out.push(styled("Heading2", block.text));
				break;
			case "paragraph": {
				const lead = !letter && firstHeading > i;
				out.push(
					lead
						? para(run(block.text, { color: ctx.p.mutedText }), '<w:spacing w:after="200"/>')
						: styled("BodyText", block.text),
				);
				break;
			}
			case "quote":
				out.push(styled("Quote", block.text));
				break;
			case "bulleted_list":
				for (const item of block.items)
					out.push(
						para(
							run(item),
							`<w:pStyle w:val="ListParagraph"/><w:numPr><w:ilvl w:val="0"/><w:numId w:val="${NUM_BULLET}"/></w:numPr>`,
						),
					);
				break;
			case "numbered_list": {
				const id = NUM_FIRST_LIST + lists.length;
				lists.push(id);
				for (const item of block.items)
					out.push(
						para(
							run(item),
							`<w:pStyle w:val="ListParagraph"/><w:numPr><w:ilvl w:val="0"/><w:numId w:val="${id}"/></w:numPr>`,
						),
					);
				break;
			}
			case "slot": {
				const label = template.slots.find((s) => s.id === block.slotId)?.label ?? block.slotId;
				const lines = block.text.split("\n").filter((line) => line.trim());
				const inner = [
					para(
						run(label, { bold: true, caps: true, size: 9, color: ctx.p.mutedText }),
						'<w:spacing w:before="40" w:after="40"/>',
					),
					...(lines.length
						? lines.map((line) => para(run(line)))
						: [para(run(SLOT_BLANK_NOTE, { size: 10, color: ctx.p.mutedText })), para("")]),
				].join("");
				out.push(table(ctx, null, [[inner]], { rowHeight: 1200, caption: `${label} (doctrinal slot)` }));
				break;
			}
		}
	});
	return out.join("");
}

function frame(ctx: Ctx, input: DocxInput) {
	const { template } = input;
	const f = template.frame;
	const fill = (text: string) => text.replaceAll("{church_name}", input.church);
	if (f.kind === "letter") {
		const out = [
			para(run(f.signOff), '<w:keepNext/><w:spacing w:before="200" w:after="600"/>'),
			input.pastorName
				? para(run(input.pastorName, { bold: true }), "<w:keepNext/>")
				: table(ctx, [{ label: "Pastor name", width: 4400 }], [[para("")]], { rowHeight: 400, caption: "Pastor name" }),
			para(run(input.church, { size: 10, color: ctx.p.mutedText })),
		];
		return out.join("");
	}
	const closing = f.closing
		? para(run(fill(f.closing), { bold: true }), '<w:keepNext/><w:spacing w:before="240"/>')
		: "";
	if (f.kind === "sign") {
		const total = TEXT_WIDTH;
		const widths = [0.38, 0.4, 0.22].map((share) => Math.round(total * share));
		const columns = f.slots.map((slot, i) => ({
			label: slot.label,
			width: widths[i] ?? Math.round(total / f.slots.length),
		}));
		return closing + table(ctx, columns, [columns.map(() => para(""))], { rowHeight: 700, caption: "Signature block" });
	}
	const columns = [
		{ label: "Board member", width: 3000 },
		{ label: "Role", width: 2200 },
		{ label: "Signature", width: 3000 },
		{ label: "Date", width: 1880 },
	];
	const rows = Array.from({ length: f.signers }, () => columns.map(() => para("")));
	return closing + table(ctx, columns, rows, { rowHeight: 640, caption: "Adoption signatures" });
}

/** The logo as an inline picture with its alt text, fitted into 150 x 34 pt like the PDF logo slot. */
function logoRun(input: DocxInput) {
	const logo = input.theme.logo;
	if (!logo || logo.mediaType === "image/svg+xml") return null;
	const scale = Math.min(150 / logo.aspect, 34);
	const cx = Math.round(scale * logo.aspect * EMU_PER_PT);
	const cy = Math.round(scale * EMU_PER_PT);
	const alt = escape(logo.alt);
	return `<w:r><w:drawing><wp:inline distT="0" distB="0" distL="0" distR="0"><wp:extent cx="${cx}" cy="${cy}"/><wp:docPr id="1" name="Logo" descr="${alt}" title="${alt}"/><wp:cNvGraphicFramePr><a:graphicFrameLocks noChangeAspect="1"/></wp:cNvGraphicFramePr><a:graphic><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/picture"><pic:pic><pic:nvPicPr><pic:cNvPr id="1" name="Logo" descr="${alt}"/><pic:cNvPicPr/></pic:nvPicPr><pic:blipFill><a:blip r:embed="rIdLogo"/><a:stretch><a:fillRect/></a:stretch></pic:blipFill><pic:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="${cx}" cy="${cy}"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom></pic:spPr></pic:pic></a:graphicData></a:graphic></wp:inline></w:drawing></w:r>`;
}

function header(ctx: Ctx, input: DocxInput) {
	const logo = logoRun(input);
	const left = logo ?? run(input.church, { font: ctx.fonts.heading, size: 18, color: ctx.p.ink });
	return `${HEAD}<w:hdr ${NS}>${para(
		`${left}<w:r><w:tab/></w:r>${run(input.template.kicker, { bold: true, caps: true, size: 9, color: ctx.p.mutedText })}`,
		`<w:pBdr><w:bottom w:val="single" w:sz="16" w:space="6" w:color="${hex(ctx.p.primary)}"/></w:pBdr><w:tabs><w:tab w:val="right" w:pos="${TEXT_WIDTH}"/></w:tabs><w:spacing w:after="120"/>`,
	)}</w:hdr>`;
}

function footer(ctx: Ctx, input: DocxInput) {
	const l = input.theme.letterhead;
	const text = l?.legalName
		? [l.legalName, l.address, l.ein ? `EIN ${l.ein}` : ""].filter(Boolean).join("  |  ")
		: `${input.church}  |  ${input.template.title}`;
	const field = (code: string) =>
		`<w:fldSimple w:instr=" ${code} "><w:r><w:rPr><w:sz w:val="18"/></w:rPr><w:t>1</w:t></w:r></w:fldSimple>`;
	const notice =
		input.template.documentClass === "formal/legal"
			? para(run("Template, not legal advice", { bold: true, size: 9, color: ctx.p.ink }), '<w:spacing w:after="0"/>')
			: "";
	return `${HEAD}<w:ftr ${NS}>${para(
		`${run(text, { size: 9, color: ctx.p.mutedText })}<w:r><w:tab/></w:r>${run("Page ", { size: 9, color: ctx.p.mutedText })}${field("PAGE")}${run(" of ", { size: 9, color: ctx.p.mutedText })}${field("NUMPAGES")}`,
		`<w:pBdr><w:top w:val="single" w:sz="8" w:space="6" w:color="${hex(ctx.p.primary)}"/></w:pBdr><w:tabs><w:tab w:val="right" w:pos="${TEXT_WIDTH}"/></w:tabs><w:spacing w:after="0"/>`,
	)}${notice}</w:ftr>`;
}

function styles(ctx: Ctx) {
	const { heading, body } = ctx.fonts;
	const font = (name: string) =>
		`<w:rFonts w:ascii="${escape(name)}" w:hAnsi="${escape(name)}" w:cs="${escape(name)}"/>`;
	const style = (id: string, name: string, ppr: string, rpr: string, o: { based?: string; next?: string } = {}) =>
		`<w:style w:type="paragraph" w:styleId="${id}"><w:name w:val="${name}"/>${o.based ? `<w:basedOn w:val="${o.based}"/>` : ""}${o.next ? `<w:next w:val="${o.next}"/>` : ""}<w:qFormat/><w:pPr>${ppr}</w:pPr><w:rPr>${rpr}</w:rPr></w:style>`;
	return `${HEAD}<w:styles ${NS}><w:docDefaults><w:rPrDefault><w:rPr>${font(body)}<w:color w:val="${hex(ctx.p.ink)}"/><w:sz w:val="21"/><w:szCs w:val="21"/><w:lang w:val="en-US" w:eastAsia="en-US" w:bidi="ar-SA"/></w:rPr></w:rPrDefault><w:pPrDefault><w:pPr><w:spacing w:after="120" w:line="336" w:lineRule="auto"/></w:pPr></w:pPrDefault></w:docDefaults>
<w:style w:type="paragraph" w:default="1" w:styleId="Normal"><w:name w:val="Normal"/><w:qFormat/></w:style>
${style("BodyText", "Body Text", '<w:spacing w:after="120"/>', "", { based: "Normal" })}
${style("Title", "Title", '<w:keepNext/><w:spacing w:before="120" w:after="200" w:line="240" w:lineRule="auto"/>', `${font(heading)}<w:color w:val="${hex(ctx.p.primaryText)}"/><w:sz w:val="56"/><w:szCs w:val="56"/>`, { based: "Normal", next: "BodyText" })}
${style("Heading1", "heading 1", '<w:keepNext/><w:keepLines/><w:pBdr><w:bottom w:val="single" w:sz="8" w:space="2" w:color="' + hex(ctx.p.primary) + '"/></w:pBdr><w:spacing w:before="320" w:after="120" w:line="240" w:lineRule="auto"/><w:outlineLvl w:val="0"/>', `<w:b/><w:color w:val="${hex(ctx.p.primaryText)}"/><w:sz w:val="32"/><w:szCs w:val="32"/>`, { based: "Normal", next: "BodyText" })}
${style("Heading2", "heading 2", '<w:keepNext/><w:keepLines/><w:spacing w:before="200" w:after="60" w:line="240" w:lineRule="auto"/><w:outlineLvl w:val="1"/>', '<w:b/><w:sz w:val="24"/><w:szCs w:val="24"/>', { based: "Normal", next: "BodyText" })}
${style("Heading3", "heading 3", '<w:keepNext/><w:spacing w:before="160" w:after="40"/><w:outlineLvl w:val="2"/>', "<w:b/>", { based: "Normal", next: "BodyText" })}
${style("Quote", "Quote", `<w:pBdr><w:left w:val="single" w:sz="24" w:space="10" w:color="${hex(ctx.p.primary)}"/></w:pBdr><w:ind w:left="480"/>`, '<w:b w:val="0"/>', { based: "Normal", next: "BodyText" })}
${style("ListParagraph", "List Paragraph", '<w:spacing w:after="40"/><w:ind w:left="720"/>', "", { based: "Normal" })}
</w:styles>`;
}

function numbering(ctx: Ctx, lists: number[]) {
	const abstract = (id: number, fmt: string, text: string, rpr = "", suffix = "tab") =>
		`<w:abstractNum w:abstractNumId="${id}"><w:multiLevelType w:val="singleLevel"/><w:lvl w:ilvl="0"><w:start w:val="1"/><w:numFmt w:val="${fmt}"/><w:suff w:val="${suffix}"/><w:lvlText w:val="${text}"/><w:lvlJc w:val="left"/><w:pPr><w:ind w:left="720" w:hanging="360"/></w:pPr>${rpr ? `<w:rPr>${rpr}</w:rPr>` : ""}</w:lvl></w:abstractNum>`;
	const heading = `<w:abstractNum w:abstractNumId="2"><w:multiLevelType w:val="singleLevel"/><w:lvl w:ilvl="0"><w:start w:val="1"/><w:numFmt w:val="decimalZero"/><w:suff w:val="space"/><w:lvlText w:val="%1"/><w:lvlJc w:val="left"/><w:pPr><w:ind w:left="0" w:firstLine="0"/></w:pPr><w:rPr><w:color w:val="${hex(ctx.p.primaryText)}"/></w:rPr></w:lvl></w:abstractNum>`;
	const nums = [
		`<w:num w:numId="${NUM_BULLET}"><w:abstractNumId w:val="1"/></w:num>`,
		`<w:num w:numId="${NUM_HEADING}"><w:abstractNumId w:val="2"/></w:num>`,
		...lists.map(
			(id) =>
				`<w:num w:numId="${id}"><w:abstractNumId w:val="3"/><w:lvlOverride w:ilvl="0"><w:startOverride w:val="1"/></w:lvlOverride></w:num>`,
		),
	];
	return `${HEAD}<w:numbering ${NS}>${abstract(1, "bullet", "•", `<w:rFonts w:ascii="${escape(ctx.fonts.body)}" w:hAnsi="${escape(ctx.fonts.body)}"/>`)}${heading}${abstract(3, "decimal", "%1.")}${nums.join("")}</w:numbering>`;
}

/** The Word file for one revision. Same inputs give the same bytes. */
export function buildDocx(input: DocxInput): Buffer {
	const ctx: Ctx = { ...palette(input.theme), fonts: input.fonts };
	const lists: number[] = [];
	const content = blocks(ctx, input.template, input.body, lists);
	const title = styled("Title", input.template.title);
	const date =
		input.template.frame.kind === "letter"
			? table(ctx, [{ label: "Date", width: 3200 }], [[para("")]], { rowHeight: 400, caption: "Letter date" })
			: "";
	const document = `${HEAD}<w:document ${NS}><w:body>${title}${date}${content}${frame(ctx, input)}<w:sectPr><w:headerReference w:type="default" r:id="rIdHeader"/><w:footerReference w:type="default" r:id="rIdFooter"/><w:pgSz w:w="12240" w:h="15840"/><w:pgMar w:top="1300" w:right="1080" w:bottom="1300" w:left="1080" w:header="560" w:footer="560" w:gutter="0"/></w:sectPr></w:body></w:document>`;
	const logo = input.theme.logo;
	const hasPicture = Boolean(logo && logo.mediaType !== "image/svg+xml");
	const ext = logo?.mediaType === "image/jpeg" ? "jpeg" : "png";
	const rel = (id: string, type: string, target: string) =>
		`<Relationship Id="${id}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/${type}" Target="${target}"/>`;
	const entries: ZipEntry[] = [
		{
			name: "[Content_Types].xml",
			data: Buffer.from(
				`${HEAD}<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Default Extension="png" ContentType="image/png"/><Default Extension="jpeg" ContentType="image/jpeg"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/><Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/><Override PartName="/word/numbering.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.numbering+xml"/><Override PartName="/word/header1.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.header+xml"/><Override PartName="/word/footer1.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.footer+xml"/><Override PartName="/docProps/core.xml" ContentType="application/vnd.openxmlformats-package.core-properties+xml"/><Override PartName="/docProps/app.xml" ContentType="application/vnd.openxmlformats-officedocument.extended-properties+xml"/></Types>`,
			),
		},
		{
			name: "_rels/.rels",
			data: Buffer.from(
				`${HEAD}<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${rel("rId1", "officeDocument", "word/document.xml")}<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties" Target="docProps/core.xml"/>${rel("rId3", "extended-properties", "docProps/app.xml")}</Relationships>`,
			),
		},
		{
			name: "docProps/core.xml",
			data: Buffer.from(
				`${HEAD}<cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:dcterms="http://purl.org/dc/terms/" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"><dc:title>${escape(`${input.template.title}, ${input.church}`)}</dc:title><dc:creator>${escape(input.church)}</dc:creator><dc:language>en-US</dc:language><dcterms:created xsi:type="dcterms:W3CDTF">${input.created.toISOString().replace(/\.\d+Z$/, "Z")}</dcterms:created></cp:coreProperties>`,
			),
		},
		{
			name: "docProps/app.xml",
			data: Buffer.from(
				`${HEAD}<Properties xmlns="http://schemas.openxmlformats.org/officeDocument/2006/extended-properties"><Application>Everyfield</Application></Properties>`,
			),
		},
		{ name: "word/document.xml", data: Buffer.from(document) },
		{ name: "word/styles.xml", data: Buffer.from(styles(ctx)) },
		{ name: "word/numbering.xml", data: Buffer.from(numbering(ctx, lists)) },
		{ name: "word/header1.xml", data: Buffer.from(header(ctx, input)) },
		{ name: "word/footer1.xml", data: Buffer.from(footer(ctx, input)) },
		{
			name: "word/_rels/document.xml.rels",
			data: Buffer.from(
				`${HEAD}<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${rel("rIdStyles", "styles", "styles.xml")}${rel("rIdNumbering", "numbering", "numbering.xml")}${rel("rIdHeader", "header", "header1.xml")}${rel("rIdFooter", "footer", "footer1.xml")}</Relationships>`,
			),
		},
	];
	if (hasPicture && logo) {
		entries.push(
			{
				name: "word/_rels/header1.xml.rels",
				data: Buffer.from(
					`${HEAD}<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${rel("rIdLogo", "image", `media/logo.${ext}`)}</Relationships>`,
				),
			},
			{ name: `word/media/logo.${ext}`, data: logo.bytes, store: true },
		);
	}
	return zip(entries);
}
