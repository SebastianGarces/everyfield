"use client";

import { Skeleton, StatePanel } from "@everyfield/ui/controls";
import type { PDFDocumentProxy } from "pdfjs-dist";
import { useEffect, useRef, useState } from "react";
import { closePdf, drawPage, openPdf } from "../pdf.ts";

// The preview of a Church Document is its real PDF: the bytes "Download PDF" gives, drawn page by page with page breaks
// and the card sheet exactly as they print. Pages draw one after another as the reader scrolls toward them. A new
// revision gets a new `src`; the parent keys this component by it, so nothing from the old file stays.

type Props = { title: string; src: string; page: { width: number; height: number } };

export function ChurchPdf({ title, src, page }: Props) {
	const [doc, setDoc] = useState<PDFDocumentProxy | null>(null);
	const [failed, setFailed] = useState(false);
	const [width, setWidth] = useState(0);
	const frame = useRef<HTMLDivElement>(null);

	useEffect(() => {
		let cancelled = false;
		let opened: PDFDocumentProxy | null = null;
		fetch(src, { cache: "no-store" })
			.then((response) => (response.ok ? response.arrayBuffer() : Promise.reject(new Error(String(response.status)))))
			.then((buffer) => openPdf(new Uint8Array(buffer)))
			.then(
				(next) => {
					if (cancelled) closePdf(next);
					else {
						opened = next;
						setDoc(next);
					}
				},
				() => !cancelled && setFailed(true),
			);
		return () => {
			cancelled = true;
			if (opened) closePdf(opened);
		};
	}, [src]);

	useEffect(() => {
		const node = frame.current;
		if (!node) return;
		const observer = new ResizeObserver(([entry]) => entry && setWidth(Math.round(entry.contentRect.width)));
		observer.observe(node);
		return () => observer.disconnect();
	}, []);

	if (failed)
		return (
			<StatePanel tone="error" title="The preview did not load" headingLevel="h2" className="py-8">
				The PDF did not render. Nothing was changed. Reload the page to try again.
			</StatePanel>
		);

	const pages = doc?.numPages ?? 0;
	return (
		<div ref={frame} className="flex flex-col gap-5" aria-busy={doc ? undefined : true}>
			<p className="sr-only" role="status">
				{doc ? `${title} preview, ${pages} page${pages === 1 ? "" : "s"}` : "Loading the preview"}
			</p>
			{doc
				? Array.from({ length: pages }, (_, i) => (
						<PdfPage key={i} doc={doc} number={i + 1} total={pages} width={width} title={title} page={page} />
					))
				: (
						<div style={{ aspectRatio: `${page.width} / ${page.height}` }} className="w-full">
							<Skeleton shape="block" className="size-full rounded-none" />
						</div>
					)}
		</div>
	);
}

function PdfPage({
	doc,
	number,
	total,
	width,
	title,
	page,
}: {
	doc: PDFDocumentProxy;
	number: number;
	total: number;
	width: number;
	title: string;
	page: { width: number; height: number };
}) {
	const canvas = useRef<HTMLCanvasElement>(null);
	const [visible, setVisible] = useState(number === 1);
	const [drawn, setDrawn] = useState(false);

	useEffect(() => {
		const node = canvas.current;
		if (!node || visible) return;
		const observer = new IntersectionObserver(([entry]) => entry?.isIntersecting && setVisible(true), {
			rootMargin: "800px 0px",
		});
		observer.observe(node);
		return () => observer.disconnect();
	}, [visible]);

	useEffect(() => {
		if (!visible || !canvas.current || width === 0) return;
		let current = true;
		drawPage(doc, number, canvas.current, width, window.devicePixelRatio || 1, () => current).then(
			() => current && setDrawn(true),
			() => undefined,
		);
		return () => {
			current = false;
		};
	}, [doc, number, width, visible]);

	return (
		<figure className="flex flex-col gap-2">
			<div
				style={{ aspectRatio: `${page.width} / ${page.height}` }}
				className="relative w-full overflow-hidden bg-white shadow-[0_0_0_1px_var(--ef-line),0_8px_24px_-12px_color-mix(in_srgb,var(--ef-ink)_25%,transparent)]"
			>
				{drawn ? null : <Skeleton shape="block" className="absolute inset-0 rounded-none" />}
				<canvas ref={canvas} role="img" aria-label={`${title}, page ${number} of ${total}`} className="block size-full" />
			</div>
			<figcaption className="text-center text-sm text-text-3 tabular-nums">
				Page {number} of {total}
			</figcaption>
		</figure>
	);
}
