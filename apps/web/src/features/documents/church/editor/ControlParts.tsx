"use client";

import type { DocBrand, Token } from "@everyfield/contracts/documents";
import { cn } from "@everyfield/ui/foundations";
import type { KeyboardEvent, ReactNode } from "react";
import { TOKEN_NAMES, TOKENS } from "./layout.ts";
import { Button } from "./tiptap/primitives/button.tsx";
import { Tooltip, TooltipContent, TooltipTrigger } from "./tiptap/primitives/tooltip.tsx";

// The small controls the settings row is made of: a tooltip for a field, a choice from a short list, a row of color
// swatches, and a labelled group. Every color control offers the format's tokens only: no hex input, no color picker.

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

export const keepSelection = (event: { preventDefault: () => void }) => event.preventDefault();

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
export function Swatches({
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

export function Group({ label, children }: { label: string; children: ReactNode }) {
	return (
		<div role="group" aria-label={label} className="flex flex-wrap items-center gap-x-3 gap-y-1.5 px-1">
			<span className="text-sm font-semibold text-ink-2">{label}</span>
			{children}
		</div>
	);
}

export function Labeled({ label, children }: { label: string; children: ReactNode }) {
	return (
		<span className="flex items-center gap-2">
			<span className="text-sm text-text-2">{label}</span>
			{children}
		</span>
	);
}
