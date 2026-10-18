import type { ReactNode } from "react";
import { cn } from "./cn";

type Props = { children: ReactNode; className?: string; as?: "div" | "article" | "li" };

/** A white marketing card: 26 px radius, soft card shadow, 30 px padding (callers may change the padding). */
export function Card({ children, className, as: As = "div" }: Props) {
	return <As className={cn("rounded-card bg-white p-[30px] shadow-mk-card", className)}>{children}</As>;
}
