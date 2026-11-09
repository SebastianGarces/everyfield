"use client";

import type { DocBrand, Token } from "@everyfield/contracts/documents";
import { cn } from "@everyfield/ui/foundations";
import type { Editor } from "@tiptap/react";
import { useEditorState } from "@tiptap/react";
import { useId, useState, type KeyboardEvent, type ReactNode } from "react";
import {
	ALIGNS,
	layoutTargets,
	setBlockAttrs,
	setColumnCount,
	TOKEN_NAMES,
	TOKENS,
	WEIGHTS,
	type Target,
} from "./layout.ts";
import { Button } from "./tiptap/primitives/button.tsx";
import { Tooltip, TooltipContent, TooltipTrigger } from "./tiptap/primitives/tooltip.tsx";
import { TOOLBAR } from "./tiptap/styles.ts";
import { setFieldValue } from "./blocks.ts";
import { fieldDecl, writeInKindLabel } from "./extensions.ts";

// The settings of the block the cursor is in or on: the number of columns, a box's fill and border, a divider's weight
// and color, an image's height and alignment. Each color control is a row of swatches, one for each token of the format,
// painted in the color the PDF prints for this document. No control takes a hex value or opens a color picker.

/** The color a token paints in this document, as the PDF prints it on white. `none` has no color. */
const swatchColor = (palette: DocBrand["palette"], token: Token) =>
	token === "none" ? null : palette[token === "muted-text" ? "mutedText" : token];

/** A hover and focus tooltip for a control that has no tooltip of its own (an input, a select, a switch). */
export function Tip({ text, children, className }: { text: string; children: ReactNode; className?: string }) {
	return (
		<Tooltip delay={300}>
			<TooltipTrigger asChild>
				<div className={className}>{children}</div>
			</TooltipTrigger>
			<TooltipContent>{text}</TooltipContent>
		</Tooltip>
	);
}

const keepSelection = (event: { preventDefault: () => void }) => event.preventDefault();

/** Arrow keys in a radio group: choose the next or previous value and move focus to it. */
function rove<T>(event: KeyboardEvent, index: number, values: readonly T[], choose: (value: T) => void) {
	const step = { ArrowRight: 1, ArrowDown: 1, ArrowLeft: -1, ArrowUp: -1 }[event.key];
	if (!step) return;
	event.preventDefault();
	const at = (index + step + values.length) % values.length;
	choose(values[at] as T);
	const group = (event.currentTarget as HTMLElement).parentElement;
	requestAnimationFrame(() => (group?.children[at] as HTMLElement | undefined)?.focus());
}

/** One choice from a short list, as a radio group: arrow keys move and choose, Tab enters and leaves. */
export function Segmented<T extends string | number>({
	label,
	value,
	options,
	onChange,
}: {
	label: string;
	value: T;
	options: { value: T; label: string; tooltip?: string }[];
	onChange: (value: T) => void;
}) {
	return (
		<div
			role="radiogroup"
			aria-label={label}
			className="flex items-center gap-0.5 rounded-sm bg-surface p-0.5 shadow-[0_0_0_1px_var(--ef-line)]"
		>
			{options.map((option, index) => (
				<Button
					key={String(option.value)}
					type="button"
					role="radio"
					aria-checked={option.value === value}
					aria-label={option.tooltip ?? option.label}
					tooltip={option.tooltip ?? option.label}
					tabIndex={option.value === value ? 0 : -1}
					data-active-state={option.value === value ? "on" : "off"}
					className="h-8 min-w-8 px-2.5"
					onMouseDown={keepSelection}
					onKeyDown={(event) =>
						rove(
							event,
							index,
							options.map((o) => o.value),
							onChange,
						)
					}
					onClick={() => onChange(option.value)}
				>
					{option.label}
				</Button>
			))}
		</div>
	);
}

