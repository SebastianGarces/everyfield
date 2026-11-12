"use client";

import { ArrowLeft01Icon, CheckmarkCircle02Icon, Refresh01Icon } from "@hugeicons/core-free-icons";
import {
	wordChanges,
	type BlockNode,
	type ChangeNote,
	type ChurchCompare,
	type CompareView,
	type DocBrand,
	type DocDifference,
	type DocDocument,
	type PageLayout,
	type WordRun,
} from "@everyfield/contracts/documents";
import { Button, Checkbox, SegmentedControl, Skeleton, StatePanel } from "@everyfield/ui/controls";
import { EditorContent, useEditor, type JSONContent } from "@tiptap/react";
import { useCallback, useEffect, useId, useMemo, useState } from "react";
import { acceptTemplateChanges, compareWithTemplate, type CompareResult } from "../actions.ts";
import { blockLabel, PAPER_LABEL } from "../labels.ts";
import { editorExtensions, type FieldValues } from "./extensions.ts";
import { paletteVars } from "./paper.ts";
import { blocksToEditor } from "./table-json.ts";
import { WORD_MARK, wordMarks } from "./word-marks.ts";

// "Compare with template": the document's saved revision beside the current template, block by block, in reading
// order, as two lists (D-423). "Template changes" opens first: only what the template changed since the version the
// document records, so the church's own edits are not listed. "All differences" lists every difference (T-19). The
// person picks the items to take; accepting saves them as one new revision. Each item says what it is in words, so
// the color only repeats the label. Inside a changed item the words that differ are marked on each side (T-82): only
// to read the change, since accepting takes the whole block.

type Props = {
	docId: string;
	brand: DocBrand;
	/** Back to the editor. `stale` is true when the compare read a newer revision than the editor holds. */
	onBack: (stale: boolean) => void;
	/** The accepted revision: the editor reopens on it. */
	onAccepted: (document: DocDocument, revision: string, taken: number) => void;
	/** The revision the editor holds, to tell when another tab saved a newer one. */
	revision: string;
};

type Load = { kind: "loading" } | { kind: "ready"; compare: ChurchCompare } | { kind: "failed"; message: string };

const KIND: Record<DocDifference["kind"], { label: string; take: string; chip: string }> = {
	"template-only": {
		label: "In template only",
		take: "Add it to your document",
		chip: "bg-green-100 text-green-700",
	},
	"document-only": {
		label: "In your document only",
		take: "Remove it from your document",
		chip: "bg-amber-100 text-amber-600",
	},
	changed: {
		label: "Changed",
		take: "Use the template's version",
		chip: "bg-blue-100 text-blue-600",
	},
	removed: {
		label: "Removed from template",
		take: "Remove it from your document",
		chip: "bg-magenta-100 text-magenta-600",
	},
	both: {
		label: "Changed in template and in your document",
		take: "Use the template's version",
		chip: "bg-violet-100 text-violet-600",
	},
};

/** What changed beside the words, said on the item. */
const NOTE: Record<ChangeNote, string> = {
	formatting: "Formatting changed",
	spacing: "Spacing changed",
	settings: "Settings changed",
};

const VIEW_LABEL: Record<CompareView, string> = { changes: "Template changes", all: "All differences" };
/** The list a view shows; "Template changes" is null when the version the document records is not stored. */
const listOf = (compare: ChurchCompare, view: CompareView) =>
	view === "changes" ? compare.changes : compare.differences;

/** What a difference is about: "Title", "Page setup", "Header", "Footer" or the kind of block. */
function partLabel(d: DocDifference) {
	if (d.part === "title") return "Title";
	if (d.part === "page") return "Page setup";
	if (d.part === "header") return "Header";
	if (d.part === "footer") return "Footer";
	const block = (d.template ?? d.document) as BlockNode;
	return blockLabel(block);
}

const inches = (pt: number) => `${Number((pt / 72).toFixed(2))} in`;

