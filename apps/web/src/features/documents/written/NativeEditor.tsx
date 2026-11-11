"use client";

import {
	Archive02Icon,
	FileImportIcon,
	FloppyDiskIcon,
	MoreHorizontalIcon,
	Refresh01Icon,
	StarIcon,
} from "@hugeicons/core-free-icons";
import { IMPORT_BYTES_MAX, IMPORT_TOO_LARGE, nativeText, type DocNode } from "@everyfield/contracts/documents";
import {
	Button,
	ConfirmDialog,
	Field,
	IconButton,
	Input,
	Menu,
	MenuContent,
	MenuItem,
	MenuTrigger,
	PageHeader,
} from "@everyfield/ui/controls";
import { Tag } from "@everyfield/ui/display";
import type { Node as PMNode } from "@tiptap/pm/model";
import { EditorContent, EditorContext, useEditor } from "@tiptap/react";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useRef, useState } from "react";
import { archiveOwnedDocument, designateOwnedDocument, saveOwnedDocument, type DocumentOutcome } from "../actions.ts";
import { clean } from "../church/editor/document-json.ts";
import "../church/editor/editor.css";
import { nativeExtensions } from "../church/editor/extensions.ts";
import {
	BlockShortcuts,
	LeaveDialog,
	SaveStatusText,
	useLeaveGuard,
	type SaveStatus,
} from "../church/editor/session.tsx";
import { EditorToolbar } from "../church/editor/Toolbar.tsx";
import { documentProblem, type WrittenView } from "../model.ts";
import { CopiedNote, SECTION, TextRevisionNote } from "./notes.tsx";

// A plain native document in the Church Document editor's toolbar and paper (D-208), with the prose tools only: no
// page setup, merge fields, slots, template compare, branding, preview or export (D-211). Save sends the title and the
// editor's body node with the expected revision; the domain parses the body again.

const EMPTY: DocNode = { type: "doc", content: [{ type: "paragraph" }] };

function fileFormat(file: File): "text" | "docx" | null {
	const name = file.name.toLowerCase();
	if (name.endsWith(".docx")) return "docx";
	if (name.endsWith(".txt") || file.type === "text/plain") return "text";
	return null;
}

/** Sends the file's raw bytes to the import route (a server action caps its body far below the import limit). */
async function importWritten(file: File, params: Record<string, string>): Promise<DocumentOutcome<WrittenView>> {
	try {
		const response = await fetch(`/documents/written/import?${new URLSearchParams(params)}`, {
			method: "POST",
			headers: { "content-type": "application/octet-stream" },
			body: file,
		});
		if (!response.ok) return { status: "lost" };
		return (await response.json()) as DocumentOutcome<WrittenView>;
	} catch {
		// A call that never reached the server, or an answer that is not the route's, reads as a lost answer.
		return { status: "lost" };
	}
}

type Saved = { id: string | null; revision: string; title: string; kind: WrittenView["kind"] };

