"use client";

import { Add01Icon, File02Icon } from "@hugeicons/core-free-icons";
import { Button, Card, ConfirmDialog, EmptyState, Field, Input, Skeleton, Textarea } from "@everyfield/ui/controls";
import { Tag } from "@everyfield/ui/display";
import { cn } from "@everyfield/ui/foundations";
import { useEffect, useRef, useState, useTransition, type RefObject } from "react";
import {
	archiveOwnedDocument,
	designateOwnedDocument,
	importOwnedDocument,
	loadWrittenDocuments,
	saveOwnedDocument,
} from "./actions.ts";
import { documentProblem, type OwnedView } from "./model.ts";

// Written documents for the account or the church. A church copy of an account document needs the revision id.
// The owned-document result only has the revision token, so this screen does not offer that command.

type Scope = "church" | "account";
type Kind = OwnedView["kind"];

type Draft = {
	id: string | null;
	title: string;
	body: string;
	revision: string;
	kind: Kind | null;
	archived: boolean;
};

const BLANK: Draft = { id: null, title: "", body: "", revision: "0", kind: null, archived: false };

const KIND_LABEL: Record<Kind, string | null> = {
	native: null,
	core_values: "Core values",
	launch_summary: "Launch summary",
};

const ROW =
	"flex min-h-11 w-full cursor-pointer flex-wrap items-center justify-between gap-2 rounded-md bg-surface-raised px-4 py-3 text-left transition-shadow duration-150 hover:bg-surface focus-visible:shadow-[0_0_0_2px_var(--ef-ink),0_0_0_5px_color-mix(in_srgb,var(--ef-focus)_28%,transparent)] focus-visible:outline-none";

function same(draft: Draft, source: OwnedView | null) {
	if (!source) return draft.title.trim() === "" && draft.body.trim() === "";
	return draft.title === source.title && draft.body === source.body;
}

function fileFormat(file: File): "text" | "docx" | null {
	const name = file.name.toLowerCase();
	if (name.endsWith(".docx")) return "docx";
	if (name.endsWith(".doc")) return null;
	if (name.endsWith(".txt") || file.type === "text/plain") return "text";
	return null;
}

async function encodeFile(file: File) {
	const bytes = new Uint8Array(await file.arrayBuffer());
	let binary = "";
	const chunk = 0x8000;
	for (let index = 0; index < bytes.length; index += chunk) {
		binary += String.fromCharCode(...bytes.subarray(index, index + chunk));
	}
	return btoa(binary);
}

function draftFrom(document: OwnedView): Draft {
	return {
		id: document.id,
		title: document.title,
		body: document.body,
		revision: document.revision,
		kind: document.kind,
		archived: document.archived,
	};
}

