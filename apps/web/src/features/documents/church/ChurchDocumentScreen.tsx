"use client";

import { Archive02Icon, Clock01Icon, Delete02Icon, Download01Icon, ViewIcon } from "@hugeicons/core-free-icons";
import {
	CHURCH_REVISION_LIST_MAX,
	exportsFor,
	type DocBrands,
	type DocDocument,
	type ExportFormat,
	type SavedExport,
} from "@everyfield/contracts/documents";
import { Button, ConfirmDialog, PageHeader, Skeleton } from "@everyfield/ui/controls";
import { LocalTime, Tag } from "@everyfield/ui/display";
import dynamic from "next/dynamic";
import { startTransition, useActionState, useOptimistic, useRef, useState } from "react";
import { ChurchBranding } from "./ChurchBranding.tsx";
import { ChurchPdf } from "./ChurchPdf.tsx";
import { ChurchRevisions } from "./ChurchRevisions.tsx";
import { liveAssets } from "./editor/brand-assets.ts";
import { SavedExports, savedExportHref } from "./SavedExports.tsx";
import { VersionHistory } from "./VersionHistory.tsx";
import { archiveChurchDocument, deleteChurchDocument, type ChurchActionResult } from "./actions.ts";
import { CLASS_LABEL } from "./labels.ts";
import type { ChurchView, ExportResult, RevisionRow, TemplateState } from "./server.ts";

// One Church Document: the real PDF as its preview, the downloads, the revisions and the saved exports. A download saves
// one export of the shown revision (or of the revision a Revisions row names), then downloads that export's stored bytes (D-78); the preview stays a fresh render and saves
// nothing. Any seat downloads (D-80). An Owner or Admin can edit, archive and delete it, and delete a saved export (D-79).
// An archived document is read-only for every seat: no editor, no branding switch, no Archive and no export delete, while its revisions
// and saved exports stay readable and downloadable, and an Owner or Admin can still delete it (T-9).
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
	/** The newest saved revisions, newest first, at most CHURCH_REVISION_LIST_MAX. */
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
	const [record, setRecord] = useState(() => ({
		revision: doc.revision,
		formats: doc.formats as readonly ExportFormat[],
		revisions: firstRevisions,
		truncated: revisionsTruncated,
		opened: {
			document: editable?.document ?? null,
			revision: doc.revision,
			template: editable?.template ?? null,
			epoch: 0,
			accepted: null as string | null,
		},
	}));
	const { revision, formats, revisions, opened: current } = record;
	const setRevision = (next: string, offered: readonly ExportFormat[]) =>
		setRecord((now) => withRevision(now, next, offered, viewerName));
	const templateVersion = current.document?.origin?.version ?? doc.templateVersion;
	const [branded, setBranded] = useState(doc.useChurchBranding);
	const file = (format: string, at = revision) =>
		`/documents/church/${doc.id}/file?format=${format}&revision=${at}&look=${branded ? "church" : "plain"}`;
	const brands = editable?.brands;
	const brandOf = (church: boolean) => (brands ? (church && brands.church ? brands.church : brands.plain) : null);
	const brand = brandOf(branded);
	const [assets] = useState(() => liveAssets(brand?.assets ?? { logo: null, mark: null, photo: null }));
	const [exports, setExports] = useState(firstExports);
	const keys = useRef<Map<string, string> | null>(null);
	const [exportingJob, showExporting] = useOptimistic<ExportJob | null>(null);
	const [exportError, exportFile, exportPending] = useActionState(
		async (_: ExportError | null, job: ExportJob): Promise<ExportError | null> => {
			showExporting(job);
			const target = job.at === null ? revision : String(job.at);
			const slot = `${target}:${job.format}`;
			keys.current ??= new Map();
			const key = keys.current.get(slot) ?? crypto.randomUUID();
			keys.current.set(slot, key);
			const result = await requestExport(doc.id, { revision: target, format: job.format, requestKey: key });
			if (result.status === "lost")
				return {
					at: job.at,
					message: "The connection dropped, so nothing was downloaded. Try again; a retry will not save a second copy.",
				};
			keys.current.delete(slot);
			if (result.status === "refused") return { at: job.at, message: result.message };
			const saved = result.saved;
			setExports((list) => [saved, ...list.filter((e) => e.id !== saved.id)].slice(0, 100));
			const link = document.createElement("a");
			link.href = savedExportHref(saved);
			link.download = saved.downloadName;
			link.click();
			return null;
		},
		null,
	);
	const exporting = exportPending ? exportingJob : null;
	const shownError = exportPending ? null : exportError;

	function download(format: ExportFormat, at: number | null = null) {
		if (exportPending) return;
		startTransition(() => exportFile({ at, format }));
	}

	async function remove() {
		const result: ChurchActionResult | undefined = await deleteChurchDocument(doc.id, revision);
		// A success redirects to the library and returns nothing here; a refusal stays in the dialog with its reason.
		if (result?.status === "refused") throw new Error(result.message);
		if (result?.status === "lost") throw new Error("The connection dropped. Nothing was deleted.");
	}

	async function archive() {
		const result: ChurchActionResult | undefined = await archiveChurchDocument(doc.id, revision);
		// A success redirects to the library and returns nothing here; a refusal stays in the dialog with its reason.
		if (result?.status === "refused") throw new Error(result.message);
		if (result?.status === "lost") throw new Error("The connection dropped. Nothing was archived.");
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
						{doc.archived ? <Tag tone="amber">Archived</Tag> : null}
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
						{canManage && !doc.archived ? (
							<ConfirmDialog
								trigger={
									<Button variant="secondary" icon={Archive02Icon}>
										Archive
									</Button>
								}
								title={`Archive "${doc.title}"?`}
								description="The document leaves your church plant's library and can no longer be edited."
								consequences={[
									"Its revisions and saved exports stay available to everyone in your church plant.",
									"Its link still opens it, read-only.",
								]}
								confirmLabel="Archive document"
								onConfirm={archive}
							/>
						) : null}
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
			{doc.archived ? (
				<p
					role="status"
					className="mb-4 rounded-md bg-surface-raised px-4 py-3 text-md text-text-2 shadow-[0_0_0_1px_var(--ef-line)]"
				>
					Archived by {doc.archived.by ?? "a former member"} on <LocalTime iso={doc.archived.at} />. It is read-only;
					its revisions and saved exports stay available.
				</p>
			) : null}
			{shownError?.at === null ? (
				<p
					role="alert"
					className="mb-4 rounded-md bg-magenta-100 px-4 py-3 text-md text-magenta-600 shadow-[0_0_0_1px_var(--ef-line)]"
				>
					{shownError.message}
				</p>
			) : null}
			{doc.archived ? null : (
				<ChurchBranding
					documentId={doc.id}
					stored={branded}
					onSaved={(next) => {
						setBranded(next);
						const nextBrand = brandOf(next);
						if (nextBrand) assets.show(nextBrand.assets);
					}}
					access={!brands ? "member" : brands.church ? "kit" : "no-kit"}
					className={editable ? undefined : "mx-auto w-full max-w-[880px]"}
				/>
			)}
			{editable && brand && current.document ? (
				<ChurchEditor
					key={current.epoch}
					docId={doc.id}
					title={doc.title}
					document={current.document}
					brand={brand}
					assets={assets}
					mergeValues={editable.mergeValues}
					revision={current.revision}
					onRevision={setRevision}
					revisions={revisions}
					file={file}
					template={current.template}
					templateName={doc.templateName}
					accepted={current.accepted}
					onAccepted={(document, next, taken) =>
						setRecord((now) => ({
							...withRevision(now, next, exportsFor(document.exports, document.body), viewerName),
							opened: {
								document,
								revision: next,
								template: "current",
								epoch: now.opened.epoch + 1,
								accepted:
									taken === 1 ? "Accepted 1 change from the template." : `Accepted ${taken} changes from the template.`,
							},
						}))
					}
				/>
			) : (
				<ReadOnly revisions={revisions} title={doc.title} current={revision} file={file} page={doc.page} />
			)}
			<ChurchRevisions
				revisions={revisions}
				truncated={record.truncated}
				current={Number(revision)}
				exporting={exporting && exporting.at !== null ? { at: exporting.at, format: exporting.format } : null}
				error={shownError}
				onDownload={(at, format) => void download(format, at)}
			/>
			<SavedExports
				exports={exports}
				canManage={canManage && !doc.archived}
				onDeleted={(id) => setExports((list) => list.filter((e) => e.id !== id))}
			/>
		</>
	);
}