export default function NativeEditor({
	doc,
	scope,
	canStore,
}: {
	/** Null for a new document: the first save creates it. */
	doc: WrittenView | null;
	scope: "church" | "account";
	canStore: boolean;
}) {
	const router = useRouter();
	// The last saved state and the shown title, as state for the page and as refs for the leave guard and Save, which
	// read them at the moment of a click.
	const first: Saved = {
		id: doc?.id ?? null,
		revision: doc?.revision ?? "0",
		title: doc?.title ?? "",
		kind: doc?.kind ?? "native",
	};
	const [saved, setSavedState] = useState<Saved>(first);
	const savedRef = useRef(first);
	const setSaved = (next: Saved) => {
		savedRef.current = next;
		setSavedState(next);
	};
	const [title, setTitleState] = useState(first.title);
	const titleRef = useRef(first.title);
	const setTitle = (next: string) => {
		titleRef.current = next;
		setTitleState(next);
	};
	const [bodyChanged, setBodyChanged] = useState(false);
	const [phase, setPhase] = useState<
		{ kind: "idle" } | { kind: "saving" } | { kind: "failed"; reason: string; conflict: boolean }
	>({ kind: "idle" });
	const [errors, setErrors] = useState<{ title?: string; body?: string }>({});
	const [note, setNote] = useState<string | null>(null);
	const [archiveOpen, setArchiveOpen] = useState(false);
	const [textRevision, setTextRevision] = useState(doc?.textRevision ?? false);
	const savedDoc = useRef<PMNode | null>(null);
	const inflight = useRef<Promise<boolean> | null>(null);
	const discarding = useRef(false);
	const fileRef = useRef<HTMLInputElement>(null);
	const importKey = useRef<string | null>(null);
	const titleInput = useRef<HTMLInputElement>(null);

	const editor = useEditor({
		extensions: [...nativeExtensions(), BlockShortcuts],
		content: doc?.body ?? EMPTY,
		immediatelyRender: true,
		editorProps: {
			attributes: {
				"aria-label": "Document text",
				"aria-multiline": "true",
				role: "textbox",
				spellcheck: "true",
			},
		},
	});

	const isSaved = useCallback((current: PMNode) => {
		let base = savedDoc.current;
		if (!base) return true;
		if (base.type.schema !== current.type.schema)
			base = savedDoc.current = current.type.schema.nodeFromJSON(base.toJSON());
		return base.eq(current);
	}, []);
	const unsaved = useCallback(
		() =>
			!discarding.current &&
			!!editor &&
			(inflight.current !== null || !isSaved(editor.state.doc) || titleRef.current.trim() !== savedRef.current.title),
		[editor, isSaved],
	);
	useEffect(() => {
		if (!editor) return;
		savedDoc.current ??= editor.state.doc;
		const sync = () => setBodyChanged(!isSaved(editor.state.doc));
		editor.on("update", sync);
		return () => void editor.off("update", sync);
	}, [editor, isSaved]);
	// A new document starts with the cursor in its title.
	useEffect(() => {
		if (!doc) titleInput.current?.focus();
	}, [doc]);

	const changed = bodyChanged || title.trim() !== saved.title;
	const status: SaveStatus =
		phase.kind === "saving"
			? { kind: "saving" }
			: phase.kind === "failed"
				? { kind: "failed", reason: phase.reason }
				: changed
					? { kind: "dirty" }
					: { kind: "saved" };

	/** The page's address names the document once the first save or import created it. */
	const created = (id: string) => {
		if (savedRef.current.id) return;
		window.history.replaceState(window.history.state, "", `/documents/written/${id}`);
	};

	/** One save of the document as it is now. The caller has checked that no save is in flight. */
	const saveNow = useCallback((): Promise<boolean> => {
		if (!editor) return Promise.resolve(false);
		const current = editor.state.doc;
		const body = clean(current.toJSON()) as DocNode;
		const nextTitle = titleRef.current.trim();
		const found = {
			...(nextTitle ? {} : { title: "Enter a title." }),
			...(nativeText(body) ? {} : { body: "Write some text before you save." }),
		};
		setErrors(found);
		if (found.title || found.body) return Promise.resolve(false);
		setPhase({ kind: "saving" });
		setNote(null);
		const base = savedRef.current;
		const run = (async () => {
			// A call that never reached the server (no connection, a refused body) reads as a lost answer, not a hang.
			const result = await saveOwnedDocument({
				title: nextTitle,
				body,
				expectedRevision: base.revision,
				...(base.id ? { documentId: base.id } : {}),
			}).catch(() => ({ status: "lost" }) as const);
			if (result.status !== "ok") {
				const conflict = result.status === "refused" && result.code === "conflict";
				setPhase({
					kind: "failed",
					conflict,
					reason: conflict
						? "Someone saved a newer version first. Your edits are still here. Copy what you need, then reload."
						: result.status === "lost"
							? "The connection dropped. Your edits are still here."
							: documentProblem(result.code, result.problem, "Try again."),
				});
				return false;
			}
			created(result.value.id);
			savedDoc.current = current;
			setSaved({ id: result.value.id, revision: result.value.revision, title: nextTitle, kind: result.value.kind });
			if (titleRef.current.trim() === nextTitle) setTitle(nextTitle);
			setBodyChanged(!editor.state.doc.eq(current));
			setTextRevision(false);
			setPhase({ kind: "idle" });
			return true;
		})().finally(() => {
			inflight.current = null;
		});
		inflight.current = run;
		return run;
	}, [editor]);

	/**
	 * Saves the document on screen. A save already in flight sent the document as it was when it started, so after it
	 * resolves, edits typed meanwhile get a save of their own. True only when what is on screen is saved; a failed save
	 * keeps its reason on the page.
	 */
	const save = useCallback(async (): Promise<boolean> => {
		if (!editor) return false;
		let joined = false;
		while (inflight.current) {
			joined = true;
			if (!(await inflight.current)) return false;
		}
		if (joined && isSaved(editor.state.doc) && titleRef.current.trim() === savedRef.current.title) return true;
		return saveNow();
	}, [editor, isSaved, saveNow]);

	// Cmd/Ctrl+S saves from anywhere on the page, and the browser's own Save dialog stays closed.
	useEffect(() => {
		const onKey = (event: KeyboardEvent) => {
			if ((event.metaKey || event.ctrlKey) && !event.altKey && event.key.toLowerCase() === "s") {
				event.preventDefault();
				void save();
			}
		};
		window.addEventListener("keydown", onKey);
		return () => window.removeEventListener("keydown", onKey);
	}, [save]);

	const leave = useLeaveGuard(editor, unsaved);

	function reload() {
		discarding.current = true;
		window.location.reload();
	}

	function importFile(file: File) {
		if (!editor) return;
		const format = fileFormat(file);
		if (!format) return setNote("Use a .txt or .docx file. Older .doc Word files are not accepted.");
		if (file.size === 0) return setNote("The file is empty.");
		if (file.size > IMPORT_BYTES_MAX) return setNote(IMPORT_TOO_LARGE);
		const base = savedRef.current;
		const nextTitle =
			titleRef.current.trim() || file.name.replace(/\.(txt|docx)$/i, "").slice(0, 200) || "Imported document";
		const key = importKey.current ?? crypto.randomUUID();
		importKey.current = key;
		setPhase({ kind: "saving" });
		setNote(null);
		void (async () => {
			const result = await importWritten(file, {
				title: nextTitle,
				format,
				expectedRevision: base.revision,
				requestKey: key,
				...(base.id ? { documentId: base.id } : {}),
			});
			setPhase({ kind: "idle" });
			if (result.status !== "ok") {
				if (result.status === "refused") importKey.current = null;
				return setNote(
					documentProblem(
						result.status === "refused" ? result.code : "lost",
						result.status === "refused" ? result.problem : undefined,
						"This file did not import. Nothing in this document changed.",
					),
				);
			}
			importKey.current = null;
			const value = result.value;
			created(value.id);
			// The imported file is the saved revision now: text as paragraphs, a Word file with its headings, lists and links.
			editor.chain().setMeta("addToHistory", false).setContent(value.body).run();
			savedDoc.current = editor.state.doc;
			setBodyChanged(false);
			setSaved({ id: value.id, revision: value.revision, title: value.title, kind: value.kind });
			setTitle(value.title);
			setTextRevision(false);
			setNote(
				format === "docx"
					? "The Word file is now this document's saved version. Its headings, lists and links came across, ready to edit."
					: "The file's text is now this document's saved version. Each line is a paragraph you can edit.",
			);
		})();
	}

	async function designate() {
		const base = savedRef.current;
		if (!base.id) return;
		setPhase({ kind: "saving" });
		const result = await designateOwnedDocument(base.id, base.revision).catch(() => ({ status: "lost" }) as const);
		setPhase({ kind: "idle" });
		if (result.status !== "ok")
			return setNote(
				documentProblem(
					result.status === "refused" ? result.code : "lost",
					result.status === "refused" ? result.problem : undefined,
					"The core values did not change. Try again.",
				),
			);
		setSaved({ ...base, revision: result.value.revision, kind: result.value.kind });
		setNote(
			scope === "church"
				? "This document is now the core values for your church."
				: "This document is now your core values.",
		);
	}

	async function archive() {
		const base = savedRef.current;
		if (!base.id) return;
		const result = await archiveOwnedDocument(base.id, base.revision);
		if (result.status !== "ok")
			throw new Error(
				documentProblem(
					result.status === "refused" ? result.code : "lost",
					result.status === "refused" ? result.problem : undefined,
					"This document was not archived. Try again.",
				),
			);
		discarding.current = true;
		router.push("/documents");
	}

	const busy = phase.kind === "saving";
	const conflict = phase.kind === "failed" && phase.conflict;
	return (
		<EditorContext.Provider value={{ editor }}>
			<div className="flex flex-col gap-4">
				<PageHeader
					breadcrumb={[{ label: "Documents", href: "/documents" }]}
					title={title.trim() || (saved.id ? saved.title : "New document")}
					subtitle={SECTION[scope]}
				/>
				{saved.kind === "core_values" || doc?.copied || textRevision ? (
					<div className="flex w-full max-w-[816px] flex-col gap-2 self-center">
						{saved.kind === "core_values" ? (
							<div>
								<Tag>Core values</Tag>
							</div>
						) : null}
						{doc?.copied ? <CopiedNote /> : null}
						{textRevision ? <TextRevisionNote /> : null}
					</div>
				) : null}
				<div className="w-full max-w-[816px] self-center">
					<Field label="Title" error={errors.title}>
						<Input
							ref={titleInput}
							value={title}
							maxLength={200}
							onChange={(event) => {
								setTitle(event.target.value);
								setErrors((e) => ({ ...e, title: undefined }));
							}}
						/>
					</Field>
				</div>
				<div className="flex w-full max-w-[816px] flex-wrap items-center justify-between gap-x-4 gap-y-2 self-center">
					{conflict ? (
						// A retry would meet the same newer version, so a conflict offers the reload instead.
						<p role="status" aria-live="polite" className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1 text-sm">
							<span className="text-magenta-600 text-pretty">Not saved. {phase.reason}</span>
							<Button variant="outline" size="sm" icon={Refresh01Icon} onClick={reload}>
								Discard my edits and reload
							</Button>
						</p>
					) : saved.id || status.kind !== "saved" ? (
						<SaveStatusText status={status} revision={saved.revision} accepted={null} onRetry={() => void save()} />
					) : (
						<p role="status" className="text-sm text-text-2">
							New document. Nothing is saved yet.
						</p>
					)}
					<div className="flex flex-wrap items-center gap-2">
						<Button
							variant="secondary"
							size="sm"
							icon={FileImportIcon}
							disabled={!canStore || busy || bodyChanged || (saved.id !== null && changed)}
							onClick={() => fileRef.current?.click()}
						>
							Import a text or Word file
						</Button>
						<input
							ref={fileRef}
							type="file"
							tabIndex={-1}
							aria-hidden="true"
							accept=".txt,.docx,text/plain,application/vnd.openxmlformats-officedocument.wordprocessingml.document"
							className="hidden"
							onChange={(event) => {
								const file = event.target.files?.[0];
								event.target.value = "";
								if (file) importFile(file);
							}}
						/>
						{saved.id ? (
							<Menu>
								<MenuTrigger asChild>
									<IconButton icon={MoreHorizontalIcon} label="More actions" size="sm" />
								</MenuTrigger>
								<MenuContent align="end">
									{saved.kind === "native" ? (
										<MenuItem icon={StarIcon} disabled={busy || changed} onSelect={() => void designate()}>
											Use as core values
										</MenuItem>
									) : null}
									<MenuItem icon={Archive02Icon} onSelect={() => setArchiveOpen(true)}>
										Archive document
									</MenuItem>
								</MenuContent>
							</Menu>
						) : null}
						<Button
							variant="primary"
							size="sm"
							icon={FloppyDiskIcon}
							loading={busy}
							disabled={!changed && phase.kind !== "failed"}
							onClick={() => void save().then((ok) => ok && editor?.view.focus())}
						>
							Save
						</Button>
					</div>
				</div>
				{changed && saved.id ? (
					<p className="w-full max-w-[816px] self-center text-sm text-text-2">
						Save your edits before you import a file or use this document as core values.
					</p>
				) : null}
				{!canStore ? (
					<p className="w-full max-w-[816px] self-center text-sm text-text-2">
						Import is not available right now. You can still type and save the text.
					</p>
				) : null}
				{note ? (
					<p role="status" className="w-full max-w-[816px] self-center text-sm text-text-2 text-pretty">
						{note}
					</p>
				) : null}
				<div className="sticky top-[calc(var(--ef-topbar-h)+28px)] z-20 w-full max-w-[816px] self-center overflow-hidden rounded-card bg-surface-raised shadow-[0_0_0_1px_var(--ef-line)]">
					{editor ? <EditorToolbar editor={editor} /> : <div className="h-[49px]" />}
				</div>
				{errors.body ? (
					<p role="alert" className="w-full max-w-[816px] self-center text-sm text-magenta-600">
						{errors.body}
					</p>
				) : null}
				<div className="ef-sheet ef-native">
					<div className="ef-paper">
						<EditorContent editor={editor} />
					</div>
				</div>
			</div>
			<LeaveDialog request={leave.request} onSave={save} onDone={leave.close} />
			<ConfirmDialog
				open={archiveOpen}
				onOpenChange={setArchiveOpen}
				tone="danger"
				title="Archive this document?"
				description="It leaves the list of documents and stops counting as core values."
				consequences={[
					"Every saved version stays stored.",
					...(changed ? ["Edits you have not saved are discarded."] : []),
				]}
				confirmLabel="Archive document"
				onConfirm={archive}
			/>
		</EditorContext.Provider>
	);
}
