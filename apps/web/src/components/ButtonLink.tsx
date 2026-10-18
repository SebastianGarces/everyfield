import Link from "next/link";
import type { ReactNode } from "react";
import { cn } from "./cn";

export type ButtonVariant = "primary" | "secondary" | "inverse";
export type ButtonSize = "md" | "nav" | "pill" | "footer";

const BASE =
	"inline-flex items-center gap-2.5 whitespace-nowrap rounded-md border-0 font-sans font-semibold no-underline cursor-pointer " +
	"[transition:background-color_.2s,color_.2s,translate_.12s,box-shadow_.2s] active:translate-y-px motion-reduce:transition-none";
const VARIANT: Record<ButtonVariant, string> = {
	primary: "bg-ink text-white hover:bg-ink-2",
	secondary:
		"bg-white text-ink shadow-[inset_0_0_0_1px_var(--color-mk-line-strong)] hover:shadow-[inset_0_0_0_1.5px_var(--color-ink)]",
	// White button on the ink footer card; it turns accent green on hover and keeps a white focus ring.
	inverse: "bg-white text-ink hover:bg-green focus-visible:outline-white",
};
const SIZE: Record<ButtonSize, string> = {
	md: "h-[50px] px-6 text-[15.5px] max-mk-sm:h-12 max-mk-sm:px-5 max-mk-sm:text-[15px]",
	nav: "h-[42px] px-[18px] text-[14.5px] max-mk-sm:h-10 max-mk-sm:px-3.5 max-mk-sm:text-[13.5px]",
	pill: "h-11 px-[18px] text-[14.5px] max-mk-sm:h-[42px] max-mk-sm:px-3.5 max-mk-sm:text-[13.5px]",
	footer: "h-[46px] px-6 text-[15.5px] max-mk-sm:px-5 max-mk-sm:text-[15px]",
};

/** Class names for a button-styled link. Shared with the client nav, which renders its own anchors. */
export function buttonClass(variant: ButtonVariant = "primary", size: ButtonSize = "md", className?: string) {
	return cn(BASE, VARIANT[variant], SIZE[size], className);
}

type Props = {
	href: string;
	children: ReactNode;
	variant?: ButtonVariant;
	size?: ButtonSize;
	/** A trailing icon, rendered by the caller (usually <Icon icon={ArrowRight02Icon} size={17} />). */
	icon?: ReactNode;
	current?: boolean;
	className?: string;
};

/** A link that looks like a button. Navigation, so it is a link (next/link), never a <button>. */
export function ButtonLink({ href, children, variant, size, icon, current, className }: Props) {
	return (
		<Link href={href} className={buttonClass(variant, size, className)} aria-current={current ? "page" : undefined}>
			{children}
			{icon}
		</Link>
	);
}
