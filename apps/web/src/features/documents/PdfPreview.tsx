"use client";

import { ArrowLeft01Icon, ArrowRight01Icon } from "@hugeicons/core-free-icons";
import { IconButton, Skeleton, StatePanel } from "@everyfield/ui/controls";
import { observeSize } from "@everyfield/ui/foundations";
import type { PDFDocumentProxy } from "pdfjs-dist";
import { useCallback, useState, type KeyboardEvent } from "react";
import type { Template } from "./model.ts";
import { closePdf, drawPage, openPdf } from "./pdf.ts";
import { RENDER_FAILED } from "./preview-client.ts";

type Props = { title: string; pageSize: NonNullable<Template["pageSize"]>; bytes: Uint8Array };

function pdfCanvas(bytes: Uint8Array, events: { opened: (pages: number) => void; failed: () => void }) {
	let page = 1;
	let draw = () => {};
	return {
		show(next: number) {
			page = next;
			draw();
		},
		attach(canvas: HTMLCanvasElement | null) {
			if (!canvas) return;
			let live = true;
			let doc: PDFDocumentProxy | null = null;
			let width = 0;
			let drawn = 0;
			const paint = () => {
				if (!live || !doc || width === 0) return;
				const mine = ++drawn;
				drawPage(doc, page, canvas, width, window.devicePixelRatio || 1, () => live && mine === drawn).catch(
					() => live && events.failed(),
				);
			};
			draw = paint;
			const stopSize = observeSize<HTMLCanvasElement>((node) => {
				width = Math.round(node.clientWidth);
				paint();
			})(canvas);
			openPdf(bytes).then(
				(opened) => {
					if (!live) return closePdf(opened);
					doc = opened;
					events.opened(opened.numPages);
					paint();
				},
				() => live && events.failed(),
			);
			return () => {
				live = false;
				stopSize?.();
				if (doc) closePdf(doc);
				if (draw === paint) draw = () => {};
			};
		},
	};
}

export function PdfPreview({ title, pageSize, bytes }: Props) {
	const [pages, setPages] = useState(0);
	const [failed, setFailed] = useState(false);
	const [page, setPage] = useState(1);
	const [canvas] = useState(() => pdfCanvas(bytes, { opened: setPages, failed: () => setFailed(true) }));
	const attach = useCallback((node: HTMLCanvasElement | null) => canvas.attach(node), [canvas]);

	const go = (next: number) => {
		const shown = Math.min(Math.max(next, 1), Math.max(pages, 1));
		setPage(shown);
		canvas.show(shown);
	};

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
			<StatePanel tone="error" title="Preview unavailable" headingLevel="h3">
				{RENDER_FAILED}
			</StatePanel>
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
				tabIndex={pages > 1 ? 0 : undefined}
				role="group"
				aria-label={`${title} preview`}
				aria-describedby={pages > 1 ? "page-keys" : undefined}
				onKeyDown={onKeyDown}
				style={{ aspectRatio: `${pageSize.width} / ${pageSize.height}` }}
				className="relative w-full overflow-hidden bg-white shadow-[0_0_0_1px_var(--ef-line),0_8px_24px_-12px_color-mix(in_srgb,var(--ef-ink)_25%,transparent)] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus"
			>
				{pages > 0 ? null : <Skeleton shape="block" className="absolute inset-0 rounded-none" />}
				<canvas
					ref={attach}
					role="img"
					aria-label={`${title}, page ${page}${pages ? ` of ${pages}` : ""}`}
					className="block size-full"
				/>
			</div>
		</div>
	);
}
