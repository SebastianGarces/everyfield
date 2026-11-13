"use client";

import { ArrowRight02Icon } from "@hugeicons/core-free-icons";
import { Icon, cn } from "@everyfield/ui/foundations";
import { ROW_OUTCOME, fieldLabel, valueText, type Change, type Review, type ReviewedRow } from "./model.ts";

// What a change that reaches several people does to each of them (WP-064): every household member's address, every
// person being tagged, every row of an import. Before approval the card lists what will happen; after it, what did,
// person by person, so a change that left anyone out never reads as done for everyone.

function Before({ change }: { change: Change }) {
	const before = valueText(change.field, change.before);
	const after = valueText(change.field, change.after);
	return (
		<span className="flex min-w-0 flex-wrap items-center gap-x-1.5 gap-y-0.5 text-sm">
			<span className="sr-only">{fieldLabel(change.field)} from </span>
			<span className={cn("break-words", before ? "text-text-2" : "text-text-3 italic")}>{before ?? "Empty"}</span>
			<Icon icon={ArrowRight02Icon} size={16} className="flex-none text-text-3" />
			<span className="sr-only"> to </span>
			<span className={cn("break-words", after ? "font-medium text-ink" : "text-text-3 italic")}>
				{after ?? "Empty"}
			</span>
		</span>
	);
}

/** One line per person: their name, then their change, or why they will not or did not change. */
function Row({ name, children }: { name: string; children: React.ReactNode }) {
	return (
		<li className="flex flex-col gap-0.5 py-2 first:pt-0 last:pb-0">
			<span className="font-medium text-ink">{name}</span>
			{children}
		</li>
	);
}

/** The people a pending review reaches, each with what will change for them. */
export function ReviewedPeople({ review }: { review: Review }) {
	const people = review.review.people;
	if (!people?.length) return null;
	return (
		<section aria-label="People this changes" className="flex flex-col gap-1.5">
			<h4 className="text-xs font-medium text-text-2">
				{people.length === 1 ? "1 person" : `${people.length} people`}
			</h4>
			<ul className="divide-y divide-line rounded-md bg-surface-2 px-3 py-2.5">
				{people.map((p) => (
					<Row key={p.id} name={p.label}>
						{p.unchanged ? (
							<span className="text-sm text-text-2">No change: {p.unchanged.toLowerCase()}</span>
						) : (
							p.changes.map((c) => <Before key={c.field} change={c} />)
						)}
					</Row>
				))}
			</ul>
		</section>
	);
}

/** After approval: who changed and who did not, and why. */
export function PeopleResult({ review }: { review: Review }) {
	const people = review.receipt?.people;
	if (!people?.length) return null;
	return (
		<section aria-label="What changed" className="flex flex-col gap-1.5">
			<ul className="divide-y divide-line rounded-md bg-surface-2 px-3 py-2.5">
				{people.map((p) => (
					<Row key={p.id} name={p.label}>
						<span className={cn("text-sm", p.outcome === "changed" ? "text-green-700" : "text-text-2")}>
							{p.outcome === "changed" ? "Changed" : `Not changed: ${(p.reason ?? "no change needed").toLowerCase()}`}
						</span>
					</Row>
				))}
			</ul>
		</section>
	);
}

/** A refusal because a record changed: the records as they are now. */
export function CurrentState({ review }: { review: Review }) {
	const current = review.receipt?.current;
	if (!current?.length) return null;
	return (
		<section aria-label="As they are now" className="flex flex-col gap-1.5">
			<h4 className="text-xs font-medium text-text-2">As they are now</h4>
			<ul className="divide-y divide-line rounded-md bg-surface-2 px-3 py-2.5">
				{current.map((p) => (
					<Row key={p.id} name={p.label}>
						<span className={cn("text-sm", p.value ? "text-text-2" : "text-text-3 italic")}>
							{p.value ?? "No address"}
						</span>
					</Row>
				))}
			</ul>
		</section>
	);
}

const OUTCOME_TONE: Record<ReviewedRow["outcome"], string> = {
	create: "bg-green-50 text-green-700",
	create_and_review: "bg-green-50 text-green-700",
	skip: "bg-surface-raised text-text-2 shadow-[inset_0_0_0_1px_var(--ef-line)]",
	fail: "bg-magenta-50 text-magenta-600",
};

/** Each row of a reviewed import with what will happen to it. */
export function ImportRows({ review }: { review: Review }) {
	const rows = review.review.rows;
	if (!rows?.length) return null;
	return (
		<ol aria-label="Rows in this file" className="divide-y divide-line rounded-md bg-surface-2 px-3 py-2.5 text-sm">
			{rows.map((r) => (
				<li key={r.row} className="grid grid-cols-[auto_1fr] items-baseline gap-x-3 py-2 first:pt-0 last:pb-0">
					<span className="text-xs text-text-3 tabular-nums">Row {r.row}</span>
					<span className="flex min-w-0 flex-col gap-0.5">
						<span className="flex flex-wrap items-center gap-2">
							<span className={cn("rounded-sm px-1.5 py-0.5 text-xs font-medium", OUTCOME_TONE[r.outcome])}>
								{ROW_OUTCOME[r.outcome]}
							</span>
							{r.label ? <span className="min-w-0 font-medium break-words text-ink">{r.label}</span> : null}
						</span>
						{r.reason ? <span className="text-text-2">{r.reason}</span> : null}
					</span>
				</li>
			))}
		</ol>
	);
}

/** After approval: the saved import's counts and each failed row's reason. The rows are written in the background. */
export function ImportResult({ review }: { review: Review }) {
	const result = review.receipt?.import;
	if (!result) return null;
	const { counts } = result;
	const toAdd = counts.created + counts.remaining;
	return (
		<section aria-label="Import result" className="flex flex-col gap-2 text-sm">
			<dl className="grid grid-cols-3 gap-2 text-center">
				{[
					[result.status === "in_progress" ? "Being added" : "Added", toAdd],
					["Skipped", counts.skipped],
					["Failed", counts.failed],
				].map(([label, n]) => (
					<div key={label} className="flex flex-col-reverse rounded-md bg-surface-2 px-2 py-2">
						<dt className="text-xs text-text-2">{label}</dt>
						<dd className="text-base font-semibold text-ink tabular-nums">{n}</dd>
					</div>
				))}
			</dl>
			{result.failed.length ? (
				<ul aria-label="Failed rows" className="divide-y divide-line rounded-md bg-surface-2 px-3 py-2.5">
					{result.failed.map((f) => (
						<li key={f.row} className="grid grid-cols-[auto_1fr] gap-x-3 py-2 first:pt-0 last:pb-0">
							<span className="text-xs text-text-3 tabular-nums">Row {f.row}</span>
							<span className="text-magenta-600">{f.reason}</span>
						</li>
					))}
				</ul>
			) : null}
			{result.status === "in_progress" ? (
				<p className="text-text-2">
					People adds the rows in the background. Ask Evry how the import went to see the final result.
				</p>
			) : null}
		</section>
	);
}
