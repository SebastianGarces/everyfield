"use client";

import { organizationBodyFits } from "@everyfield/contracts/wiki";
import { Button, ConfirmDialog, Field, Select, Textarea } from "@everyfield/ui/controls";
import { useFocusRequest } from "@everyfield/ui/foundations";
import { useReducer, useRef, useState, useTransition } from "react";
import { hideWikiSource, publishWikiArticle, saveWikiDraft, type OrgResult } from "./actions.ts";
import {
	articlePath,
	articleTextChanged,
	changedSectionLabels,
	editorBlocksFromBody,
	editorHasText,
	editorWriteBody,
	type EditorBlock,
	type FixedBlock,
} from "./model.ts";
import { ArticleBlocks } from "./prose.tsx";

type Row = { key: string; block: EditorBlock };
type TextBlock = Exclude<EditorBlock, { kind: "fixed" }>;
type ArticleState = "published" | "hide" | "draft" | "inherited" | null;
type Kind = "paragraph" | "heading" | "subheading" | "quote" | "list" | "numbered";

const KINDS: { value: Kind; label: string }[] = [
	{ value: "paragraph", label: "Paragraph" },
	{ value: "heading", label: "Heading" },
	{ value: "subheading", label: "Subheading" },
	{ value: "quote", label: "Quote" },
	{ value: "list", label: "List" },
	{ value: "numbered", label: "Numbered list" },
];

const EMPTY_TEXT = "Add article text before you save.";
const LONG_TEXT = "Shorten the article. It is too long to save.";

const FIXED_NAME: Record<FixedBlock["kind"], string> = {
	table: "Table",
	callout: "Callout",
	code: "Code",
	diagram: "Diagram",
};

function kindValue(block: TextBlock): Kind {
	if (block.kind === "heading") return block.level === 3 ? "subheading" : "heading";
	if (block.kind === "list") return block.ordered ? "numbered" : "list";
	if (block.kind === "quote") return "quote";
	return "paragraph";
}

function applyKind(block: TextBlock, value: Kind): EditorBlock {
	const text = block.text;
	if (value === "heading") return { kind: "heading", level: 2, text };
	if (value === "subheading") return { kind: "heading", level: 3, text };
	if (value === "quote") return { kind: "quote", text };
	if (value === "list") return { kind: "list", ordered: false, text };
	if (value === "numbered") return { kind: "list", ordered: true, text };
	return { kind: "paragraph", text };
}

function textLabel(block: TextBlock): string {
	if (block.kind === "heading") return block.level === 3 ? "Subheading" : "Heading";
	if (block.kind === "quote") return "Quote";
	if (block.kind === "list") return "List items";
	return "Paragraph";
}

type Doc = { rows: Row[]; next: number; focus: { key: string; n: number } | null };

type Edit =
	| { type: "update"; key: string; block: EditorBlock }
	| { type: "move"; index: number; direction: -1 | 1 }
	| { type: "remove"; key: string }
	| { type: "add" }
	| { type: "focus"; key: string };

function seedDoc({ body, contentType }: { body: string | null; contentType: string }): Doc {
	const parsed = body ? editorBlocksFromBody(contentType, body) : [];
	const blocks = parsed.length ? parsed : [{ kind: "paragraph" as const, text: "" }];
	return {
		rows: blocks.map((block, index) => ({ key: `block-${index + 1}`, block })),
		next: blocks.length + 1,
		focus: null,
	};
}

const focusOn = (doc: Doc, key: string): Doc["focus"] => ({ key, n: (doc.focus?.n ?? 0) + 1 });

