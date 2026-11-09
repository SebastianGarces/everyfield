"use client";

import { ArrowLeft01Icon, CheckmarkCircle02Icon, Refresh01Icon } from "@hugeicons/core-free-icons";
import type {
	BlockNode,
	ChurchCompare,
	DocBrand,
	DocDifference,
	DocDocument,
	PageLayout,
} from "@everyfield/contracts/documents";
import { Button, Checkbox, Skeleton, StatePanel } from "@everyfield/ui/controls";
import { EditorContent, useEditor, type JSONContent } from "@tiptap/react";
import { useCallback, useEffect, useId, useMemo, useState } from "react";
import { acceptTemplateChanges, compareWithTemplate, type CompareResult } from "../actions.ts";
import { editorExtensions, type FieldValues } from "./extensions.ts";
import { paletteVars } from "./paper.ts";

// "Compare with template": the document's saved revision beside the current template, block by block, in reading
// order. The person picks the changes to take; accepting saves them as one new revision. Each difference says what it
// is in words ("In template only", "In your document only", "Changed"), so the color only repeats the label.

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
};

const BLOCK: Record<string, (block: BlockNode) => string> = {
	paragraph: () => "Paragraph",
	heading: (b) => `Heading ${(b.attrs as { level?: number } | undefined)?.level ?? 1}`,
	bulletList: () => "Bulleted list",
	orderedList: () => "Numbered list",
	quote: () => "Quote",
	divider: () => "Divider",
	spacer: () => "Spacer",
	pageBreak: () => "Page break",
	columns: (b) => `${(b as { content?: unknown[] }).content?.length ?? 2} columns`,
	box: () => "Colored box",
	image: (b) => {
		const source = (b.attrs as { source?: string } | undefined)?.source ?? "logo";
		return source === "mark" ? "Mark" : source === "photo" ? "Photo" : "Logo";
	},
	writeIn: (b) => {
		const kind = (b.attrs as { kind?: string } | undefined)?.kind;
		return kind === "signature" ? "Signature line" : kind === "date" ? "Date line" : "Write-in line";
	},
	slot: (b) => (b.attrs as { label?: string } | undefined)?.label ?? "Section",
	table: () => "Table",
};

/** What a difference is about: "Title", "Page setup", "Header", "Footer" or the kind of block. */
function partLabel(d: DocDifference) {
	if (d.part === "title") return "Title";
	if (d.part === "page") return "Page setup";
	if (d.part === "header") return "Header";
	if (d.part === "footer") return "Footer";
	const block = (d.template ?? d.document) as BlockNode;
	return BLOCK[block.type]?.(block) ?? "Block";
}

const SIZE: Record<string, string> = {
	letter: "Letter",
	legal: "Legal",
	a4: "A4",
	"half-letter": "Half Letter",
	"card-4x6": "4 x 6 card",
	custom: "Custom",
};
const inches = (pt: number) => `${Number((pt / 72).toFixed(2))} in`;

/** The page setup in words, as Page setup names it. */
function describePage(page: PageLayout) {
	const m = page.margin;
	const parts = [
		`${SIZE[page.size] ?? page.size}, ${page.orientation}`,
		`Margins: top ${inches(m.top)}, right ${inches(m.right)}, bottom ${inches(m.bottom)}, left ${inches(m.left)}`,
	];
	if (page.tile)
		parts.push(`${page.tile.across * page.tile.down} cards per sheet${page.tile.cutMarks ? ", with cut marks" : ""}`);
	return parts;
}

