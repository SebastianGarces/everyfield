import { cva, type VariantProps } from "class-variance-authority";
import type { ComponentPropsWithRef, ReactNode } from "react";
import { cn, Icon, type IconSvgElement } from "../foundations";
import { TINT, type Tone } from "./tone";

/**
 * The five evidence states (foundations.md, Color roles). The dot carries the hue; the label always carries the
 * meaning, so the state never depends on color alone.
 */
export type Status = "positive" | "measured" | "attention" | "risk" | "unknown";

const DOT: Record<Status, string> = {
	positive: "bg-green-500",
	measured: "bg-blue-500",
	attention: "bg-amber-500",
	risk: "bg-magenta-500",
	unknown: "bg-transparent shadow-[inset_0_0_0_1.5px_var(--ef-text-3)]",
};
const SOFT: Record<Status, string> = {
	positive: "bg-green-100 text-green-700",
	measured: "bg-blue-100 text-blue-600",
	attention: "bg-amber-100 text-amber-600",
	risk: "bg-magenta-100 text-magenta-600",
	unknown: "bg-surface-2 text-text-2",
};

const badgeVariants = cva(
	"inline-flex flex-none items-center gap-1.5 rounded-full font-semibold whitespace-nowrap text-ink",
	{
		variants: {
			fill: {
				outline: "bg-surface-raised shadow-[inset_0_0_0_1px_var(--ef-line)]",
				soft: "",
			},
			size: { md: "h-7 px-[11px] text-sm", sm: "h-[22px] px-2 text-xs" },
		},
		defaultVariants: { fill: "outline", size: "md" },
	},
);

/** StatusBadge (components.md): Dot and Label. `plain` drops the dot for a neutral count badge. */
export function StatusBadge({
	status = "unknown",
	fill,
	size,
	plain,
	className,
	children,
	...props
}: ComponentPropsWithRef<"span"> &
	VariantProps<typeof badgeVariants> & { status?: Status; plain?: boolean; children: ReactNode }) {
	return (
		<span
			data-status={status}
			className={cn(badgeVariants({ fill, size }), fill === "soft" && SOFT[status], className)}
			{...props}
		>
			{plain ? null : <span aria-hidden="true" className={cn("size-[7px] flex-none rounded-full", DOT[status])} />}
			{children}
		</span>
	);
}

/**
 * DeltaChip (components.md): an arrow and a value. The arrow is drawn, so the direction is also said in words for
 * screen readers ("up 9 people"). tone="risk" turns an upward arrow magenta, for counts where up is bad.
 */
export function DeltaChip({
	dir,
	tone = "auto",
	size = "md",
	onInk,
	className,
	children,
}: {
	dir: "up" | "down";
	tone?: "auto" | "risk";
	size?: "md" | "sm";
	/** On an InsightCard gradient: a translucent white chip. */
	onInk?: boolean;
	className?: string;
	children: ReactNode;
}) {
	const bad = dir === "down" || tone === "risk";
	return (
		<span
			data-dir={dir}
			className={cn(
				"inline-flex flex-none items-center gap-1.5 rounded-full font-semibold whitespace-nowrap tabular-nums",
				size === "sm" ? "h-6 px-2 text-xs" : "h-[30px] px-[11px] text-md",
				onInk
					? "bg-white/14 text-white shadow-[inset_0_0_0_1px_color-mix(in_srgb,white_22%,transparent)]"
					: "bg-surface-raised text-ink shadow-[inset_0_0_0_1px_var(--ef-line)]",
				className,
			)}
		>
			<span
				aria-hidden="true"
				className={cn(
					"size-0 border-x-[5px] border-x-transparent",
					dir === "up" ? "border-b-[7px]" : "border-t-[7px]",
					bad ? "border-b-magenta-500 border-t-magenta-500" : "border-b-green-500 border-t-green-500",
				)}
			/>
			<span className="sr-only">{dir === "up" ? "up " : "down "}</span>
			{children}
		</span>
	);
}

/** Tag (components.md): an optional icon and a label in a tone. Use for ministries, skills and labels. */
export function Tag({
	tone,
	icon,
	className,
	children,
}: {
	tone?: Tone;
	icon?: IconSvgElement;
	className?: string;
	children: ReactNode;
}) {
	return (
		<span
			className={cn(
				"inline-flex h-[26px] flex-none items-center gap-1.5 rounded-[8px] px-2.5 text-sm font-medium whitespace-nowrap",
				tone ? TINT[tone] : "bg-surface-2 text-ink-2",
				className,
			)}
		>
			{icon ? <Icon icon={icon} size={16} className="size-3.5" /> : null}
			{children}
		</span>
	);
}

/** The seven pipeline stages, in order (components.md, Stage chip). */
export const STAGES = ["prospect", "attendee", "following", "interviewed", "core", "launch", "leader"] as const;
export type Stage = (typeof STAGES)[number];

export const STAGE_LABEL: Record<Stage, string> = {
	prospect: "Prospect",
	attendee: "Attendee",
	following: "Following up",
	interviewed: "Interviewed",
	core: "Core group",
	launch: "Launch team",
	leader: "Leader",
};

