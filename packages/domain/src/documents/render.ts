import { createHash } from "node:crypto";
import { crc32 } from "node:zlib";
import { hash } from "../operations/canonical.ts";
import type { CatalogTemplate } from "./catalog.ts";
import { outlinePhrases } from "./catalog.ts";
import type { ResolvedMerge } from "./merge.ts";

/** Stored ZIP entries and a fixed DOS time, so the same profile yields the same bytes. */
export const RENDER_PROFILE = { pdf: "1.4", font: "Helvetica", zipMethod: 0, dosTime: 0 } as const;
const ARTIFACT_MAX = 8 * 1024 * 1024;
const XML_MAX = 2_000_000;
const BLOCK_MAX = 1000;
const SHEET_MAX = 20;
const ROW_MAX = 500;
const COL_MAX = 50;

export class RenderFailed extends Error {
	constructor() {
		super("render_failed");
	}
}
export function renderEngineVersion() {
	return hash(RENDER_PROFILE);
}

function unsafe(value: string) {
	if (value.includes("\0")) return true;
	for (let i = 0; i < value.length; i++) {
		const code = value.charCodeAt(i);
		if (code >= 0xd800 && code <= 0xdbff) {
			const next = value.charCodeAt(i + 1);
			if (!(next >= 0xdc00 && next <= 0xdfff)) return true;
			i += 1;
		} else if (code >= 0xdc00 && code <= 0xdfff) return true;
	}
	return false;
}

function pdfLiteral(value: string) {
	let out = "";
	for (const char of value) {
		const point = char.codePointAt(0) ?? 0;
		if (point === 0x28 || point === 0x29 || point === 0x5c) out += "\\" + char;
		else if (point >= 32 && point <= 126) out += char;
		else {
			for (const byte of Buffer.from(char, "utf8")) out += "\\" + byte.toString(8).padStart(3, "0");
		}
	}
	return out;
}

function pageStream(lines: string[]) {
	const commands = ["BT", "/F1 12 Tf", "72 700 Td"];
	lines.forEach((line, index) => {
		if (index > 0) commands.push("0 -16 Td");
		commands.push("(" + pdfLiteral(line) + ") Tj");
	});
	commands.push("ET");
	return commands.join("\n") + "\n";
}

function buildPdf(pages: string[], media: readonly number[]) {
	if (pages.length > BLOCK_MAX) throw new RenderFailed();
	const fontId = 3 + pages.length * 2;
	const objects = [
		"<< /Type /Catalog /Pages 2 0 R >>",
		`<< /Type /Pages /Count ${pages.length} /Kids [${pages.map((_, index) => `${3 + index * 2} 0 R`).join(" ")}] >>`,
	];
	const box = media.join(" ");
	pages.forEach((page, index) => {
		const contentId = 4 + index * 2;
		objects.push(
			`<< /Type /Page /Parent 2 0 R /MediaBox [${box}] /Contents ${contentId} 0 R /Resources << /Font << /F1 ${fontId} 0 R >> >> >>`,
		);
		objects.push(`<< /Length ${Buffer.byteLength(page, "latin1")} >>\nstream\n${page}endstream`);
	});
	objects.push("<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>");
	let body = "%PDF-1.4\n";
	const offsets = [0];
	objects.forEach((object, index) => {
		offsets.push(Buffer.byteLength(body, "latin1"));
		body += `${index + 1} 0 obj\n${object}\nendobj\n`;
	});
	const xref = Buffer.byteLength(body, "latin1");
	body += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
	for (let index = 1; index < offsets.length; index++) body += `${String(offsets[index]).padStart(10, "0")} 00000 n \n`;
	body += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
	return finish(Buffer.from(body, "latin1"));
}

function xml(value: string) {
	return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;");
}

type ZipEntry = { name: string; data: Buffer };

