import type { MeetingStatus } from "./model.ts";

// What the meeting page asks of the organizer next (WP-020/ui). Pure functions only: the page passes facts in and shows
// the answer. The table in the WP-020/ui spec is the contract; tests/integration/meetings/next-step.test.mts runs every row.

export type Primary = "add-guest" | "send-invites" | "check-in" | "finalize" | "cards" | "evaluation";
export type TabId = "guests" | "kit" | "results";

type NextStepInput = {
	status: MeetingStatus;
	canWrite: boolean;
	/** Start check-in by main's rule: a person who can mark attendance, attendance not final, not cancelled, not voided. */
	checkIn: boolean;
	guestCount: number;
	final: boolean;
	/** The meeting is not cancelled and not voided, so attendance can be settled (canSettle). */
	canSettle: boolean;
	/** Attended guests who have no response card (vision meetings only). */
	attendedWithoutCard: number;
	evaluationSaved: boolean;
	vision: boolean;
};

export type NextStep = {
	primary: Primary | null;
	/** Header buttons next to the primary, at most two. */
	secondary: ("check-in" | "finalize")[];
	/** Send invites as a link in the Guests tab toolbar: the primary is something else and invites are still open. */
	toolbarInvites: boolean;
};

export function nextStep(i: NextStepInput): NextStep {
	if (i.status === "cancelled") return { primary: null, secondary: [], toolbarInvites: false };
	if (i.final) {
		const primary: Primary | null =
			!i.canWrite || !i.vision ? null : i.attendedWithoutCard > 0 ? "cards" : i.evaluationSaved ? null : "evaluation";
		return { primary, secondary: [], toolbarInvites: false };
	}
	if (i.status === "planning" || i.status === "ready") {
		return {
			primary: i.canWrite ? (i.guestCount === 0 ? "add-guest" : "send-invites") : null,
			secondary: i.checkIn ? ["check-in"] : [],
			toolbarInvites: false,
		};
	}
	if (i.status === "in_progress") {
		return {
			primary: i.checkIn ? "check-in" : null,
			secondary: i.canWrite && i.canSettle ? ["finalize"] : [],
			toolbarInvites: i.canWrite,
		};
	}
	// completed: a practice marked held is completed too
	const finalize = i.canWrite && i.canSettle;
	return { primary: finalize ? "finalize" : null, secondary: i.checkIn ? ["check-in"] : [], toolbarInvites: false };
}

/** The tab the page opens on: Results once the meeting is completed (follow-ups start there), Guests before that. */
export function defaultTab(status: MeetingStatus, final: boolean): TabId {
	return final || status === "completed" ? "results" : "guests";
}

/** The tab in the address when it names a tab this meeting has; otherwise the default. */
export function pickTab(raw: string | null, tabs: readonly TabId[], fallback: TabId): TabId {
	return tabs.find((t) => t === raw) ?? fallback;
}
