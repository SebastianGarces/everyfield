import { Cancel01Icon } from "@hugeicons/core-free-icons";
import { cva, type VariantProps } from "class-variance-authority";
import type { ComponentPropsWithRef, ReactNode } from "react";
import { cn, Icon, type IconSvgElement } from "../foundations";
import { IconButton } from "./Button";

/** The tone pairs for icon circles and callouts: a 100 tint behind a 600 or 700 mark (foundations.md, Color roles). */
export type Tone = "green" | "blue" | "amber" | "magenta" | "violet" | "teal" | "ink";

const TONE: Record<Tone, string> = {
	green: "bg-green-100 text-green-700",
	blue: "bg-blue-100 text-blue-600",
	amber: "bg-amber-100 text-amber-600",
	magenta: "bg-magenta-100 text-magenta-600",
	violet: "bg-violet-100 text-violet-600",
	teal: "bg-teal-100 text-teal-600",
	ink: "bg-surface-2 text-ink-2",
};

/** The text color for a callout label in each tone. */
const TONE_TEXT: Record<Tone, string> = {
	green: "text-green-700",
	blue: "text-blue-600",
	amber: "text-amber-600",
	magenta: "text-magenta-600",
	violet: "text-violet-600",
	teal: "text-teal-600",
	ink: "text-ink-2",
};

export const cardVariants = cva("relative flex min-w-0 flex-col", {
	variants: {
		variant: {
			default: "border border-[var(--ef-card-edge)] bg-surface shadow-card",
			raised: "border border-[var(--ef-card-edge)] bg-surface-raised shadow-card",
			flat: "border border-dashed border-line-2 bg-transparent",
			callout: "rounded-lg border border-line bg-surface-raised px-5 py-[18px] shadow-card",
		},
		size: { md: "", sm: "" },
	},
	compoundVariants: [
		{
			variant: ["default", "raised", "flat"],
			size: "md",
			className: "rounded-card px-7 py-[26px] max-app-sm:px-5 max-app-sm:py-5",
		},
		{ variant: ["default", "raised", "flat"], size: "sm", className: "rounded-lg px-[22px] py-5" },
	],
	defaultVariants: { variant: "default", size: "md" },
});

type CardProps = ComponentPropsWithRef<"div"> &
	VariantProps<typeof cardVariants> & {
		/** Callout tone: the label and its icon circle take it. The card itself stays white. */
		tone?: Tone;
		/** Render as a section or article (with a heading inside) instead of a div. */
		as?: "div" | "section" | "article";
	};

/**
 * A card frame with optional slots (components.md, Card). Use only the slots you need: Header (Title, Description,
 * Actions, Close), Body or ScrollArea, Footer and Inset. variant="callout" with tone is the Callout row.
 */
export function Card({ variant, size, tone = "amber", as: Comp = "div", className, ...props }: CardProps) {
	return (
		<Comp
			data-variant={variant ?? "default"}
			data-tone={variant === "callout" ? tone : undefined}
			className={cn(cardVariants({ variant, size }), className)}
			{...props}
		/>
	);
}

export function CardHeader({ className, ...props }: ComponentPropsWithRef<"div">) {
	return <div className={cn("mb-5 flex items-start gap-4", className)} {...props} />;
}

/** The title and description column of a header; it takes the free width. */
export function CardHeading({ className, ...props }: ComponentPropsWithRef<"div">) {
	return <div className={cn("min-w-0 flex-1", className)} {...props} />;
}

type HeadingLevel = "h2" | "h3" | "h4" | "p";

export function CardTitle({
	as: Comp = "h2",
	size = "md",
	className,
	...props
}: ComponentPropsWithRef<"h2"> & { as?: HeadingLevel; size?: "md" | "sm" }) {
	return (
		<Comp
			className={cn(
				"font-display leading-[1.2] font-medium tracking-[-0.02em] text-ink text-pretty",
				size === "sm" ? "text-title-sm" : "text-title-md",
				className,
			)}
			{...props}
		/>
	);
}

