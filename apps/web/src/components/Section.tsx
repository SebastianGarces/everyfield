import type { ReactNode } from "react";
import { cn } from "./cn";

/** The page column: 1440 px at most, page padding on both sides. */
export function Container({ children, className }: { children: ReactNode; className?: string }) {
	return <div className={cn("mx-auto max-w-mk px-page", className)}>{children}</div>;
}

type SectionProps = { id?: string; children: ReactNode; className?: string; labelledBy?: string };

/** A page section with the marketing section spacing (72 to 120 px above and below) and the page column inside. */
export function Section({ id, children, className, labelledBy }: SectionProps) {
	return (
		<section id={id} aria-labelledby={labelledBy} className={cn("relative py-section", className)}>
			<Container>{children}</Container>
		</section>
	);
}