function edit(doc: Doc, change: Edit): Doc {
	const { rows } = doc;
	if (change.type === "update")
		return { ...doc, rows: rows.map((row) => (row.key === change.key ? { ...row, block: change.block } : row)) };
	if (change.type === "focus") return { ...doc, focus: focusOn(doc, change.key) };
	if (change.type === "add") {
		const key = `block-${doc.next}`;
		return {
			rows: [...rows, { key, block: { kind: "paragraph", text: "" } }],
			next: doc.next + 1,
			focus: focusOn(doc, key),
		};
	}
	if (change.type === "remove") {
		if (rows.length < 2) return doc;
		const index = rows.findIndex((row) => row.key === change.key);
		const landing = rows[Math.max(0, index - 1)]?.key;
		return {
			...doc,
			rows: rows.filter((row) => row.key !== change.key),
			focus: landing ? focusOn(doc, landing) : doc.focus,
		};
	}
	const target = change.index + change.direction;
	const row = rows[change.index];
	const other = rows[target];
	if (!row || !other) return doc;
	const next = rows.slice();
	next[change.index] = other;
	next[target] = row;
	return { ...doc, rows: next, focus: focusOn(doc, row.key) };
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

/** A table, callout, diagram or code block: shown as readers see it and saved as it is. */
function FixedView({ block }: { block: FixedBlock }) {
	const name = FIXED_NAME[block.kind];
	return (
		<div className="flex flex-col gap-2">
			<p className="text-sm text-text-2">{name}. It stays as it is when you save. You can move it or remove it.</p>
			<div className="rounded-card border border-line px-4 py-1">
				<ArticleBlocks blocks={[block]} size="sm" />
			</div>
		</div>
	);
}

function TextFields({
	block,
	index,
	error,
	focusRequest,
	onChange,
}: {
	block: TextBlock;
	index: number;
	error: string | undefined;
	focusRequest: number;
	onChange: (block: EditorBlock) => void;
}) {
	const focusText = useFocusRequest<HTMLTextAreaElement>(focusRequest);
	return (
		<>
			<Field label={`Block ${index + 1} type`}>
				<Select
					options={KINDS}
					value={kindValue(block)}
					onValueChange={(value) => onChange(applyKind(block, value as Kind))}
				/>
			</Field>
			<Field
				label={textLabel(block)}
				hint={block.kind === "list" ? "Put one item on each line." : undefined}
				error={error}
			>
				<Textarea
					ref={focusText}
					value={block.text}
					rows={block.kind === "paragraph" || block.kind === "list" ? 5 : 2}
					onChange={(event) => onChange({ ...block, text: event.target.value })}
				/>
			</Field>
		</>
	);
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
	const [doc, dispatch] = useReducer(edit, { body: initialBody, contentType: initialContentType }, seedDoc);
	const [saved, setSaved] = useState({ revision: initialRevision, state: initialState });
	const [notice, setNotice] = useState({ status: "", error: "" });
	const [confirm, setConfirm] = useState<"publish" | "hide" | null>(null);
	const [saving, startSave] = useTransition();
	const lock = useRef(false);
	const { rows } = doc;
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
		if (!organizationBodyFits(writeBody())) return LONG_TEXT;
		return null;
	}

	async function commit(kind: "save" | "publish" | "hide"): Promise<string | null> {
		if (lock.current) return "Wait for the current save to finish.";
		if (kind !== "hide") {
			const invalid = problem();
			if (invalid) return invalid;
		}
		lock.current = true;
		setNotice((current) => ({ ...current, error: "" }));
		const command = {
			requestKey: crypto.randomUUID(),
			expectedRevision: saved.revision,
			articleId,
			organizationId,
			body: writeBody(),
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
			setSaved({ revision: result.revision, state: result.state });
			setNotice({ status: successCopy(kind, result.state), error: "" });
			return null;
		} catch {
			return "That did not save. Try again.";
		} finally {
			lock.current = false;
		}
	}

	function showProblem(message: string) {
		setNotice({ status: "", error: message });
		const key = rows[0]?.key;
		if (message === EMPTY_TEXT && key) dispatch({ type: "focus", key });
	}

	function save() {
		const invalid = problem();
		if (invalid) {
			showProblem(invalid);
			return;
		}
		startSave(async () => {
			const message = await commit("save");
			if (message) showProblem(message);
		});
	}

	function openPublish() {
		const message = problem();
		if (message) {
			showProblem(message);
			return;
		}
		setNotice((current) => ({ ...current, error: "" }));
		setConfirm("publish");
	}

	function openHide() {
		setNotice((current) => ({ ...current, error: "" }));
		setConfirm("hide");
	}

	const formError = notice.error;
	const locked = saving || confirm !== null;
	const canHide = saved.revision !== "0" && saved.state !== "hide";

	return (
		<div className="rounded-card bg-surface px-6 py-8 shadow-card max-app-sm:px-4 sm:px-11">
			<form
				className="mx-auto flex max-w-[700px] flex-col gap-8 [&_*]:scroll-mb-32"
				aria-label="Organization version"
				onSubmit={(event) => event.preventDefault()}
			>
				<ol className="flex flex-col gap-8">
					{rows.map((row, index) => (
						<li key={row.key}>
							<fieldset className="flex flex-col gap-4" disabled={locked}>
								<legend className="text-sm font-medium text-ink">Block {index + 1}</legend>
								{row.block.kind === "fixed" ? (
									<FixedView block={row.block.block} />
								) : (
									<TextFields
										block={row.block}
										index={index}
										error={
											formError === EMPTY_TEXT &&
											!row.block.text.trim() &&
											rows.findIndex((item) => item.block.kind !== "fixed" && !item.block.text.trim()) === index
												? formError
												: undefined
										}
										focusRequest={doc.focus?.key === row.key ? doc.focus.n : 0}
										onChange={(block) => dispatch({ type: "update", key: row.key, block })}
									/>
								)}
								<div className="flex flex-wrap gap-2">
									<Button
										type="button"
										variant="ghost"
										disabled={index === 0}
										onClick={() => dispatch({ type: "move", index, direction: -1 })}
									>
										Move up
									</Button>
									<Button
										type="button"
										variant="ghost"
										disabled={index === rows.length - 1}
										onClick={() => dispatch({ type: "move", index, direction: 1 })}
									>
										Move down
									</Button>
									<Button
										type="button"
										variant="ghost"
										disabled={rows.length < 2}
										onClick={() => dispatch({ type: "remove", key: row.key })}
									>
										Remove
									</Button>
								</div>
							</fieldset>
						</li>
					))}
				</ol>
				<div>
					<Button type="button" variant="outline" disabled={locked} onClick={() => dispatch({ type: "add" })}>
						Add a paragraph
					</Button>
				</div>
				<div className="sticky bottom-0 z-[2] -mx-6 -mb-8 flex flex-col gap-3 rounded-b-card border-t border-line bg-surface px-6 pt-3 pb-[max(12px,env(safe-area-inset-bottom))] max-app-sm:-mx-4 max-app-sm:px-4 sm:-mx-11 sm:px-11">
					<div role="alert" className="empty:hidden">
						{formError && formError !== EMPTY_TEXT ? (
							<p className="text-sm font-medium text-magenta-600">{formError}</p>
						) : null}
					</div>
					<p role="status" className="min-h-6 text-sm text-text-2">
						{notice.status}
					</p>
					<div className="flex flex-wrap gap-3">
						<Button type="button" loading={saving} disabled={locked && !saving} onClick={save}>
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
					open={confirm === "publish"}
					onOpenChange={(open) => setConfirm(open ? "publish" : null)}
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
					open={confirm === "hide"}
					onOpenChange={(open) => setConfirm(open ? "hide" : null)}
					title="Hide this source?"
					description="You can publish this source again later."
					tone="danger"
					consequences={[
						"Readers of this source see that it is hidden, not its text.",
						"People can still open another published source.",
					]}
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
