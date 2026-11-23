import type { ComponentPropsWithRef } from "react";
import { cn } from "../foundations";

const PILL_TONE = {
	neutral: "bg-surface-2 text-text-2",
	attention: "bg-amber-100 text-amber-600",
	positive: "bg-green-100 text-green-700",
	error: "bg-magenta-50 text-magenta-600",
} as const;
export type PillTone = keyof typeof PILL_TONE;

export function TonePill({
	tone,
	...props
}: Omit<ComponentPropsWithRef<"span">, "className" | "style"> & { tone: PillTone }) {
	return (
		<span
			{...props}
			className={cn(
				"inline-flex h-6 shrink-0 items-center rounded-full px-2.5 text-xs font-medium whitespace-nowrap",
				PILL_TONE[tone],
			)}
		/>
	);
}

const TAG_TONE = {
	positive: "bg-green-50 text-green-700",
	muted: "bg-surface-raised text-text-2 shadow-[inset_0_0_0_1px_var(--ef-line)]",
	error: "bg-magenta-50 text-magenta-600",
} as const;
export type TagTone = keyof typeof TAG_TONE;

export function ToneTag({
	tone,
	...props
}: Omit<ComponentPropsWithRef<"span">, "className" | "style"> & { tone: TagTone }) {
	return <span {...props} className={cn("rounded-sm px-1.5 py-0.5 text-xs font-medium", TAG_TONE[tone])} />;
}

const BAND_TONE = {
	amber: "bg-amber-50 text-amber-600 border-b-[color-mix(in_srgb,var(--ef-amber-500)_20%,transparent)]",
	green: "bg-green-50 text-green-700 border-b-[color-mix(in_srgb,var(--ef-green-500)_20%,transparent)]",
	magenta: "bg-magenta-50 text-magenta-600 border-b-[color-mix(in_srgb,var(--ef-magenta-500)_20%,transparent)]",
	gray: "bg-surface-2 text-text-2 border-b-line",
} as const;
export type BandTone = keyof typeof BAND_TONE;

export function ToneBand({
	tone,
	...props
}: Omit<ComponentPropsWithRef<"h3">, "className" | "style"> & { tone: BandTone }) {
	return (
		<h3
			{...props}
			className={cn(
				"flex items-center gap-2.5 border-b px-4 py-3 font-sans text-sm font-semibold tracking-normal outline-none focus-visible:ring-2 focus-visible:ring-focus focus-visible:ring-inset",
				BAND_TONE[tone],
			)}
		/>
	);
}
