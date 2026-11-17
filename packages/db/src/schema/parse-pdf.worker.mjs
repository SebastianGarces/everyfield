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
