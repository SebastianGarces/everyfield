import type { PDFDocumentProxy } from "pdfjs-dist";

// Draws PDF pages in the browser from the bytes the production renderer made. pdf.js loads on first use, so the
// library route does not carry it until a thumbnail or a preview needs it.

let loaded: Promise<typeof import("pdfjs-dist")> | null = null;

function library() {
	loaded ??= import("pdfjs-dist").then((pdfjs) => {
		pdfjs.GlobalWorkerOptions.workerSrc = new URL("pdfjs-dist/build/pdf.worker.min.mjs", import.meta.url).toString();
		return pdfjs;
	});
	return loaded;
}

/** pdf.js hands the buffer to its worker, so it gets a copy and the caller keeps its bytes. */
export async function openPdf(bytes: Uint8Array): Promise<PDFDocumentProxy> {
	const pdfjs = await library();
	return pdfjs.getDocument({ data: bytes.slice() }).promise;
}

/** Draws one page so its width is `cssWidth` CSS pixels, sharp at `ratio` device pixels per CSS pixel. */
export async function drawPage(
	doc: PDFDocumentProxy,
	number: number,
	canvas: HTMLCanvasElement,
	cssWidth: number,
	ratio: number,
) {
	const page = await doc.getPage(number);
	const base = page.getViewport({ scale: 1 });
	const viewport = page.getViewport({ scale: (cssWidth * ratio) / base.width });
	canvas.width = Math.round(viewport.width);
	canvas.height = Math.round(viewport.height);
	await page.render({ canvas, viewport }).promise;
}

/** Frees the worker's copy of the document. */
export function closePdf(doc: PDFDocumentProxy) {
	void doc.loadingTask.destroy();
}