/** The dot color of each stage, also used by pipeline column headers. */
export const STAGE_DOT: Record<Stage, string> = {
	prospect: "bg-text-3",
	attendee: "bg-blue-500",
	following: "bg-amber-500",
	interviewed: "bg-violet-500",
	core: "bg-green-500",
	launch: "bg-teal-500",
	leader: "bg-ink",
};

const STAGE_FILL: Record<Stage, string> = {
	prospect: "bg-surface-2 text-text-2",
	attendee: "bg-blue-100 text-blue-600",
	following: "bg-amber-100 text-amber-600",
	interviewed: "bg-violet-100 text-violet-600",
	core: "bg-green-100 text-green-700",
	launch: "bg-teal-100 text-teal-600",
	leader: "bg-ink text-on-ink",
};

/** StageChip (components.md): Dot and Label for one of the seven pipeline stages. */
export function StageChip({ stage, className, children }: { stage: Stage; className?: string; children?: ReactNode }) {
	return (
		<span
			data-stage={stage}
			className={cn(
				"inline-flex h-[26px] flex-none items-center gap-1.5 rounded-full px-2.5 text-xs font-semibold whitespace-nowrap",
				STAGE_FILL[stage],
				className,
			)}
		>
			<span aria-hidden="true" className="size-1.5 rounded-full bg-current" />
			{children ?? STAGE_LABEL[stage]}
		</span>
	);
}

export type AvatarSize = "xs" | "sm" | "md" | "lg" | "xl";
const AVATAR_SIZE: Record<AvatarSize, string> = {
	xs: "size-[26px] text-[11px]",
	sm: "size-8 text-xs",
	md: "size-10 text-sm",
	lg: "size-16 text-[22px]",
	xl: "size-[92px] font-display text-[32px]",
};

/** Two initials from a display name: "Maria Santos" is MS, "Cher" is CH. */
export function initials(name: string): string {
	const words = name.trim().split(/\s+/).filter(Boolean);
	if (words.length === 0) return "?";
	if (words.length === 1) return words[0]!.slice(0, 2).toUpperCase();
	return (words[0]![0]! + words[words.length - 1]![0]!).toUpperCase();
}

/**
 * Avatar (components.md): Image or Fallback initials in a tone. The person's name is the accessible name; pass
 * `decorative` when the name is already written next to it, as in a list row.
 */
export function Avatar({
	name,
	label,
	src,
	tone = "ink",
	size = "md",
	ring,
	decorative,
	className,
	children,
}: {
	name: string;
	/** The accessible name when it says more than the name: "Owner: Daniel Reyes". Initials still come from `name`. */
	label?: string;
	src?: string;
	tone?: Tone;
	size?: AvatarSize;
	/** The green ring of the signed-in user. */
	ring?: boolean;
	decorative?: boolean;
	className?: string;
	/** Replaces the initials, for an icon in an open role slot. */
	children?: ReactNode;
}) {
	return (
		<span
			role={decorative ? undefined : "img"}
			aria-label={decorative ? undefined : (label ?? name)}
			aria-hidden={decorative ? true : undefined}
			className={cn(
				"relative grid flex-none place-items-center overflow-hidden rounded-full font-semibold",
				AVATAR_SIZE[size],
				TINT[tone],
				ring
					? "shadow-[0_0_0_2px_var(--ef-surface),0_0_0_4px_var(--ef-green-500)]"
					: "shadow-[0_0_0_2px_var(--ef-surface)]",
				className,
			)}
		>
			{src ? (
				<img src={src} alt="" className="size-full object-cover" />
			) : (
				(children ?? <span aria-hidden="true">{initials(name)}</span>)
			)}
		</span>
	);
}

/**
 * AvatarGroup (components.md): overlapping avatars with a "+n" counter. The group is one image named by `label`
 * ("Maria Santos, James Okafor and 8 others"), so a screen reader hears one sentence instead of each circle.
 */
export function AvatarGroup({
	people,
	max = 3,
	size = "sm",
	label,
	className,
}: {
	people: { name: string; src?: string; tone?: Tone }[];
	max?: number;
	size?: AvatarSize;
	label?: string;
	className?: string;
}) {
	const shown = people.slice(0, max);
	const more = people.length - shown.length;
	const names = shown.map((p) => p.name).join(", ");
	return (
		<span
			role="img"
			aria-label={label ?? (more > 0 ? `${names} and ${more} more` : names)}
			className={cn("flex", className)}
		>
			{shown.map((p, i) => (
				<Avatar
					key={p.name + i}
					{...p}
					size={size}
					decorative
					className={i === 0 ? undefined : size === "xs" ? "-ml-[5px]" : "-ml-2"}
				/>
			))}
			{more > 0 ? (
				<span
					aria-hidden="true"
					className={cn(
						"grid flex-none place-items-center rounded-full bg-ink font-semibold text-on-ink shadow-[0_0_0_2px_var(--ef-surface)]",
						AVATAR_SIZE[size],
						size === "xs" ? "-ml-[5px] text-[10px]" : "-ml-2",
					)}
				>
					+{more}
				</span>
			) : null}
		</span>
	);
}