/** The page setup in words, as Page setup names it. */
function describePage(page: PageLayout) {
	const m = page.margin;
	const parts = [
		`${PAPER_LABEL[page.size]}, ${page.orientation}`,
		`Margins: top ${inches(m.top)}, right ${inches(m.right)}, bottom ${inches(m.bottom)}, left ${inches(m.left)}`,
	];
	if (page.tile)
		parts.push(`${page.tile.across * page.tile.down} cards per sheet${page.tile.cutMarks ? ", with cut marks" : ""}`);
	return parts;
}

export function TemplateCompare({ docId, brand, onBack, onAccepted, revision }: Props) {
	const [load, setLoad] = useState<Load>({ kind: "loading" });
	const [view, setView] = useState<CompareView>("changes");
	const [chosen, setChosen] = useState<ReadonlySet<number>>(new Set());
	const [busy, setBusy] = useState<"chosen" | "all" | null>(null);
	const [notice, setNotice] = useState<string | null>(null);
	const headingId = useId();

	const show = useCallback((result: CompareResult) => {
		if (result.status === "ok") {
			setLoad({ kind: "ready", compare: result.compare });
			setView((now) => (result.compare.changes === null ? "all" : now));
			setChosen(new Set());
			return result.compare;
		}
		setLoad({
			kind: "failed",
			message: result.status === "refused" ? result.message : "The connection dropped. Nothing was changed.",
		});
		return null;
	}, []);
	const read = useCallback(async () => {
		setLoad({ kind: "loading" });
		return show(await compareWithTemplate(docId).catch(() => ({ status: "lost" }) as const));
	}, [docId, show]);
	useEffect(() => {
		let live = true;
		void compareWithTemplate(docId)
			.catch(() => ({ status: "lost" }) as const)
			.then((result) => live && show(result));
		return () => {
			live = false;
		};
	}, [docId, show]);

	const stale = load.kind === "ready" && load.compare.revision !== revision;

	async function accept(which: number[] | "all") {
		if (load.kind !== "ready") return;
		const { compare } = load;
		const key = compare.keys[view];
		if (!key) return;
		setBusy(which === "all" ? "all" : "chosen");
		setNotice(null);
		const result = await acceptTemplateChanges(docId, compare.revision, compare.templateHash, view, key, which).catch(
			() => ({ status: "lost" }) as const,
		);
		setBusy(null);
		if (result.status === "accepted") {
			onAccepted(
				result.document,
				result.revision,
				which === "all" ? (listOf(compare, view)?.length ?? 0) : which.length,
			);
			return;
		}
		if (result.status === "refused" && result.code === "conflict") {
			const fresh = await read();
			setNotice(
				`This document was saved somewhere else after the compare opened, so nothing was accepted. The compare now shows revision ${fresh?.revision ?? "the newest"}. Choose again.`,
			);
			return;
		}
		setNotice(result.status === "refused" ? result.message : "The connection dropped. Nothing was accepted.");
	}

	const header = (
		<div className="flex flex-wrap items-start justify-between gap-x-4 gap-y-3">
			<div className="min-w-0">
				<h2 id={headingId} className="font-display text-2xl text-ink">
					Compare with template
				</h2>
				{load.kind === "ready" && load.compare.churchTemplate ? (
					<>
						<p className="mt-2">
							<span className="inline-flex h-[26px] items-center rounded-md bg-surface-sunken px-2.5 text-sm font-semibold text-ink shadow-[0_0_0_1px_var(--ef-line)]">
								Your church&rsquo;s template
							</span>
						</p>
						<p className="mt-2 text-sm text-pretty text-text-2">
							Your saved document, revision <span className="tabular-nums">{load.compare.revision}</span>, beside your
							church&rsquo;s own template &ldquo;{load.compare.templateTitle}&rdquo;, version{" "}
							<span className="tabular-nums">{load.compare.templateVersion}</span>.
						</p>
					</>
				) : load.kind === "ready" ? (
					<p className="mt-1 text-sm text-pretty text-text-2">
						Your saved document, revision <span className="tabular-nums">{load.compare.revision}</span>, beside the
						current {load.compare.templateTitle} template, version{" "}
						<span className="tabular-nums">{load.compare.templateVersion}</span>.
					</p>
				) : null}
			</div>
			<Button variant="secondary" size="sm" icon={ArrowLeft01Icon} onClick={() => onBack(stale)}>
				Back to editing
			</Button>
		</div>
	);

	return (
		<section aria-labelledby={headingId} className="flex flex-col gap-4">
			{header}
			{notice ? (
				<p role="alert" className="rounded-lg bg-magenta-100 px-4 py-3 text-sm text-pretty text-magenta-700">
					{notice}
				</p>
			) : null}
			{load.kind === "loading" ? (
				<div aria-busy="true" className="flex flex-col gap-3">
					<span className="sr-only" role="status">
						Comparing with the template
					</span>
					<Skeleton className="h-40 w-full rounded-card" />
					<Skeleton className="h-40 w-full rounded-card" />
				</div>
			) : load.kind === "failed" ? (
				<div className="rounded-card bg-surface-raised p-6 shadow-[0_0_0_1px_var(--ef-line)]">
					<StatePanel tone="error" title="We could not compare this document" headingLevel="h3">
						{load.message}
					</StatePanel>
					<div className="mt-4 flex justify-center">
						<Button variant="secondary" size="sm" icon={Refresh01Icon} onClick={() => void read()}>
							Try again
						</Button>
					</div>
				</div>
			) : (
				<>
					{load.compare.changes === null ? (
						<p className="rounded-lg bg-surface-sunken px-4 py-3 text-sm text-pretty text-text-2 shadow-[0_0_0_1px_var(--ef-line)]">
							The template version this document records is not stored, so the compare can&rsquo;t tell the
							template&rsquo;s changes from your own. It shows all differences from the current version.
						</p>
					) : (
						<SegmentedControl
							label="Compare view"
							size="sm"
							options={(["changes", "all"] as const).map((value) => ({
								value,
								label: VIEW_LABEL[value],
								count: listOf(load.compare, value)?.length ?? 0,
							}))}
							value={view}
							onValueChange={(next) => {
								setView(next);
								setChosen(new Set());
							}}
							className="self-start"
						/>
					)}
					{view === "changes" && load.compare.changes?.length === 0 ? (
						<HasEveryChange base={load.compare.baseVersion} church={load.compare.churchTemplate} />
					) : listOf(load.compare, view)?.length === 0 ? (
						<NoDifferences behind={load.compare.behind} busy={busy !== null} onMark={() => void accept("all")} />
					) : (
						<Differences
							// Each snippet's editor keeps the content it was made with, so another view mounts afresh.
							key={view}
							view={view}
							items={listOf(load.compare, view) ?? []}
							compare={load.compare}
							brand={brand}
							chosen={chosen}
							busy={busy}
							onToggle={(id, on) =>
								setChosen((now) => {
									const next = new Set(now);
									if (on) next.add(id);
									else next.delete(id);
									return next;
								})
							}
							onAccept={(which) => void accept(which)}
						/>
					)}
				</>
			)}
		</section>
	);
}

