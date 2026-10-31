// Readers that are independent of the writers under test: pdf.js reads a PDF, Python's zipfile and ElementTree read a
// Word file, and LibreOffice opens it when the machine has it.
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

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

export const hasSoffice = () => spawnSync("soffice", ["--version"], { stdio: "ignore" }).status === 0;

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
