"use client";

import { BlockEditor, type BlockEditorHandle, type BlockKind, type BlockRow } from "@/components/BlockEditor";
import { Button, ConfirmDialog } from "@everyfield/ui/controls";
import { useEffect, useRef, useState } from "react";
import { hideWikiSource, publishWikiArticle, saveWikiDraft, type OrgResult } from "./actions.ts";
import {
	EDITOR_BODY_LIMIT,
	articlePath,
	articleTextChanged,
	changedSectionLabels,
	editorBlocksFromBody,
	editorHasText,
	editorWriteBody,
	type EditorBlock,
} from "./model.ts";

type Row = { key: string; block: EditorBlock };
type ArticleState = "published" | "hide" | "draft" | "inherited" | null;

const EMPTY_TEXT = "Add article text before you save.";
const LONG_TEXT = "Shorten the article. It is too long to save.";

function kindValue(block: EditorBlock): BlockKind {
	if (block.kind === "heading") return block.level === 3 ? "subheading" : "heading";
	if (block.kind === "list") return block.ordered ? "numbered" : "list";
	if (block.kind === "quote") return "quote";
	return "paragraph";
}

function applyKind(block: EditorBlock, value: BlockKind): EditorBlock {
	const text = block.text;
	if (value === "heading") return { kind: "heading", level: 2, text };
	if (value === "subheading") return { kind: "heading", level: 3, text };
	if (value === "quote") return { kind: "quote", text };
	if (value === "list") return { kind: "list", ordered: false, text };
	if (value === "numbered") return { kind: "list", ordered: true, text };
	return { kind: "paragraph", text };
}

/** The shared editor's rows, and back: a row whose kind did not change keeps its block (a level 4 heading stays one). */
function toRows(rows: Row[]): BlockRow[] {
	return rows.map((row) => ({ key: row.key, kind: kindValue(row.block), text: row.block.text }));
}
function fromRows(next: BlockRow[], current: Row[]): Row[] {
	return next.map((row) => {
		const before = current.find((item) => item.key === row.key);
		if (before && kindValue(before.block) === row.kind)
			return { key: row.key, block: { ...before.block, text: row.text } };
		return { key: row.key, block: applyKind(before?.block ?? { kind: "paragraph", text: row.text }, row.kind) };
	});
}

function seedRows(body: string | null, contentType: string): Row[] {
	const parsed = body ? editorBlocksFromBody(contentType, body) : [];
	const blocks = parsed.length ? parsed : [{ kind: "paragraph" as const, text: "" }];
	return blocks.map((block, index) => ({ key: `block-${index + 1}`, block }));
}

function failureCopy(status: Exclude<OrgResult["status"], "ok">): string {
	if (status === "conflict") return "Someone else saved this article. Reload the page, then try again.";
	if (status === "denied" || status === "invalid") return "This article cannot be edited.";
	if (status === "review") return "This change needs a review before it can be saved.";
	return "That did not save. Try again.";
}

function successCopy(kind: "save" | "publish" | "hide", state: ArticleState): string {
	if (kind === "publish") return "Article published.";
	if (kind === "hide") return "Source hidden.";
	if (state === "hide") return "Draft saved. This source stays hidden until you publish it.";
	return "Draft saved.";
}