/** "Template changes" is empty: every change the template made since the base is in the document (D-425). */
function HasEveryChange({ base, church }: { base: number | null; church: boolean }) {
	return (
		<div className="rounded-card bg-surface-raised p-6 shadow-[0_0_0_1px_var(--ef-line)]">
			<StatePanel tone="neutral" title="Your document has every template change" headingLevel="h3">
				Everything {church ? "your church’s" : "the"} template changed since version{" "}
				<span className="tabular-nums">{base}</span> is already in this document. Any other differences are your own
				edits; All differences lists them.
			</StatePanel>
		</div>
	);
}

function NoDifferences({ behind, busy, onMark }: { behind: boolean; busy: boolean; onMark: () => void }) {
	return (
		<div className="rounded-card bg-surface-raised p-6 shadow-[0_0_0_1px_var(--ef-line)]">
			<StatePanel tone="neutral" title="No differences from the current template" headingLevel="h3">
				{behind
					? "The template changed in ways that do not touch this document's content, such as a sample value."
					: "Every block, the title, the page setup, the header and the footer match the template."}
			</StatePanel>
			{behind ? (
				<div className="mt-4 flex justify-center">
					<Button variant="secondary" size="sm" icon={CheckmarkCircle02Icon} loading={busy} onClick={onMark}>
						Mark as up to date
					</Button>
				</div>
			) : null}
		</div>
	);
}

