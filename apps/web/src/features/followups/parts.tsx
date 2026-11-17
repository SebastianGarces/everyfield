"use client";

import { StatusBadge } from "@everyfield/ui/display";
import { useRef } from "react";
import { When } from "../people/parts.tsx";
import { CHANNEL_LABEL, OUTCOME_LABEL, OUTCOME_STATUS, originText, type OutcomeItem } from "./model.ts";

export function OutcomeBadge({ item }: { item: Pick<OutcomeItem, "outcome" | "state"> }) {
	const effective = item.state === "effective";
	return (
		<StatusBadge
			status={effective ? OUTCOME_STATUS[item.outcome] : "unknown"}
			size="sm"
			className={effective ? undefined : "line-through decoration-text-3"}
		>
			{OUTCOME_LABEL[item.outcome]}
		</StatusBadge>
	);
}

export function actorName(actor: OutcomeItem["actor"], accountId: string): string {
	if (actor.kind === "former_account") return "a former team member";
	if (actor.accountId === accountId) return "you";
	return actor.displayName ?? "a team member";
}

export function EntryFacts({ item }: { item: OutcomeItem }) {
	return (
		<span className="text-sm text-text-2">
			<When at={item.occurredAt} withTime />
			{item.channel ? ` · ${CHANNEL_LABEL[item.channel]}` : null}
			{item.completedTask ? " · finished the follow-up" : null}
			{item.alsoFinished.length
				? ` · also finished ${item.alsoFinished.map((a) => originText(a.origin)).join(", ")}`
				: null}
		</span>
	);
}

export function ContactEntries({ items, accountId }: { items: readonly OutcomeItem[]; accountId: string }) {
	return (
		<ol className="flex flex-col">
			{items.map((item) => (
				<li key={item.id} className="flex flex-col gap-1 border-t border-line py-3 first:border-t-0">
					<span className="flex flex-wrap items-center gap-2">
						<OutcomeBadge item={item} />
						{item.state === "corrected" ? (
							<span className="text-xs font-medium text-text-2">Corrected</span>
						) : item.state === "voided" ? (
							<span className="text-xs font-medium text-text-2">Withdrawn</span>
						) : null}
					</span>
					<EntryFacts item={item} />
					{item.notes ? (
						<p className="text-sm whitespace-pre-wrap text-ink-2 [overflow-wrap:anywhere]">{item.notes}</p>
					) : null}
					<p className="text-xs text-text-3">
						Recorded by {actorName(item.actor, accountId)} <When at={item.recordedAt} />
					</p>
				</li>
			))}
		</ol>
	);
}

export function LastContact({ at }: { at: string | null }) {
	return at ? (
		<>
			Last contact <When at={at} />
		</>
	) : (
		<>Last contact unknown</>
	);
}

export function useOpener() {
	const el = useRef<HTMLElement | null>(null);
	return {
		mark: (e: { currentTarget: HTMLElement }) => {
			el.current = e.currentTarget;
		},
		returnFocus: (e: Event) => {
			const target = el.current;
			if (!target?.isConnected) return;
			e.preventDefault();
			target.focus({ preventScroll: true });
		},
	};
}
