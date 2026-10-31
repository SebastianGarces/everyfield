"use client";

import { BlockEditor, type BlockEditorHandle, type BlockRow } from "@/components/BlockEditor";
import { Download01Icon, File02Icon } from "@hugeicons/core-free-icons";
import type { ChurchBlock, ChurchList, ChurchPage } from "@everyfield/contracts/documents";
import { Button, Card, ConfirmDialog, EmptyState, PageHeader, Switch } from "@everyfield/ui/controls";
import { Tag } from "@everyfield/ui/display";
import { cn } from "@everyfield/ui/foundations";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useRef, useState, useTransition } from "react";
import {
	exportChurchDocument,
	readChurchRevision,
	saveChurchDocument,
	setChurchBranding,
	downloadSavedDocument,
} from "./actions.ts";
import {
	CLASS_LABEL,
	THEME_LABEL,
	bodyFromRows,
	bodyProblem,
	churchProblem,
	plantTime,
	rowsFromBody,
	sameBody,
	type ChurchClass,
} from "./church-model.ts";

// Church Documents: the list on /documents and the page of one document. The editor is the block editor the Wiki
// uses. The legal notice, the letterhead and the signature block are not body text: export prints them from the template.

const FORMAT = { pdf: "PDF", docx: "Word" } as const;
const ROW_LINK =
	"flex min-h-11 w-full cursor-pointer flex-wrap items-center justify-between gap-x-4 gap-y-2 rounded-md bg-surface-raised px-4 py-3 text-left shadow-[0_0_0_1px_var(--ef-line)] transition-shadow duration-150 hover:bg-surface focus-visible:shadow-[0_0_0_2px_var(--ef-ink),0_0_0_5px_color-mix(in_srgb,var(--ef-focus)_28%,transparent)] focus-visible:outline-none";

export function ChurchDocumentList({ list }: { list: ChurchList }) {
	return (
		<section aria-labelledby="church-documents-heading" className="mt-8 flex flex-col gap-4">
			<h2 id="church-documents-heading" className="font-title text-title-sm tracking-[-0.02em] text-ink">
				Church Documents
			</h2>
			{list.documents.length === 0 ? (
				<Card>
					<EmptyState icon={File02Icon} title="No Church Documents yet" headingLevel="h3">
						Pick a template marked Editable, then choose Create Church Document. Your church plant edits its own copy.
					</EmptyState>
				</Card>
			) : (
				<ul className="flex flex-col gap-2">
					{list.documents.map((document) => (
						<li key={document.id}>
							<Link href={`/documents/${document.id}`} className={ROW_LINK}>
								<span className="flex min-w-0 flex-col">
									<span className="font-medium text-ink">{document.title}</span>
									<span className="text-sm text-text-2">From {document.templateName}</span>
								</span>
								<span className="flex flex-wrap items-center gap-2 text-sm text-text-2">
									<Tag>{CLASS_LABEL[document.documentClass]}</Tag>
									<span>Revision {document.revision}</span>
									<span>Edited {plantTime(document.editedAt, list.timeZone)}</span>
								</span>
							</Link>
						</li>
					))}
				</ul>
			)}
		</section>
	);
}