export function CardDescription({ className, ...props }: ComponentPropsWithRef<"p">) {
	return <p className={cn("mt-1 text-md text-text-3", className)} {...props} />;
}

export function CardActions({ className, ...props }: ComponentPropsWithRef<"div">) {
	return <div className={cn("flex flex-none items-center gap-2", className)} {...props} />;
}

/** The close button in a header. `label` names what closes, such as "Dismiss the meeting reminder". */
export function CardClose({
	label = "Close",
	...props
}: Omit<ComponentPropsWithRef<"button">, "children"> & { label?: string }) {
	return <IconButton icon={Cancel01Icon} label={label} size="sm" {...props} />;
}

export function CardBody({ className, ...props }: ComponentPropsWithRef<"div">) {
	return <div className={cn("min-w-0 flex-1", className)} {...props} />;
}

/**
 * A scrolling body with the prototype's bottom fade. It is a focusable region so keyboard users can scroll it;
 * `label` names it for screen readers.
 */
export function CardScrollArea({
	label,
	maxHeight = 220,
	className,
	style,
	...props
}: ComponentPropsWithRef<"div"> & { label: string; maxHeight?: number }) {
	return (
		<div
			role="region"
			aria-label={label}
			tabIndex={0}
			data-focus-inset=""
			style={{ maxHeight, ...style }}
			className={cn("ef-scroll-fade -mx-3 overflow-y-auto rounded-md px-3 pb-3", className)}
			{...props}
		/>
	);
}

export function CardFooter({ plain, className, ...props }: ComponentPropsWithRef<"div"> & { plain?: boolean }) {
	return (
		<div
			className={cn(
				"mt-[22px] flex flex-wrap items-center gap-2.5",
				!plain && "border-t border-line pt-[18px]",
				className,
			)}
			{...props}
		/>
	);
}

/** A raised panel inside a card or dialog. */
export function CardInset({ className, ...props }: ComponentPropsWithRef<"div">) {
	return (
		<div
			className={cn("rounded-md bg-surface-raised px-5 py-[18px] shadow-[0_1px_2px_var(--ef-line)]", className)}
			{...props}
		/>
	);
}

/** A round icon tile in a tone, as in card and dialog headers. Decorative. */
export function CardIcon({
	icon,
	tone = "ink",
	size = 44,
	className,
}: {
	icon: IconSvgElement;
	tone?: Tone;
	size?: 36 | 44;
	className?: string;
}) {
	return (
		<span
			aria-hidden="true"
			className={cn(
				"grid flex-none place-items-center rounded-full",
				TONE[tone],
				size === 36 ? "size-9" : "size-11",
				className,
			)}
		>
			<Icon icon={icon} size={size === 36 ? 16 : 20} />
		</span>
	);
}

/** Callout label: a small tinted icon circle (or EvryBot) and a short label in the callout's tone. */
export function CalloutLabel({
	tone = "amber",
	icon,
	art,
	children,
}: {
	tone?: Tone;
	icon?: IconSvgElement;
	art?: ReactNode;
	children: ReactNode;
}) {
	return (
		<p className={cn("flex items-center gap-2.5 text-sm font-semibold", TONE_TEXT[tone])}>
			{art ??
				(icon ? (
					<span aria-hidden="true" className={cn("grid size-7 flex-none place-items-center rounded-full", TONE[tone])}>
						<Icon icon={icon} size={16} />
					</span>
				) : null)}
			{children}
		</p>
	);
}

export function CalloutTitle({ className, ...props }: ComponentPropsWithRef<"p">) {
	return <p className={cn("mt-3 font-semibold text-ink", className)} {...props} />;
}

export function CalloutText({ className, ...props }: ComponentPropsWithRef<"p">) {
	return <p className={cn("mt-1.5 text-[15px] text-ink-2 text-pretty", className)} {...props} />;
}

export { TONE as toneClasses };
