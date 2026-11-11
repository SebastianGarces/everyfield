"use client";

import { Clock01Icon, Delete02Icon, Download01Icon, ViewIcon } from "@hugeicons/core-free-icons";
import { exportsFor, type DocBrands, type DocDocument, type SavedExport } from "@everyfield/contracts/documents";
import { Button, ConfirmDialog, PageHeader, Skeleton } from "@everyfield/ui/controls";
import { Tag } from "@everyfield/ui/display";
import dynamic from "next/dynamic";
import { useRef, useState } from "react";
import { ChurchBranding } from "./ChurchBranding.tsx";
import { ChurchPdf } from "./ChurchPdf.tsx";
import { ChurchRevisions, REVISIONS_LISTED } from "./ChurchRevisions.tsx";
import { SavedExports, savedExportHref } from "./SavedExports.tsx";
import { VersionHistory } from "./VersionHistory.tsx";
import { deleteChurchDocument, type ChurchActionResult } from "./actions.ts";
import { CLASS_LABEL, type FORMAT_LABEL } from "./labels.ts";
import type { ChurchView, ExportResult, RevisionRow, TemplateState } from "./server.ts";

// One Church Document: the real PDF as its preview, the downloads, the revisions and the saved exports. A download saves
// one export of the shown revision (or of the revision a Revisions row names), then downloads that export's stored bytes (D-78); the preview stays a fresh render and saves
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
	revisions: firstRevisions,
	revisionsTruncated,
	viewerName,
}: {
	doc: ChurchView;
	/** The newest saved revisions, newest first, at most REVISIONS_LISTED. */
	revisions: RevisionRow[];
	/** True when the document has older revisions than `revisions` holds. */
	revisionsTruncated: boolean;
	/** The latest saved exports, newest first. */
	exports: SavedExport[];
	/** The stored document, only for an Owner or Admin. A Member gets null and the read-only page. */
	editable: {
		document: DocDocument;
		brands: DocBrands;
		template: TemplateState;
		mergeValues: Record<string, string>;
	} | null;
	canManage: boolean;
	/** The viewer's own name, for the row their save adds; the server reads the same name for that revision. */
	viewerName: string | null;
}) {
	// A save moves the revision here, so the header, the downloads and the Revisions list follow without a page refresh.
	const [revision, setShownRevision] = useState(doc.revision);
	const [listed, setListed] = useState({ revisions: firstRevisions, truncated: revisionsTruncated });
	const { revisions } = listed;
	const [history, setHistory] = useState(false);
	const setRevision = (next: string) => {
		setShownRevision(next);
		// The save's own time is on the server; this one is within a second of it and a reload shows the stored one.
		const row = { number: Number(next), recordedAt: new Date().toISOString(), savedBy: viewerName };
		// The list keeps the server's bound: a save past it drops the oldest row, and the list then says it is cut short.
		setListed((now) =>
			now.revisions.some((r) => r.number === row.number)
				? now
				: {
						revisions: [row, ...now.revisions].slice(0, REVISIONS_LISTED),
						truncated: now.truncated || now.revisions.length >= REVISIONS_LISTED,
					},
		);
	};
	// Excel is offered while the body holds a budget table, so a save can add it or take it away.
	const [formats, setFormats] = useState<readonly string[]>(doc.formats);
	// Accepting template changes writes a revision the editor did not make: the editor opens again on it.
	const [current, setCurrent] = useState(() => ({
		document: editable?.document ?? null,
		revision: doc.revision,
		template: editable?.template ?? null,
		epoch: 0,
		accepted: null as string | null,
	}));
	const templateVersion = current.document?.origin?.version ?? doc.templateVersion;
	// The branding switch makes no revision, so the preview's address also names the look: a change loads it again.
	// The file route reads the stored value; `look` only keys the preview.
	const [branded, setBranded] = useState(doc.useChurchBranding);
	const file = (format: string, at = revision) =>
		`/documents/church/${doc.id}/file?format=${format}&revision=${at}&look=${branded ? "church" : "plain"}`;
	const brands = editable?.brands;
	const brand = brands ? (branded && brands.church ? brands.church : brands.plain) : null;
	const [exports, setExports] = useState(firstExports);
	// `at` is null for the header's downloads (the shown revision) and a revision number for a Revisions row, so the
	// spinner and a failure show beside the button that was clicked.
	const [exporting, setExporting] = useState<{ at: number | null; format: keyof typeof FORMAT_LABEL } | null>(null);
	const [exportError, setExportError] = useState<{ at: number | null; message: string } | null>(null);
	// One request key for each revision and format until a result arrives: a double click or a retry after a lost reply
	// reaches the same saved export instead of making a second one.
	const keys = useRef(new Map<string, string>());

	async function download(format: keyof typeof FORMAT_LABEL, at: number | null = null) {
		if (exporting) return;
		const target = at === null ? revision : String(at);
		const slot = `${target}:${format}`;
		const key = keys.current.get(slot) ?? crypto.randomUUID();
		keys.current.set(slot, key);
		setExporting({ at, format });
		setExportError(null);
		const result = await requestExport(doc.id, { revision: target, format, requestKey: key });
		setExporting(null);
		if (result.status === "lost") {
			setExportError({
				at,
				message: "The connection dropped, so nothing was downloaded. Try again; a retry will not save a second copy.",
			});
			return;
		}
		keys.current.delete(slot);
		if (result.status === "refused") {
			setExportError({ at, message: result.message });
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
							from {doc.templateName ?? doc.templateId} v{templateVersion}
						</span>
						<Tag>{CLASS_LABEL[doc.documentClass]}</Tag>
						<span className="tabular-nums">Revision {revision}</span>
						{doc.page.perSheet > 1 ? <span>{doc.page.perSheet} cards on each sheet</span> : null}
					</span>
				}
				actions={
					<>
						{DOWNLOADS.filter((d) => formats.includes(d.format)).map((d, i) => (
							<Button
								key={d.format}
								variant={i === 0 ? "primary" : "secondary"}
								icon={Download01Icon}
								loading={exporting?.at === null && exporting.format === d.format}
								disabled={exporting !== null && !(exporting.at === null && exporting.format === d.format)}
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
			{exportError?.at === null ? (
				<p
					role="alert"
					className="mb-4 rounded-md bg-magenta-100 px-4 py-3 text-md text-magenta-600 shadow-[0_0_0_1px_var(--ef-line)]"
				>
					{exportError.message}
				</p>
			) : null}
			<ChurchBranding
				documentId={doc.id}
				stored={branded}
				onSaved={setBranded}
				access={!brands ? "member" : brands.church ? "kit" : "no-kit"}
				className={editable ? undefined : "mx-auto w-full max-w-[880px]"}
			/>
			{editable && brand && current.document ? (
				<ChurchEditor
					key={current.epoch}
					docId={doc.id}
					title={doc.title}
					document={current.document}
					brand={brand}
					mergeValues={editable.mergeValues}
					revision={current.revision}
					onRevision={(next, offered) => {
						setRevision(next);
						setFormats(offered);
					}}
					revisions={revisions}
					file={file}
					template={current.template}
					templateName={doc.templateName}
					accepted={current.accepted}
					onAccepted={(document, next, taken) => {
						setRevision(next);
						// The accepted body may add or remove a budget table, and Excel follows it as on a save.
						setFormats(exportsFor(document.exports, document.body));
						setCurrent((now) => ({
							document,
							revision: next,
							template: "current",
							epoch: now.epoch + 1,
							accepted:
								taken === 1 ? "Accepted 1 change from the template." : `Accepted ${taken} changes from the template.`,
						}));
					}}
				/>
			) : (
				<div className="flex flex-col gap-3">
					<div className="flex justify-end">
						<Button
							variant="secondary"
							size="sm"
							icon={history ? ViewIcon : Clock01Icon}
							onClick={() => setHistory((open) => !open)}
						>
							{history ? "Back to the document" : "Version history"}
						</Button>
					</div>
					{history ? (
						<VersionHistory revisions={revisions} title={doc.title} current={revision} file={file} page={doc.page} />
					) : (
						<section aria-label="Preview" className="mx-auto w-full max-w-[880px]">
							<ChurchPdf key={file("pdf")} title={doc.title} src={file("pdf")} page={doc.page} />
						</section>
					)}
				</div>
			)}
			<ChurchRevisions
				revisions={revisions}
				truncated={listed.truncated}
				current={Number(revision)}
				formats={doc.formats}
				exporting={exporting && exporting.at !== null ? { at: exporting.at, format: exporting.format } : null}
				error={exportError}
				onDownload={(at, format) => void download(format, at)}
			/>
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
