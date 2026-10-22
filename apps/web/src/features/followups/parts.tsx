"use client";

import { StatusBadge } from "@everyfield/ui/display";
import { When } from "../people/parts.tsx";
import { CHANNEL_LABEL, OUTCOME_LABEL, OUTCOME_STATUS, type OutcomeItem } from "./model.ts";

/** An outcome as a badge. A Contacted entry says it is human contact; nothing here ever says an email was delivered. */
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

/** Who recorded or changed an entry: "you", their name, or a former team member. */
export function actorName(actor: OutcomeItem["actor"], accountId: string): string {
	if (actor.kind === "former_account") return "a former team member";
	if (actor.accountId === accountId) return "you";
	return actor.displayName ?? "a team member";
}

/** One line under an entry: when it happened, how, and what it did to the follow-up. */
export function EntryFacts({ item }: { item: OutcomeItem }) {
	return (
		<span className="text-sm text-text-2">
			<When at={item.occurredAt} withTime />
			{item.channel ? ` · ${CHANNEL_LABEL[item.channel]}` : null}
			{item.completedTask ? " · finished the follow-up" : null}
		</span>
	);
}

/** "Last contact" in words. No effective Contacted entry reads as Unknown, never as a guessed date (REQ-MTG-022). */
export function LastContact({ at }: { at: string | null }) {
	return at ? (
		<>
			Last contact <When at={at} />
		</>
	) : (
		<>Last contact unknown</>
	);
}