function Differences({
	view,
	items,
	compare,
	brand,
	chosen,
	busy,
	onToggle,
	onAccept,
}: {
	view: CompareView;
	items: DocDifference[];
	compare: ChurchCompare;
	brand: DocBrand;
	chosen: ReadonlySet<number>;
	busy: "chosen" | "all" | null;
	onToggle: (id: number, on: boolean) => void;
	onAccept: (which: number[] | "all") => void;
}) {
	const total = items.length;
	const count = chosen.size;
	return (
		<>
			<p className="text-sm text-pretty text-text-2">
				{view === "changes" ? (
					<>
						{total === 1 ? "1 change" : `${total} changes`} the template made since version{" "}
						<span className="tabular-nums">{compare.baseVersion}</span>, in reading order. Your own edits are not
						listed. Choose the changes to take; everything else keeps your version.
					</>
				) : (
					<>
						{total === 1 ? "1 difference" : `${total} differences`} from the current template, in reading order. Choose
						the ones to take from the template; everything else keeps your version.
					</>
				)}
			</p>
			<ol className="flex flex-col gap-3" aria-label={VIEW_LABEL[view]}>
				{items.map((d) => (
					<DifferenceCard
						key={d.id}
						difference={d}
						values={compare.values}
						brand={brand}
						checked={chosen.has(d.id)}
						disabled={busy !== null}
						onToggle={(on) => onToggle(d.id, on)}
					/>
				))}
			</ol>
			<div className="sticky bottom-3 z-10 flex flex-wrap items-center justify-between gap-x-4 gap-y-2 rounded-card bg-surface-raised px-4 py-3 shadow-[0_0_0_1px_var(--ef-line),0_8px_24px_-12px_color-mix(in_srgb,var(--ef-ink)_30%,transparent)]">
				<p className="text-sm text-text-2" aria-live="polite">
					<span className="tabular-nums">{count}</span> of <span className="tabular-nums">{total}</span> chosen.
					Accepting saves one new revision.
				</p>
				<div className="flex flex-wrap items-center gap-2">
					<Button
						variant="secondary"
						size="sm"
						loading={busy === "all"}
						disabled={busy !== null}
						onClick={() => onAccept("all")}
					>
						Accept all
					</Button>
					<Button
						variant="primary"
						size="sm"
						loading={busy === "chosen"}
						disabled={busy !== null || count === 0}
						onClick={() => onAccept([...chosen].sort((a, b) => a - b))}
					>
						{count === 0 ? "Accept chosen" : count === 1 ? "Accept 1 change" : `Accept ${count} changes`}
					</Button>
				</div>
			</div>
		</>
	);
}

