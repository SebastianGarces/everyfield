"use client";

import { File02Icon, Table01Icon } from "@hugeicons/core-free-icons";
import { Icon } from "@everyfield/ui/foundations";
import { useEffect, useRef, useState } from "react";
import type { Template } from "./model.ts";
import { closePdf, drawPage, openPdf } from "./pdf.ts";
import { bytesOf, postPreview } from "./preview-client.ts";

// A library thumbnail: page 1 of the renderer's own bytes for the template, drawn when the card scrolls into view.
// Renders run one at a time and the picture is kept for the visit, so the library route stays quick.

const WIDTH = 200;
const pictures = new Map<string, Promise<string | null>>();
let queue: Promise<unknown> = Promise.resolve();

function picture(template: Template) {
	let known = pictures.get(template.id);
	if (!known) {
		known = new Promise<string | null>((resolve) => {
			queue = queue.then(async () => {
				try {
					const reply = await postPreview(template.id, "pdf", {});
					const artifact = reply.status === "ok" ? reply.value.artifact : null;
					if (!artifact) return resolve(null);
					const doc = await openPdf(bytesOf(artifact));
					const canvas = document.createElement("canvas");
					await drawPage(doc, 1, canvas, WIDTH, 2);
					closePdf(doc);
					resolve(canvas.toDataURL("image/png"));
				} catch {
					resolve(null);
				}
			});
		});
		pictures.set(template.id, known);
		void known.then((url) => url === null && pictures.delete(template.id));
	}
	return known;
}

export function Thumbnail({ template, enabled }: { template: Template; enabled: boolean }) {
	const frame = useRef<HTMLSpanElement>(null);
	const [url, setUrl] = useState<string | null>(null);
	const pdf = template.formats[0] === "pdf" && template.pageSize !== null;

	useEffect(() => {
		const node = frame.current;
		if (!node || !pdf || !enabled) return;
		let current = true;
		const observer = new IntersectionObserver(
			([entry]) => {
				if (!entry?.isIntersecting) return;
				observer.disconnect();
				void picture(template).then((next) => current && setUrl(next));
			},
			{ rootMargin: "200px" },
		);
		observer.observe(node);
		return () => {
			current = false;
			observer.disconnect();
		};
	}, [template, pdf, enabled]);

	const size = template.pageSize;
	return (
		<span
			ref={frame}
			className="flex h-56 w-full items-center justify-center overflow-hidden rounded-md bg-surface-2 p-3"
			data-thumbnail={url ? "ready" : "pending"}
		>
			{url && size ? (
				// eslint-disable-next-line @next/next/no-img-element -- a data URL drawn from the renderer's bytes
				<img
					src={url}
					alt={`Page 1 of ${template.name}`}
					width={size.width}
					height={size.height}
					className="max-h-full max-w-full bg-white object-contain shadow-[0_0_0_1px_var(--ef-line),0_4px_12px_-6px_rgba(0,0,0,0.3)]"
				/>
			) : (
				<Icon icon={pdf ? File02Icon : Table01Icon} size={24} className="text-text-3" />
			)}
		</span>
	);
}
