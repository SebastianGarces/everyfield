"use client";

import {
	Archive02Icon,
	FileImportIcon,
	FloppyDiskIcon,
	MoreHorizontalIcon,
	Refresh01Icon,
	StarIcon,
} from "@hugeicons/core-free-icons";
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
import { focusOnMount } from "@everyfield/ui/foundations";
import { EditorContent, EditorContext, useEditor, useEditorState } from "@tiptap/react";
import { useRouter } from "next/navigation";
import { useCallback, useRef, useState } from "react";
import { writeAddress } from "../../../components/location.ts";
import { SAVE_SHORTCUT, shortcutMark } from "../../../components/save/leave.ts";
import { useLocalStore, useStore } from "../../../components/store.ts";
import { archiveOwnedDocument, designateOwnedDocument, saveOwnedDocument, type DocumentOutcome } from "../actions.ts";
import "../church/editor/editor.css";
import { nativeExtensions } from "../church/editor/extensions.ts";
import { BlockControls } from "../church/editor/LayoutControls.tsx";
import { TABLE_REFUSED } from "../church/editor/TableControls.tsx";
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
import { EMPTY, createNativeEditorStore, sameDoc, toEditor } from "./NativeEditor.store.ts";

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
		return { status: "lost" };
	}
}

const port = {
	save: saveOwnedDocument,
	importFile: importWritten,
	designate: designateOwnedDocument,
	created: (id: string) => writeAddress(`/documents/written/${id}`, { replace: true }),
};

export default function NativeEditor({
	doc,
	scope,
	canStore,
}: {
	doc: WrittenView | null;
	scope: "church" | "account";
	canStore: boolean;
}) {
	const router = useRouter();
	const store = useLocalStore(() => createNativeEditorStore({ doc, port }));
	const actions = useStore(store, (state) => state.actions);
	const saved = useStore(store, (state) => state.saved);
	const title = useStore(store, (state) => state.title);
	const phase = useStore(store, (state) => state.phase);
	const errors = useStore(store, (state) => state.errors);
	const note = useStore(store, (state) => state.note);
	const refused = useStore(store, (state) => state.refused);
	const [archiveOpen, setArchiveOpen] = useState(false);
	const fileInput = useRef<HTMLInputElement>(null);

	const editor = useEditor({
		extensions: [...nativeExtensions(), BlockShortcuts],
		content: toEditor(doc?.body ?? EMPTY),
		immediatelyRender: true,
		editorProps: {
			attributes: {
				"aria-label": "Document text",
				"aria-multiline": "true",
				role: "textbox",
				spellcheck: "true",
			},
		},
		onCreate: ({ editor: created }) => actions.began(created),
		onUpdate: actions.settle,
		onSelectionUpdate: actions.settle,
	});

	const bodyChanged =
		useEditorState({
			editor,
			selector: ({ editor: current }) => !!current && !sameDoc(saved.doc, current.state.doc),
		}) ?? false;
	const changed = bodyChanged || title.trim() !== saved.title;
	const status: SaveStatus =
		phase.kind === "saving"
			? { kind: "saving" }
			: phase.kind === "failed"
				? { kind: "failed", reason: phase.reason }
				: changed
					? { kind: "dirty" }
					: { kind: "saved" };

	const save = useCallback(async () => (editor ? actions.save(editor) : false), [editor, actions]);
	const unsaved = useCallback(() => !!editor && actions.unsaved(editor), [editor, actions]);
	const leave = useLeaveGuard(editor, unsaved);

	function reload() {
		actions.discard();
		window.location.reload();
	}

	async function archive() {
		const base = store.getState().saved;
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
		actions.discard();
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
				{saved.kind === "core_values" || doc?.copied || saved.textRevision ? (
					<div className="flex w-full max-w-[816px] flex-col gap-2 self-center">
						{saved.kind === "core_values" ? (
							<div>
								<Tag>Core values</Tag>
							</div>
						) : null}
						{doc?.copied ? <CopiedNote /> : null}
						{saved.textRevision ? <TextRevisionNote /> : null}
					</div>
				) : null}
				<div className="w-full max-w-[816px] self-center">
					<Field label="Title" error={errors.title}>
						<Input
							ref={doc ? undefined : focusOnMount}
							value={title}
							maxLength={200}
							onChange={(event) => actions.typeTitle(event.target.value)}
						/>
					</Field>
				</div>
				<div className="flex w-full max-w-[816px] flex-wrap items-center justify-between gap-x-4 gap-y-2 self-center">
					{conflict ? (
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
					<form
						className="flex flex-wrap items-center gap-2"
						{...shortcutMark(SAVE_SHORTCUT)}
						onSubmit={(event) => {
							event.preventDefault();
							const fromButton = (event.nativeEvent as SubmitEvent).submitter !== null;
							void save().then((ok) => ok && fromButton && editor?.view.focus());
						}}
					>
						<Button
							variant="secondary"
							size="sm"
							icon={FileImportIcon}
							disabled={!canStore || busy || bodyChanged || (saved.id !== null && changed)}
							onClick={() => fileInput.current?.click()}
						>
							Import a text or Word file
						</Button>
						<input
							ref={fileInput}
							type="file"
							tabIndex={-1}
							aria-hidden="true"
							accept=".txt,.docx,text/plain,application/vnd.openxmlformats-officedocument.wordprocessingml.document"
							className="hidden"
							onChange={(event) => {
								const file = event.target.files?.[0];
								event.target.value = "";
								if (file && editor) actions.importFile(editor, file);
							}}
						/>
						{saved.id ? (
							<Menu>
								<MenuTrigger asChild>
									<IconButton icon={MoreHorizontalIcon} label="More actions" size="sm" />
								</MenuTrigger>
								<MenuContent align="end">
									{saved.kind === "native" ? (
										<MenuItem icon={StarIcon} disabled={busy || changed} onSelect={() => void actions.designate(scope)}>
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
							type="submit"
						>
							Save
						</Button>
					</form>
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
					{editor ? (
						<>
							<EditorToolbar editor={editor} />
							<BlockControls editor={editor} palette={null} />
							{refused ? (
								<p role="alert" data-table-refused="" className="px-3 py-2 text-xs font-medium text-magenta-600">
									{TABLE_REFUSED}
								</p>
							) : null}
						</>
					) : (
						<div className="h-[49px]" />
					)}
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