export function WikiEditor({
	articleId,
	slug,
	organizationId,
	revision: initialRevision,
	state: initialState,
	initialBody,
	initialContentType,
	baselineBody,
	baselineContentType,
}: {
	articleId: string;
	slug: string;
	organizationId: string;
	revision: string;
	state: ArticleState;
	initialBody: string | null;
	initialContentType: string;
	baselineBody: string | null;
	baselineContentType: string;
}) {
	const [rows, setRows] = useState<Row[]>(() => seedRows(initialBody, initialContentType));
	const [revision, setRevision] = useState(initialRevision);
	const [articleState, setArticleState] = useState<ArticleState>(initialState);
	const [busy, setBusy] = useState<"save" | "publish" | "hide" | null>(null);
	const [status, setStatus] = useState("");
	const [formError, setFormError] = useState("");
	const [publishOpen, setPublishOpen] = useState(false);
	const [hideOpen, setHideOpen] = useState(false);
	const revisionRef = useRef(initialRevision);
	const lock = useRef(false);
	const editor = useRef<BlockEditorHandle>(null);
	const baseline = baselineBody ? editorBlocksFromBody(baselineContentType, baselineBody) : [];
	const blocks = rows.map((row) => row.block);
	const changes = changedSectionLabels(baseline, blocks);
	const consequences = [...changes, "Finished readers will see Updated since you read it."];
	const textChanged = articleTextChanged(baseline, blocks);

	function writeBody(): string {
		return editorWriteBody(initialBody, initialContentType, blocks);
	}

	function problem(): string | null {
		if (!editorHasText(blocks)) return EMPTY_TEXT;
		if (writeBody().length > EDITOR_BODY_LIMIT) return LONG_TEXT;
		return null;
	}

	async function commit(kind: "save" | "publish" | "hide"): Promise<string | null> {
		if (lock.current) return "Wait for the current save to finish.";
		if (kind !== "hide") {
			const invalid = problem();
			if (invalid) return invalid;
		}
		lock.current = true;
		setBusy(kind);
		setFormError("");
		const body = writeBody();
		const command = {
			requestKey: crypto.randomUUID(),
			expectedRevision: revisionRef.current,
			articleId,
			organizationId,
			body,
			cachePath: articlePath(slug).slice(0, 400),
		};
		try {
			const result =
				kind === "hide"
					? await hideWikiSource(command)
					: kind === "publish"
						? await publishWikiArticle(command)
						: await saveWikiDraft(command);
			if (result.status !== "ok") return failureCopy(result.status);
			revisionRef.current = result.revision;
			setRevision(result.revision);
			setArticleState(result.state);
			setStatus(successCopy(kind, result.state));
			return null;
		} catch {
			return "That did not save. Try again.";
		} finally {
			lock.current = false;
			setBusy(null);
		}
	}

	function showProblem(message: string) {
		setFormError(message);
		setStatus("");
		if (message === EMPTY_TEXT) {
			const key = rows[0]?.key;
			if (key) editor.current?.focus(key);
		}
	}

	async function save() {
		const message = await commit("save");
		if (message) showProblem(message);
	}

	function openPublish() {
		const message = problem();
		if (message) {
			showProblem(message);
			return;
		}
		setFormError("");
		setPublishOpen(true);
	}

	function openHide() {
		setFormError("");
		setHideOpen(true);
	}

	const emptyRow = rows.find((row) => !row.block.text.trim());
	const emptyError = formError === EMPTY_TEXT && emptyRow ? { key: emptyRow.key, message: formError } : null;
	const locked = busy !== null || publishOpen || hideOpen;
	const canHide = revision !== "0" && articleState !== "hide";

	useEffect(() => {
		const root = document.documentElement;
		const previous = root.style.scrollPaddingBottom;
		root.style.scrollPaddingBottom = "128px";
		return () => {
			root.style.scrollPaddingBottom = previous;
		};
	}, []);

	return (
		<div className="rounded-card bg-surface px-6 py-8 shadow-card max-app-sm:px-4 sm:px-11">
			<form
				className="mx-auto flex max-w-[700px] flex-col gap-8"
				aria-label="Organization version"
				onSubmit={(event) => event.preventDefault()}
			>
				<BlockEditor
					ref={editor}
					rows={toRows(rows)}
					onChange={(next) => setRows((current) => fromRows(next, current))}
					disabled={locked}
					error={emptyError}
				/>
				<div className="sticky bottom-0 z-[2] -mx-6 -mb-8 flex flex-col gap-3 rounded-b-card border-t border-line bg-surface px-6 pt-3 pb-[max(12px,env(safe-area-inset-bottom))] max-app-sm:-mx-4 max-app-sm:px-4 sm:-mx-11 sm:px-11">
					<div role="alert" className="empty:hidden">
						{formError && formError !== EMPTY_TEXT ? (
							<p className="text-sm font-medium text-magenta-600">{formError}</p>
						) : null}
					</div>
					<p role="status" className="min-h-6 text-sm text-text-2">
						{status}
					</p>
					<div className="flex flex-wrap gap-3">
						<Button
							type="button"
							loading={busy === "save"}
							disabled={locked && busy !== "save"}
							onClick={() => void save()}
						>
							Save draft
						</Button>
						<Button type="button" variant="primary" disabled={locked} onClick={openPublish}>
							Review and publish
						</Button>
						{canHide ? (
							<Button type="button" variant="danger" disabled={locked} onClick={openHide}>
								Hide this source
							</Button>
						) : null}
					</div>
				</div>
				<ConfirmDialog
					open={publishOpen}
					onOpenChange={setPublishOpen}
					title="Publish this article?"
					description="Readers of this wiki will see this version."
					consequences={textChanged ? consequences : ["Finished readers will see Updated since you read it."]}
					confirmLabel="Publish article"
					onConfirm={async () => {
						const message = await commit("publish");
						if (message) throw new Error(message);
					}}
				/>
				<ConfirmDialog
					open={hideOpen}
					onOpenChange={setHideOpen}
					title="Hide this source?"
					description="You can publish this source again later."
					tone="danger"
					consequences={["The default wiki skips this source.", "People can still open another published source."]}
					confirmLabel="Hide this source"
					onConfirm={async () => {
						const message = await commit("hide");
						if (message) throw new Error(message);
					}}
				/>
			</form>
		</div>
	);
}
