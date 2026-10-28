import type { MeetingStatus } from "./model.ts";

// What the meeting page asks of the organizer next (WP-020/ui). Pure functions only: the page passes facts in and shows
// the answer. The table in the WP-020/ui spec is the contract; tests/integration/meetings/next-step.test.mts runs every row.

export type Primary = "add-guest" | "send-invites" | "check-in" | "finalize" | "cards" | "evaluation";
export type Secondary = "check-in" | "finalize";
export type TabId = "guests" | "kit" | "results";

export type NextStepInput = {
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
	secondary: Secondary[];
	/** Send invites as a link in the Guests tab toolbar: the primary is something else and invites are still open. */
	toolbarInvites: boolean;
};

export function nextStep(i: NextStepInput): NextStep {
	if (i.status === "cancelled") return { primary: null, secondary: [], toolbarInvites: false };
	const checkIn = i.checkIn;
	if (i.final) {
		const primary: Primary | null =
			!i.canWrite || !i.vision ? null : i.attendedWithoutCard > 0 ? "cards" : i.evaluationSaved ? null : "evaluation";
		return { primary, secondary: [], toolbarInvites: false };
	}
	if (i.status === "planning" || i.status === "ready") {
		return {
			primary: i.canWrite ? (i.guestCount === 0 ? "add-guest" : "send-invites") : null,
			secondary: checkIn ? ["check-in"] : [],
			toolbarInvites: false,
		};
	}
	if (i.status === "in_progress") {
		return {
			primary: checkIn ? "check-in" : null,
			secondary: i.canWrite && i.canSettle ? ["finalize"] : [],
			toolbarInvites: i.canWrite,
		};
	}
	// completed: a practice marked held is completed too
	const finalize = i.canWrite && i.canSettle;
	return { primary: finalize ? "finalize" : null, secondary: checkIn ? ["check-in"] : [], toolbarInvites: false };
}

/** The tab a primary action works in. With no action: Results once the meeting is over, Guests otherwise. */
export function defaultTab(primary: Primary | null, status: MeetingStatus, final: boolean): TabId {
	if (primary === "finalize" || primary === "evaluation") return "results";
	if (primary) return "guests";
	return final || status === "completed" ? "results" : "guests";
}

/** The tab in the address when it names a tab this meeting has; otherwise the default. */
export function pickTab(raw: string | null, tabs: readonly TabId[], fallback: TabId): TabId {
	return tabs.find((t) => t === raw) ?? fallback;
}

// -------------------------------------------------------------------------------------------------------------
// The lifecycle stepper: Invite, Check in, Follow up.

export const STEPS = ["invite", "checkin", "followup"] as const;
export type StepId = (typeof STEPS)[number];
export const STEP_LABEL: Record<StepId, string> = { invite: "Invite", checkin: "Check in", followup: "Follow up" };
export type StepState = "done" | "current" | "later";

/** Where the meeting is now. Cancelled has no current step. */
export function currentStep(status: MeetingStatus, final: boolean): StepId | null {
	if (status === "cancelled") return null;
	if (final) return "followup";
	return status === "in_progress" || status === "completed" ? "checkin" : "invite";
}

export type StepperInput = {
	status: MeetingStatus;
	final: boolean;
	vision: boolean;
	/** The guest list, or null when it did not load. */
	guests: { invited: number; yes: number; no: number; pending: number } | null;
	attended: number;
	/** Attended guests with a response card. */
	cardsIn: number;
	evaluationSaved: boolean;
	/** The next-step table, asked as a writer, gives no primary action: nothing is left to do. */
	followUpDone: boolean;
};

export type Step = { id: StepId; label: string; state: StepState; line: string };

export function stepper(i: StepperInput): Step[] {
	const now = currentStep(i.status, i.final);
	const stateOf = (id: StepId): StepState => {
		if (now === null) return "later";
		if (id === "followup" && now === "followup" && i.followUpDone) return "done";
		const d = STEPS.indexOf(id) - STEPS.indexOf(now);
		return d < 0 ? "done" : d === 0 ? "current" : "later";
	};
	const started = i.status === "in_progress" || i.status === "completed" || i.final;
	const lines: Record<StepId, string> = {
		invite: i.guests
			? `${i.guests.invited} invited · ${i.guests.yes} yes · ${i.guests.no} no · ${i.guests.pending} pending`
			: "Did not load",
		checkin: started ? `${i.attended} attended${i.final ? " · final" : ""}` : "Not started",
		followup: !i.final
			? "Opens when attendance is final"
			: i.vision
				? `${i.cardsIn} of ${i.attended} cards · evaluation ${i.evaluationSaved ? "recorded" : "open"}`
				: "Attendance final",
	};
	return STEPS.map((id) => ({ id, label: STEP_LABEL[id], state: stateOf(id), line: lines[id] }));
}