function zipStored(entries: ZipEntry[]) {
	const parts: Buffer[] = [];
	const central: Buffer[] = [];
	let offset = 0;
	for (const entry of entries) {
		const name = Buffer.from(entry.name, "utf8");
		const crc = crc32(entry.data) >>> 0;
		const local = Buffer.alloc(30 + name.length);
		local.writeUInt32LE(0x04034b50, 0);
		local.writeUInt16LE(20, 4);
		local.writeUInt16LE(0, 8);
		local.writeUInt32LE(crc, 14);
		local.writeUInt32LE(entry.data.length, 18);
		local.writeUInt32LE(entry.data.length, 22);
		local.writeUInt16LE(name.length, 26);
		name.copy(local, 30);
		parts.push(local, entry.data);
		const row = Buffer.alloc(46 + name.length);
		row.writeUInt32LE(0x02014b50, 0);
		row.writeUInt16LE(20, 4);
		row.writeUInt16LE(20, 6);
		row.writeUInt32LE(crc, 16);
		row.writeUInt32LE(entry.data.length, 20);
		row.writeUInt32LE(entry.data.length, 24);
		row.writeUInt16LE(name.length, 28);
		row.writeUInt32LE(offset, 42);
		name.copy(row, 46);
		central.push(row);
		offset += local.length + entry.data.length;
	}
	const directory = Buffer.concat(central);
	const end = Buffer.alloc(22);
	end.writeUInt32LE(0x06054b50, 0);
	end.writeUInt16LE(entries.length, 8);
	end.writeUInt16LE(entries.length, 10);
	end.writeUInt32LE(directory.length, 12);
	end.writeUInt32LE(offset, 16);
	return finish(Buffer.concat([...parts, directory, end]));
}

function finish(bytes: Buffer) {
	if (bytes.length > ARTIFACT_MAX) throw new RenderFailed();
	return bytes;
}

function documentXml(lines: string[]) {
	const paragraphs = lines.map((line) => `<w:p><w:r><w:t xml:space="preserve">${xml(line)}</w:t></w:r></w:p>`).join("");
	return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><w:body>${paragraphs}<w:sectPr><w:footerReference w:type="default" r:id="rIdFooter"/></w:sectPr></w:body></w:document>`;
}

function buildDocx(lines: string[], church: string) {
	if (lines.length > BLOCK_MAX) throw new RenderFailed();
	const document = documentXml(lines);
	const footer = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:ftr xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:p><w:r><w:t xml:space="preserve">${xml(church)}</w:t></w:r></w:p></w:ftr>`;
	const files = [document, footer];
	if (files.some((file) => file.length > XML_MAX)) throw new RenderFailed();
	return zipStored([
		{
			name: "[Content_Types].xml",
			data: Buffer.from(
				`<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/><Override PartName="/word/footer.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.footer+xml"/></Types>`,
				"utf8",
			),
		},
		{
			name: "_rels/.rels",
			data: Buffer.from(
				`<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>`,
				"utf8",
			),
		},
		{ name: "word/document.xml", data: Buffer.from(document, "utf8") },
		{ name: "word/footer.xml", data: Buffer.from(footer, "utf8") },
		{
			name: "word/_rels/document.xml.rels",
			data: Buffer.from(
				`<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rIdFooter" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/footer" Target="footer.xml"/></Relationships>`,
				"utf8",
			),
		},
	]);
}

function column(index: number) {
	let value = index;
	let out = "";
	while (value > 0) {
		const mod = (value - 1) % 26;
		out = String.fromCharCode(65 + mod) + out;
		value = Math.floor((value - 1) / 26);
	}
	return out;
}

function cell(ref: string, text: string) {
	return `<c r="${ref}" t="inlineStr"><is><t xml:space="preserve">${xml(text)}</t></is></c>`;
}
function numberCell(ref: string, value: number) {
	return `<c r="${ref}"><v>${value}</v></c>`;
}
function formulaCell(ref: string, formula: string) {
	return `<c r="${ref}"><f>${xml(formula)}</f><v>0</v></c>`;
}

function sheetName(name: string) {
	const cleaned = name.replace(/[:\\/?*[\]]/g, " ").trim() || "Sheet";
	return cleaned.slice(0, 31);
}

