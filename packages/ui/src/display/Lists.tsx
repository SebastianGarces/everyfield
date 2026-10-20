import { ArrowRight01Icon } from "@hugeicons/core-free-icons";
import type { ComponentPropsWithRef, ElementType, ReactNode } from "react";
import { cn, Icon, type IconSvgElement } from "../foundations";
import { TINT, type Tone } from "./tone";
import { formatCount, type Count } from "./values";

/** KeyValue (components.md): Key, Value and an optional Delta in a ruled list. */
export function KeyValue({
	k,
	value,
	delta,
	size = "md",
	className,
}: {
	k: ReactNode;
	value: Count | ReactNode;
	delta?: ReactNode;
	/** sm: a compact text row for side panels ("Based on · Everyfield global v4"). */
	size?: "md" | "sm";
	className?: string;
}) {
	return (
		<div
			className={cn(
				"flex items-center justify-between gap-3 border-t border-line first:border-t-0",
				size === "sm" ? "py-2.5 text-sm" : "py-3.5",
				className,
			)}
		>
			<dt className="text-text-2">{k}</dt>
			<dd className="flex items-center gap-2">
				{value === null ? (
					<span className="text-text-3">Not recorded</span>
				) : (
					<span
						className={
							size === "sm" ? "text-right font-medium text-ink" : "num text-xl font-medium tracking-[-0.02em] text-ink"
						}
					>
						{typeof value === "number" ? formatCount(value) : value}
					</span>
				)}
				{delta}
			</dd>
		</div>
	);
}

/** A list of KeyValue rows. It is a description list, so each key names its value. */
export function KeyValueList({ className, ...props }: ComponentPropsWithRef<"dl">) {
	return <dl className={cn("flex flex-col", className)} {...props} />;
}

type ListRowProps = {
	title: ReactNode;
	subtitle?: ReactNode;
	/** An icon in a tone circle, or an Avatar passed as `leading`. */
	icon?: IconSvgElement;
	tone?: Tone;
	leading?: ReactNode;
	trailing?: ReactNode;
	/** A link row: it shows the chevron. Pass `linkAs` (next/link) for client navigation. */
	href?: string;
	linkAs?: ElementType;
	onClick?: () => void;
	/** The subtitle in magenta, for an overdue or failing item. */
	urgent?: boolean;
	className?: string;
};

/**
 * ListRow (components.md): Icon, Title, Subtitle and Trailing. With href it is a link, with onClick a button, else a
 * plain row. Rows are ruled by a hairline and draw the focus ring inside their edge.
 */
export function ListRow({
	title,
	subtitle,
	icon,
	tone = "ink",
	leading,
	trailing,
	href,
	linkAs,
	onClick,
	urgent,
	className,
}: ListRowProps) {
	const interactive = href !== undefined || onClick !== undefined;
	const Comp: ElementType = href !== undefined ? (linkAs ?? "a") : onClick ? "button" : "div";
	return (
		<Comp
			href={href}
			type={Comp === "button" ? "button" : undefined}
			onClick={onClick}
			data-focus-inset={interactive ? "" : undefined}
			className={cn(
				"flex w-full items-center gap-3.5 border-t border-line py-4 text-left text-ink first:border-t-0",
				interactive && "-mx-2 w-[calc(100%+16px)] cursor-pointer rounded-md px-2 transition-colors hover:bg-hover",
				className,
			)}
		>
			{leading ??
				(icon ? (
					<span aria-hidden="true" className={cn("grid size-11 flex-none place-items-center rounded-full", TINT[tone])}>
						<Icon icon={icon} size={20} />
					</span>
				) : null)}
			<span className="min-w-0 flex-1">
				<span className="block text-[15px] font-medium">{title}</span>
				{subtitle ? (
					<span className={cn("mt-0.5 block text-md", urgent ? "text-magenta-600" : "text-text-3")}>{subtitle}</span>
				) : null}
			</span>
			{trailing}
			{href !== undefined ? <Icon icon={ArrowRight01Icon} size={16} className="text-text-3" /> : null}
		</Comp>
	);
}

/** A list of ListRows, or of any rows ruled the same way. */
export function List({ className, ...props }: ComponentPropsWithRef<"div">) {
	return <div className={cn("flex flex-col", className)} {...props} />;
}
