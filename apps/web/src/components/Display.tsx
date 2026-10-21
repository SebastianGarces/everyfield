import type { ReactNode } from "react";
import { cn } from "./cn";

export type DisplaySize = "hero" | "h1" | "h2" | "h3";
// Each size carries its serif: DM Serif Display at 24px and up, DM Serif Text below. h3 is 22px until mk-xl, then 28px.
const SIZE: Record<DisplaySize, string> = {
	hero: "font-display text-mk-hero",
	h1: "font-display text-mk-h1",
	h2: "font-display text-mk-h2",
	h3: "font-title text-mk-h3 mk-xl:font-display",
};

type Props = { as: "h1" | "h2" | "h3"; size?: DisplaySize; id?: string; className?: string; children: ReactNode };

/**
 * A display heading (serif 400 at -0.02em, balanced lines). The heading level follows the page outline; the size is
 * separate, so a footer h2 can be smaller than a section h2. Pass size, or a text-* class with its font-display or
 * font-title class.
 */
export function Display({ as: As, size, id, className, children }: Props) {
	return (
		<As id={id} className={cn("mk-display", size && SIZE[size], className)}>
			{children}
		</As>
	);
}
