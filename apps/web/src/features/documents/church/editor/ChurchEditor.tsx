"use client";

import {
	Cancel01Icon,
	Delete02Icon,
	Edit02Icon,
	FileSyncIcon,
	FloppyDiskIcon,
	MoreHorizontalIcon,
	Refresh01Icon,
	FileAddIcon,
	ViewIcon,
} from "@hugeicons/core-free-icons";
import { LEGAL_NOTICE, pageBox, tileBox, type DocBrand, type DocDocument } from "@everyfield/contracts/documents";
import {
	Button,
	ConfirmDialog,
	Dialog,
	DialogContent,
	DialogFooter,
	DialogHeader,
	IconButton,
	IntentLink,
	Menu,
	MenuContent,
	MenuItem,
	MenuTrigger,
	Tooltip,
} from "@everyfield/ui/controls";
import { Extension, type Editor } from "@tiptap/core";
import type { Node as PMNode } from "@tiptap/pm/model";
import { Selection } from "@tiptap/pm/state";
import { EditorContent, EditorContext, useEditor, useEditorState } from "@tiptap/react";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useId, useMemo, useRef, useState, type CSSProperties } from "react";
import { holdLeave } from "../../../../components/save/leave.ts";
import { saveChurchDocument } from "../actions.ts";
import { ChurchPdf } from "../ChurchPdf.tsx";
import { deleteAllContent, deleteBlock, moveBlock } from "./blocks.ts";
import { documentFrom, editorContent } from "./document-json.ts";
import "./editor.css";
import { editorExtensions } from "./extensions.ts";
import { fieldValues } from "./field-values.ts";
import { BlockControls } from "./LayoutControls.tsx";
import { readPage } from "./layout.ts";
import { paletteVars } from "./paper.ts";
import { PageSetupPanel } from "./PageSetup.tsx";
import { SaveAsTemplateDialog, type TemplateSaved } from "./SaveAsTemplate.tsx";
import { TemplateCompare } from "./TemplateCompare.tsx";
import { EditorToolbar } from "./Toolbar.tsx";

// The Church Document editor: the toolbar, the paper page, the save status and the real-PDF preview. The editor holds
// the document as ProseMirror JSON and builds the stored document from it on Save. It stays mounted while the preview
// shows, so the content, the cursor and the undo history survive a trip to the preview and back.

export type SaveStatus =
	{ kind: "saved" } | { kind: "dirty" } | { kind: "saving" } | { kind: "failed"; reason: string };

const NOTICE_WHY =
	"Every formal or legal document prints this notice, in the PDF and the Word file. Editing the document cannot remove it.";

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
	/** The palette the PDF paints for this document and the brand-kit images it may show. */
	brand: DocBrand;
	revision: string;
	onRevision: (revision: string) => void;
	previewSrc: (revision: string) => string;
	/** Where the document stands against its template; null when there is nothing to compare with. */
	template: "behind" | "current" | null;
	/** Changes from the template were accepted as `revision`: the page reopens the editor on it. */
	onAccepted: (document: DocDocument, revision: string, taken: number) => void;
	/** What the last accept did, shown in the status line until the next edit. */
	accepted?: string | null;
};