function sheetRows(template: CatalogTemplate, church: string) {
	if (template.description.includes("income/expense")) {
		const months = Array.from({ length: 12 }, (_, index) => numberCell(`${column(index + 2)}2`, 0)).join("");
		const monthsExpense = Array.from({ length: 12 }, (_, index) => numberCell(`${column(index + 2)}3`, 0)).join("");
		return [
			`<row r="1">${cell("A1", church)}</row>`,
			`<row r="2">${cell("A2", "income")}${months}${formulaCell("N2", "SUM(B2:M2)")}</row>`,
			`<row r="3">${cell("A3", "expense")}${monthsExpense}${formulaCell("N3", "SUM(B3:M3)")}</row>`,
		];
	}
	if (template.description.includes("monthly-vs-annual")) {
		return [
			`<row r="1">${cell("A1", church)}</row>`,
			`<row r="2">${cell("A2", "monthly")}${numberCell("B2", 0)}${formulaCell("C2", "B2*12")}</row>`,
		];
	}
	throw new RenderFailed();
}

function buildXlsx(template: CatalogTemplate, church: string) {
	const rows = sheetRows(template, church);
	const columns = template.description.includes("income/expense") ? 14 : 3;
	const sheets = 1;
	if (rows.length > ROW_MAX || columns > COL_MAX || sheets > SHEET_MAX) throw new RenderFailed();
	const sheet = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>${rows.join("")}</sheetData></worksheet>`;
	const workbook = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="${xml(sheetName(template.name))}" sheetId="1" r:id="rId1"/></sheets></workbook>`;
	if (sheet.length > XML_MAX || workbook.length > XML_MAX) throw new RenderFailed();
	return zipStored([
		{
			name: "[Content_Types].xml",
			data: Buffer.from(
				`<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/><Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/></Types>`,
				"utf8",
			),
		},
		{
			name: "_rels/.rels",
			data: Buffer.from(
				`<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>`,
				"utf8",
			),
		},
		{ name: "xl/workbook.xml", data: Buffer.from(workbook, "utf8") },
		{
			name: "xl/_rels/workbook.xml.rels",
			data: Buffer.from(
				`<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>`,
				"utf8",
			),
		},
		{ name: "xl/worksheets/sheet1.xml", data: Buffer.from(sheet, "utf8") },
		{
			name: "xl/styles.xml",
			data: Buffer.from(
				`<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><fonts count="1"><font><sz val="11"/><name val="Calibri"/></font></fonts><fills count="1"><fill><patternFill patternType="none"/></fill></fills><borders count="1"><border/></borders><cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs><cellXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/></cellXfs></styleSheet>`,
				"utf8",
			),
		},
	]);
}

function linesOf(template: CatalogTemplate, resolved: Extract<ResolvedMerge, { ok: true }>) {
	const lines = [template.name];
	for (const field of resolved.fields) if (field.value) lines.push(field.value);
	lines.push(...outlinePhrases(template.description));
	if (lines.some(unsafe)) throw new RenderFailed();
	return lines;
}

/** Null when a required field is missing. Bytes come only from the catalog outline and the resolved fields. */
export function renderPreview(
	template: CatalogTemplate,
	format: "pdf" | "docx" | "xlsx",
	resolved: Extract<ResolvedMerge, { ok: true }>,
) {
	if (!resolved.complete) return null;
	const lines = linesOf(template, resolved);
	const church = resolved.fields.find((field) => field.key === "church_name")?.value ?? "";
	if (format === "pdf") {
		const phrases = outlinePhrases(template.description);
		const split = phrases.length === template.pageCount && template.pageCount > 1;
		const media = template.description.includes("quarter-page")
			? ([0, 0, 306, 396] as const)
			: ([0, 0, 612, 792] as const);
		const pages = split ? phrases.map((phrase) => pageStream([church, phrase])) : [pageStream(lines)];
		return buildPdf(pages, media);
	}
	if (format === "docx") return buildDocx(lines, church);
	if (format === "xlsx") return buildXlsx(template, church);
	throw new RenderFailed();
}

export function digestOf(bytes: Buffer) {
	return createHash("sha256").update(bytes).digest("hex");
}