export function NativeDocuments({
	written,
	canEdit,
	canStore,
}: {
	written: Scope;
	canEdit: boolean;
	canStore: boolean;
}) {
	const [documents, setDocuments] = useState<OwnedView[] | null>(null);
	const [evidence, setEvidence] = useState<string | null>(null);
	const [failed, setFailed] = useState(false);
	const [attempt, setAttempt] = useState(0);
	const [draft, setDraft] = useState<Draft | null>(null);
	const [fieldError, setFieldError] = useState<{ title?: string; body?: string }>({});
	const [note, setNote] = useState<string | null>(null);
	const [conflict, setConflict] = useState(false);
	const [leaveTo, setLeaveTo] = useState<OwnedView | "new" | null>(null);
	const [archiveOpen, setArchiveOpen] = useState(false);
	const [pending, start] = useTransition();
	const reopen = useRef<string | null>(null);
	const titleRef = useRef<HTMLInputElement>(null);
	const fileRef = useRef<HTMLInputElement>(null);
	const importKey = useRef<string | null>(null);
	const heading = written === "church" ? "Written for your church" : "Your documents";
	const evidenceLabel = written === "church" ? "Core values for your church" : "Your core values";

	useEffect(() => {
		let cancel = false;
		loadWrittenDocuments().then((result) => {
			if (cancel) return;
			if (result.status !== "ok") {
				setDocuments([]);
				setEvidence(null);
				setFailed(true);
				return;
			}
			setDocuments(result.value.documents);
			setEvidence(result.value.evidence);
			setFailed(false);
			const id = reopen.current;
			reopen.current = null;
			if (!id) return;
			const found = result.value.documents.find((item) => item.id === id);
			setDraft(found ? draftFrom(found) : null);
			setConflict(false);
		});
		return () => {
			cancel = true;
		};
	}, [attempt]);

	const source = documents?.find((item) => item.id === draft?.id) ?? null;
	const dirty = draft ? !same(draft, source) : false;
	const readOnly = !canEdit || Boolean(draft?.archived);

	function apply(next: Draft) {
		setDraft(next);
		setFieldError({});
		setNote(null);
		setConflict(false);
		if (!next.id) queueMicrotask(() => titleRef.current?.focus());
	}

	function ask(next: OwnedView | "new") {
		if (next !== "new" && next.id === draft?.id) return;
		if (draft && dirty) {
			setLeaveTo(next);
			return;
		}
		apply(next === "new" ? BLANK : draftFrom(next));
	}

	async function commit(saved: OwnedView) {
		setDraft(draftFrom(saved));
		setFieldError({});
		setConflict(false);
		const listed = await loadWrittenDocuments();
		if (listed.status !== "ok") {
			setDocuments((current) => {
				const list = current ?? [];
				const index = list.findIndex((item) => item.id === saved.id);
				if (index === -1) return [saved, ...list];
				const copy = list.slice();
				copy[index] = saved;
				return copy;
			});
			return;
		}
		setDocuments(listed.value.documents);
		setEvidence(listed.value.evidence);
	}

	function save() {
		if (!draft || readOnly) return;
		const title = draft.title.trim();
		const body = draft.body;
		const nextError: { title?: string; body?: string } = {};
		if (!title) nextError.title = "Enter a title.";
		if (!body.trim()) nextError.body = "Enter the document text.";
		setFieldError(nextError);
		if (nextError.title || nextError.body) return;
		const payload = draft.id
			? { title, body, documentId: draft.id, expectedRevision: draft.revision }
			: { title, body, expectedRevision: "0" };
		start(async () => {
			const result = await saveOwnedDocument(payload);
			if (result.status !== "ok") {
				setConflict(result.status === "refused" && result.code === "conflict");
				setNote(
					documentProblem(
						result.status === "refused" ? result.code : "lost",
						result.status === "refused" ? result.problem : undefined,
						"This document did not save. Try again.",
					),
				);
				return;
			}
			await commit(result.value);
			setNote("Document saved.");
		});
	}

	function designate() {
		if (!draft?.id || readOnly || dirty || draft.kind !== "native") return;
		start(async () => {
			const result = await designateOwnedDocument(draft.id as string, draft.revision);
			if (result.status !== "ok") {
				setConflict(result.status === "refused" && result.code === "conflict");
				setNote(
					documentProblem(
						result.status === "refused" ? result.code : "lost",
						result.status === "refused" ? result.problem : undefined,
						"Core values were not updated. Try again.",
					),
				);
				return;
			}
			await commit(result.value);
			setNote("This document is the current core values.");
		});
	}

	async function confirmArchive() {
		if (!draft?.id) return;
		const result = await archiveOwnedDocument(draft.id, draft.revision);
		if (result.status !== "ok") {
			setConflict(result.status === "refused" && result.code === "conflict");
			throw new Error(
				documentProblem(
					result.status === "refused" ? result.code : "lost",
					result.status === "refused" ? result.problem : undefined,
					"This document was not archived. Try again.",
				),
			);
		}
		await commit(result.value);
		setNote("Document archived. The text stays in the list. It is no longer current.");
	}

	function importFile(file: File) {
		if (!draft || readOnly) return;
		const format = fileFormat(file);
		if (!format) {
			setNote("Use a .txt or .docx file. Legacy Word documents are not accepted.");
			return;
		}
		if (file.size === 0) {
			setNote("The file is empty.");
			return;
		}
		if (file.size > 10 * 1024 * 1024) {
			setNote("The file must be 10 MB or smaller.");
			return;
		}
		const title = draft.title.trim() || file.name.replace(/\.(txt|docx)$/i, "").slice(0, 200) || "Imported document";
		const key = importKey.current ?? crypto.randomUUID();
		importKey.current = key;
		start(async () => {
			let bytes: string;
			try {
				bytes = await encodeFile(file);
			} catch {
				setNote("This file did not import. Try a .txt or .docx file.");
				return;
			}
			const payload = draft.id
				? { title, format, bytes, documentId: draft.id, expectedRevision: draft.revision, requestKey: key }
				: { title, format, bytes, expectedRevision: "0", requestKey: key };
			const result = await importOwnedDocument(payload);
			if (result.status !== "ok") {
				if (result.status === "refused" && result.code === "conflict") importKey.current = null;
				setConflict(result.status === "refused" && result.code === "conflict");
				setNote(
					documentProblem(
						result.status === "refused" ? result.code : "lost",
						result.status === "refused" ? result.problem : undefined,
						"This file did not import. Try a .txt or .docx file.",
					),
				);
				return;
			}
			importKey.current = null;
			await commit(result.value);
			setNote("Imported text is saved in this document.");
		});
	}

	function reload() {
		reopen.current = draft?.id ?? null;
		setAttempt((current) => current + 1);
		setDocuments(null);
		setNote(null);
		setConflict(false);
	}

	return (
		<section aria-labelledby="written-heading" className="mt-8 flex flex-col gap-4">
			<div className="flex flex-wrap items-center justify-between gap-3">
				<h2 id="written-heading" className="font-title text-title-sm tracking-[-0.02em] text-ink">
					{heading}
				</h2>
				{canEdit ? (
					<Button variant="secondary" icon={Add01Icon} onClick={() => ask("new")}>
						New document
					</Button>
				) : null}
			</div>
			{documents === null ? (
				<div aria-busy="true" className="flex flex-col gap-2">
					<span className="sr-only" role="status">
						Loading written documents
					</span>
					<Skeleton className="h-14 w-full rounded-md" />
					<Skeleton className="h-40 w-full rounded-card" />
				</div>
			) : failed ? (
				<Card>
					<EmptyState
						icon={File02Icon}
						title="Written documents did not load"
						headingLevel="h3"
						action={
							<Button variant="secondary" onClick={reload}>
								Try again
							</Button>
						}
					>
						This is a loading problem. Nothing was changed.
					</EmptyState>
				</Card>
			) : (
				<div className="grid items-start gap-5 lg:grid-cols-[minmax(0,1fr)_360px]">
					<div className="flex min-w-0 flex-col gap-4">
						{evidence ? (
							<div className="rounded-md bg-surface-raised px-4 py-3 shadow-[0_0_0_1px_var(--ef-line)]">
								<h3 className="text-sm font-medium text-ink">{evidenceLabel}</h3>
								<div className="mt-2 max-h-40 overflow-y-auto whitespace-pre-wrap text-sm text-text-2">{evidence}</div>
							</div>
						) : null}
						{documents.length === 0 ? (
							<Card>
								<EmptyState
									icon={File02Icon}
									title="No written documents yet"
									headingLevel="h3"
									action={
										canEdit ? (
											<Button variant="secondary" icon={Add01Icon} onClick={() => ask("new")}>
												New document
											</Button>
										) : undefined
									}
								>
									{canEdit
										? "Write the text here, or import a text or Word file."
										: "Documents written for this church show up here."}
								</EmptyState>
							</Card>
						) : (
							<ul className="flex max-h-[32rem] flex-col gap-2 overflow-y-auto">
								{documents.map((document) => {
									const pressed = draft?.id === document.id;
									const label = KIND_LABEL[document.kind];
									return (
										<li key={document.id}>
											<button
												type="button"
												aria-pressed={pressed}
												onClick={() => ask(document)}
												className={cn(
													ROW,
													pressed ? "shadow-[0_0_0_2px_var(--ef-ink)]" : "shadow-[0_0_0_1px_var(--ef-line)]",
												)}
											>
												<span className="min-w-0 font-medium text-ink">{document.title}</span>
												<span className="flex flex-wrap gap-1.5">
													{label ? <Tag>{label}</Tag> : null}
													{document.archived ? <Tag>Archived</Tag> : null}
												</span>
											</button>
										</li>
									);
								})}
							</ul>
						)}
					</div>
					<aside className="lg:sticky lg:top-24">
						<Card className="gap-4">
							{draft ? (
								<Editor
									draft={draft}
									readOnly={readOnly}
									canEdit={canEdit}
									canStore={canStore}
									pending={pending}
									dirty={dirty}
									fieldError={fieldError}
									note={note}
									conflict={conflict}
									titleRef={titleRef}
									fileRef={fileRef}
									onTitle={(title) => {
										setDraft({ ...draft, title });
										setNote(null);
									}}
									onBody={(body) => {
										setDraft({ ...draft, body });
										setNote(null);
									}}
									onSave={save}
									onDesignate={designate}
									onArchive={() => setArchiveOpen(true)}
									onImport={(file) => importFile(file)}
									onReload={reload}
								/>
							) : (
								<EmptyState icon={File02Icon} title="Select a document" headingLevel="h2">
									{canEdit ? "Choose a document, or write a new one." : "Choose a document to read it."}
								</EmptyState>
							)}
						</Card>
					</aside>
				</div>
			)}
			<ConfirmDialog
				open={leaveTo !== null}
				onOpenChange={(open) => {
					if (!open) setLeaveTo(null);
				}}
				title="Leave without saving?"
				description="The text you entered is not saved."
				confirmLabel="Leave without saving"
				tone="danger"
				onConfirm={() => {
					if (leaveTo === null) return;
					apply(leaveTo === "new" ? BLANK : draftFrom(leaveTo));
					setLeaveTo(null);
				}}
			/>
			<ConfirmDialog
				open={archiveOpen}
				onOpenChange={setArchiveOpen}
				title="Archive this document?"
				description={
					dirty
						? "The text stays in the list. It is no longer current. Unsaved text in the editor is discarded."
						: "The text stays in the list. It is no longer current."
				}
				confirmLabel="Archive document"
				tone="danger"
				onConfirm={confirmArchive}
			/>
		</section>
	);
}

