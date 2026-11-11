"use client";

import { pageBox, type DocDocument } from "@everyfield/contracts/documents";
import { Field, Input, Select, Switch } from "@everyfield/ui/controls";
import type { Editor } from "@tiptap/react";
import { useEditorState } from "@tiptap/react";
import { useState, type ReactNode } from "react";
import {
	applyPage,
	pageIssues,
	POINTS,
	readPage,
	regionPages,
	setRegion,
	toInches,
	toPoints,
	type PageWithoutRegions,
	type RegionKey,
} from "./layout.ts";
import { Segmented, Tip } from "./ControlParts.tsx";

// The page setup panel: paper size, orientation, the four margins, cards per sheet with cut marks, and the header and
// footer. Each change applies at once as one step of the editor's history, after the format has checked it. A value the
// format refuses shows the format's message next to its field and is not applied. Margins and custom sizes show in
// inches and store points (72 to the inch).

const SIZES = [
	{ value: "letter", label: "Letter" },
	{ value: "legal", label: "Legal" },
	{ value: "a4", label: "A4" },
	{ value: "half-letter", label: "Half Letter" },
	{ value: "card-4x6", label: "4 x 6 card" },
	{ value: "custom", label: "Custom" },
];
const PAGES = [
	{ value: "all", label: "All pages" },
	{ value: "first", label: "First page" },
	{ value: "rest", label: "Other pages" },
] as const;
const SIDES = ["top", "right", "bottom", "left"] as const;
const SIDE_LABEL = { top: "Top margin", right: "Right margin", bottom: "Bottom margin", left: "Left margin" } as const;

type Fault = { field: string; message: string };

/** A number field in inches. The text stays as typed until the field loses focus, so "0." and "" are not rewritten. */
function Inches({
	label,
	field,
	points,
	min,
	max,
	fault,
	onCommit,
}: {
	label: string;
	field: string;
	points: number;
	min: number;
	max: number;
	fault: Fault | null;
	onCommit: (points: number) => void;
}) {
	const [draft, setDraft] = useState<string | null>(null);
	const mine = fault?.field === field ? fault.message : undefined;
	return (
		<Field label={label} error={mine} hint={`${min} to ${max} in`}>
			<Tip text={`${label} in inches`}>
				<Input
					type="number"
					inputMode="decimal"
					step={0.05}
					min={min}
					max={max}
					value={draft ?? String(toInches(points))}
					onChange={(event) => {
						const text = event.target.value;
						setDraft(text);
						const inches = Number(text);
						if (text.trim() !== "" && Number.isFinite(inches)) onCommit(toPoints(inches));
					}}
					onBlur={() => setDraft(null)}
				/>
			</Tip>
		</Field>
	);
}

/** The format's message for a control with no Field of its own, under that control. */
function FaultNote({ message }: { message: string | undefined }) {
	return message ? (
		<p role="alert" className="text-xs font-medium text-magenta-600">
			{message}
		</p>
	) : null;
}

function Fieldset({ legend, children }: { legend: string; children: ReactNode }) {
	return (
		<fieldset className="flex min-w-0 flex-col gap-1.5 border-0 p-0">
			<legend className="mb-1.5 text-sm font-medium text-ink-2">{legend}</legend>
			{children}
		</fieldset>
	);
}

