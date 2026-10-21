// The PDF parse worker of validateCommitment. A file the bundler sees through `new Worker(new URL(...))`, so the built
// app ships it with pdfjs. Tests may pass a different parser module as workerData.entry.
// pdfjs parses in a "fake worker" on this thread. It imports ./pdf.worker.mjs next to its own file unless
// globalThis.pdfjsWorker holds that module; in the built app that file does not exist, so it is loaded here.
import { parentPort, workerData } from "node:worker_threads";

try {
	globalThis.pdfjsWorker = await import("pdfjs-dist/legacy/build/pdf.worker.mjs");
	const { getDocument } = workerData.entry
		? await import(/* turbopackIgnore: true */ /* webpackIgnore: true */ workerData.entry)
		: await import("pdfjs-dist/legacy/build/pdf.mjs");
	parentPort.postMessage("ready");
	const task = getDocument({
		data: workerData.bytes,
		disableFontFace: true,
		useSystemFonts: false,
		maxImageSize: 0,
		isEvalSupported: false,
		verbosity: 0,
	});
	try {
		const pdf = await task.promise;
		if (pdf.numPages > 100) throw Error("pages");
		let length = 0;
		for (let i = 1; i <= pdf.numPages; i++) {
			const page = await pdf.getPage(i);
			const content = await page.getTextContent();
			length += JSON.stringify(content).length;
			if (length > 1000000) throw Error("expansion");
		}
		parentPort.postMessage(true);
	} finally {
		await task.destroy();
	}
} catch {
	parentPort.postMessage(false);
}
