"use client";

import { Delete02Icon, Download01Icon } from "@hugeicons/core-free-icons";
import type { DocBrands, DocDocument, SavedExport } from "@everyfield/contracts/documents";
import { Button, ConfirmDialog, PageHeader, Skeleton } from "@everyfield/ui/controls";
import { Tag } from "@everyfield/ui/display";
import dynamic from "next/dynamic";
import { useRef, useState } from "react";
import { ChurchBranding } from "./ChurchBranding.tsx";
import { ChurchPdf } from "./ChurchPdf.tsx";
import { SavedExports, savedExportHref } from "./SavedExports.tsx";
import { deleteChurchDocument, type ChurchActionResult } from "./actions.ts";
import { CLASS_LABEL } from "./labels.ts";
import type { ChurchView, ExportResult } from "./server.ts";

// One Church Document: the real PDF as its preview, the downloads and the saved exports. A download saves one export of
// the shown revision, then downloads that export's stored bytes (D-78); the preview stays a fresh render and saves
// nothing. Any seat downloads (D-80). An Owner or Admin can edit and delete it, and delete a saved export (D-79).
// The editor is a separate chunk, loaded only when an Owner or Admin opens the page: a Member's page never loads it.

const ChurchEditor = dynamic(() => import("./editor/ChurchEditor.tsx"), {
	ssr: false,
	loading: () => (
		<div aria-busy="true" className="flex flex-col gap-3">
			<span className="sr-only" role="status">
				Loading the editor
			</span>
			<Skeleton className="h-12 w-full rounded-card" />
			<Skeleton className="mx-auto aspect-[612/792] w-full max-w-[816px] rounded-none" />
		</div>
	),
});

const DOWNLOADS = [
	{ format: "pdf", label: "Download PDF" },
	{ format: "docx", label: "Download Word" },
	{ format: "xlsx", label: "Download Excel" },
] as const;

export function ChurchDocumentScreen({
	doc,
	editable,
	canManage,
	exports: firstExports,
}: {
	doc: ChurchView;
	/** The latest saved exports, newest first. */
	exports: SavedExport[];
	/** The stored document, only for an Owner or Admin. A Member gets null and the read-only page. */
	editable: { document: DocDocument; brands: DocBrands } | null;
	canManage: boolean;
}) {
	// A save moves the revision here, so the header and the downloads follow without a page refresh.
	const [revision, setRevision] = useState(doc.revision);
	// The branding switch makes no revision, so the preview's address also names the look: a change loads it again.
	// The file route reads the stored value; `look` only keys the preview.
	const [branded, setBranded] = useState(doc.useChurchBranding);
	const file = (format: string, at = revision) =>
		`/documents/church/${doc.id}/file?format=${format}&revision=${at}&look=${branded ? "church" : "plain"}`;
	const brands = editable?.brands;
	const brand = brands ? (branded && brands.church ? brands.church : brands.plain) : null;
	const [exports, setExports] = useState(firstExports);
	const [exporting, setExporting] = useState<string | null>(null);
	const [exportError, setExportError] = useState<string | null>(null);
	// One request key for each revision and format until a result arrives: a double click or a retry after a lost reply
	// reaches the same saved export instead of making a second one.
	const keys = useRef(new Map<string, string>());

	async function download(format: string) {
		if (exporting) return;
		const slot = `${revision}:${format}`;
		const key = keys.current.get(slot) ?? crypto.randomUUID();
		keys.current.set(slot, key);
		setExporting(format);
		setExportError(null);
		const result = await requestExport(doc.id, { revision, format, requestKey: key });
		setExporting(null);
		if (result.status === "lost") {
			setExportError(
				"The connection dropped, so nothing was downloaded. Try again; a retry will not save a second copy.",
			);
			return;
		}
		keys.current.delete(slot);
		if (result.status === "refused") {
			setExportError(result.message);
			return;
		}
		const saved = result.saved;
		setExports((list) => [saved, ...list.filter((e) => e.id !== saved.id)].slice(0, 100));
		const link = document.createElement("a");
		link.href = savedExportHref(saved);
		link.download = saved.downloadName;
		link.click();
	}

	async function remove() {
		const result: ChurchActionResult | undefined = await deleteChurchDocument(doc.id, revision);
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
						<span className="tabular-nums">Revision {revision}</span>
						{doc.page.perSheet > 1 ? <span>{doc.page.perSheet} cards on each sheet</span> : null}
					</span>
				}
				actions={
					<>
						{DOWNLOADS.filter((d) => doc.formats.includes(d.format)).map((d, i) => (
							<Button
								key={d.format}
								variant={i === 0 ? "primary" : "secondary"}
								icon={Download01Icon}
								loading={exporting === d.format}
								disabled={exporting !== null && exporting !== d.format}
								onClick={() => void download(d.format)}
							>
								{d.label}
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
			{exportError ? (
				<p
					role="alert"
					className="mb-4 rounded-md bg-magenta-100 px-4 py-3 text-md text-magenta-600 shadow-[0_0_0_1px_var(--ef-line)]"
				>
					{exportError}
				</p>
			) : null}
			<ChurchBranding
				documentId={doc.id}
				stored={branded}
				onSaved={setBranded}
				access={!brands ? "member" : brands.church ? "kit" : "no-kit"}
				className={editable ? undefined : "mx-auto w-full max-w-[880px]"}
			/>
			{editable && brand ? (
				<ChurchEditor
					docId={doc.id}
					title={doc.title}
					document={editable.document}
					brand={brand}
					revision={doc.revision}
					onRevision={setRevision}
					previewSrc={(at) => file("pdf", at)}
				/>
			) : (
				<section aria-label="Preview" className="mx-auto w-full max-w-[880px]">
					<ChurchPdf key={file("pdf")} title={doc.title} src={file("pdf")} page={doc.page} />
				</section>
			)}
			<SavedExports
				exports={exports}
				canManage={canManage}
				onDeleted={(id) => setExports((list) => list.filter((e) => e.id !== id))}
			/>
		</>
	);
}

/** Asks the server to save one export. Any failure to reach it, or an answer that is not JSON, is a lost connection. */
async function requestExport(
	documentId: string,
	body: { revision: string; format: string; requestKey: string },
): Promise<ExportResult> {
	try {
		const response = await fetch(`/documents/church/${documentId}/exports`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify(body),
		});
		if (!response.ok) return { status: "lost" };
		return (await response.json()) as ExportResult;
	} catch {
		return { status: "lost" };
	}
}
