"use client";

import { File02Icon, Table01Icon } from "@hugeicons/core-free-icons";
import { Skeleton } from "@everyfield/ui/controls";
import { Icon, observeIntersection } from "@everyfield/ui/foundations";
import { useState } from "react";
import type { Template } from "./model.ts";
import { closePdf, drawPage, openPdf } from "./pdf.ts";
import { bytesOf, sharedPreview } from "./preview-client.ts";
import { NativeImage } from "@/components/native";

// A library thumbnail: page 1 of the renderer's own bytes for the template, drawn when the card scrolls into view.
// Renders run one at a time and the picture is kept for the visit, by the render key of what it printed, so the
// library route stays quick and a change to the template or the church's values draws a new one. The selected
// template's preview shares the same render (sharedPreview).

const WIDTH = 200;
const pictures = new Map<string, Promise<string | null>>();
let queue: Promise<unknown> = Promise.resolve();

function picture(template: Template, key: string) {
	let known = pictures.get(key);
	if (!known) {
		known = new Promise<string | null>((resolve) => {
			queue = queue.then(async () => {
				try {
					const reply = await sharedPreview(key, template.id, "pdf", {});
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
		pictures.set(key, known);
		void known.then((url) => url === null && pictures.delete(key));
	}
	return known;
}

export function Thumbnail({
	template,
	renderKey,
	enabled,
}: {
	template: Template;
	/** What the picture prints: model.ts `renderKey` for the template as a PDF with no overrides. */
	renderKey: string;
	enabled: boolean;
}) {
	const [url, setUrl] = useState<string | null>(null);
	const [loading, setLoading] = useState(false);
	const pdf = template.formats[0] === "pdf" && template.pageSize !== null;
	const [watch] = useState(() =>
		pdf && enabled
			? observeIntersection<HTMLSpanElement>(
					(entry, stop) => {
						if (!entry.isIntersecting) return;
						stop();
						setLoading(true);
						void picture(template, renderKey).then((next) => {
							setUrl(next);
							setLoading(false);
						});
					},
					{ rootMargin: "200px" },
				)
			: undefined,
	);

	const size = template.pageSize;
	return (
		<span
			ref={watch}
			className="flex h-56 w-full items-center justify-center overflow-hidden rounded-md bg-surface-2 p-3"
			data-thumbnail={url ? "ready" : "pending"}
		>
			{url && size ? (
				<NativeImage
					src={url}
					alt={`Page 1 of ${template.name}`}
					width={size.width}
					height={size.height}
					className="h-auto max-h-full w-auto max-w-full bg-white shadow-[0_0_0_1px_var(--ef-line),0_4px_12px_-6px_color-mix(in_srgb,var(--ef-ink)_30%,transparent)]"
				/>
			) : loading ? (
				<Skeleton shape="block" className="h-full w-32 rounded-none" />
			) : (
				<Icon icon={pdf ? File02Icon : Table01Icon} size={24} className="text-text-3" />
			)}
		</span>
	);
}
