// Readers that are independent of the writers under test: pdf.js reads a PDF, Python's zipfile and ElementTree read a
// Word file, and LibreOffice opens it when the machine has it.
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";

type PdfJs = {
	getDocument(options: { data: Uint8Array }): {
		promise: Promise<{
			numPages: number;
			getPage(n: number): Promise<{ getTextContent(): Promise<{ items: { str?: string }[] }> }>;
		}>;
	};
};
let pdfjs: PdfJs | undefined;

/** The text of each page of a PDF, in reading order. */
export async function pdfPages(bytes: Uint8Array): Promise<string[]> {
	if (!pdfjs) {
		const base = "../../../../packages/db/node_modules/pdfjs-dist/legacy/build/";
		(globalThis as { pdfjsWorker?: unknown }).pdfjsWorker = await import(base + "pdf.worker.mjs");
		pdfjs = (await import(base + "pdf.mjs")) as unknown as PdfJs;
	}
	const doc = await pdfjs.getDocument({ data: new Uint8Array(bytes) }).promise;
	const pages: string[] = [];
	for (let n = 1; n <= doc.numPages; n++) {
		const content = await (await doc.getPage(n)).getTextContent();
		pages.push(
			content.items
				.map((item) => item.str ?? "")
				.join(" ")
				.replace(/\s+/g, " "),
		);
	}
	return pages;
}

const SCRIPT = `
import sys, json, zipfile, io
import xml.etree.ElementTree as ET
z = zipfile.ZipFile(io.BytesIO(sys.stdin.buffer.read()))
bad = z.testzip()
if bad: raise SystemExit("bad zip member " + bad)
out = {}
for name in z.namelist():
    data = z.read(name)
    if name.endswith(".xml") or name.endswith(".rels"):
        ET.fromstring(data)  # raises when the part is not well-formed XML
        out[name] = data.decode("utf-8")
    else:
        out[name] = "<%d bytes>" % len(data)
json.dump(out, sys.stdout)
`;

/** Every part of a Word file by name. A part that is not well-formed XML, or a bad ZIP, throws. */
export function docxParts(bytes: Uint8Array): Record<string, string> {
	const out = execFileSync("python3", ["-I", "-c", SCRIPT], { input: Buffer.from(bytes), maxBuffer: 64 * 1024 * 1024 });
	return JSON.parse(out.toString("utf8"));
}

/** Plain text of one XML part: the w:t runs, with a space between paragraphs and table cells. */
export function wordText(xml: string): string {
	return xml
		.replace(/<\/w:p>/g, " ")
		.replace(/<w:tab\/>/g, " ")
		.replace(/<[^>]+>/g, "")
		.replace(/&amp;/g, "&")
		.replace(/&lt;/g, "<")
		.replace(/&gt;/g, ">")
		.replace(/&quot;/g, '"')
		.replace(/\s+/g, " ")
		.trim();
}

const MEDIA = `
import sys, json, zipfile, io, hashlib
z = zipfile.ZipFile(io.BytesIO(sys.stdin.buffer.read()))
out = {}
for name in z.namelist():
    if name.startswith("word/media/"):
        out[name] = hashlib.sha256(z.read(name)).hexdigest()
json.dump(out, sys.stdout)
`;

/** The SHA-256 of each picture in a Word file, by part name. */
export function docxMedia(bytes: Uint8Array): Record<string, string> {
	const out = execFileSync("python3", ["-I", "-c", MEDIA], { input: Buffer.from(bytes), maxBuffer: 64 * 1024 * 1024 });
	return JSON.parse(out.toString("utf8"));
}

let soffice: boolean | undefined;
/** True when LibreOffice's `soffice` runs on this machine. */
const hasSoffice = () => (soffice ??= spawnSync("soffice", ["--version"], { stdio: "ignore" }).status === 0);

/**
 * A check that opens a file in LibreOffice. Without `soffice` it skips, except in CI: CI installs LibreOffice, so there
 * the check runs and fails instead of passing while it covers less than it claims.
 */
export function sofficeTest(name: string, fn: (t: TestContext) => Promise<void>) {
	const ci = process.env.CI === "true";
	return test(name, { skip: !ci && !hasSoffice() && "LibreOffice is not installed" }, async (t) => {
		assert.ok(hasSoffice(), "LibreOffice (soffice) is not on PATH. CI installs it so this check runs.");
		await fn(t);
	});
}