function DifferenceCard({
	difference: d,
	values,
	brand,
	checked,
	disabled,
	onToggle,
}: {
	difference: DocDifference;
	values: FieldValues;
	brand: DocBrand;
	checked: boolean;
	disabled: boolean;
	onToggle: (on: boolean) => void;
}) {
	const kind = KIND[d.kind];
	const words = useMemo(() => wordChanges(d), [d]);
	const notes = words && words.show !== "whole" ? words.notes : [];
	// A block the template removed after the church changed it: the template's side says so in words.
	const goneFromTemplate = d.kind === "both" && d.template === null;
	const marked = (side: "document" | "template") => (words?.show === "words" ? words[side] : null);
	const sides = [
		d.document !== null ? { who: "Your document", value: d.document, lines: marked("document") } : null,
		d.template !== null
			? { who: d.kind === "both" ? "Template, new version" : "Template", value: d.template, lines: marked("template") }
			: null,
	].filter((side) => side !== null);
	return (
		<li
			data-kind={d.kind}
			className="flex flex-col gap-3 rounded-card bg-surface-raised p-4 shadow-[0_0_0_1px_var(--ef-line)] data-[kind=changed]:border-l-4 data-[kind=changed]:border-blue-600 data-[kind=document-only]:border-l-4 data-[kind=document-only]:border-amber-600 data-[kind=template-only]:border-l-4 data-[kind=template-only]:border-green-600 data-[kind=removed]:border-l-4 data-[kind=removed]:border-magenta-600 data-[kind=both]:border-l-4 data-[kind=both]:border-violet-600 app-sm:p-5"
		>
			<div className="flex flex-wrap items-center gap-2">
				<span className={`inline-flex h-[26px] items-center rounded-md px-2.5 text-sm font-semibold ${kind.chip}`}>
					{kind.label}
				</span>
				<span className="text-sm font-medium text-ink">{partLabel(d)}</span>
				{notes.map((note) => (
					<span key={note} className="text-sm text-text-2">
						&middot; {NOTE[note]}
					</span>
				))}
			</div>
			<div className={sides.length === 2 || goneFromTemplate ? "grid gap-3 app-md:grid-cols-2" : "grid gap-3"}>
				{sides.map((side) => (
					<div key={side.who} className="flex min-w-0 flex-col gap-1.5">
						<p className="text-xs font-semibold tracking-wide text-text-3 uppercase">{side.who}</p>
						<Side difference={d} value={side.value} lines={side.lines} values={values} brand={brand} />
					</div>
				))}
				{goneFromTemplate ? (
					<div className="flex min-w-0 flex-col gap-1.5">
						<p className="text-xs font-semibold tracking-wide text-text-3 uppercase">Template, new version</p>
						<p className="text-[15px] text-text-2">The template removed this.</p>
					</div>
				) : null}
			</div>
			<Checkbox
				checked={checked}
				disabled={disabled}
				onCheckedChange={(on) => onToggle(on === true)}
				label={goneFromTemplate ? KIND.removed.take : kind.take}
			/>
		</li>
	);
}

/**
 * One side of a difference: the title or page setup in words, or the blocks as the paper page shows them. `lines` are
 * the side's word marks, one list of runs per text line, or null to show the side unmarked.
 */
function Side({
	difference: d,
	value,
	lines,
	values,
	brand,
}: {
	difference: DocDifference;
	value: unknown;
	lines: WordRun[][] | null;
	values: FieldValues;
	brand: DocBrand;
}) {
	if (d.part === "title")
		return (
			<p className="text-[15px] text-ink">
				{lines
					? lines[0]!.map((run) => {
							if (run.op === "kept") return run.text;
							const Mark = WORD_MARK[run.op].nodeName;
							return (
								<Mark key={run.from} className={WORD_MARK[run.op].class}>
									{run.text}
								</Mark>
							);
						})
					: (value as string)}
			</p>
		);
	if (d.part === "page")
		return (
			<ul className="text-[15px] text-ink">
				{describePage(value as PageLayout).map((line) => (
					<li key={line}>{line}</li>
				))}
			</ul>
		);
	const content =
		d.part === "body"
			? [value]
			: [
					{
						type: d.part === "header" ? "pageHeader" : "pageFooter",
						attrs: { pages: (value as { pages: string }).pages },
						content: (value as { content: unknown[] }).content,
					},
				];
	return <Snippet content={content} lines={lines} values={values} brand={brand} />;
}

/** Blocks on a strip of white paper, drawn by the editor's own nodes, read only. */
function Snippet({
	content,
	lines,
	values,
	brand,
}: {
	content: unknown[];
	lines: WordRun[][] | null;
	values: FieldValues;
	brand: DocBrand;
}) {
	const extensions = useMemo(
		() => [...editorExtensions(brand.assets), ...(lines ? [wordMarks(lines)] : [])],
		[brand.assets, lines],
	);
	// Fields read their values from the root node, so the snippet's root carries the printed values as data.
	const fields = Object.keys(values).map((key) => ({ key, type: "string", label: key }));
	const editor = useEditor({
		extensions,
		// The format's tables become the editor's own table nodes, as on every other load path: without this an amount,
		// check box or row number cell draws empty.
		content: { type: "doc", attrs: { fields, data: values }, content: blocksToEditor(content) as JSONContent[] },
		editable: false,
		immediatelyRender: true,
		editorProps: { attributes: { "aria-readonly": "true" } },
	});
	return (
		<div className="ef-sheet" style={paletteVars(brand.palette)}>
			<div className="ef-paper ef-snippet">
				<EditorContent editor={editor} />
			</div>
		</div>
	);
}
