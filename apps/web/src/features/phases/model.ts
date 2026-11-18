import {
	classifyChange,
	type Direction,
	type JourneyEntry,
	type JourneyState,
	type PhaseNumber,
	type PhasesError,
	type ReasonProblem,
} from "@everyfield/contracts/phases";

export type Outcome<T> = { status: "ok"; value: T } | { status: "refused"; error: PhasesError } | { status: "lost" };

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

export function entryTitle(entry: JourneyEntry): string {
	if (entry.kind === "creation") return "Church created";
	if (entry.kind === "initial_declaration") return "Declared at setup";
	if (entry.kind === "launch_sunday") return "Launch Sunday held";
	if (entry.kind === "gathering") return `${entry.name} reached`;
	return DIRECTION_LABEL[entry.direction];
}

export function entryDetail(entry: JourneyEntry): string {
	const day = (date: string) =>
		new Intl.DateTimeFormat("en-US", {
			timeZone: "UTC",
			weekday: "short",
			month: "short",
			day: "numeric",
			year: "numeric",
		}).format(new Date(`${date}T12:00:00Z`));
	if (entry.kind === "launch_sunday") return `Held ${day(entry.actualDate)}. The phase stays as it is.`;
	if (entry.kind === "gathering") return `Reached ${day(entry.reachedOn)}. The phase stays as it is.`;
	return entry.fromPhase === null
		? `Started at Phase ${entry.toPhase}`
		: `Phase ${entry.fromPhase} → Phase ${entry.toPhase}`;
}

export const POST_LAUNCH_MEASURES = [
	{
		key: "guest_follow_up_48h",
		label: "Guests followed up within 48 hours",
		note: "Not measured yet. Everyfield has no post-launch follow-up source, so Vision Meeting follow-ups from before launch don't count here.",
	},
] as const;

export const REASON_MESSAGE: Record<ReasonProblem, string> = {
	empty: "Write a short reason for the move.",
	too_long: "Keep the reason to 2,000 characters or fewer.",
	reserved: "That sentence is kept for setup declarations. Write the reason in your own words.",
};

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

export async function sent<T>(call: () => Promise<Outcome<T>>): Promise<Outcome<T>> {
	try {
		return await call();
	} catch {
		return { status: "lost" };
	}
}

export type Journey = { state: JourneyState; entries: JourneyEntry[] };

export function withEntry(journey: Journey, state: JourneyState, entry: JourneyEntry): Journey {
	return { state, entries: [...journey.entries.filter((e) => e.id !== entry.id), entry] };
}

const PENDING_ID = "00000000-0000-4000-8000-000000000000" as JourneyEntry["id"];
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

export function entryDate(occurredAt: string, timeZone: string): string {
	return new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric", year: "numeric", timeZone }).format(
		new Date(occurredAt),
	);
}