/** LibreOffice converts the Word file to PDF; the result is that PDF's bytes. */
export function sofficeToPdf(docx: Uint8Array): Buffer {
	const dir = mkdtempSync(join(tmpdir(), "wp037-soffice-"));
	const input = join(dir, "in.docx");
	writeFileSync(input, docx);
	execFileSync(
		"soffice",
		["--headless", `-env:UserInstallation=file://${dir}/profile`, "--convert-to", "pdf", "--outdir", dir, input],
		{
			stdio: "ignore",
			timeout: 120_000,
		},
	);
	return readFileSync(join(dir, "in.pdf"));
}

/**
 * Each embedded TrueType font of a PDF: the name the PDF gives it (BaseFont, subset prefix removed) and the family and
 * style the font program's own `name` table holds. A face that prints the wrong file shows here as a name mismatch.
 */
export async function pdfFontFaces(bytes: Uint8Array): Promise<{ baseFont: string; family: string; style: string }[]> {
	const { PDFDocument, PDFDict, PDFName, PDFRawStream } =
		await import("../../../../packages/domain/node_modules/pdf-lib/cjs/index.js");
	const { inflateSync } = await import("node:zlib");
	const doc = await PDFDocument.load(bytes);
	const faces: { baseFont: string; family: string; style: string }[] = [];
	for (const [, obj] of doc.context.enumerateIndirectObjects()) {
		if (!(obj instanceof PDFDict)) continue;
		const file = obj.lookup(PDFName.of("FontFile2"));
		if (!(file instanceof PDFRawStream)) continue;
		const raw = Buffer.from(file.contents);
		const font = file.dict.get(PDFName.of("Filter")) ? inflateSync(raw) : raw;
		const names = nameTable(font);
		faces.push({
			baseFont: (obj.get(PDFName.of("FontName")) as InstanceType<typeof PDFName>)
				.decodeText()
				.replace(/^[A-Z]{6}\+/, ""),
			family: names[1] ?? "",
			style: names[2] ?? "",
		});
	}
	return faces;
}

/** Name IDs 1 (family) and 2 (subfamily) of a TrueType font, from its Windows or Mac records. */
function nameTable(font: Buffer): Record<number, string> {
	const out: Record<number, string> = {};
	const tables = font.readUInt16BE(4);
	for (let i = 0; i < tables; i++) {
		const entry = 12 + i * 16;
		if (font.toString("latin1", entry, entry + 4) !== "name") continue;
		const at = font.readUInt32BE(entry + 8);
		const strings = at + font.readUInt16BE(at + 4);
		for (let j = 0; j < font.readUInt16BE(at + 2); j++) {
			const record = at + 6 + j * 12;
			const platform = font.readUInt16BE(record);
			const id = font.readUInt16BE(record + 6);
			if ((id !== 1 && id !== 2) || out[id]) continue;
			const value = font.subarray(
				strings + font.readUInt16BE(record + 10),
				strings + font.readUInt16BE(record + 10) + font.readUInt16BE(record + 8),
			);
			out[id] = platform === 1 ? value.toString("latin1") : Buffer.from(value).swap16().toString("utf16le");
		}
	}
	return out;
}

/** The decoded content-stream operators of every page of a PDF, as text, with the ExtGState dictionaries they name. */
export async function pdfOperators(bytes: Uint8Array): Promise<string> {
	const { PDFDocument, PDFArray, PDFRawStream, decodePDFRawStream } =
		await import("../../../../packages/domain/node_modules/pdf-lib/cjs/index.js");
	const doc = await PDFDocument.load(bytes);
	const out: string[] = [];
	for (const page of doc.getPages()) {
		const contents = page.node.Contents();
		if (!contents) continue;
		const streams = contents instanceof PDFArray ? contents.asArray().map((s) => doc.context.lookup(s)) : [contents];
		for (const s of streams)
			out.push(s instanceof PDFRawStream ? Buffer.from(decodePDFRawStream(s).decode()).toString("latin1") : String(s));
		out.push(String(page.node.Resources() ?? ""));
	}
	return out.join("\n");
}