/** The body as read-only prose, for a Member and for an older revision. */
function Prose({ body, page }: { body: readonly ChurchBlock[]; page: ChurchPage }) {
	return (
		<div className="flex flex-col gap-3 text-ink">
			{body.map((block, index) => {
				if (block.kind === "slot") {
					const label = page.slots.find((slot) => slot.id === block.slotId)?.label ?? block.slotId;
					return (
						<div key={index} className="rounded-md border border-dashed border-line bg-surface-raised p-4">
							<p className="flex flex-wrap items-center gap-2 text-sm font-medium">
								{label} <Tag tone="amber">Doctrinal slot</Tag>
							</p>
							{block.text.trim() ? (
								<p className="mt-2 whitespace-pre-wrap">{block.text}</p>
							) : (
								<p className="mt-2 text-sm text-text-2">Blank. Your church or its sending network adds this text.</p>
							)}
						</div>
					);
				}
				if (block.kind === "heading")
					return (
						<h3 key={index} className="font-title text-title-sm tracking-[-0.02em]">
							{block.text}
						</h3>
					);
				if (block.kind === "subheading")
					return (
						<h4 key={index} className="text-base font-semibold">
							{block.text}
						</h4>
					);
				if (block.kind === "quote")
					return (
						<blockquote key={index} className="border-l-2 border-line pl-4 text-text-2">
							{block.text}
						</blockquote>
					);
				if (block.kind === "bulleted_list")
					return (
						<ul key={index} className="list-disc pl-6">
							{block.items.map((item, at) => (
								<li key={at}>{item}</li>
							))}
						</ul>
					);
				if (block.kind === "numbered_list")
					return (
						<ol key={index} className="list-decimal pl-6">
							{block.items.map((item, at) => (
								<li key={at}>{item}</li>
							))}
						</ol>
					);
				return (
					<p key={index} className="whitespace-pre-wrap">
						{block.text}
					</p>
				);
			})}
		</div>
	);
}

type Opened = { number: number; body: ChurchBlock[] };

