"use client";

import { Delete02Icon, Edit02Icon, FloppyDiskIcon, Refresh01Icon, ViewIcon } from "@hugeicons/core-free-icons";
import { pageBox, tileBox, type DocDocument } from "@everyfield/contracts/documents";
import { Button, ConfirmDialog, Tooltip } from "@everyfield/ui/controls";
import { Extension } from "@tiptap/core";
import type { Node as PMNode } from "@tiptap/pm/model";
import { Selection } from "@tiptap/pm/state";
import { EditorContent, EditorContext, useEditor, useEditorState } from "@tiptap/react";
import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import { saveChurchDocument } from "../actions.ts";
import { ChurchPdf } from "../ChurchPdf.tsx";
import { deleteAllContent, deleteBlock, moveBlock } from "./blocks.ts";
import { documentFrom, editorContent } from "./document-json.ts";
import "./editor.css";
import { editorExtensions, type FieldValues } from "./extensions.ts";
import { EditorToolbar } from "./Toolbar.tsx";

// The Church Document editor: the toolbar, the paper page, the save status and the real-PDF preview. The editor holds
// the document as ProseMirror JSON and builds the stored document from it on Save. It stays mounted while the preview
// shows, so the content, the cursor and the undo history survive a trip to the preview and back.

export type SaveStatus =
	{ kind: "saved" } | { kind: "dirty" } | { kind: "saving" } | { kind: "failed"; reason: string };

const NOTICE = "Template, not legal advice";
const NOTICE_WHY =
	"Every formal or legal document prints this notice, in the PDF and the Word file. Editing the document cannot remove it.";

function fieldValues(doc: DocDocument): FieldValues {
	const values: FieldValues = {};
	for (const field of doc.fields) {
		const raw = doc.data?.[field.key];
		const text = Array.isArray(raw) ? raw.join(", ") : raw === undefined || raw === null ? "" : String(raw);
		values[field.key] = text || field.fallback || `[${field.label}]`;
	}
	return values;
}

/** Block shortcuts that need no toolbar: Move block up and down, Delete block. */
const BlockShortcuts = Extension.create({
	name: "blockShortcuts",
	addKeyboardShortcuts() {
		return {
			"Mod-Alt-ArrowUp": () => moveBlock(this.editor, -1),
			"Mod-Alt-ArrowDown": () => moveBlock(this.editor, 1),
			"Mod-Alt-Backspace": () => deleteBlock(this.editor),
		};
	},
});

type Props = {
	docId: string;
	title: string;
	document: DocDocument;
	revision: string;
	onRevision: (revision: string) => void;
	previewSrc: (revision: string) => string;
};

