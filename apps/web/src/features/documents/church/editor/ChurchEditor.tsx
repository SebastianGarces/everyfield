"use client";

import {
	Cancel01Icon,
	Clock01Icon,
	Delete02Icon,
	Edit02Icon,
	FileSyncIcon,
	FloppyDiskIcon,
	MoreHorizontalIcon,
	FileAddIcon,
	ViewIcon,
} from "@hugeicons/core-free-icons";
import {
	LEGAL_NOTICE,
	pageBox,
	tileBox,
	type DocBrand,
	type DocDocument,
	type ExportFormat,
} from "@everyfield/contracts/documents";
import {
	Button,
	ConfirmDialog,
	IconButton,
	IntentLink,
	Menu,
	MenuContent,
	MenuItem,
	MenuTrigger,
	Tooltip,
} from "@everyfield/ui/controls";
import { EditorContent, EditorContext, useEditor, useEditorState } from "@tiptap/react";
import { useCallback, useId, useMemo, useState, type CSSProperties, type FormEvent } from "react";
import { SAVE_SHORTCUT, shortcutMark } from "../../../../components/save/leave.ts";
import { useLocalStore, useStore } from "../../../../components/store.ts";
import { saveChurchDocument } from "../actions.ts";
import { ChurchPdf } from "../ChurchPdf.tsx";
import type { RevisionRow } from "../server.ts";
import { VersionHistory } from "../VersionHistory.tsx";
import { deleteAllContent } from "./blocks.ts";
import type { LiveAssets } from "./brand-assets.ts";
import { createChurchEditorStore, sameAsSaved } from "./ChurchEditor.store.ts";
import { editorContent } from "./document-json.ts";
import "./editor.css";
import { editorExtensions } from "./extensions.ts";
import { BlockControls } from "./LayoutControls.tsx";
import { TABLE_REFUSED } from "./TableControls.tsx";
import { readPage } from "./layout.ts";
import { paletteVars } from "./paper.ts";
import { PageSetupPanel } from "./PageSetup.tsx";
import { SaveAsTemplateDialog, churchTemplates, type TemplateSaved } from "./SaveAsTemplate.tsx";
import { BlockShortcuts, LeaveDialog, SaveStatusText, useLeaveGuard, type SaveStatus } from "./session.tsx";
import { TemplateCompare, templateCompares } from "./TemplateCompare.tsx";
import { EditorToolbar } from "./Toolbar.tsx";

const NOTICE_WHY =
	"Every formal or legal document prints this notice, in the PDF and the Word file. Editing the document cannot remove it.";

type Props = {
	docId: string;
	title: string;
	document: DocDocument;
	brand: DocBrand;
	assets: LiveAssets;
	mergeValues: Record<string, string>;
	revision: string;
	onRevision: (revision: string, formats: ExportFormat[]) => void;
	revisions: RevisionRow[];
	file: (format: string, revision: string) => string;
	template: "behind" | "current" | null;
	templateName: string | null;
	onAccepted: (document: DocDocument, revision: string, taken: number) => void;
	accepted?: string | null;
};