export function PageSetupPanel({
	editor,
	base,
	id,
	onClose,
}: {
	editor: Editor;
	/** The stored document the page setup is checked against: read when a value changes, not when the panel draws. */
	base: () => DocDocument;
	id: string;
	onClose: () => void;
}) {
	const state = useEditorState({
		editor,
		selector: ({ editor: e }) => ({
			page: readPage(e.state),
			header: regionPages(e.state, "header"),
			footer: regionPages(e.state, "footer"),
		}),
		equalityFn: (a, b) => !!a && !!b && a.page === b.page && a.header === b.header && a.footer === b.footer,
	});
	const [fault, setFault] = useState<Fault | null>(null);
	const { page, header, footer } = state;
	const faultAt = (field: string) => (fault?.field === field ? fault.message : undefined);

	/** Applies `next` when the format accepts it; else shows the format's message at `field` and applies nothing. */
	const change = (field: string, next: PageWithoutRegions) => {
		const issues = pageIssues(editor, base(), next);
		if (issues.length > 0) {
			setFault({ field, message: issues[0]?.message ?? "The format refuses this value." });
			return;
		}
		setFault(null);
		applyPage(editor, next);
	};

	const box = pageBox(page) ?? { width: 612, height: 792 };
	const tile = page.tile ?? null;
	const margin = page.margin;

	const setSize = (size: string) => {
		const next = { ...page, size } as PageWithoutRegions;
		if (size === "custom") {
			// A custom page starts at the size it replaces, in portrait numbers.
			const upright = pageBox({ ...page, orientation: "portrait" }) ?? box;
			Object.assign(next, { width: upright.width, height: upright.height });
		} else {
			delete (next as { width?: number }).width;
			delete (next as { height?: number }).height;
		}
		change("size", next);
	};

	const region = (key: RegionKey, pages: "all" | "first" | "rest" | null) => (
		<div className="flex min-w-0 flex-col gap-2">
			<Tip text={`Turn the page ${key} on or off`}>
				<Switch
					label={key === "header" ? "Header" : "Footer"}
					checked={pages !== null}
					onCheckedChange={(on) => {
						setFault(null);
						setRegion(editor, key, on);
					}}
				/>
			</Tip>
			{pages !== null ? (
				<Segmented
					label={`${key === "header" ? "Header" : "Footer"} prints on`}
					value={pages}
					options={[...PAGES]}
					onChange={(value) => setRegion(editor, key, true, value)}
				/>
			) : null}
		</div>
	);

	return (
		<section
			id={id}
			aria-label="Page setup"
			className="flex flex-col gap-4 rounded-card bg-surface-raised p-4 shadow-[0_0_0_1px_var(--ef-line)]"
		>
			<div className="flex items-center justify-between gap-3">
				<h2 className="text-lg font-semibold text-ink">Page setup</h2>
				<Tip text="Close page setup">
					<button
						type="button"
						className="cursor-pointer rounded-sm px-2 py-1 text-sm font-medium text-ink-2 hover:bg-hover"
						onClick={onClose}
					>
						Close
					</button>
				</Tip>
			</div>
			<div className="grid grid-cols-1 gap-x-5 gap-y-4 sm:grid-cols-2 lg:grid-cols-4">
				<Field label="Paper size" error={faultAt("size")}>
					<Tip text="Paper size">
						<Select options={SIZES} value={page.size} onValueChange={setSize} aria-label="Paper size" />
					</Tip>
				</Field>
				<Fieldset legend="Orientation">
					<Segmented
						label="Orientation"
						value={page.orientation}
						options={[
							{ value: "portrait", label: "Portrait" },
							{ value: "landscape", label: "Landscape" },
						]}
						onChange={(orientation) => change("orientation", { ...page, orientation })}
					/>
					<FaultNote message={faultAt("orientation")} />
				</Fieldset>
				{page.size === "custom" ? (
					<>
						<Inches
							label="Width"
							field="width"
							points={page.width ?? box.width}
							min={2}
							max={24}
							fault={fault}
							onCommit={(width) => change("width", { ...page, width })}
						/>
						<Inches
							label="Height"
							field="height"
							points={page.height ?? box.height}
							min={2}
							max={24}
							fault={fault}
							onCommit={(height) => change("height", { ...page, height })}
						/>
					</>
				) : null}
			</div>
			<Fieldset legend="Margins">
				<div className="grid grid-cols-2 gap-x-5 gap-y-3 lg:grid-cols-4">
					{SIDES.map((side) => (
						<Inches
							key={side}
							label={SIDE_LABEL[side]}
							field={`margin.${side}`}
							points={margin[side]}
							min={0}
							max={toInches(144)}
							fault={fault}
							onCommit={(points) => change(`margin.${side}`, { ...page, margin: { ...margin, [side]: points } })}
						/>
					))}
				</div>
			</Fieldset>
			<div className="grid grid-cols-1 gap-x-5 gap-y-4 sm:grid-cols-2">
				<Fieldset legend="Cards per sheet">
					<Segmented
						label="Cards per sheet"
						value={tile ? 4 : 1}
						options={[
							{ value: 1, label: "1", tooltip: "1 card per sheet" },
							{ value: 4, label: "4", tooltip: "4 cards per sheet, 2 across and 2 down" },
						]}
						onChange={(count) =>
							change("tile", {
								...page,
								tile: count === 4 ? { across: 2, down: 2, padding: 14, cutMarks: tile?.cutMarks ?? true } : null,
							})
						}
					/>
					<FaultNote message={faultAt("tile")} />
				</Fieldset>
				{tile ? (
					<div className="flex min-w-0 flex-col gap-1.5">
						<Tip text="Print trim marks at the corners of each card">
							<Switch
								label="Cut marks"
								description="Trim marks at the corners of each card."
								checked={tile.cutMarks}
								onCheckedChange={(cutMarks) => change("cutMarks", { ...page, tile: { ...tile, cutMarks } })}
							/>
						</Tip>
						<FaultNote message={faultAt("cutMarks")} />
					</div>
				) : null}
			</div>
			<div className="grid grid-cols-1 gap-x-5 gap-y-4 sm:grid-cols-2">
				{region("header", header)}
				{region("footer", footer)}
			</div>
			<p className="text-xs text-text-3">Inches here are stored as points ({POINTS} to the inch).</p>
		</section>
	);
}
