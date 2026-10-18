import "server-only";
import { Worker } from "node:worker_threads";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import { unzipSync, strFromU8 } from "fflate";
import { Refusal } from "./boundary.ts";

export type FileFormat = "docx" | "xlsx" | "pdf";
export const maxFileBytes = 1024 * 1024;
export async function previewText(bytes: Uint8Array, format: FileFormat): Promise<string> {
	if (bytes.length === 0 || bytes.length > maxFileBytes) throw new Refusal("invalid_input", 422);
	if (format === "pdf") {
		if (Buffer.from(bytes.subarray(0, 5)).toString() !== "%PDF-") throw new Refusal("invalid_input", 422);
		// Separate heap and deadline bound PDF decompression/parsing. The worker imports
		// the pinned Node package directly, including its own PDF.js worker module.
		const require = createRequire(process.cwd() + "/package.json");
		const entry = require.resolve("pdfjs-dist/legacy/build/pdf.mjs", {
			paths: [process.cwd(), process.cwd() + "/apps/web"],
		});
		const source = `
      const { parentPort, workerData } = require("node:worker_threads");
      (async () => {
        const { getDocument } = await import(workerData.entry);
        const task = getDocument({data: workerData.bytes, useSystemFonts:false, disableFontFace:true, maxImageSize:0, verbosity:0});
        try {
          const pdf = await task.promise;
          if(pdf.numPages>20)throw new Error("page_limit");
          const texts=[];let size=0;
          for(let i=1;i<=pdf.numPages;i++) {
            const page=await pdf.getPage(i);const content=await page.getTextContent();
            const text=content.items.map(item=>"str" in item?item.str:"").join(" ");
            size+=text.length;if(size>64000)throw new Error("text_limit");texts.push(text);
          }
          parentPort.postMessage({text:texts.join("\\n")});
        } finally { await task.destroy(); }
      })().catch(()=>parentPort.postMessage({error:true}));
    `;
		return new Promise<string>((resolve, reject) => {
			const worker = new Worker(source, {
				eval: true,
				workerData: { entry: pathToFileURL(entry).href, bytes: Uint8Array.from(bytes) },
				resourceLimits: { maxOldGenerationSizeMb: 96, maxYoungGenerationSizeMb: 16, stackSizeMb: 4 },
			});
			const timeout = setTimeout(() => {
				void worker.terminate();
				reject(new Refusal("invalid_input", 422));
			}, 3000);
			worker.once("message", (message: unknown) => {
				clearTimeout(timeout);
				void worker.terminate();
				if (typeof message === "object" && message !== null && "text" in message && typeof message.text === "string")
					resolve(message.text);
				else reject(new Refusal("invalid_input", 422));
			});
			worker.once("error", () => {
				clearTimeout(timeout);
				reject(new Refusal("invalid_input", 422));
			});
			worker.once("exit", (code) => {
				clearTimeout(timeout);
				if (code !== 0) reject(new Refusal("invalid_input", 422));
			});
		});
	}
	if (bytes[0] !== 0x50 || bytes[1] !== 0x4b) throw new Refusal("invalid_input", 422);
	let expanded = 0;
	let entries = 0;
	const files = unzipSync(bytes, {
		filter: (file) => {
			expanded += file.originalSize;
			entries++;
			if (
				entries > 64 ||
				expanded > 8 * 1024 * 1024 ||
				file.originalSize > 1024 * 1024 ||
				/(?:\.\.|^\/|vbaProject|externalLinks)/i.test(file.name)
			)
				throw new Refusal("invalid_input", 422);
			return true;
		},
	});
	if (!files["[Content_Types].xml"] || !files["_rels/.rels"]) throw new Refusal("invalid_input", 422);
	const target = format === "docx" ? "word/document.xml" : "xl/workbook.xml";
	if (!files[target]) throw new Refusal("invalid_input", 422);
	const xml = Object.entries(files)
		.filter(([name]) => /\.xml$|\.rels$/.test(name))
		.map(([, data]) => strFromU8(data));
	if (xml.some((text) => /<!DOCTYPE|<!ENTITY|TargetMode\s*=\s*["']External|<f[\s>]/i.test(text)))
		throw new Refusal("invalid_input", 422);
	const content =
		format === "docx"
			? strFromU8(files[target])
			: Object.entries(files)
					.filter(([name]) => /^xl\/(sharedStrings|worksheets\/sheet\d+)\.xml$/.test(name))
					.map(([, data]) => strFromU8(data))
					.join("\n");
	// Return inert JSON text only, never upload HTML, SVG, macros or embedded objects.
	return [...content.matchAll(/<(?:w:t|t|v)(?:\s[^>]*)?>([^<]*)<\//g)]
		.map((m) => m[1])
		.join(" ")
		.slice(0, 64_000);
}
