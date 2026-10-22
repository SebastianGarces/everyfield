// The PDF parse worker of validateCommitment. A file the bundler sees through `new Worker(new URL(...))`, so the built
// app ships it with pdfjs. Tests may pass a different parser module as workerData.entry.
// pdfjs parses in a "fake worker" on this thread. It imports ./pdf.worker.mjs next to its own file unless
// globalThis.pdfjsWorker holds that module; in the built app that file does not exist, so it is loaded here.
// The worker stays warm: it loads the parser once, says "ready", then answers each file it receives with true or false.
// The host sends one file at a time and replaces the worker after a timeout or a crash.
import { parentPort, workerData } from "node:worker_threads";

async function parse(getDocument, data) {
	const task = getDocument({
		data,
		disableFontFace: true,
		useSystemFonts: false,
		maxImageSize: 0,
		isEvalSupported: false,
		verbosity: 0,
	});
	try {
		const pdf = await task.promise;
		if (pdf.numPages > 100) return false;
		let length = 0;
		for (let i = 1; i <= pdf.numPages; i++) {
			const page = await pdf.getPage(i);
			const content = await page.getTextContent();
			length += JSON.stringify(content).length;
			if (length > 1000000) return false;
		}
		return true;
	} catch {
		return false;
	} finally {
		await task.destroy();
	}
}

try {
	globalThis.pdfjsWorker = await import("pdfjs-dist/legacy/build/pdf.worker.mjs");
	const { getDocument } = workerData.entry
		? await import(/* turbopackIgnore: true */ /* webpackIgnore: true */ workerData.entry)
		: await import("pdfjs-dist/legacy/build/pdf.mjs");
	parentPort.on("message", async (bytes) => parentPort.postMessage(await parse(getDocument, bytes)));
	parentPort.postMessage("ready");
} catch {
	parentPort.postMessage(false);
}
