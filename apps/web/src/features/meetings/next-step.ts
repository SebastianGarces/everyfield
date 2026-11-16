import type { MeetingStatus } from "./model.ts";

export type Primary = "add-guest" | "send-invites" | "check-in" | "finalize" | "cards" | "evaluation";
export type TabId = "guests" | "kit" | "results";

type NextStepInput = {
	status: MeetingStatus;
	canWrite: boolean;
	checkIn: boolean;
	canFinalize: boolean;
	guestCount: number;
	final: boolean;
	canSettle: boolean;
	attendedWithoutCard: number;
	evaluationSaved: boolean;
	vision: boolean;
};

export type NextStep = {
	primary: Primary | null;
	secondary: ("check-in" | "finalize")[];
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
			secondary: i.canFinalize && i.canSettle ? ["finalize"] : [],
			toolbarInvites: i.canWrite,
		};
	}
	const finalize = i.canFinalize && i.canSettle;
	return { primary: finalize ? "finalize" : null, secondary: i.checkIn ? ["check-in"] : [], toolbarInvites: false };
}

export function defaultTab(status: MeetingStatus, final: boolean): TabId {
	return final || status === "completed" ? "results" : "guests";
}

export function pickTab(raw: string | null, tabs: readonly TabId[], fallback: TabId): TabId {
	return tabs.find((t) => t === raw) ?? fallback;
}
