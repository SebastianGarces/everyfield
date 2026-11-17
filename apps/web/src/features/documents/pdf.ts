import type { PDFDocumentProxy } from "pdfjs-dist";

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

export async function openPdf(bytes: Uint8Array): Promise<PDFDocumentProxy> {
	const pdfjs = await library();
	return pdfjs.getDocument({ data: bytes.slice() }).promise;
}

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

export function closePdf(doc: PDFDocumentProxy) {
	void doc.loadingTask.destroy();
}
