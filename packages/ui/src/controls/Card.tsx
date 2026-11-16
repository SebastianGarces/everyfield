import { Cancel01Icon } from "@hugeicons/core-free-icons";
import { cva, type VariantProps } from "class-variance-authority";
import type { ComponentPropsWithRef, ReactNode } from "react";
import { cn, Icon, type IconSvgElement } from "../foundations";
import { IconButton } from "./Button";

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
			default: "border border-[var(--ef-card-edge)] bg-surface shadow-card [--ef-card-fill:var(--ef-surface)]",
			raised:
				"border border-[var(--ef-card-edge)] bg-surface-raised shadow-card [--ef-card-fill:var(--ef-surface-raised)]",
			flat: "border border-dashed border-line-2 bg-transparent [--ef-card-fill:var(--ef-surface)]",
			callout:
				"rounded-lg border border-line bg-surface-raised px-5 py-[18px] shadow-card [--ef-card-bottom:18px] [--ef-card-corner:var(--ef-radius-lg)] [--ef-card-fill:var(--ef-surface-raised)] [--ef-card-x:20px]",
		},
		size: { md: "", sm: "" },
	},
	compoundVariants: [
		{
			variant: ["default", "raised", "flat"],
			size: "md",
			className:
				"rounded-card px-7 py-[26px] [--ef-card-bottom:26px] [--ef-card-corner:var(--ef-radius-card)] [--ef-card-x:28px] max-app-sm:px-5 max-app-sm:py-5 max-app-sm:[--ef-card-bottom:20px] max-app-sm:[--ef-card-x:20px]",
		},
		{
			variant: ["default", "raised", "flat"],
			size: "sm",
			className:
				"rounded-lg px-[22px] py-5 [--ef-card-bottom:20px] [--ef-card-corner:var(--ef-radius-lg)] [--ef-card-x:22px]",
		},
	],
	defaultVariants: { variant: "default", size: "md" },
});

type CardProps = ComponentPropsWithRef<"div"> &
	VariantProps<typeof cardVariants> & {
		tone?: Tone;
		as?: "div" | "section" | "article";
	};

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
				"font-title leading-[1.2] tracking-[-0.02em] text-ink text-pretty",
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

export function CardClose({
	label = "Close",
	...props
}: Omit<ComponentPropsWithRef<"button">, "children"> & { label?: string }) {
	return <IconButton icon={Cancel01Icon} label={label} size="sm" {...props} />;
}

export function CardBody({ className, ...props }: ComponentPropsWithRef<"div">) {
	return <div className={cn("min-w-0 flex-1", className)} {...props} />;
}

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

export function CardStickyFooter({ className, ...props }: ComponentPropsWithRef<"div">) {
	return (
		<div
			className={cn(
				"sticky bottom-0 z-[2] -mx-[var(--ef-card-x)] -mb-[var(--ef-card-bottom)] flex flex-wrap items-center justify-between gap-3 rounded-b-[var(--ef-card-corner)] border-t border-line bg-[var(--ef-card-fill)] px-[var(--ef-card-x)] pt-3 pb-[max(12px,env(safe-area-inset-bottom))]",
				className,
			)}
			{...props}
		/>
	);
}

export function CardInset({ className, ...props }: ComponentPropsWithRef<"div">) {
	return (
		<div
			className={cn("rounded-md bg-surface-raised px-5 py-[18px] shadow-[0_1px_2px_var(--ef-line)]", className)}
			{...props}
		/>
	);
}

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
				"grid flex-none place-items-center rounded-pill",
				TONE[tone],
				size === 36 ? "size-9" : "size-11",
				className,
			)}
		>
			<Icon icon={icon} size={size === 36 ? 16 : 20} />
		</span>
	);
}

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
					<span aria-hidden="true" className={cn("grid size-7 flex-none place-items-center rounded-pill", TONE[tone])}>
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