/** A row of swatches, one for each token, each named by the token's readable name. */
function Swatches({
	label,
	value,
	palette,
	onChange,
}: {
	label: string;
	value: Token;
	palette: DocBrand["palette"];
	onChange: (token: Token) => void;
}) {
	return (
		<div role="radiogroup" aria-label={label} className="flex items-center gap-1">
			{TOKENS.map((token, index) => {
				const color = swatchColor(palette, token);
				const on = token === value;
				return (
					<Button
						key={token}
						type="button"
						role="radio"
						aria-checked={on}
						aria-label={TOKEN_NAMES[token]}
						tooltip={TOKEN_NAMES[token]}
						tabIndex={on ? 0 : -1}
						data-token={token}
						data-active-state={on ? "on" : "off"}
						className={cn("!size-8 !min-w-8 !rounded-full !p-0", on && "shadow-[0_0_0_2px_var(--ef-ink)]")}
						onMouseDown={keepSelection}
						onKeyDown={(event) => rove(event, index, TOKENS, onChange)}
						onClick={() => onChange(token)}
					>
						<span
							aria-hidden="true"
							className="block size-5 rounded-full shadow-[inset_0_0_0_1px_color-mix(in_srgb,var(--ef-ink)_30%,transparent)]"
							style={
								color
									? { background: color }
									: {
											background:
												"linear-gradient(135deg, transparent 45%, var(--ef-magenta-500) 45% 55%, transparent 55%)",
										}
							}
						/>
					</Button>
				);
			})}
		</div>
	);
}

function Group({ label, children }: { label: string; children: ReactNode }) {
	return (
		<div role="group" aria-label={label} className="flex flex-wrap items-center gap-x-3 gap-y-1.5 px-1">
			<span className="text-sm font-semibold text-ink-2">{label}</span>
			{children}
		</div>
	);
}

function Labeled({ label, children }: { label: string; children: ReactNode }) {
	return (
		<span className="flex items-center gap-2">
			<span className="text-sm text-text-2">{label}</span>
			{children}
		</span>
	);
}

/** Height of an image in points: the format takes 8 to 1440. A value outside it is refused with the format's words. */
function HeightField({ editor, target }: { editor: Editor; target: Target }) {
	const id = useId();
	const current = typeof target.node.attrs.height === "number" ? target.node.attrs.height : 34;
	const [draft, setDraft] = useState<string | null>(null);
	const inRange = (text: string) => text !== "" && Number(text) >= 8 && Number(text) <= 1440;
	const problem = draft !== null && !inRange(draft) ? `${draft || "(empty)"} is outside 8 to 1440` : null;
	return (
		<span className="flex flex-wrap items-center gap-2">
			<label htmlFor={id} className="text-sm text-text-2">
				Height (pt)
			</label>
			<Tip text="Image height in points, 8 to 1440">
				<input
					id={id}
					type="number"
					inputMode="numeric"
					min={8}
					max={1440}
					step={1}
					value={draft ?? String(current)}
					aria-invalid={problem ? true : undefined}
					aria-describedby={problem ? `${id}-problem` : undefined}
					className="h-9 w-20 rounded-sm bg-surface px-2 text-md text-ink shadow-[0_0_0_1px_var(--ef-line-2)] outline-none focus-visible:shadow-[0_0_0_2px_var(--ef-focus)] aria-[invalid=true]:shadow-[0_0_0_1px_var(--ef-magenta-500)]"
					onChange={(event) => {
						const text = event.target.value;
						setDraft(text);
						if (inRange(text)) setBlockAttrs(editor, target.pos, { height: Number(text) });
					}}
					onBlur={() => setDraft(null)}
				/>
			</Tip>
			{problem ? (
				<span id={`${id}-problem`} role="alert" className="text-xs font-medium text-magenta-600">
					{problem}
				</span>
			) : null}
		</span>
	);
}

const WEIGHT_LABEL = { hairline: "Hairline", rule: "Rule", bar: "Bar" } as const;
const ALIGN_LABEL = { left: "Left", center: "Center", right: "Right" } as const;

