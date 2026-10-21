import "server-only";
import { Worker } from "node:worker_threads";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import sharp from "sharp";
const require = createRequire(import.meta.url);

// The parse limit is a security bound on parsing only. It starts when the worker has loaded the parser, so a slow
// worker start (a loaded machine or a cold start) does not reject a valid PDF.
const PARSE_MS = 3000;
// A worker that never loads the parser is stopped here.
const STARTUP_MS = 30_000;

// Parse untrusted PDFs on a bounded heap and deadline; no scripts, attachments or rendering.
export async function validateCommitment(
	bytes: Uint8Array,
	mediaType: string,
	// Tests only: a different parser module or parse limit.
	pdf: { entry?: string; parseMs?: number } = {},
): Promise<void> {
	if (!bytes.length || bytes.length > 10 * 1024 * 1024) throw new Error("invalid_file");
	if (mediaType === "image/jpeg" || mediaType === "image/png") {
		try {
			const image = sharp(bytes, { limitInputPixels: 16_000_000, failOn: "warning", animated: false });
			const metadata = await image.metadata();
			if (metadata.format !== (mediaType === "image/jpeg" ? "jpeg" : "png")) throw new Error("invalid_file");
			await image.raw().timeout({ seconds: 3 }).toBuffer();
		} catch {
			throw new Error("invalid_file");
		}
		return;
	}
	if (mediaType !== "application/pdf" || Buffer.from(bytes.subarray(0, 5)).toString() !== "%PDF-")
		throw new Error("invalid_file");
	const entry = pdf.entry ?? pathToFileURL(require.resolve("pdfjs-dist/legacy/build/pdf.mjs")).href;
	await new Promise<void>((resolve, reject) => {
		const worker = new Worker(
			`const {parentPort,workerData}=require('node:worker_threads');
      (async()=>{const {getDocument}=await import(workerData.entry);parentPort.postMessage('ready');const task=getDocument({data:workerData.bytes,disableFontFace:true,useSystemFonts:false,maxImageSize:0,isEvalSupported:false,verbosity:0});
      try {const pdf=await task.promise;if(pdf.numPages>100)throw Error('pages');let length=0;for(let i=1;i<=pdf.numPages;i++){const page=await pdf.getPage(i);const content=await page.getTextContent();length+=JSON.stringify(content).length;if(length>1000000)throw Error('expansion');}parentPort.postMessage(true);}finally{await task.destroy();}})().catch(()=>parentPort.postMessage(false));`,
			{
				eval: true,
				workerData: { entry, bytes: Uint8Array.from(bytes) },
				resourceLimits: { maxOldGenerationSizeMb: 96, maxYoungGenerationSizeMb: 16, stackSizeMb: 4 },
			},
		);
		let settled = false;
		const finish = (valid: boolean) => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			void worker.terminate();
			if (valid) resolve();
			else reject(new Error("invalid_file"));
		};
		let timer = setTimeout(() => finish(false), STARTUP_MS);
		worker.on("message", (value) => {
			if (value !== "ready") return finish(value === true);
			clearTimeout(timer);
			timer = setTimeout(() => finish(false), pdf.parseMs ?? PARSE_MS);
		});
		worker.once("error", () => finish(false));
		worker.once("exit", () => finish(false));
	});
}

export async function validateAvatar(bytes: Uint8Array, mediaType: string): Promise<void> {
	if (!bytes.length || bytes.length > 3 * 1024 * 1024 || !["image/jpeg", "image/png", "image/webp"].includes(mediaType))
		throw Error("invalid_avatar");
	try {
		const image = sharp(bytes, { limitInputPixels: 16_000_000, failOn: "warning", animated: false });
		const metadata = await image.metadata();
		if (
			metadata.format !== (mediaType === "image/jpeg" ? "jpeg" : mediaType === "image/png" ? "png" : "webp") ||
			(metadata.pages ?? 1) !== 1
		)
			throw Error("invalid_avatar");
		await image.raw().timeout({ seconds: 3 }).toBuffer();
	} catch {
		throw Error("invalid_avatar");
	}
}
