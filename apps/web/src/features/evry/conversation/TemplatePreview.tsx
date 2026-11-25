"use client";

import { createRead, useRead } from "@/components/read";
import { Download01Icon } from "@hugeicons/core-free-icons";
import { Button, Skeleton, StatePanel } from "@everyfield/ui/controls";
import dynamic from "next/dynamic";
import { useMemo } from "react";
import { bytesOf, downloadBytes, RENDER_FAILED, sharedPreview } from "../../documents/preview-client.ts";
import type { TemplateFill } from "./resultView.ts";

const PdfPreview = dynamic(() => import("../../documents/PdfPreview.tsx").then((m) => m.PdfPreview), { ssr: false });

const keyOf = (fill: TemplateFill) =>
	JSON.stringify(["evry", fill.templateId, fill.format, fill.meetingId, Object.entries(fill.overrides).sort()]);
const rendered = createRead(
	(_key: string, fill: TemplateFill) =>
		sharedPreview(keyOf(fill), fill.templateId, fill.format, fill.overrides, null, fill.meetingId).then((reply) =>
			reply.status === "ok" ? reply.value.artifact : null,
		),
	{ failed: () => null },
);

export function TemplatePreview({ fill }: { fill: TemplateFill }) {
	const artifact = useRead(rendered, keyOf(fill), fill).value;
	const bytes = useMemo(() => (artifact && fill.format === "pdf" ? bytesOf(artifact) : null), [artifact, fill.format]);
	return (
		<div className="flex flex-col gap-2 px-2 pb-3">
			{artifact === undefined ? (
				<div role="status" aria-busy="true">
					<span className="sr-only">Loading preview</span>
					<Skeleton shape="block" height={200} />
				</div>
			) : artifact === null ? (
				<StatePanel tone="error" title="Preview unavailable" headingLevel="h3">
					{RENDER_FAILED}
				</StatePanel>
			) : bytes && fill.page ? (
				<PdfPreview title={fill.title} pageSize={fill.page} bytes={bytes} />
			) : (
				<>
					<p className="text-sm text-text-2">This file opens in Excel, so it has no page to show here.</p>
					<Button
						size="sm"
						variant="secondary"
						icon={Download01Icon}
						className="self-start"
						onClick={() => downloadBytes(fill.title, fill.format, artifact)}
					>
						Download a preview
					</Button>
				</>
			)}
		</div>
	);
}
