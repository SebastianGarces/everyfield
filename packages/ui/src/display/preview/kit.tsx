import type { ReactNode } from "react";
import { CardDescription, CardHeader, CardHeading, CardTitle } from "../../controls";
import { cn, revealDelay } from "../../foundations";

/** One preview section: a title, the component names it shows and the specimens. */
export function Section({
	title,
	code,
	index,
	note,
	children,
}: {
	title: string;
	code: string;
	index: number;
	note?: ReactNode;
	children: ReactNode;
}) {
	const id = `section-${title.toLowerCase().replace(/[^a-z]+/g, "-")}`;
	return (
		<section aria-labelledby={id} className="reveal" style={revealDelay(index)}>
			<div className="mb-4 flex flex-wrap items-baseline gap-x-4 gap-y-1">
				<h2 id={id} className="text-title-lg text-ink">
					{title}
				</h2>
				<code className="text-sm text-text-3">{code}</code>
			</div>
			{note ? <p className="mb-4 max-w-[760px] text-text-2">{note}</p> : null}
			{children}
		</section>
	);
}

/** A white card holding one or more specimens, with an optional small heading. */
export function Specimen({
	title,
	description,
	action,
	className,
	children,
}: {
	title?: string;
	description?: string;
	action?: ReactNode;
	className?: string;
	children: ReactNode;
}) {
	return (
		<div
			className={cn(
				"min-w-0 rounded-card border border-[var(--ef-card-edge)] bg-surface px-7 py-[26px] shadow-card max-app-sm:px-5 max-app-sm:py-5",
				className,
			)}
		>
			{title ? (
				<CardHeader>
					<CardHeading>
						<CardTitle as="h3" size="sm">
							{title}
						</CardTitle>
						{description ? <CardDescription>{description}</CardDescription> : null}
					</CardHeading>
					{action}
				</CardHeader>
			) : null}
			{children}
		</div>
	);
}

/** A responsive grid of specimens: one column on a phone, `cols` from 1024px. */
export function Grid({ cols = 3, className, children }: { cols?: 2 | 3 | 4; className?: string; children: ReactNode }) {
	return (
		<div
			className={cn(
				"grid items-start gap-5",
				cols === 2 && "grid-cols-2 max-app-md:grid-cols-1",
				cols === 3 && "grid-cols-3 max-app-lg:grid-cols-2 max-app-md:grid-cols-1",
				cols === 4 && "grid-cols-4 max-app-lg:grid-cols-2 max-app-sm:grid-cols-1",
				className,
			)}
		>
			{children}
		</div>
	);
}