export default function ChurchEditor({
	docId,
	title,
	document: stored,
	revision: initialRevision,
	onRevision,
	previewSrc,
}: Props) {
	const base = useRef(stored);
	const revision = useRef(initialRevision);
	const [shownRevision, setShownRevision] = useState(initialRevision);
	const [status, setStatus] = useState<SaveStatus>({ kind: "saved" });
	const [mode, setMode] = useState<"edit" | "preview">("edit");
	const savedDoc = useRef<PMNode | null>(null);
	const inflight = useRef<Promise<boolean> | null>(null);

	const extensions = useMemo(() => [...editorExtensions(fieldValues(stored)), BlockShortcuts], [stored]);
	const editor = useEditor({
		extensions,
		content: editorContent(stored),
		immediatelyRender: true,
		// Start with the cursor in the first line of text, not on a whole block.
		onCreate: ({ editor: created }) => {
			const first = Selection.findFrom(created.state.doc.resolve(0), 1, true);
			if (first) created.view.dispatch(created.state.tr.setSelection(first).setMeta("addToHistory", false));
		},
		editorProps: {
			attributes: {
				"aria-label": `${title}, document body`,
				"aria-multiline": "true",
				role: "textbox",
				spellcheck: "true",
			},
		},
	});

	// "Unsaved changes" means the document differs from the last saved one, so Undo back to it reads "Saved" again.
	useEffect(() => {
		if (!editor) return;
		savedDoc.current ??= editor.state.doc;
		const sync = () => {
			const same = (savedDoc.current as PMNode).eq(editor.state.doc);
			setStatus((current) =>
				current.kind === "saving"
					? current
					: same
						? { kind: "saved" }
						: current.kind === "failed"
							? current
							: { kind: "dirty" },
			);
		};
		editor.on("update", sync);
		return () => void editor.off("update", sync);
	}, [editor]);

	const save = useCallback((): Promise<boolean> => {
		if (!editor) return Promise.resolve(false);
		if (inflight.current) return inflight.current;
		const doc = editor.state.doc;
		const body = documentFrom(base.current, doc.toJSON());
		setStatus({ kind: "saving" });
		const run = (async () => {
			const result = await saveChurchDocument(docId, revision.current, body);
			if (result.status === "saved") {
				revision.current = result.revision;
				savedDoc.current = doc;
				base.current = body;
				setShownRevision(result.revision);
				onRevision(result.revision);
				// Edits typed while the request ran keep the "Unsaved changes" status.
				setStatus((editor.state.doc.eq(doc) ? { kind: "saved" } : { kind: "dirty" }) satisfies SaveStatus);
				return true;
			}
			setStatus({
				kind: "failed",
				reason:
					result.status === "refused"
						? result.code === "conflict"
							? "Someone saved a newer revision first. Your edits are still here. Copy them, reload the page, then paste them in."
							: result.message
						: "The connection dropped. Your edits are still here.",
			});
			return false;
		})().finally(() => {
			inflight.current = null;
		});
		inflight.current = run;
		return run;
	}, [editor, docId, onRevision]);

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

	useLeaveGuard(status.kind !== "saved");

	const preview = useCallback(async () => {
		if (status.kind !== "saved" && !(await save())) return;
		setMode("preview");
	}, [save, status.kind]);

	const deleteAll = useCallback(() => {
		if (editor) deleteAllContent(editor);
	}, [editor]);

	const page = stored.page;
	const sheet = useMemo(() => {
		const full = pageBox(page) ?? { width: 612, height: 792 };
		const cell = page.tile ? tileBox(page) : null;
		const width = cell ? cell.width : full.width;
		const height = cell ? cell.height : full.height;
		const pad = page.tile
			? { x: page.tile.padding, y: page.tile.padding }
			: { x: page.margin.left, y: page.margin.top };
		const px = (n: number) => `${((n * 4) / 3).toFixed(2)}px`;
		return {
			"--page-w": px(width + (page.tile ? 2 * page.tile.padding : 0)),
			"--page-h": px(height + (page.tile ? 2 * page.tile.padding : 0)),
			"--pad-x": px(pad.x),
			"--pad-y": px(pad.y),
		} as CSSProperties;
	}, [page]);

	const empty = useEditorState({ editor, selector: ({ editor: e }) => (e ? e.state.doc.childCount === 0 : true) });
	const legal = stored.class === "formal/legal";

	return (
		<EditorContext.Provider value={{ editor }}>
			<div className="flex flex-col gap-3">
				<div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2">
					<SaveStatusText status={status} revision={shownRevision} onRetry={() => void save()} />
					<div className="flex flex-wrap items-center gap-2">
						{mode === "edit" ? (
							<Button variant="secondary" size="sm" icon={ViewIcon} onClick={() => void preview()}>
								Preview
							</Button>
						) : (
							<Button variant="secondary" size="sm" icon={Edit02Icon} onClick={() => setMode("edit")}>
								Back to editing
							</Button>
						)}
						<Button
							variant="primary"
							size="sm"
							icon={FloppyDiskIcon}
							loading={status.kind === "saving"}
							onClick={() => void save().then((saved) => saved && editor?.view.focus())}
						>
							Save
						</Button>
						<ConfirmDialog
							trigger={
								<Button variant="secondary" size="sm" icon={Delete02Icon}>
									Delete all content
								</Button>
							}
							tone="danger"
							title="Delete all content?"
							description="The body, the header and the footer become empty."
							consequences={[
								legal
									? `The page keeps only "${NOTICE}", which prints on every formal or legal document.`
									: "The page is empty until you add a block.",
								"You can bring it all back with Undo until you leave the page.",
							]}
							confirmLabel="Delete all content"
							onConfirm={deleteAll}
						/>
					</div>
				</div>
				{/* The editor stays in the page while the preview shows, so its content, cursor and undo history stay. */}
				<div hidden={mode !== "edit"} className="flex flex-col gap-3">
					<div className="overflow-hidden rounded-card bg-surface-raised shadow-[0_0_0_1px_var(--ef-line)]">
						{editor ? <EditorToolbar editor={editor} /> : <div className="h-[49px]" />}
					</div>
					<div className="ef-sheet" style={sheet}>
						<div className="ef-paper">
							{empty && editor ? <p className="ef-empty">This document is empty. Use Insert to add a block.</p> : null}
							<EditorContent editor={editor} />
							{legal ? (
								<footer className="ef-notice">
									<span>{NOTICE}</span>
									<Tooltip
										content={<span className="block max-w-[260px] text-pretty whitespace-normal">{NOTICE_WHY}</span>}
										side="top"
									>
										<button
											type="button"
											className="inline-flex cursor-pointer items-center gap-1 rounded-sm bg-[var(--paper-muted)] px-2 py-0.5 text-xs font-semibold text-[var(--paper-ink)]"
										>
											<LockGlyph />
											Locked
										</button>
									</Tooltip>
								</footer>
							) : null}
						</div>
					</div>
				</div>
				{mode === "preview" ? (
					<section aria-label="Preview" className="mx-auto w-full max-w-[880px]">
						<ChurchPdf
							key={previewSrc(shownRevision)}
							title={title}
							src={previewSrc(shownRevision)}
							page={{ width: pageBox(page)?.width ?? 612, height: pageBox(page)?.height ?? 792 }}
						/>
					</section>
				) : null}
			</div>
		</EditorContext.Provider>
	);
}

