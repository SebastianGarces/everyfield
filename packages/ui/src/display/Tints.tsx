import type { ComponentPropsWithRef } from "react";
import { cn } from "../foundations";

const PILL_TONE = {
	neutral: "bg-surface-2 text-text-2",
	attention: "bg-amber-100 text-amber-600",
	positive: "bg-green-100 text-green-700",
	error: "bg-magenta-50 text-magenta-600",
} as const;
export type PillTone = keyof typeof PILL_TONE;

export function TonePill({ tone, className, ...props }: ComponentPropsWithRef<"span"> & { tone: PillTone }) {
	return (
		<span
			className={cn(
				"inline-flex h-6 shrink-0 items-center rounded-full px-2.5 text-xs font-medium whitespace-nowrap",
				PILL_TONE[tone],
				className,
			)}
			{...props}
		/>
	);
}

const TAG_TONE = {
	positive: "bg-green-50 text-green-700",
	muted: "bg-surface-raised text-text-2 shadow-[inset_0_0_0_1px_var(--ef-line)]",
	error: "bg-magenta-50 text-magenta-600",
} as const;
export type TagTone = keyof typeof TAG_TONE;

export function ToneTag({ tone, className, ...props }: ComponentPropsWithRef<"span"> & { tone: TagTone }) {
	return <span className={cn("rounded-sm px-1.5 py-0.5 text-xs font-medium", TAG_TONE[tone], className)} {...props} />;
}

const BAND_TONE = {
	amber: "bg-amber-50 text-amber-600 border-b-[color-mix(in_srgb,var(--ef-amber-500)_20%,transparent)]",
	green: "bg-green-50 text-green-700 border-b-[color-mix(in_srgb,var(--ef-green-500)_20%,transparent)]",
	magenta: "bg-magenta-50 text-magenta-600 border-b-[color-mix(in_srgb,var(--ef-magenta-500)_20%,transparent)]",
	gray: "bg-surface-2 text-text-2 border-b-line",
} as const;
export type BandTone = keyof typeof BAND_TONE;

export function ToneBand({ tone, className, ...props }: ComponentPropsWithRef<"h3"> & { tone: BandTone }) {
	return <h3 className={cn(className, BAND_TONE[tone])} {...props} />;
}
