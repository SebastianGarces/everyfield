import Link from "next/link";
import type { ReactNode } from "react";
import { cn } from "./cn";

export type ButtonVariant = "primary" | "secondary" | "inverse" | "photo" | "photo-secondary";
export type ButtonSize = "md" | "nav" | "pill" | "footer";

const BASE =
	"inline-flex items-center gap-2.5 whitespace-nowrap rounded-md border-0 font-sans font-semibold no-underline cursor-pointer " +
	"[transition:background-color_.2s,color_.2s,translate_.12s,box-shadow_.2s] active:translate-y-px motion-reduce:transition-none";
const VARIANT: Record<ButtonVariant, string> = {
	primary: "bg-ink text-cream hover:bg-ink-2",
	secondary:
		"bg-white text-ink shadow-[inset_0_0_0_1px_var(--color-mk-line-strong)] hover:shadow-[inset_0_0_0_1.5px_var(--color-ink)]",
	// Cream button on the ink footer card; it turns accent green on hover and keeps a cream focus ring.
	inverse: "bg-cream text-ink hover:bg-green focus-visible:outline-cream",
	// On a photo: a cream primary, and a secondary on a 42 % ink backing that keeps its cream label at 4.5:1 over light
	// patches. Both keep a cream focus ring.
	photo: "bg-cream text-ink hover:bg-white focus-visible:outline-cream",
	"photo-secondary":
		"bg-mk-ink-42 text-cream shadow-[inset_0_0_0_1px_var(--color-mk-cream-70)] hover:bg-mk-ink-56 hover:shadow-[inset_0_0_0_1.5px_var(--color-cream)] focus-visible:outline-cream",
};
const SIZE: Record<ButtonSize, string> = {
	md: "h-[50px] px-6 type-lg max-mk-sm:h-12 max-mk-sm:px-5",
	nav: "h-[42px] px-[18px] type-md max-mk-sm:h-10 max-mk-sm:px-3.5",
	pill: "h-11 px-[18px] type-md max-mk-sm:h-[42px] max-mk-sm:px-3.5",
	footer: "h-[46px] px-6 type-lg max-mk-sm:px-5",
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