export default function ChurchEditor({
	docId,
	title,
	document: stored,
	brand,
	assets,
	mergeValues,
	revision: initialRevision,
	onRevision,
	revisions,
	file,
	template,
	templateName,
	onAccepted,
	accepted = null,
}: Props) {
	const previewSrc = (at: string) => file("pdf", at);
	const store = useLocalStore(() =>
		createChurchEditorStore({ docId, revision: initialRevision, body: stored, port: { save: saveChurchDocument } }),
	);
	const actions = useStore(store, (state) => state.actions);
	const saved = useStore(store, (state) => state.saved);
	const phase = useStore(store, (state) => state.phase);
	const refused = useStore(store, (state) => state.refused);
	const shownRevision = saved.revision;
	const [mode, setMode] = useState<"edit" | "preview" | "history" | "compare">("edit");

	const extensions = useMemo(() => [...editorExtensions(assets.assets), BlockShortcuts], [assets]);
	const content = useMemo(() => editorContent(stored), [stored]);
	const editorProps = useMemo(
		() => ({
			attributes: {
				"aria-label": `${title}, document body`,
				"aria-multiline": "true",
				role: "textbox",
				spellcheck: "true",
			},
		}),
		[title],
	);
	const editor = useEditor({
		extensions,
		content,
		immediatelyRender: true,
		onCreate: ({ editor: created }) => {
			actions.began(created);
			assets.drawIn(created);
		},
		onUpdate: ({ editor: changed }) => actions.edited(changed),
		onSelectionUpdate: actions.moved,
		editorProps,
	});

	const same =
		useEditorState({
			editor,
			selector: ({ editor: current }) => !current || sameAsSaved(saved.doc, current.state.doc),
		}) ?? true;
	const status: SaveStatus =
		phase.kind === "saving"
			? { kind: "saving" }
			: phase.kind === "failed"
				? { kind: "failed", reason: phase.reason }
				: same
					? { kind: "saved" }
					: { kind: "dirty" };

	const unsaved = useCallback(() => !!editor && actions.unsaved(editor), [editor, actions]);

	const save = useCallback(
		async (): Promise<boolean> => (editor ? actions.save(editor, onRevision) : false),
		[editor, actions, onRevision],
	);

	function submit(event: FormEvent<HTMLFormElement>) {
		event.preventDefault();
		const fromButton = (event.nativeEvent as SubmitEvent).submitter !== null;
		void save().then((ok) => ok && fromButton && editor?.view.focus());
	}

	const leave = useLeaveGuard(editor, unsaved);

	const preview = useCallback(async () => {
		if (status.kind !== "saved" && !(await save())) return;
		setMode("preview");
	}, [save, status.kind]);

	const compare = useCallback(async () => {
		if (status.kind !== "saved" && !(await save())) return;
		templateCompares.prefetch(docId);
		setMode("compare");
	}, [save, status.kind, docId]);

	const deleteAll = useCallback(() => {
		if (editor) deleteAllContent(editor);
	}, [editor]);

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
			"--page-w": px(width),
			"--page-h": px(height),
			"--pad-x": px(pad.x),
			"--pad-y": px(pad.y),
			...paletteVars(brand.palette),
		} as CSSProperties;
	}, [page, brand]);

	const [templateDialog, setTemplateDialog] = useState({ open: false, opening: 0, requestKey: "" });
	const [savedTemplate, setSavedTemplate] = useState<TemplateSaved | null>(null);

	const editorContext = useMemo(() => ({ editor }), [editor]);
	const empty = useEditorState({ editor, selector: ({ editor: e }) => (e ? e.state.doc.childCount === 0 : true) });
	const legal = stored.class === "formal/legal";

	return (
		<EditorContext.Provider value={editorContext}>
			<div className="flex flex-col gap-3">
				<form
					className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2"
					{...shortcutMark(SAVE_SHORTCUT)}
					onSubmit={submit}
				>
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
							<>
								<Button variant="secondary" size="sm" icon={ViewIcon} onClick={() => void preview()}>
									Preview
								</Button>
								<Button variant="secondary" size="sm" icon={Clock01Icon} onClick={() => setMode("history")}>
									Version history
								</Button>
							</>
						) : (
							<Button variant="secondary" size="sm" icon={Edit02Icon} onClick={() => setMode("edit")}>
								Back to editing
							</Button>
						)}
						<Button variant="primary" size="sm" icon={FloppyDiskIcon} loading={status.kind === "saving"} type="submit">
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
									onSelect={() => {
										churchTemplates.retry();
										const requestKey = crypto.randomUUID();
										setTemplateDialog((d) => ({ open: true, opening: d.opening + 1, requestKey }));
									}}
								>
									Save as template
								</MenuItem>
							</MenuContent>
						</Menu>
					</div>
				</form>
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
							<IntentLink href="/documents/church" className="text-ink underline underline-offset-2">
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
				{template === "behind" && mode === "edit" ? (
					<TemplateNotice churchTemplate={templateName} onCompare={() => void compare()} />
				) : null}
				<div hidden={mode !== "edit"} className="flex flex-col gap-3">
					<div className="sticky top-[calc(var(--ef-topbar-h)+28px)] z-20 overflow-hidden rounded-card bg-surface-raised shadow-[0_0_0_1px_var(--ef-line)]">
						{editor ? (
							<>
								<EditorToolbar
									editor={editor}
									church={{
										brand,
										mergeValues,
										pageSetup: { open: setupOpen, controls: setupId, toggle: () => setSetupOpen((open) => !open) },
									}}
								/>
								<BlockControls editor={editor} palette={brand.palette} />
								{refused ? (
									<p
										role="alert"
										data-table-refused={refused === TABLE_REFUSED ? "" : undefined}
										data-condition-refused={refused === TABLE_REFUSED ? undefined : ""}
										className="px-3 py-2 text-xs font-medium text-magenta-600"
									>
										{refused}
									</p>
								) : null}
							</>
						) : (
							<div className="h-[49px]" />
						)}
					</div>
					{setupOpen && editor ? (
						<PageSetupPanel
							editor={editor}
							base={() => store.getState().saved.body}
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
											className="inline-flex items-center gap-1 rounded-sm bg-[var(--paper-muted)] px-2 py-0.5 text-xs font-semibold text-[var(--paper-ink)]"
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
				{mode === "history" ? (
					<VersionHistory
						revisions={revisions}
						title={title}
						current={shownRevision}
						file={file}
						page={{ width: pageBox(page)?.width ?? 612, height: pageBox(page)?.height ?? 792 }}
					/>
				) : null}
				{mode === "compare" ? (
					<TemplateCompare
						docId={docId}
						brand={brand}
						revision={shownRevision}
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
			{templateDialog.opening > 0 ? (
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
					requestKey={templateDialog.requestKey}
				/>
			) : null}
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

function TemplateNotice({ churchTemplate, onCompare }: { churchTemplate: string | null; onCompare: () => void }) {
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
					{churchTemplate ? (
						<>
							Your church&rsquo;s template &ldquo;{churchTemplate}&rdquo; has changed since this document was made from
							it. Compare to choose which changes to take.
						</>
					) : (
						"The template this document came from has changed. Compare to choose which changes to take."
					)}
				</span>
			</p>
			<Button variant="primary" size="sm" icon={FileSyncIcon} onClick={onCompare}>
				Compare with template
			</Button>
		</section>
	);
}
