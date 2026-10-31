"use client";

import { ArrowLeft01Icon, ArrowRight01Icon } from "@hugeicons/core-free-icons";
import { IconButton } from "@everyfield/ui/controls";
import { Skeleton } from "@everyfield/ui/controls";
import type { PDFDocumentProxy } from "pdfjs-dist";
import { useEffect, useRef, useState, type KeyboardEvent } from "react";
import type { Template } from "./model.ts";
import { closePdf, drawPage, openPdf } from "./pdf.ts";

// The preview: each page at its true aspect (Letter 8.5 x 11, card 4.25 x 5.5), drawn from the renderer's bytes.
// Arrow keys, Page Up and Page Down, Home and End move between pages when the page has focus.

type Props = { title: string; pageSize: NonNullable<Template["pageSize"]>; bytes: Uint8Array };

export function PdfPreview({ title, pageSize, bytes }: Props) {
	const [doc, setDoc] = useState<PDFDocumentProxy | null>(null);
	const [failed, setFailed] = useState(false);
	const [page, setPage] = useState(1);
	const [width, setWidth] = useState(0);
	const frame = useRef<HTMLDivElement>(null);
	const canvas = useRef<HTMLCanvasElement>(null);

	useEffect(() => {
		let cancelled = false;
		let opened: PDFDocumentProxy | null = null;
		openPdf(bytes).then(
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
	}, [bytes]);

	useEffect(() => {
		const node = frame.current;
		if (!node) return;
		const observer = new ResizeObserver(([entry]) => entry && setWidth(Math.round(entry.contentRect.width)));
		observer.observe(node);
		return () => observer.disconnect();
	}, []);

	useEffect(() => {
		if (!doc || !canvas.current || width === 0) return;
		let current = true;
		drawPage(doc, page, canvas.current, width, window.devicePixelRatio || 1, () => current).catch(
			() => current && setFailed(true),
		);
		return () => {
			current = false;
		};
	}, [doc, page, width]);

	const pages = doc?.numPages ?? 0;
	const go = (next: number) => setPage(Math.min(Math.max(next, 1), Math.max(pages, 1)));

	function onKeyDown(event: KeyboardEvent) {
		const target: Record<string, number> = {
			ArrowLeft: page - 1,
			ArrowUp: page - 1,
			PageUp: page - 1,
			ArrowRight: page + 1,
			ArrowDown: page + 1,
			PageDown: page + 1,
			Home: 1,
			End: pages,
		};
		const next = target[event.key];
		if (next === undefined || pages < 2) return;
		event.preventDefault();
		go(next);
	}

	if (failed)
		return (
			<p role="status" className="rounded-md bg-surface-2 px-4 py-6 text-center text-sm text-text-2">
				This file did not render. Nothing was saved.
			</p>
		);

	return (
		<div className="flex flex-col gap-3">
			{pages > 1 ? (
				<div className="flex items-center justify-between gap-3">
					<IconButton
						icon={ArrowLeft01Icon}
						label="Previous page"
						variant="default"
						disabled={page <= 1}
						onClick={() => go(page - 1)}
					/>
					<p aria-live="polite" className="text-sm font-medium text-ink">
						Page {page} of {pages}
					</p>
					<IconButton
						icon={ArrowRight01Icon}
						label="Next page"
						variant="default"
						disabled={page >= pages}
						onClick={() => go(page + 1)}
					/>
					<span id="page-keys" className="sr-only">
						Use the arrow keys to move between pages.
					</span>
				</div>
			) : null}
			<div
				ref={frame}
				tabIndex={pages > 1 ? 0 : undefined}
				role="group"
				aria-label={`${title} preview`}
				aria-describedby={pages > 1 ? "page-keys" : undefined}
				onKeyDown={onKeyDown}
				style={{ aspectRatio: `${pageSize.width} / ${pageSize.height}` }}
				className="relative w-full overflow-hidden bg-white shadow-[0_0_0_1px_var(--ef-line),0_8px_24px_-12px_rgba(0,0,0,0.25)] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus"
			>
				{doc ? null : <Skeleton shape="block" className="absolute inset-0 rounded-none" />}
				<canvas
					ref={canvas}
					role="img"
					aria-label={`${title}, page ${page}${pages ? ` of ${pages}` : ""}`}
					className="block size-full"
				/>
			</div>
		</div>
	);
}