export default function ChurchEditor({
	docId,
	title,
	document: stored,
	brand,
	revision: initialRevision,
	onRevision,
	previewSrc,
	template,
	onAccepted,
	accepted = null,
}: Props) {
	const base = useRef(stored);
	const revision = useRef(initialRevision);
	const [shownRevision, setShownRevision] = useState(initialRevision);
	const [status, setStatus] = useState<SaveStatus>({ kind: "saved" });
	const [mode, setMode] = useState<"edit" | "preview" | "compare">("edit");
	const savedDoc = useRef<PMNode | null>(null);
	const inflight = useRef<Promise<boolean> | null>(null);

	// The image blocks read the brand-kit images through this one object, so the branding switch can change the images
	// without a new editor: its content, cursor and undo history stay, and only the image views draw again (below).
	const liveAssets = useRef(brand.assets);
	const assets = useMemo<DocBrand["assets"]>(
		() => ({
			get logo() {
				return liveAssets.current.logo;
			},
			get mark() {
				return liveAssets.current.mark;
			},
			get photo() {
				return liveAssets.current.photo;
			},
		}),
		[],
	);
	const extensions = useMemo(
		() => [...editorExtensions(fieldValues(stored), assets), BlockShortcuts],
		[stored, assets],
	);
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

	useEffect(() => {
		if (liveAssets.current === brand.assets) return;
		liveAssets.current = brand.assets;
		// New node view functions make ProseMirror draw the image blocks again, now with the new brand's images.
		if (editor && !editor.isDestroyed) editor.createNodeViews();
	}, [editor, brand.assets]);

	// "Unsaved changes" means the document differs from the last saved one, so Undo back to it reads "Saved" again.
	// Tiptap can build the schema again after the first render; the saved document is read into the current schema
	// first, because nodes of two schemas are never equal.
	const isSaved = useCallback((doc: PMNode) => {
		let saved = savedDoc.current;
		if (!saved) return true;
		if (saved.type.schema !== doc.type.schema) saved = savedDoc.current = doc.type.schema.nodeFromJSON(saved.toJSON());
		return saved.eq(doc);
	}, []);
	// Read when a way out is taken, not from React state: a click straight after an edit can come before React renders.
	const unsaved = useCallback(
		() => !!editor && (inflight.current !== null || !isSaved(editor.state.doc)),
		[editor, isSaved],
	);
	useEffect(() => {
		if (!editor) return;
		savedDoc.current ??= editor.state.doc;
		const sync = () => {
			const same = isSaved(editor.state.doc);
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
	}, [editor, isSaved]);

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

	const leave = useLeaveGuard(editor, unsaved);

	const preview = useCallback(async () => {
		if (status.kind !== "saved" && !(await save())) return;
		setMode("preview");
	}, [save, status.kind]);

	// The compare reads the saved revision, so edits not yet saved are saved first.
	const compare = useCallback(async () => {
		if (status.kind !== "saved" && !(await save())) return;
		setMode("compare");
	}, [save, status.kind]);

	const deleteAll = useCallback(() => {
		if (editor) deleteAllContent(editor);
	}, [editor]);

	// The page setup the editor holds now: a change in the Page setup panel reaches the paper at once.
	const page = useEditorState({
		editor,
		selector: ({ editor: e }) => (e ? readPage(e.state) : (stored.page as ReturnType<typeof readPage>)),
	});
	const [setupOpen, setSetupOpen] = useState(false);
	const setupId = useId();
	const sheet = useMemo(() => {
		const full = pageBox(page) ?? { width: 612, height: 792 };
		const cell = page.tile ? tileBox(page as DocDocument["page"]) : null;
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
			...paletteVars(brand.palette),
		} as CSSProperties;
	}, [page, brand]);

	// Save as template: each opening mounts the dialog afresh (a new request key); a success names the template here.
	const [templateDialog, setTemplateDialog] = useState({ open: false, opening: 0 });
	const [savedTemplate, setSavedTemplate] = useState<TemplateSaved | null>(null);

	const empty = useEditorState({ editor, selector: ({ editor: e }) => (e ? e.state.doc.childCount === 0 : true) });
	const legal = stored.class === "formal/legal";

	return (
		<EditorContext.Provider value={{ editor }}>
			<div className="flex flex-col gap-3">
				<div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2">
					<SaveStatusText
						status={status}
						revision={shownRevision}
						accepted={status.kind === "saved" && shownRevision === initialRevision ? accepted : null}
						onRetry={() => void save()}
					/>
					<div hidden={mode === "compare"} className="flex flex-wrap items-center gap-2">
						{template !== null && mode === "edit" ? (
							<Button variant="secondary" size="sm" icon={FileSyncIcon} onClick={() => void compare()}>
								Compare with template
							</Button>
						) : null}
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
									? `The page keeps only "${LEGAL_NOTICE}", which prints on every formal or legal document.`
									: "The page is empty until you add a block.",
								"You can bring it all back with Undo until you leave the page.",
							]}
							confirmLabel="Delete all content"
							onConfirm={deleteAll}
						/>
						<Menu>
							<MenuTrigger asChild>
								<IconButton icon={MoreHorizontalIcon} label="More actions" size="sm" />
							</MenuTrigger>
							<MenuContent align="end">
								<MenuItem
									icon={FileAddIcon}
									onSelect={() => setTemplateDialog((d) => ({ open: true, opening: d.opening + 1 }))}
								>
									Save as template
								</MenuItem>
							</MenuContent>
						</Menu>
					</div>
				</div>
				{savedTemplate ? (
					<div className="flex items-start gap-3 rounded-md bg-surface-raised px-4 py-3 shadow-[0_0_0_1px_var(--ef-line)]">
						<p role="status" className="min-w-0 flex-1 text-md text-text-2 text-pretty">
							{savedTemplate.updated ? (
								<>
									Updated <span className="font-medium text-ink">“{savedTemplate.title}”</span> to v
									{savedTemplate.version}. Documents made from earlier versions keep theirs. New documents from it use v
									{savedTemplate.version} in New from template on{" "}
								</>
							) : (
								<>
									Saved <span className="font-medium text-ink">“{savedTemplate.title}”</span> as your church&apos;s
									template. Find it in New from template on{" "}
								</>
							)}
							<IntentLink href="/documents/church" className="cursor-pointer text-ink underline underline-offset-2">
								Church documents
							</IntentLink>
							.
						</p>
						<IconButton
							icon={Cancel01Icon}
							label="Dismiss"
							size="sm"
							variant="soft"
							onClick={() => setSavedTemplate(null)}
						/>
					</div>
				) : null}
				{template === "behind" && mode === "edit" ? <TemplateNotice onCompare={() => void compare()} /> : null}
				{/* The editor stays in the page while the preview shows, so its content, cursor and undo history stay. */}
				<div hidden={mode !== "edit"} className="flex flex-col gap-3">
					<div className="sticky top-[calc(var(--ef-topbar-h)+28px)] z-20 overflow-hidden rounded-card bg-surface-raised shadow-[0_0_0_1px_var(--ef-line)]">
						{editor ? (
							<>
								<EditorToolbar
									editor={editor}
									brand={brand}
									pageSetup={{ open: setupOpen, controls: setupId, toggle: () => setSetupOpen((open) => !open) }}
								/>
								<BlockControls editor={editor} palette={brand.palette} />
							</>
						) : (
							<div className="h-[49px]" />
						)}
					</div>
					{setupOpen && editor ? (
						<PageSetupPanel
							editor={editor}
							base={() => base.current}
							id={setupId}
							onClose={() => setSetupOpen(false)}
						/>
					) : null}
					{page.tile ? (
						<p className="text-center text-sm font-medium text-text-2">
							<span className="rounded-pill bg-green-100 px-2.5 py-1 text-ink">4 per sheet</span>
							<span className="ml-2">
								One card shown. The preview and the PDF print 4 on a sheet{page.tile.cutMarks ? ", with cut marks" : ""}
								.
							</span>
						</p>
					) : null}
					<div className="ef-sheet" style={sheet}>
						<div className="ef-paper">
							{empty && editor ? <p className="ef-empty">This document is empty. Use Insert to add a block.</p> : null}
							<EditorContent editor={editor} />
							{legal ? (
								<footer className="ef-notice">
									<span>{LEGAL_NOTICE}</span>
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
				{mode === "compare" ? (
					<TemplateCompare
						docId={docId}
						brand={brand}
						revision={shownRevision}
						// A compare that read a newer revision (saved in another tab) reloads the page onto it: nothing here is unsaved.
						onBack={(stale) => (stale ? window.location.reload() : setMode("edit"))}
						onAccepted={onAccepted}
					/>
				) : null}
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
			<LeaveDialog request={leave.request} onSave={save} onDone={leave.close} />
			<SaveAsTemplateDialog
				key={templateDialog.opening}
				open={templateDialog.open}
				onOpenChange={(open) => setTemplateDialog((d) => ({ ...d, open }))}
				docId={docId}
				title={title}
				revision={shownRevision}
				unsaved={status.kind !== "saved"}
				saving={status.kind === "saving"}
				onSaveFirst={save}
				onSaved={setSavedTemplate}
			/>
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

/** The template this document came from has changed since: a plain notice with the way to compare. */
function TemplateNotice({ onCompare }: { onCompare: () => void }) {
	return (
		<section
			aria-label="Template updated"
			className="flex flex-wrap items-center justify-between gap-x-4 gap-y-3 rounded-card bg-surface-raised px-4 py-3 shadow-[0_0_0_1px_var(--ef-line)] app-sm:px-5"
		>
			<p className="flex min-w-0 flex-[1_1_18rem] flex-wrap items-baseline gap-x-2 gap-y-1 text-sm">
				<span className="inline-flex h-[26px] flex-none items-center rounded-md bg-blue-100 px-2.5 font-semibold text-blue-600">
					Template updated
				</span>
				<span className="min-w-0 flex-[1_1_14rem] text-pretty text-text-2">
					The template this document came from has changed. Compare to choose which changes to take.
				</span>
			</p>
			<Button variant="primary" size="sm" icon={FileSyncIcon} onClick={onCompare}>
				Compare with template
			</Button>
		</section>
	);
}

function SaveStatusText({
	status,
	revision,
	accepted,
	onRetry,
}: {
	status: SaveStatus;
	revision: string;
	accepted: string | null;
	onRetry: () => void;
}) {
	return (
		<p
			role="status"
			aria-live="polite"
			className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1 text-sm text-text-2"
		>
			{status.kind === "saved" ? (
				<span>
					{accepted ? `${accepted} ` : "Saved "}
					<span className="tabular-nums">· Revision {revision}</span>
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

/** A way out of the page that waits for an answer: `go` leaves, `stay` (if any) puts back what the way out undid. */
type LeaveRequest = { go: () => void; stay?: () => void };

/**
 * Asks before an in-app link, the Back button or a page-wide action such as Sign out (`leavePage`) leaves the page
 * while the document has changes that are not saved. The question is an Everyfield dialog (LeaveDialog), never a
 * browser confirm. Closing or reloading the tab can only show the browser's own beforeunload prompt; after the person
 * chose to leave, it stays quiet. The listeners stay on for the life of the editor and ask `unsaved` at the moment of
 * the click or the Back press, so no edit, however close to the click, gets past them.
 */
function useLeaveGuard(editor: Editor | null, unsaved: () => boolean) {
	const router = useRouter();
	const [request, setRequest] = useState<LeaveRequest | null>(null);
	useEffect(() => {
		if (!editor) return;
		// The person chose "Leave without saving" for a way out that loads a new page (Sign out): no second question.
		let released = false;
		const beforeUnload = (event: BeforeUnloadEvent) => {
			if (released || !unsaved()) return;
			event.preventDefault();
			event.returnValue = "";
		};
		const onClick = (event: MouseEvent) => {
			if (event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey) return;
			const link = (event.target as Element | null)?.closest?.("a[href]");
			if (!(link instanceof HTMLAnchorElement) || link.hasAttribute("download") || link.target === "_blank") return;
			const url = new URL(link.href, window.location.href);
			if (url.origin !== window.location.origin) return;
			if (url.pathname === window.location.pathname && url.search === window.location.search) return;
			if (!unsaved()) return;
			event.preventDefault();
			event.stopPropagation();
			setRequest({ go: () => router.push(`${url.pathname}${url.search}${url.hash}`) });
		};
		// The Back button: a sentinel entry with the same address takes the first Back press. The edit that makes the
		// document unsaved pushes it, so it is in place before any Back press. Leaving the sentinel with nothing unsaved
		// (after a Save) goes on back, so one press still leaves the page.
		// The Settings dialog opens over the editor with its own history entries (/settings/account). They can sit above
		// the sentinel, so an edit checks the entry it is on, and Back onto a Settings entry is no way out: the editor is
		// still there under the dialog.
		const here = () => window.location.pathname + window.location.search;
		const home = here();
		const onSentinel = () => window.history.state?.efLeaveGuard === true;
		let armed = onSentinel();
		let leaving = false;
		const pushSentinel = () => {
			window.history.pushState({ ...window.history.state, efLeaveGuard: true }, "", window.location.href);
			armed = true;
		};
		const arm = () => {
			if (!onSentinel() && unsaved()) pushSentinel();
		};
		const onPopState = () => {
			const left = armed;
			armed = onSentinel();
			if (leaving || !left || armed || here() !== home) return;
			const back = () => {
				leaving = true;
				window.history.back();
			};
			if (unsaved()) setRequest({ go: back, stay: pushSentinel });
			else back();
		};
		const release = holdLeave((go) => {
			if (!unsaved()) return false;
			setRequest({
				go: () => {
					released = true;
					go();
				},
			});
			return true;
		});
		editor.on("update", arm);
		window.addEventListener("beforeunload", beforeUnload);
		window.addEventListener("popstate", onPopState);
		document.addEventListener("click", onClick, true);
		return () => {
			release();
			editor.off("update", arm);
			window.removeEventListener("beforeunload", beforeUnload);
			window.removeEventListener("popstate", onPopState);
			document.removeEventListener("click", onClick, true);
		};
	}, [editor, unsaved, router]);
	return { request, close: () => setRequest(null) };
}

/** Save and leave, Leave without saving, or Cancel. A save that fails keeps the page, with the reason in the status. */
function LeaveDialog({
	request,
	onSave,
	onDone,
}: {
	request: LeaveRequest | null;
	onSave: () => Promise<boolean>;
	onDone: () => void;
}) {
	const [saving, setSaving] = useState(false);
	const finish = (leave: boolean) => {
		if (!request) return;
		onDone();
		if (leave) request.go();
		else request.stay?.();
	};
	return (
		<Dialog
			open={request !== null}
			onOpenChange={(open) => {
				if (!open && !saving) finish(false);
			}}
		>
			<DialogContent size="md">
				<DialogHeader
					title="Leave without saving?"
					description="This document has changes that are not saved. If you leave now, they are lost."
					closable={false}
				/>
				<DialogFooter>
					<Button variant="secondary" disabled={saving} onClick={() => finish(false)}>
						Cancel
					</Button>
					<Button variant="danger" disabled={saving} onClick={() => finish(true)}>
						Leave without saving
					</Button>
					<Button
						variant="primary"
						loading={saving}
						onClick={async () => {
							setSaving(true);
							const saved = await onSave();
							setSaving(false);
							finish(saved);
						}}
					>
						Save and leave
					</Button>
				</DialogFooter>
			</DialogContent>
		</Dialog>
	);
}