function Editor({
	draft,
	readOnly,
	canEdit,
	canStore,
	pending,
	dirty,
	fieldError,
	note,
	conflict,
	titleRef,
	fileRef,
	onTitle,
	onBody,
	onSave,
	onDesignate,
	onArchive,
	onImport,
	onReload,
}: {
	draft: Draft;
	readOnly: boolean;
	canEdit: boolean;
	canStore: boolean;
	pending: boolean;
	dirty: boolean;
	fieldError: { title?: string; body?: string };
	note: string | null;
	conflict: boolean;
	titleRef: RefObject<HTMLInputElement | null>;
	fileRef: RefObject<HTMLInputElement | null>;
	onTitle: (title: string) => void;
	onBody: (body: string) => void;
	onSave: () => void;
	onDesignate: () => void;
	onArchive: () => void;
	onImport: (file: File) => void;
	onReload: () => void;
}) {
	const label = draft.kind ? KIND_LABEL[draft.kind] : null;
	return (
		<div className="flex flex-col gap-4">
			<div className="flex flex-wrap gap-1.5">
				{label ? <Tag>{label}</Tag> : null}
				{draft.archived ? <Tag>Archived</Tag> : null}
			</div>
			{readOnly ? (
				<>
					<h3 className="font-title text-title-sm leading-[1.2] tracking-[-0.02em] text-ink text-balance">
						{draft.title}
					</h3>
					<div className="max-h-80 overflow-y-auto whitespace-pre-wrap text-sm text-text-2">{draft.body}</div>
					{draft.archived ? (
						<p className="text-sm text-text-2">This document is archived. The text stays here. It is not current.</p>
					) : null}
				</>
			) : (
				<>
					<Field label="Title" error={fieldError.title}>
						<Input
							ref={titleRef}
							value={draft.title}
							maxLength={200}
							onChange={(event) => onTitle(event.target.value)}
						/>
					</Field>
					<Field label="Text" error={fieldError.body}>
						<Textarea
							value={draft.body}
							maxLength={2_000_000}
							className="min-h-48"
							onChange={(event) => onBody(event.target.value)}
						/>
					</Field>
					<div className="flex flex-wrap gap-2">
						<Button variant="primary" loading={pending} onClick={onSave}>
							Save document
						</Button>
						<Button variant="secondary" disabled={!canStore || pending} onClick={() => fileRef.current?.click()}>
							Import text or Word
						</Button>
						<input
							ref={fileRef}
							type="file"
							tabIndex={-1}
							aria-label="Import a text or Word file"
							accept=".txt,.docx,text/plain,application/vnd.openxmlformats-officedocument.wordprocessingml.document"
							className="sr-only"
							onChange={(event) => {
								const file = event.target.files?.[0];
								event.target.value = "";
								if (file) onImport(file);
							}}
						/>
					</div>
					{canStore ? null : (
						<p className="text-sm text-text-2">
							Import is not available right now. You can still type and save the text.
						</p>
					)}
					<div className="flex flex-wrap gap-2">
						{draft.id && draft.kind === "native" ? (
							<Button variant="secondary" disabled={pending || dirty || !draft.body.trim()} onClick={onDesignate}>
								Use as core values
							</Button>
						) : null}
						{draft.id ? (
							<Button variant="danger" disabled={pending} onClick={onArchive}>
								Archive document
							</Button>
						) : null}
					</div>
					{dirty && draft.id && draft.kind === "native" ? (
						<p className="text-sm text-text-2">Save the document before you use it as core values.</p>
					) : null}
				</>
			)}
			{note ? (
				<p role="status" className="text-sm text-text-2">
					{note}
				</p>
			) : null}
			{conflict ? (
				<Button variant="secondary" onClick={onReload}>
					Reload this document
				</Button>
			) : null}
			{canEdit ? null : <p className="text-sm text-text-2">You can read these documents. You cannot change them.</p>}
		</div>
	);
}
