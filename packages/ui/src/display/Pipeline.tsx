"use client";

import { useId, type ElementType, type ReactNode } from "react";
import { cn } from "../foundations";
import { Avatar, STAGE_DOT, STAGE_LABEL, type Stage } from "./Badges";
import type { Tone } from "./tone";

/**
 * PersonCard (components.md): Avatar, Name, Meta and Footer; selected or dragging. The name is the link. The
 * dragging look is a prop: the feature owns drag and drop (dnd-kit) and its keyboard alternative.
 */
export function PersonCard({
	name,
	meta,
	tone,
	footer,
	href,
	linkAs: Link = "a",
	selected,
	dragging,
	className,
}: {
	name: string;
	meta?: ReactNode;
	tone?: Tone;
	footer?: ReactNode;
	href?: string;
	linkAs?: ElementType;
	selected?: boolean;
	dragging?: boolean;
	className?: string;
}) {
	return (
		<article
			aria-label={name}
			data-selected={selected ? "true" : undefined}
			data-dragging={dragging ? "true" : undefined}
			className={cn(
				"relative flex flex-col gap-2.5 rounded-card bg-surface-raised p-3 shadow-raised transition-[box-shadow,transform] duration-150",
				selected && "shadow-[var(--ef-shadow-raised),inset_0_0_0_1.5px_var(--ef-ink)]",
				dragging && "rotate-[1.5deg] shadow-pop motion-reduce:rotate-0",
				className,
			)}
		>
			<div className="flex items-center gap-2.5">
				<Avatar name={name} tone={tone} size="sm" decorative />
				<div className="min-w-0">
					<div className="truncate text-sm leading-[1.2] font-semibold text-ink">
						{href ? (
							<Link href={href} className="after:absolute after:inset-0 after:rounded-card hover:underline">
								{name}
							</Link>
						) : (
							name
						)}
					</div>
					{meta ? <div className="truncate text-xs text-text-3">{meta}</div> : null}
				</div>
			</div>
			{footer ? <div className="flex flex-wrap items-center justify-between gap-1.5">{footer}</div> : null}
		</article>
	);
}

/**
 * PipelineColumn (components.md): Header, Count, Cards and DropZone for one stage. `dropTarget` outlines the column
 * while a card is dragged over it; the feature wires dragging. An empty column says so.
 */
export function PipelineColumn({
	stage,
	label,
	count,
	dropTarget,
	children,
	emptyText = "Nobody at this stage",
	className,
}: {
	stage: Stage;
	label?: string;
	count: number;
	dropTarget?: boolean;
	children?: ReactNode;
	emptyText?: string;
	className?: string;
}) {
	const id = useId();
	return (
		<section
			aria-labelledby={id}
			data-drop-target={dropTarget ? "true" : undefined}
			className={cn(
				"relative flex min-h-[420px] min-w-[220px] flex-col gap-2.5 rounded-card bg-surface-2 p-2.5 transition-shadow duration-150",
				dropTarget && "shadow-[inset_0_0_0_2px_var(--ef-green-500)]",
				className,
			)}
		>
			<h3
				id={id}
				className="flex items-center gap-2 px-1.5 pt-1 pb-1.5 font-body text-sm font-semibold tracking-normal text-ink"
			>
				<span aria-hidden="true" className={cn("size-2 rounded-full", STAGE_DOT[stage])} />
				{label ?? STAGE_LABEL[stage]}
				<span className="ml-auto font-medium text-text-3">
					{count}
					<span className="sr-only"> {count === 1 ? "person" : "people"}</span>
				</span>
			</h3>
			{count === 0 && !children ? (
				<p className="rounded-card border-[1.5px] border-dashed border-line-2 px-3 py-6 text-center text-sm text-text-3">
					{emptyText}
				</p>
			) : (
				children
			)}
		</section>
	);
}
