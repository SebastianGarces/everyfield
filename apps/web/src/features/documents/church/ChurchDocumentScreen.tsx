"use client";

import { Delete02Icon, Download01Icon } from "@hugeicons/core-free-icons";
import { Button, ConfirmDialog, PageHeader } from "@everyfield/ui/controls";
import { Tag } from "@everyfield/ui/display";
import { ChurchPdf } from "./ChurchPdf.tsx";
import { deleteChurchDocument, type ChurchActionResult } from "./actions.ts";
import { CLASS_LABEL } from "./labels.ts";
import type { ChurchView } from "./server.ts";

// One Church Document: the real PDF as its preview, and the downloads. The preview and every download read the same
// file route for the same revision, so the preview is the file Download gives. An Owner or Admin can delete it.

const DOWNLOADS = [
	{ format: "pdf", label: "Download PDF" },
	{ format: "docx", label: "Download Word" },
	{ format: "xlsx", label: "Download Excel" },
] as const;

export function ChurchDocumentScreen({ doc, canManage }: { doc: ChurchView; canManage: boolean }) {
	const file = (format: string, download: boolean) =>
		`/documents/church/${doc.id}/file?format=${format}&revision=${doc.revision}${download ? "&download=1" : ""}`;

	async function remove() {
		const result: ChurchActionResult | undefined = await deleteChurchDocument(doc.id, doc.revision);
		// A success redirects to the library and returns nothing here; a refusal stays in the dialog with its reason.
		if (result?.status === "refused") throw new Error(result.message);
		if (result?.status === "lost") throw new Error("The connection dropped. Nothing was deleted.");
	}

	return (
		<>
			<PageHeader
				breadcrumb={[
					{ label: "Documents", href: "/documents" },
					{ label: "Church documents", href: "/documents/church" },
					{ label: doc.title },
				]}
				title={doc.title}
				subtitle={
					<span className="flex flex-wrap items-center gap-x-3 gap-y-2">
						<span>
							from {doc.templateId} v{doc.templateVersion}
						</span>
						<Tag>{CLASS_LABEL[doc.documentClass]}</Tag>
						<span className="tabular-nums">Revision {doc.revision}</span>
						{doc.perSheet > 1 ? <span>{doc.perSheet} cards on each sheet</span> : null}
					</span>
				}
				actions={
					<>
						{DOWNLOADS.filter((d) => doc.formats.includes(d.format)).map((d, i) => (
							<Button key={d.format} variant={i === 0 ? "primary" : "secondary"} icon={Download01Icon} asChild>
								<a href={file(d.format, true)} download>
									{d.label}
								</a>
							</Button>
						))}
						{canManage ? (
							<ConfirmDialog
								trigger={
									<Button variant="secondary" icon={Delete02Icon}>
										Delete
									</Button>
								}
								tone="danger"
								title={`Delete "${doc.title}"?`}
								description="The document leaves your church plant's library."
								consequences={[
									"Members can no longer open it or download it.",
									"The template stays in Everyfield, so you can make a new copy later.",
								]}
								confirmLabel="Delete document"
								onConfirm={remove}
							/>
						) : null}
					</>
				}
			/>
			<section aria-label="Preview" className="mx-auto w-full max-w-[880px]">
				<ChurchPdf key={file("pdf", false)} title={doc.title} src={file("pdf", false)} page={doc.page} />
			</section>
		</>
	);
}
