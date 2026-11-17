"use client";

import { Skeleton, StatePanel } from "@everyfield/ui/controls";
import { observeIntersection, observeSize } from "@everyfield/ui/foundations";
import type { PDFDocumentProxy } from "pdfjs-dist";
import { useCallback, useState } from "react";
import { createRead, useRead } from "../../../components/read.tsx";
import { closePdf, drawPage, openPdf } from "../pdf.ts";

type Props = { title: string; src: string; page: { width: number; height: number } };

type PdfFile = { status: "ok"; bytes: Uint8Array } | { status: "lost" };

const pdfFiles = createRead(
	(src: string) =>
		fetch(src, { cache: "no-store" }).then((response): Promise<PdfFile> | PdfFile =>
			response.ok
				? response.arrayBuffer().then((buffer): PdfFile => ({ status: "ok", bytes: new Uint8Array(buffer) }))
				: { status: "lost" },
		),
	{ failed: (): PdfFile => ({ status: "lost" }) },
);

function pdfPages(bytes: Uint8Array, events: { opened: (pages: number) => void; failed: () => void }) {
	let doc: PDFDocumentProxy | null = null;
	let width = 0;
	const painters = new Set<() => void>();
	const paintAll = () => {
		for (const paint of painters) paint();
	};
	return {
		attach(frame: HTMLDivElement | null) {
			if (!frame) return;
			let live = true;
			const stopSize = observeSize<HTMLDivElement>((node) => {
				width = Math.round(node.clientWidth);
				paintAll();
			})(frame);
			openPdf(bytes).then(
				(opened) => {
					if (!live) return closePdf(opened);
					doc = opened;
					events.opened(opened.numPages);
					paintAll();
				},
				() => live && events.failed(),
			);
			return () => {
				live = false;
				stopSize?.();
				if (doc) closePdf(doc);
				doc = null;
			};
		},
		page(number: number, drawn: () => void) {
			return (canvas: HTMLCanvasElement | null) => {
				if (!canvas) return;
				let live = true;
				let visible = number === 1;
				let latest = 0;
				const paint = () => {
					if (!live || !visible || !doc || width === 0) return;
					const mine = ++latest;
					const current = () => live && mine === latest;
					drawPage(doc, number, canvas, width, window.devicePixelRatio || 1, current).then(
						() => current() && drawn(),
						() => undefined,
					);
				};
				painters.add(paint);
				const stopSeen = visible
					? undefined
					: observeIntersection<HTMLCanvasElement>(
							(entry, stop) => {
								if (!entry.isIntersecting) return;
								stop();
								visible = true;
								paint();
							},
							{ rootMargin: "800px 0px" },
						)(canvas);
				paint();
				return () => {
					live = false;
					stopSeen?.();
					painters.delete(paint);
				};
			};
		},
	};
}

type Pages = ReturnType<typeof pdfPages>;

export function ChurchPdf({ title, src, page }: Props) {
	const file = useRead(pdfFiles, src);
	if (file.value?.status === "lost") return <Failed />;
	return file.value ? <PdfPages title={title} bytes={file.value.bytes} page={page} /> : <Loading page={page} />;
}

function Failed() {
	return (
		<StatePanel tone="error" title="The preview did not load" headingLevel="h2" className="py-8">
			The PDF did not render. Nothing was changed. Reload the page to try again.
		</StatePanel>
	);
}

function Loading({ page }: { page: Props["page"] }) {
	return (
		<div className="flex flex-col gap-5" aria-busy>
			<p className="sr-only" role="status">
				Loading the preview
			</p>
			<div style={{ aspectRatio: `${page.width} / ${page.height}` }} className="w-full">
				<Skeleton shape="block" className="size-full rounded-none" />
			</div>
		</div>
	);
}

function PdfPages({ title, bytes, page }: { title: string; bytes: Uint8Array; page: Props["page"] }) {
	const [pages, setPages] = useState(0);
	const [failed, setFailed] = useState(false);
	const [pdf] = useState(() => pdfPages(bytes, { opened: setPages, failed: () => setFailed(true) }));
	const attach = useCallback((node: HTMLDivElement | null) => pdf.attach(node), [pdf]);

	if (failed) return <Failed />;
	return (
		<div ref={attach} className="flex flex-col gap-5" aria-busy={pages ? undefined : true}>
			<p className="sr-only" role="status">
				{pages ? `${title} preview, ${pages} page${pages === 1 ? "" : "s"}` : "Loading the preview"}
			</p>
			{pages ? (
				Array.from({ length: pages }, (_, i) => (
					<PdfPage key={i} pdf={pdf} number={i + 1} total={pages} title={title} page={page} />
				))
			) : (
				<div style={{ aspectRatio: `${page.width} / ${page.height}` }} className="w-full">
					<Skeleton shape="block" className="size-full rounded-none" />
				</div>
			)}
		</div>
	);
}

function PdfPage({
	pdf,
	number,
	total,
	title,
	page,
}: {
	pdf: Pages;
	number: number;
	total: number;
	title: string;
	page: Props["page"];
}) {
	const [drawn, setDrawn] = useState(false);
	const [attach] = useState(() => pdf.page(number, () => setDrawn(true)));

	return (
		<figure className="flex flex-col gap-2">
			<div
				style={{ aspectRatio: `${page.width} / ${page.height}` }}
				className="relative w-full overflow-hidden bg-white shadow-[0_0_0_1px_var(--ef-line),0_8px_24px_-12px_color-mix(in_srgb,var(--ef-ink)_25%,transparent)]"
			>
				{drawn ? null : <Skeleton shape="block" className="absolute inset-0 rounded-none" />}
				<canvas
					ref={attach}
					role="img"
					aria-label={`${title}, page ${number} of ${total}`}
					className="block size-full"
				/>
			</div>
			<figcaption className="text-center text-sm text-text-3 tabular-nums">
				Page {number} of {total}
			</figcaption>
		</figure>
	);
}