export function TemplateCompare({ docId, brand, onBack, onAccepted, revision }: Props) {
	const [load, setLoad] = useState<Load>({ kind: "loading" });
	const [chosen, setChosen] = useState<ReadonlySet<number>>(new Set());
	const [busy, setBusy] = useState<"chosen" | "all" | null>(null);
	const [notice, setNotice] = useState<string | null>(null);
	const headingId = useId();

	const show = useCallback((result: CompareResult) => {
		if (result.status === "ok") {
			setLoad({ kind: "ready", compare: result.compare });
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
		return show(await compareWithTemplate(docId));
	}, [docId, show]);
	useEffect(() => {
		let live = true;
		void compareWithTemplate(docId).then((result) => live && show(result));
		return () => {
			live = false;
		};
	}, [docId, show]);

	const stale = load.kind === "ready" && load.compare.revision !== revision;

	async function accept(which: number[] | "all") {
		if (load.kind !== "ready") return;
		const { compare } = load;
		setBusy(which === "all" ? "all" : "chosen");
		setNotice(null);
		const result = await acceptTemplateChanges(docId, compare.revision, compare.templateHash, which);
		setBusy(null);
		if (result.status === "accepted") {
			onAccepted(result.document, result.revision, which === "all" ? compare.differences.length : which.length);
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
				{load.kind === "ready" ? (
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
			) : load.compare.differences.length === 0 ? (
				<NoDifferences behind={load.compare.behind} busy={busy !== null} onMark={() => void accept("all")} />
			) : (
				<Differences
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
		</section>
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
	compare,
	brand,
	chosen,
	busy,
	onToggle,
	onAccept,
}: {
	compare: ChurchCompare;
	brand: DocBrand;
	chosen: ReadonlySet<number>;
	busy: "chosen" | "all" | null;
	onToggle: (id: number, on: boolean) => void;
	onAccept: (which: number[] | "all") => void;
}) {
	const total = compare.differences.length;
	const count = chosen.size;
	return (
		<>
			<p className="text-sm text-text-2">
				{total === 1 ? "1 difference" : `${total} differences`}, in reading order. Choose the ones to take from the
				template; everything else keeps your version.
			</p>
			<ol className="flex flex-col gap-3" aria-label="Differences">
				{compare.differences.map((d) => (
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
	const sides = [
		d.document !== null ? { who: "Your document", value: d.document } : null,
		d.template !== null ? { who: "Template", value: d.template } : null,
	].filter((side) => side !== null);
	return (
		<li
			data-kind={d.kind}
			className="flex flex-col gap-3 rounded-card bg-surface-raised p-4 shadow-[0_0_0_1px_var(--ef-line)] data-[kind=changed]:border-l-4 data-[kind=changed]:border-blue-600 data-[kind=document-only]:border-l-4 data-[kind=document-only]:border-amber-600 data-[kind=template-only]:border-l-4 data-[kind=template-only]:border-green-600 app-sm:p-5"
		>
			<div className="flex flex-wrap items-center gap-2">
				<span className={`inline-flex h-[26px] items-center rounded-md px-2.5 text-sm font-semibold ${kind.chip}`}>
					{kind.label}
				</span>
				<span className="text-sm font-medium text-ink">{partLabel(d)}</span>
			</div>
			<div className={sides.length === 2 ? "grid gap-3 app-md:grid-cols-2" : "grid gap-3"}>
				{sides.map((side) => (
					<div key={side.who} className="flex min-w-0 flex-col gap-1.5">
						<p className="text-xs font-semibold tracking-wide text-text-3 uppercase">{side.who}</p>
						<Side difference={d} value={side.value} values={values} brand={brand} />
					</div>
				))}
			</div>
			<Checkbox
				checked={checked}
				disabled={disabled}
				onCheckedChange={(on) => onToggle(on === true)}
				label={kind.take}
			/>
		</li>
	);
}

/** One side of a difference: the title or page setup in words, or the blocks as the paper page shows them. */
function Side({
	difference: d,
	value,
	values,
	brand,
}: {
	difference: DocDifference;
	value: unknown;
	values: FieldValues;
	brand: DocBrand;
}) {
	if (d.part === "title") return <p className="text-[15px] text-ink">{value as string}</p>;
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
	return <Snippet content={content} values={values} brand={brand} />;
}

/** Blocks on a strip of white paper, drawn by the editor's own nodes, read only. */
function Snippet({ content, values, brand }: { content: unknown[]; values: FieldValues; brand: DocBrand }) {
	const extensions = useMemo(() => editorExtensions(values, brand.assets), [values, brand.assets]);
	const editor = useEditor({
		extensions,
		content: { type: "doc", content: content as JSONContent[] },
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