type ExportJob = { at: number | null; format: ExportFormat };
type ExportError = { at: number | null; message: string };

type Listed = { revision: string; formats: readonly ExportFormat[]; revisions: RevisionRow[]; truncated: boolean };

function withRevision<T extends Listed>(
	now: T,
	next: string,
	offered: readonly ExportFormat[],
	viewerName: string | null,
): T {
	const row = { number: Number(next), recordedAt: new Date().toISOString(), savedBy: viewerName, formats: offered };
	const listed = now.revisions.some((r) => r.number === row.number)
		? { revisions: now.revisions, truncated: now.truncated }
		: {
				revisions: [row, ...now.revisions].slice(0, CHURCH_REVISION_LIST_MAX),
				truncated: now.truncated || now.revisions.length >= CHURCH_REVISION_LIST_MAX,
			};
	return { ...now, revision: next, formats: offered, ...listed };
}

function ReadOnly({
	revisions,
	title,
	current,
	file,
	page,
}: {
	revisions: RevisionRow[];
	title: string;
	current: string;
	file: (format: string, at?: string) => string;
	page: ChurchView["page"];
}) {
	const [history, setHistory] = useState(false);
	return (
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
				<VersionHistory revisions={revisions} title={title} current={current} file={file} page={page} />
			) : (
				<section aria-label="Preview" className="mx-auto w-full max-w-[880px]">
					<ChurchPdf key={file("pdf")} title={title} src={file("pdf")} page={page} />
				</section>
			)}
		</div>
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
