"use client";

import { Edit02Icon, UserIcon, UserMultipleIcon } from "@hugeicons/core-free-icons";
import { Button, IntentLink } from "@everyfield/ui/controls";
import { cn, Icon } from "@everyfield/ui/foundations";
import { Avatar, StageChip } from "@everyfield/ui/display";
import { useState } from "react";
import { STAGE_KEY, STAGE_LABEL } from "../../people/model.ts";
import type { SourceResult } from "./model.ts";

// A source-bound result card (REQ-EVR-024): the rows Evry read, as they are now, with the count, whether more exist and
// what the read leaves out. Rows link to their records, which load on intent only.

const TITLE: Record<string, string> = {
	"people.listPeople": "People",
	"people.getPerson": "Person",
	"evry.selectReturnedRows": "Selected people",
};

const isStage = (value: unknown): value is keyof typeof STAGE_KEY => typeof value === "string" && value in STAGE_KEY;
/** A long result starts with this many rows; the rest open on request. */
const FIRST_ROWS = 6;
const count = (n: number, one: string, many: string) => `${n.toLocaleString()} ${n === 1 ? one : many}`;

export function ResultCard({
	operation,
	result,
	originalTotal,
}: {
	operation: string;
	result: SourceResult;
	originalTotal: number | null;
}) {
	const [all, setAll] = useState(false);
	const title = TITLE[operation] ?? "Records";
	const shown = result.rows.length;
	const summary =
		result.status === "not_found"
			? "Not found"
			: result.total === null || result.total === shown
				? count(shown, "person", "people")
				: `${shown.toLocaleString()} of ${result.total.toLocaleString()}`;
	const facts: string[] = [];
	if (result.status === "not_found") facts.push("No person in this church matches, or you can't see them.");
	if (result.withheldRows)
		facts.push(`${count(result.withheldRows, "row is", "rows are")} no longer available and not shown.`);
	if (result.completeness === "partial" && result.next !== null)
		facts.push(`More people match. Ask Evry for page ${result.next}.`);
	if (operation === "evry.selectReturnedRows") {
		if (originalTotal !== null) facts.push(`Picked from ${count(originalTotal, "match", "matches")}.`);
	} else if (result.exclusions.length) facts.push(`Not included: ${result.exclusions.join(", ")}.`);

	return (
		<section
			aria-label={`${title}, ${summary}`}
			className="overflow-hidden rounded-card bg-surface-raised shadow-[inset_0_0_0_1px_var(--ef-line),var(--ef-shadow-raised)]"
		>
			<header className="flex items-center gap-2.5 border-b border-line px-4 py-3 text-sm font-semibold text-ink">
				<Icon icon={shown > 1 ? UserMultipleIcon : UserIcon} size={16} className="text-text-3" />
				<span className="flex-1">{title}</span>
				<span className="font-medium text-text-3 tabular-nums">{summary}</span>
			</header>
			{shown ? (
				<ul className="flex flex-col px-2 py-1.5">
					{(all ? result.rows : result.rows.slice(0, FIRST_ROWS)).map((row) => {
						const city = typeof row.fields.city === "string" ? row.fields.city : null;
						return (
							<li key={row.id}>
								<IntentLink
									href={`/people/${row.id}`}
									data-focus-inset=""
									className="flex min-h-11 items-center gap-3 rounded-md px-2 py-2 text-ink transition-[background-color] hover:bg-hover"
								>
									<Avatar name={row.label} size="sm" decorative />
									<span className="min-w-0 flex-1">
										<span className="block truncate font-medium">{row.label}</span>
										{city ? <span className="block truncate text-xs text-text-3">{city}</span> : null}
									</span>
									{isStage(row.fields.stage) ? (
										<StageChip stage={STAGE_KEY[row.fields.stage]}>{STAGE_LABEL[row.fields.stage]}</StageChip>
									) : null}
								</IntentLink>
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
				</div>
			) : null}
		</section>
	);
}

/**
 * The place for a prepared change in the conversation. WP-053/ui replaces this with the review card (approve, edit,
 * cancel); until then the panel says plainly that a change waits and that nothing changes without approval.
 */
export function ReviewSlot({ proposalId, target }: { proposalId: string; target: string | null }) {
	return (
		<section
			data-proposal={proposalId}
			aria-label="Prepared change"
			className="overflow-hidden rounded-card bg-surface-raised shadow-[inset_0_0_0_1px_var(--ef-line),var(--ef-shadow-raised)]"
		>
			<header className="flex items-center gap-2.5 border-b border-line bg-amber-50 px-4 py-3 text-sm font-semibold text-amber-600">
				<Icon icon={Edit02Icon} size={16} />
				{target ? `Change prepared for ${target}` : "Change prepared"}
			</header>
			<p className="px-4 py-3 text-sm text-text-2">
				Nothing changes until you approve it. Reviewing changes in this panel is not available yet.
			</p>
		</section>
	);
}
