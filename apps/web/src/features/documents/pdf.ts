import type { PDFDocumentProxy } from "pdfjs-dist";

// Draws PDF pages in the browser from the bytes the production renderer made. pdf.js loads on first use, so the
// library route does not carry it until a thumbnail or a preview needs it. The legacy build carries the polyfills
// that browsers without Map.getOrInsertComputed need.

let loaded: Promise<typeof import("pdfjs-dist/legacy/build/pdf.mjs")> | null = null;

function library() {
	loaded ??= import("pdfjs-dist/legacy/build/pdf.mjs").then((pdfjs) => {
		pdfjs.GlobalWorkerOptions.workerSrc = new URL(
			"pdfjs-dist/legacy/build/pdf.worker.min.mjs",
			import.meta.url,
		).toString();
		return pdfjs;
	});
	return loaded;
}

/** pdf.js hands the buffer to its worker, so it gets a copy and the caller keeps its bytes. */
export async function openPdf(bytes: Uint8Array): Promise<PDFDocumentProxy> {
	const pdfjs = await library();
	return pdfjs.getDocument({ data: bytes.slice() }).promise;
}

/**
 * Draws one page so its width is `cssWidth` CSS pixels, sharp at `ratio` device pixels per CSS pixel. The page is drawn
 * on its own canvas and copied over only while `current()` is true, so quick page changes never share a canvas.
 */
export async function drawPage(
	doc: PDFDocumentProxy,
	number: number,
	target: HTMLCanvasElement,
	cssWidth: number,
	ratio: number,
	current: () => boolean = () => true,
) {
	const page = await doc.getPage(number);
	const base = page.getViewport({ scale: 1 });
	const viewport = page.getViewport({ scale: (cssWidth * ratio) / base.width });
	const canvas = document.createElement("canvas");
	canvas.width = Math.round(viewport.width);
	canvas.height = Math.round(viewport.height);
	await page.render({ canvas, viewport }).promise;
	if (!current()) return;
	target.width = canvas.width;
	target.height = canvas.height;
	target.getContext("2d")?.drawImage(canvas, 0, 0);
}

/** Frees the worker's copy of the document. */
export function closePdf(doc: PDFDocumentProxy) {
	void doc.loadingTask.destroy();
}
