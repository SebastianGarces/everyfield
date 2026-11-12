import type { makePalette } from "./theme.ts";

// The Office Open XML parts every Word file shares: the namespaces, escaping, borders and the paragraph styles.
// doc-docx.ts writes the document itself.

export const NS =
	'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:wp="http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:pic="http://schemas.openxmlformats.org/drawingml/2006/picture"';
export const HEAD = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n';
export const escape = (value: string) =>
	value
		.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F￾￿]/g, "")
		.replace(/&/g, "&amp;")
		.replace(/</g, "&lt;")
		.replace(/>/g, "&gt;")
		.replace(/"/g, "&quot;");
export const hex = (color: string) => color.replace("#", "").toUpperCase();

/** The palette and the font names Word shows. Word falls back if a font is missing. */
export type DocxCtx = { p: ReturnType<typeof makePalette>; fonts: { heading: string; body: string } };

export const border = (color: string, size = 4) =>
	["top", "left", "bottom", "right"]
		.map((side) => `<w:${side} w:val="single" w:sz="${size}" w:space="0" w:color="${hex(color)}"/>`)
		.join("");

export function styles(ctx: DocxCtx) {
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
