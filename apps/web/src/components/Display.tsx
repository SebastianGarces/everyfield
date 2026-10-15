import type { ReactNode } from "react";
import { cn } from "./cn";

export type DisplaySize = "hero" | "h1" | "h2" | "h3";
const SIZE: Record<DisplaySize, string> = {
  hero: "text-mk-hero",
  h1: "text-mk-h1",
  h2: "text-mk-h2",
  h3: "text-mk-h3 tracking-[-0.02em]",
};

type Props = { as: "h1" | "h2" | "h3"; size?: DisplaySize; id?: string; className?: string; children: ReactNode };

/**
 * A display heading (Bricolage Grotesque 500, tight tracking, balanced lines). The heading level follows the page
 * outline; the size is separate, so a footer h2 can be smaller than a section h2. Pass size or a text-* class.
 */
export function Display({ as: As, size, id, className, children }: Props) {
  return <As id={id} className={cn("mk-display", size && SIZE[size], className)}>{children}</As>;
}