function LockGlyph() {
	return (
		<svg
			viewBox="0 0 24 24"
			width="12"
			height="12"
			fill="none"
			stroke="currentColor"
			strokeWidth="2"
			aria-hidden="true"
		>
			<rect x="5" y="11" width="14" height="9" rx="2" />
			<path d="M8 11V8a4 4 0 0 1 8 0v3" />
		</svg>
	);
}

function SaveStatusText({ status, revision, onRetry }: { status: SaveStatus; revision: string; onRetry: () => void }) {
	return (
		<p
			role="status"
			aria-live="polite"
			className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1 text-sm text-text-2"
		>
			{status.kind === "saved" ? (
				<span>
					Saved <span className="tabular-nums">· Revision {revision}</span>
				</span>
			) : status.kind === "dirty" ? (
				<span>Unsaved changes</span>
			) : status.kind === "saving" ? (
				<span>Saving…</span>
			) : (
				<>
					<span className="text-magenta-600">Not saved. {status.reason}</span>
					<Button variant="outline" size="sm" icon={Refresh01Icon} onClick={onRetry}>
						Retry
					</Button>
				</>
			)}
		</p>
	);
}

/** Asks before the page closes or an in-app link leaves it while the document has changes that are not saved. */
function useLeaveGuard(active: boolean) {
	useEffect(() => {
		if (!active) return;
		const beforeUnload = (event: BeforeUnloadEvent) => {
			event.preventDefault();
			event.returnValue = "";
		};
		const onClick = (event: MouseEvent) => {
			const link = (event.target as Element | null)?.closest?.("a[href]");
			if (!(link instanceof HTMLAnchorElement) || link.hasAttribute("download") || link.target === "_blank") return;
			const url = new URL(link.href, window.location.href);
			if (url.origin !== window.location.origin) return;
			if (url.pathname === window.location.pathname && url.search === window.location.search) return;
			if (!window.confirm("You have unsaved changes. Leave this page without saving?")) {
				event.preventDefault();
				event.stopPropagation();
			}
		};
		window.addEventListener("beforeunload", beforeUnload);
		document.addEventListener("click", onClick, true);
		return () => {
			window.removeEventListener("beforeunload", beforeUnload);
			document.removeEventListener("click", onClick, true);
		};
	}, [active]);
}
