import { cn } from "@everyfield/ui/foundations";
import type { ReactNode } from "react";

type DisplaySize = "hero" | "h1" | "h2" | "h3";
const SIZE: Record<DisplaySize, string> = {
	hero: "font-display text-mk-hero",
	h1: "font-display text-mk-h1",
	h2: "font-display text-mk-h2",
	h3: "font-title text-mk-h3 mk-xl:font-display",
};

type Props = { as: "h1" | "h2" | "h3"; size?: DisplaySize; id?: string; className?: string; children: ReactNode };

export function Display({ as: As, size, id, className, children }: Props) {
	return (
		<As id={id} className={cn("mk-display", size && SIZE[size], className)}>
			{children}
		</As>
	);
}