function ControlsFor({ editor, target, palette }: { editor: Editor; target: Target; palette: DocBrand["palette"] }) {
	const attrs = target.node.attrs;
	switch (target.kind) {
		case "columns":
			return (
				<Group label="Columns">
					<Segmented
						label="Number of columns"
						value={target.node.childCount}
						options={[2, 3, 4].map((n) => ({ value: n, label: String(n), tooltip: `${n} columns` }))}
						onChange={(count) => setColumnCount(editor, target.pos, count)}
					/>
				</Group>
			);
		case "box":
			return (
				<Group label="Box">
					<Labeled label="Fill">
						<Swatches
							label="Box fill"
							value={(attrs.fill as Token | undefined) ?? "none"}
							palette={palette}
							onChange={(fill) => setBlockAttrs(editor, target.pos, { fill })}
						/>
					</Labeled>
					<Labeled label="Border">
						<Swatches
							label="Box border"
							value={(attrs.border as Token | undefined) ?? "border"}
							palette={palette}
							onChange={(border) => setBlockAttrs(editor, target.pos, { border })}
						/>
					</Labeled>
				</Group>
			);
		case "divider":
			return (
				<Group label="Divider">
					<Segmented
						label="Divider weight"
						value={(attrs.weight as (typeof WEIGHTS)[number] | undefined) ?? "rule"}
						options={WEIGHTS.map((w) => ({ value: w, label: WEIGHT_LABEL[w], tooltip: `${WEIGHT_LABEL[w]} weight` }))}
						onChange={(weight) => setBlockAttrs(editor, target.pos, { weight })}
					/>
					<Labeled label="Color">
						<Swatches
							label="Divider color"
							value={(attrs.color as Token | undefined) ?? "ink"}
							palette={palette}
							onChange={(color) => setBlockAttrs(editor, target.pos, { color })}
						/>
					</Labeled>
				</Group>
			);
		case "image":
			return (
				<Group label="Image">
					<HeightField editor={editor} target={target} />
					<Segmented
						label="Image alignment"
						value={(attrs.align as (typeof ALIGNS)[number] | undefined) ?? "left"}
						options={ALIGNS.map((a) => ({ value: a, label: ALIGN_LABEL[a], tooltip: `Align ${a}` }))}
						onChange={(align) => setBlockAttrs(editor, target.pos, { align })}
					/>
				</Group>
			);
		case "writeIn":
			return (
				<Group label={writeInKindLabel(attrs.kind)}>
					<span className="text-sm text-text-2">Edit the label on the line.</span>
				</Group>
			);
		case "field":
			return <FieldValue editor={editor} fieldKey={String(attrs.key ?? "")} />;
	}
}

/**
 * The value of the selected merge field. It commits on Enter or when the input loses focus, as one Undo step, and every
 * copy of the field on the page shows it at once. Escape puts back the value it had.
 */
function FieldValue({ editor, fieldKey }: { editor: Editor; fieldKey: string }) {
	const id = useId();
	const label = useEditorState({
		editor,
		selector: ({ editor: e }) => fieldDecl(e.state.doc, fieldKey)?.label ?? fieldKey,
	});
	const stored = useEditorState({
		editor,
		selector: ({ editor: e }) => {
			const value = (e.state.doc.attrs.data as Record<string, unknown> | undefined)?.[fieldKey];
			return typeof value === "string" ? value : "";
		},
	});
	const [draft, setDraft] = useState<string | null>(null);
	const commit = () => {
		if (draft !== null) setFieldValue(editor, fieldKey, draft);
		setDraft(null);
	};
	return (
		<Group label={`Merge field · ${label}`}>
			<span className="flex flex-wrap items-center gap-2">
				<label htmlFor={id} className="text-sm text-text-2">
					Value
				</label>
				<Tip text="What every copy of this field prints. Leave it empty to print its label in brackets.">
					<input
						id={id}
						type="text"
						maxLength={500}
						value={draft ?? stored}
						placeholder={`[${label.toLowerCase()}]`}
						className="h-9 w-[min(280px,60vw)] rounded-sm bg-surface px-2 text-md text-ink shadow-[0_0_0_1px_var(--ef-line-2)] outline-none placeholder:text-text-3 focus-visible:shadow-[0_0_0_2px_var(--ef-focus)]"
						onChange={(event) => setDraft(event.target.value)}
						onKeyDown={(event) => {
							if (event.key === "Enter") {
								event.preventDefault();
								commit();
								editor.view.focus();
							} else if (event.key === "Escape") {
								event.preventDefault();
								setDraft(null);
								editor.view.focus();
							}
						}}
						onBlur={commit}
					/>
				</Tip>
				<span className="text-sm text-text-2">Every copy of this field shows it.</span>
			</span>
		</Group>
	);
}

/** The settings row under the main toolbar. It shows only while the cursor is in a block that has settings. */
export function BlockControls({ editor, palette }: { editor: Editor; palette: DocBrand["palette"] }) {
	const targets = useEditorState({
		editor,
		selector: ({ editor: e }) => layoutTargets(e.state),
		equalityFn: (a, b) =>
			!!a && !!b && a.length === b.length && a.every((t, i) => t.pos === b[i]?.pos && t.node === b[i]?.node),
	});
	if (!targets || targets.length === 0) return null;
	return (
		<div
			role="group"
			aria-label="Block settings"
			className={cn(TOOLBAR, "flex-wrap overflow-visible border-t border-b-0 border-line")}
		>
			{targets.map((target) => (
				<ControlsFor key={`${target.kind}-${target.pos}`} editor={editor} target={target} palette={palette} />
			))}
		</div>
	);
}
