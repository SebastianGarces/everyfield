import {
	classifyChange,
	type Direction,
	type JourneyEntry,
	type JourneyState,
	type PhaseNumber,
	type PhasesError,
	type ReasonProblem,
} from "@everyfield/contracts/phases";

// The journey screen's pure model: labels, messages and the optimistic journey. No React and no server code, so the
// UI tests can call it directly.

/** A server action's answer: the operation's reply, or "lost" when the request never reached a database answer. */
export type Outcome<T> = { status: "ok"; value: T } | { status: "refused"; error: PhasesError } | { status: "lost" };

/** The seven phases as the track labels them (prototype #/intelligence). */
export const SHORT_NAME: readonly string[] = [
	"Discovery",
	"Core group",
	"Launch team",
	"Training",
	"Pre-launch",
	"Launch Sunday",
	"Post-launch",
];

const DIRECTION_LABEL: Record<Direction, string> = {
	forward: "Moved forward",
	skip_forward: "Skipped ahead",
	backward: "Moved back",
};

/** What a timeline entry is called. */
export function entryTitle(entry: JourneyEntry): string {
	if (entry.kind === "creation") return "Church created";
	if (entry.kind === "initial_declaration") return "Declared at setup";
	return DIRECTION_LABEL[entry.direction];
}

export const REASON_MESSAGE: Record<ReasonProblem, string> = {
	empty: "Write a short reason for the move.",
	too_long: "Keep the reason to 2,000 characters or fewer.",
	reserved: "That sentence is kept for setup declarations. Write the reason in your own words.",
};

/** The message a refused or lost change shows next to the control that sent it. */
export function refusalMessage(outcome: Exclude<Outcome<unknown>, { status: "ok" }>): string {
	if (outcome.status === "lost")
		return "Everyfield's answer did not come back, so the phase may not have changed. Try again: the same change will not apply twice.";
	const error = outcome.error;
	switch (error.code) {
		case "invalid_reason":
			return REASON_MESSAGE[error.details.problem];
		case "already_declared":
			return "This church already has its starting phase. Use Change phase to move it.";
		case "revision_conflict":
			return `Someone changed the phase while you were reviewing. It is now Phase ${error.details.state.phase}. Review it and try again.`;
		case "access_denied":
			return "Only an Owner or Admin can change the phase. Your seat may have changed.";
		default:
			return "Nothing changed. Reload the page and try again.";
	}
}

/**
 * One request key per intent: the same move or declaration from the same revision reuses its key, so a retry after a
 * lost answer replays the first write instead of applying it again. A settled answer (ok or refused) drops the key.
 */
export function requestKeys(fresh: () => string) {
	const keys = new Map<string, string>();
	return {
		keyFor(intent: readonly unknown[]) {
			const id = JSON.stringify(intent);
			if (!keys.has(id)) keys.set(id, fresh());
			return keys.get(id)!;
		},
		settle(intent: readonly unknown[]) {
			keys.delete(JSON.stringify(intent));
		},
	};
}

/** A server action's call, with a rejected one (offline, a dropped connection) read as a lost answer. */
export async function sent<T>(call: () => Promise<Outcome<T>>): Promise<Outcome<T>> {
	try {
		return await call();
	} catch {
		return { status: "lost" };
	}
}

export type Journey = { state: JourneyState; entries: JourneyEntry[] };

/** The journey with a new entry and state: the confirmed answer, or the optimistic one before it. */
export function withEntry(journey: Journey, state: JourneyState, entry: JourneyEntry): Journey {
	return { state, entries: [...journey.entries.filter((e) => e.id !== entry.id), entry] };
}

const PENDING_ID = "00000000-0000-4000-8000-000000000000" as JourneyEntry["id"];
/** The entry a move shows before the server answers. The server's own entry replaces it. */
export function pendingMove(
	journey: Journey,
	to: PhaseNumber,
	reason: string,
	actor: JourneyEntry["actor"],
	now: string,
): Journey {
	const from = journey.state.phase;
	const direction = classifyChange(from, to);
	if (direction === "same") return journey;
	const entry = {
		kind: "movement",
		id: PENDING_ID,
		fromPhase: from,
		toPhase: to,
		direction,
		reason: reason.trim(),
		actor,
		occurredAt: now,
	} as JourneyEntry;
	return withEntry(journey, { ...journey.state, phase: to, declarable: false }, entry);
}
/** The entry a declaration shows before the server answers. */
export function pendingDeclaration(
	journey: Journey,
	to: PhaseNumber,
	actor: JourneyEntry["actor"],
	now: string,
): Journey {
	const entry = {
		kind: "initial_declaration",
		id: PENDING_ID,
		fromPhase: journey.state.phase,
		toPhase: to,
		actor,
		occurredAt: now,
	} as JourneyEntry;
	return withEntry(journey, { ...journey.state, phase: to, declarable: false }, entry);
}
export const isPending = (entry: JourneyEntry) => entry.id === PENDING_ID;

/** "Nov 2, 2026" in the plant's time zone, the same on the server and in the browser. */
export function entryDate(occurredAt: string, timeZone: string): string {
	return new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric", year: "numeric", timeZone }).format(
		new Date(occurredAt),
	);
}