export function ChurchDocumentView({ initial, canEdit }: { initial: ChurchPage; canEdit: boolean }) {
	const router = useRouter();
	const [page, setPage] = useState(initial);
	const [rows, setRows] = useState<BlockRow[]>(() => rowsFromBody(initial.document.body, initial.slots));
	const [saved, setSaved] = useState<readonly ChurchBlock[]>(initial.document.body);
	const [branding, setBranding] = useState(initial.document.useChurchBranding);
	const [opened, setOpened] = useState<Opened | null>(null);
	const [saveNote, setSaveNote] = useState<{ tone: "ok" | "error"; text: string; conflict?: boolean } | null>(null);
	const [fieldError, setFieldError] = useState<string | null>(null);
	const [brandNote, setBrandNote] = useState<string | null>(null);
	const [exportNote, setExportNote] = useState<string | null>(null);
	const [exporting, setExporting] = useState<string | null>(null);
	const [downloadLink, setDownloadLink] = useState<{ id: string; url: string } | null>(null);
	const [leaveTo, setLeaveTo] = useState<string | null>(null);
	const [saving, startSave] = useTransition();
	const [openingRevision, setOpeningRevision] = useState<number | null>(null);
	const editor = useRef<BlockEditorHandle>(null);
	const exportKeys = useRef(new Map<string, string>());
	const bypass = useRef(false);

	const doc = page.document;
	const editable = canEdit && !doc.archived;
	const dirty = editable && !sameBody(rows, saved);
	const current = Number(doc.revision);
	const onScreen = opened?.number ?? current;
	const legal = doc.documentClass === "formal/legal";

	// Leaving with unsaved edits asks first: a tab close or reload through the browser, a link through the dialog.
	useEffect(() => {
		if (!dirty) return;
		const beforeUnload = (event: BeforeUnloadEvent) => {
			if (!bypass.current) event.preventDefault();
		};
		const onClick = (event: MouseEvent) => {
			if (bypass.current || event.defaultPrevented || event.button !== 0) return;
			if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
			const anchor = (event.target as Element | null)?.closest?.("a[href]") as HTMLAnchorElement | null;
			if (!anchor || anchor.target === "_blank" || anchor.hasAttribute("download")) return;
			const url = new URL(anchor.href, window.location.href);
			if (url.origin !== window.location.origin || url.href === window.location.href) return;
			event.preventDefault();
			event.stopPropagation();
			setLeaveTo(url.pathname + url.search);
		};
		window.addEventListener("beforeunload", beforeUnload);
		document.addEventListener("click", onClick, true);
		return () => {
			window.removeEventListener("beforeunload", beforeUnload);
			document.removeEventListener("click", onClick, true);
		};
	}, [dirty]);

	function save() {
		if (!editable || !dirty) return;
		const problem = bodyProblem(rows);
		if (problem) {
			setFieldError(problem);
			setSaveNote(null);
			return;
		}
		setFieldError(null);
		const body = bodyFromRows(rows);
		startSave(async () => {
			const result = await saveChurchDocument(doc.id, doc.revision, body);
			if (result.status !== "ok") {
				setSaveNote({
					tone: "error",
					text: churchProblem(
						result.status === "refused" ? result : "lost",
						"This did not save. Your edits are still here. Try again.",
						page.slots,
					),
					conflict: result.status === "refused" && result.code === "conflict",
				});
				return;
			}
			setPage(result.value);
			setSaved(result.value.document.body);
			setRows(rowsFromBody(result.value.document.body, result.value.slots));
			setOpened(null);
			setSaveNote({ tone: "ok", text: `Saved as revision ${result.value.document.revision}.` });
		});
	}

	function reload() {
		// A newer revision exists: load the page as it is now. The person chose to drop the unsaved edits.
		bypass.current = true;
		window.location.reload();
	}

	async function open(number: number) {
		if (number === current) {
			setOpened(null);
			return;
		}
		setOpeningRevision(number);
		const result = await readChurchRevision(doc.id, number);
		setOpeningRevision(null);
		if (result.status !== "ok") {
			setExportNote("That revision did not open. Try again.");
			return;
		}
		setOpened({ number: result.value.number, body: result.value.body });
	}

	async function toggleBranding(next: boolean) {
		const before = branding;
		setBranding(next);
		setBrandNote(null);
		const result = await setChurchBranding(doc.id, next);
		if (result.status !== "ok") {
			setBranding(before);
			setBrandNote("The setting did not change. Try again.");
			return;
		}
		setBranding(result.value.useChurchBranding);
	}

	async function makeExport(format: "pdf" | "docx") {
		const slot = `${onScreen}:${format}`;
		const key = exportKeys.current.get(slot) ?? crypto.randomUUID();
		exportKeys.current.set(slot, key);
		setExporting(slot);
		setExportNote(null);
		setDownloadLink(null);
		const result = await exportChurchDocument(doc.id, onScreen, format, key);
		setExporting(null);
		if (result.status !== "ok") {
			exportKeys.current.delete(slot);
			setExportNote(
				churchProblem(
					result.status === "refused" ? result : "lost",
					"The file did not download. Nothing was saved. Try again.",
				),
			);
			return;
		}
		exportKeys.current.delete(slot);
		// The new export appears at the top of the saved exports. A reader's own edits stay as they are.
		setPage((before) => ({ ...before, exports: result.value.page.exports }));
		startDownload(result.value.url, result.value.page.exports[0]?.id ?? "");
	}

	/** Open the signed link. A browser that blocks the new tab leaves the link below the buttons. */
	function startDownload(url: string, id: string) {
		const opened = window.open(url, "_blank", "noopener,noreferrer");
		setDownloadLink(opened ? null : { id, url });
	}

	async function downloadAgain(id: string) {
		setExportNote(null);
		const result = await downloadSavedDocument(id);
		if (result.status !== "ok") {
			setExportNote("This download did not start. Try again.");
			return;
		}
		startDownload(result.value.url, id);
	}

	const exportsNeutral = !branding || !page.hasBrandKit;

	return (
		<>
			<PageHeader
				title={doc.title}
				breadcrumb={[{ label: "Documents", href: "/documents" }, { label: doc.title }]}
				subtitle={
					<span className="flex flex-wrap items-center gap-2">
						<Tag>{CLASS_LABEL[doc.documentClass as ChurchClass]}</Tag>
						<span>From {page.templateName}</span>
						<span>Revision {doc.revision}</span>
					</span>
				}
			/>
			<div className="grid items-start gap-5 lg:grid-cols-[minmax(0,1fr)_360px]">
				<div className="flex min-w-0 flex-col gap-4">
					{legal ? (
						<div
							role="note"
							className="rounded-md bg-amber-100 px-4 py-3 text-sm text-ink shadow-[0_0_0_1px_var(--ef-line)]"
						>
							<p className="font-semibold">Template, not legal advice</p>
							<p className="mt-1 text-text-2">
								This notice prints above the text on every export. You cannot edit or remove it.
							</p>
						</div>
					) : null}
					<p className="text-sm text-text-2">
						The letterhead and the signature block print from the template. They are not part of the text below.
					</p>
					{opened ? (
						<Card className="gap-4">
							<div className="flex flex-wrap items-center justify-between gap-2">
								<p className="text-sm font-medium text-ink">
									Revision {opened.number} (read only)
									{opened.number === current ? "" : ". A newer revision exists."}
								</p>
								<Button variant="secondary" onClick={() => setOpened(null)}>
									Back to revision {doc.revision}
								</Button>
							</div>
							<Prose body={opened.body} page={page} />
						</Card>
					) : editable ? (
						<div className="rounded-card bg-surface px-6 py-8 shadow-card max-app-sm:px-4">
							<form
								className="mx-auto flex max-w-[700px] flex-col gap-8"
								aria-label="Document text"
								onSubmit={(event) => event.preventDefault()}
							>
								<BlockEditor
									ref={editor}
									rows={rows}
									onChange={(next) => {
										setRows(next);
										setFieldError(null);
										setSaveNote(null);
									}}
									disabled={saving}
								/>
								<div className="flex flex-col gap-3 border-t border-line pt-3">
									{fieldError ? (
										<p role="alert" className="text-sm font-medium text-magenta-600">
											{fieldError}
										</p>
									) : null}
									<div role="status" className="min-h-6 text-sm">
										{saveNote ? (
											<p className={saveNote.tone === "error" ? "font-medium text-magenta-600" : "text-text-2"}>
												{saveNote.text}
											</p>
										) : null}
									</div>
									<div className="flex flex-wrap gap-3">
										<Button type="button" variant="primary" loading={saving} disabled={!dirty} onClick={save}>
											Save
										</Button>
										{saveNote?.conflict ? (
											<Button type="button" variant="secondary" onClick={reload}>
												Reload the newer version
											</Button>
										) : null}
									</div>
									{dirty ? <p className="text-sm text-text-2">You have unsaved edits.</p> : null}
								</div>
							</form>
						</div>
					) : (
						<Card className="gap-4">
							<Prose body={doc.body} page={page} />
							{canEdit ? null : (
								<p className="text-sm text-text-2">Only an Owner or Admin of the church plant edits this document.</p>
							)}
						</Card>
					)}
				</div>
				<aside className="flex flex-col gap-4 lg:sticky lg:top-24">
					<Card className="gap-3">
						<h2 className="font-title text-title-sm tracking-[-0.02em] text-ink">Branding</h2>
						{canEdit ? (
							<Switch
								label="Use church branding"
								description="Exports use your church plant's colors, letterhead and logo."
								checked={branding}
								onCheckedChange={(next) => void toggleBranding(next)}
							/>
						) : (
							<p className="text-sm text-text-2">Use church branding: {branding ? "On" : "Off"}</p>
						)}
						{exportsNeutral ? (
							<p className="text-sm text-text-2">
								{page.hasBrandKit
									? "Church branding is off, so exports use the Everyfield-neutral theme."
									: "Your church plant has no brand kit yet, so exports use the Everyfield-neutral theme."}
							</p>
						) : null}
						{canEdit && exportsNeutral ? (
							<Link href="/settings/brand" className="w-fit cursor-pointer text-sm font-medium text-ink underline">
								Open the brand kit in Settings
							</Link>
						) : null}
						{brandNote ? (
							<p role="status" className="text-sm font-medium text-magenta-600">
								{brandNote}
							</p>
						) : null}
					</Card>
					<Card className="gap-3">
						<h2 className="font-title text-title-sm tracking-[-0.02em] text-ink">Export revision {onScreen}</h2>
						<div className="flex flex-wrap gap-2">
							{(["pdf", "docx"] as const).map((format) => (
								<Button
									key={format}
									variant="secondary"
									icon={Download01Icon}
									loading={exporting === `${onScreen}:${format}`}
									disabled={exporting !== null}
									onClick={() => void makeExport(format)}
								>
									{FORMAT[format]}
								</Button>
							))}
						</div>
						{dirty && !opened ? (
							<p className="text-sm text-text-2">Exports use the saved revision, not your unsaved edits.</p>
						) : null}
						{exportNote ? (
							<p role="status" className="text-sm font-medium text-magenta-600">
								{exportNote}
							</p>
						) : null}
						{downloadLink ? (
							<a
								href={downloadLink.url}
								target="_blank"
								rel="noopener noreferrer"
								className="w-fit cursor-pointer text-sm text-ink underline"
							>
								Open the download
							</a>
						) : null}
					</Card>
					<Card className="gap-3">
						<h2 className="font-title text-title-sm tracking-[-0.02em] text-ink">Revision history</h2>
						<ul className="flex flex-col gap-2">
							{page.revisions.map((revision) => {
								const shown = revision.number === onScreen;
								return (
									<li
										key={revision.id}
										className={cn(
											"flex flex-wrap items-center justify-between gap-2 rounded-md bg-surface px-3 py-2",
											shown && "shadow-[0_0_0_2px_var(--ef-ink)]",
										)}
									>
										<div className="min-w-0 text-sm">
											<p className="flex flex-wrap items-center gap-2 font-medium text-ink">
												Revision {revision.number}
												{revision.number === current ? <Tag tone="green">Current</Tag> : null}
											</p>
											<p className="text-text-2">
												{revision.authorName ?? "Account removed"} · {plantTime(revision.recordedAt, page.timeZone)}
											</p>
										</div>
										<Button
											variant="ghost"
											loading={openingRevision === revision.number}
											aria-label={`Open revision ${revision.number}`}
											disabled={shown && (opened ? opened.number === revision.number : true)}
											onClick={() => void open(revision.number)}
										>
											Open
										</Button>
									</li>
								);
							})}
						</ul>
					</Card>
					<Card className="gap-3">
						<h2 className="font-title text-title-sm tracking-[-0.02em] text-ink">Saved exports</h2>
						{page.exports.length === 0 ? (
							<p className="text-sm text-text-2">Nothing exported yet. Each export is saved here.</p>
						) : (
							<ul className="flex flex-col gap-2">
								{page.exports.map((item) => (
									<li
										key={item.id}
										className="flex flex-wrap items-center justify-between gap-2 rounded-md bg-surface px-3 py-2"
									>
										<div className="min-w-0 text-sm">
											<p className="flex flex-wrap items-center gap-2 font-medium text-ink">
												{FORMAT[item.format]} · Revision {item.revision}
											</p>
											<p className="text-text-2">
												{THEME_LABEL[item.theme]} · {item.creatorName ?? "Account removed"} ·{" "}
												{plantTime(item.generatedAt, page.timeZone)}
											</p>
										</div>
										<Button
											variant="secondary"
											aria-label={`Download again: ${FORMAT[item.format]}, revision ${item.revision}`}
											onClick={() => void downloadAgain(item.id)}
										>
											Download again
										</Button>
									</li>
								))}
							</ul>
						)}
					</Card>
				</aside>
			</div>
			<ConfirmDialog
				open={leaveTo !== null}
				onOpenChange={(open) => {
					if (!open) setLeaveTo(null);
				}}
				title="Leave without saving?"
				description="Your edits to this document are not saved."
				confirmLabel="Leave without saving"
				tone="danger"
				onConfirm={() => {
					const target = leaveTo;
					setLeaveTo(null);
					if (!target) return;
					bypass.current = true;
					router.push(target);
				}}
			/>
		</>
	);
}
