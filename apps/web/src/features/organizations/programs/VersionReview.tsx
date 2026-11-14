"use client";

import type { VersionReview } from "@everyfield/contracts/organizations";
import { CheckmarkCircle02Icon } from "@hugeicons/core-free-icons";
import { Field, Select } from "@everyfield/ui/controls";
import { Icon } from "@everyfield/ui/foundations";
import type { ReactNode } from "react";

type Reviewed = VersionReview["added"][number];

/**
 * What applying the program's current version changes for one person (REQ-MUL-011): what is added, removed and
 * changed, the finished milestones that carry over, and their stage on the new version. The single apply on an
 * enrollment and the apply to several people on the program both show it.
 */
export function ReviewParts({
	review,
	stageId,
	onStageChange,
	heading = "h3",
}: {
	review: VersionReview;
	stageId: string;
	onStageChange: (stageId: string) => void;
	/** h4 when the parts sit under a heading of their own, such as the person's name. */
	heading?: "h3" | "h4";
}) {
	const { name } = review;
	return (
		<>
			<ReviewList
				heading={heading}
				title="Added"
				empty="Nothing added."
				items={review.added.map((m, i) => (
					<Wording key={i} m={m} />
				))}
			/>
			<ReviewList
				heading={heading}
				title="Removed"
				empty="Nothing removed."
				items={review.removed.map((m, i) => (
					<Wording
						key={i}
						m={m}
						note={m.finished ? `${name} finished this. The finished record is kept.` : undefined}
					/>
				))}
			/>
			<ReviewList
				heading={heading}
				title="Changed"
				empty="Nothing changed."
				items={review.changed.map((c, i) => (
					<div key={i} className="grid grid-cols-2 gap-3 max-app-sm:grid-cols-1">
						<Wording m={c.before} label={`Version ${review.fromNumber}`} />
						<Wording m={c.after} label={`Version ${review.toNumber}`} />
						{c.before.finished ? (
							<p className="col-span-full text-text-2">
								{name} finished this. It stays finished with its original record.
							</p>
						) : null}
					</div>
				))}
			/>
			<ReviewList
				heading={heading}
				title="Finished milestones that carry over"
				empty={`${name} hasn’t finished any milestone that carries over.`}
				hint="Each keeps who recorded and confirmed it, and when."
				items={review.carried.map((title, i) => (
					<span key={i} className="flex items-start gap-2">
						<Icon icon={CheckmarkCircle02Icon} size={16} className="mt-0.5 flex-none text-green-700" />
						<span className="[overflow-wrap:anywhere] text-ink">{title}</span>
					</span>
				))}
			/>
			<Field
				label={`Program stage on Version ${review.toNumber}`}
				hint={`On Version ${review.fromNumber}: ${review.stage}.`}
			>
				<Select
					value={stageId}
					onValueChange={(v) => onStageChange(String(v))}
					options={review.stages.map((s) => ({ value: s.id, label: s.label }))}
				/>
			</Field>
		</>
	);
}

/** One part of the review: a heading with its count, then each item, or a line saying there is none. */
function ReviewList({
	heading: Heading,
	title,
	empty,
	hint,
	items,
}: {
	heading: "h3" | "h4";
	title: string;
	empty: string;
	hint?: string;
	items: ReactNode[];
}) {
	return (
		<section aria-label={title} className="flex flex-col gap-2">
			<Heading className="text-sm font-semibold text-ink">
				{title}
				{items.length ? <span className="font-normal text-text-3"> · {items.length}</span> : null}
			</Heading>
			{hint && items.length ? <p className="-mt-1 text-sm text-text-2">{hint}</p> : null}
			{items.length ? (
				<ul className="flex flex-col gap-2 text-sm">
					{items.map((item, i) => (
						<li key={i} className="rounded-md bg-surface-2 p-3">
							{item}
						</li>
					))}
				</ul>
			) : (
				<p className="text-sm text-text-3">{empty}</p>
			)}
		</section>
	);
}

/** A milestone's wording in one version: its title, kind and description. */
function Wording({ m, label, note }: { m: Reviewed; label?: string; note?: string }) {
	return (
		<div className="flex min-w-0 flex-col gap-0.5">
			{label ? <span className="text-xs font-medium text-text-3">{label}</span> : null}
			<span className="font-medium [overflow-wrap:anywhere] text-ink">{m.title}</span>
			{m.handsOn ? <span className="text-xs font-medium text-blue-600">Hands-on assignment</span> : null}
			{m.description ? <span className="[overflow-wrap:anywhere] text-text-2">{m.description}</span> : null}
			{note ? <span className="text-text-2">{note}</span> : null}
		</div>
	);
}
