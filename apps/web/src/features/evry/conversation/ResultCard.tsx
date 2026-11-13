"use client";

import {
	Award01Icon,
	Clock01Icon,
	File01Icon,
	File02Icon,
	LicenseDraftIcon,
	Home01Icon,
	Mail01Icon,
	Tag01Icon,
	UserIcon,
	UserMultipleIcon,
} from "@hugeicons/core-free-icons";
import { Button, IntentLink } from "@everyfield/ui/controls";
import { cn, Icon, type IconSvgElement } from "@everyfield/ui/foundations";
import { Avatar, StageChip, Tag } from "@everyfield/ui/display";
import { useState } from "react";
import { STAGE_KEY, STAGE_LABEL } from "../../people/model.ts";
import type { SourceResult } from "./model.ts";
import { cardView, type Glyph, type RowView } from "./resultView.ts";

// A source-bound result card (REQ-EVR-024): the rows Evry read, as they are now, with the count, whether more exist and
// what the read leaves out. A person row links to the person, which loads on intent only. A household, tag, skill,
// activity or file row has no page.

const isStage = (value: string): value is keyof typeof STAGE_KEY => value in STAGE_KEY;
const GLYPH: Record<Glyph, IconSvgElement> = {
	person: UserIcon,
	people: UserMultipleIcon,
	household: Home01Icon,
	tag: Tag01Icon,
	skill: Award01Icon,
	activity: Clock01Icon,
	file: File01Icon,
	message: Mail01Icon,
	document: File02Icon,
	template: LicenseDraftIcon,
};

function Mark({ mark }: { mark: RowView["mark"] }) {
	if (!mark) return null;
	if (mark.kind === "status") return <Tag tone={mark.warn ? "amber" : undefined}>{mark.text}</Tag>;
	if (mark.kind === "match")
		return <Tag tone={mark.exact ? "amber" : undefined}>{mark.exact ? "Same email or phone" : "Similar name"}</Tag>;
	return isStage(mark.stage) ? <StageChip stage={STAGE_KEY[mark.stage]}>{STAGE_LABEL[mark.stage]}</StageChip> : null;
}

/** A long result starts with this many rows; the rest open on request. */
const FIRST_ROWS = 6;

export function ResultCard({
	operation,
	result,
	originalTotal,
	photos,
}: {
	operation: string;
	result: SourceResult;
	originalTotal: number | null;
	/** The current photo route of each person row, by person id (useRowPhotos). A row without one keeps the initials. */
	photos: Readonly<Record<string, string>>;
}) {
	const [all, setAll] = useState(false);
	const { title, summary, icon, rows, facts, links } = cardView(operation, result, originalTotal);
	const shown = rows.length;
	const rowClass = "flex min-h-11 items-center gap-3 rounded-md px-2 py-2 text-ink";

	return (
		<section
			aria-label={summary ? `${title}, ${summary}` : title}
			className="overflow-hidden rounded-card bg-surface-raised shadow-[inset_0_0_0_1px_var(--ef-line),var(--ef-shadow-raised)]"
		>
			<header className="flex items-center gap-2.5 border-b border-line px-4 py-3 text-sm font-semibold text-ink">
				<Icon icon={GLYPH[icon]} size={16} className="text-text-3" />
				<span className="flex-1">{title}</span>
				<span className="font-medium text-text-3 tabular-nums">{summary}</span>
			</header>
			{shown ? (
				<ul className="flex flex-col px-2 py-1.5">
					{(all ? rows : rows.slice(0, FIRST_ROWS)).map((view) => {
						const body = (
							<>
								{view.avatar === "person" ? (
									<Avatar
										name={view.name}
										src={view.photoFor ? photos[view.photoFor] : undefined}
										size="sm"
										decorative
									/>
								) : null}
								{view.avatar && view.avatar !== "person" ? (
									<span
										aria-hidden="true"
										className="grid size-8 shrink-0 place-items-center rounded-full bg-surface-2 text-text-3"
									>
										<Icon icon={GLYPH[view.avatar]} size={16} />
									</span>
								) : null}
								<span className="min-w-0 flex-1">
									<span className="block truncate font-medium">{view.name}</span>
									{view.line ? (
										<span className="line-clamp-2 block text-xs break-words text-text-3">{view.line}</span>
									) : null}
								</span>
								<Mark mark={view.mark} />
							</>
						);
						return (
							<li key={view.key}>
								{view.href ? (
									<IntentLink
										href={view.href}
										data-focus-inset=""
										className={cn(rowClass, "transition-[background-color] hover:bg-hover")}
									>
										{body}
									</IntentLink>
								) : (
									<div className={rowClass}>{body}</div>
								)}
							</li>
						);
					})}
				</ul>
			) : null}
			{shown > FIRST_ROWS && !all ? (
				<div className="px-2 pb-2">
					<Button size="sm" variant="ghost" onClick={() => setAll(true)}>
						Show all {shown}
					</Button>
				</div>
			) : null}
			{facts.length ? (
				<div
					className={cn(
						"flex flex-col gap-1 bg-surface-2 px-4 py-2.5 text-sm text-text-2",
						shown > 0 && "border-t border-line",
					)}
				>
					{facts.map((fact) => (
						<p key={fact}>{fact}</p>
					))}
					{links.length ? (
						<p className="flex flex-wrap gap-x-4 gap-y-1">
							{links.map((link) => (
								<IntentLink
									key={link.href}
									href={link.href}
									className="font-medium text-ink underline underline-offset-2"
								>
									{link.label}
								</IntentLink>
							))}
						</p>
					) : null}
				</div>
			) : null}
		</section>
	);
}
