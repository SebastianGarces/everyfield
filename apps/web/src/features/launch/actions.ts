"use server";

import type {
	DebriefAnswers,
	GatheringOffer,
	GuestMatch,
	History,
	Milestone,
	Plan,
} from "@everyfield/contracts/launch";
import type { Outcome } from "./model.ts";
import { read, write } from "./server.ts";

// The browser boundary of the Launch plan's writes. Each hands the browser's values to the Launch writer, which parses
// them with the strict launch contract and rechecks the live Owner or Admin seat inside its statement. A retry with
// the same request key replays the stored answer. Prep tasks complete and reopen through the Tasks actions.

type DateResult = { outcome: "changed" | "noop"; plan: Plan };
type MilestoneResult = { outcome: "changed" | "noop"; milestone: Milestone };

export async function setLaunchDate(
	requestKey: string,
	expectedRevision: string,
	date: unknown,
	reason: unknown,
): Promise<Outcome<DateResult>> {
	return write((w, db, authority) =>
		w.schedule(db, authority, { requestKey, expectedRevision, input: { date, reason } }),
	);
}

export async function postponeLaunch(
	requestKey: string,
	expectedRevision: string,
	reason: unknown,
): Promise<Outcome<DateResult>> {
	return write((w, db, authority) => w.postpone(db, authority, { requestKey, expectedRevision, input: { reason } }));
}

export async function completeMilestone(
	requestKey: string,
	expectedRevision: string,
	milestoneId: unknown,
	reviewed: unknown,
): Promise<Outcome<MilestoneResult>> {
	return write((w, db, authority) =>
		w.completeMilestone(db, authority, { requestKey, expectedRevision, input: { milestoneId, reviewed } }),
	);
}

export async function reopenMilestone(
	requestKey: string,
	expectedRevision: string,
	milestoneId: unknown,
): Promise<Outcome<MilestoneResult>> {
	return write((w, db, authority) =>
		w.reopenMilestone(db, authority, { requestKey, expectedRevision, input: { milestoneId } }),
	);
}

export async function recordOutcome(
	requestKey: string,
	expectedRevision: string,
	input: { actualDate: unknown; attendance: unknown; decisions: unknown; note: unknown },
): Promise<Outcome<DateResult>> {
	return write((w, db, authority) => w.recordOutcome(db, authority, { requestKey, expectedRevision, input }));
}

export async function correctOutcome(
	requestKey: string,
	expectedRevision: string,
	input: { actualDate: unknown; attendance: unknown; decisions: unknown; note: unknown; reason: unknown },
): Promise<Outcome<DateResult>> {
	return write((w, db, authority) => w.correctOutcome(db, authority, { requestKey, expectedRevision, input }));
}

/** Name a guest: `{ personId }` picks a suggested Person, `{ displayName }` adds a new one. */
export async function addGuest(requestKey: string, input: unknown): Promise<Outcome<DateResult>> {
	return write((w, db, authority) => w.addGuestAttendance(db, authority, { requestKey, input }));
}

export async function saveDebrief(
	requestKey: string,
	expectedRevision: string,
	draftId: unknown,
	answers: DebriefAnswers,
	submit: boolean,
): Promise<Outcome<DateResult>> {
	return write((w, db, authority) =>
		w[submit ? "submitDebrief" : "saveDebriefDraft"](db, authority, {
			requestKey,
			expectedRevision,
			input: { draftId, answers },
		}),
	);
}

export async function saveSummary(
	requestKey: string,
	expectedRevision: string,
	draftId: unknown,
	body: unknown,
	publish: boolean,
): Promise<Outcome<DateResult>> {
	return write((w, db, authority) =>
		w[publish ? "publishDebriefSummary" : "saveDebriefSummaryDraft"](db, authority, {
			requestKey,
			expectedRevision,
			input: { draftId, body },
		}),
	);
}

/** Use an offered milestone (`{ path: "milestone", organizationId }`) or Launch Sunday again (T-296). */
export async function chooseGatheringPath(
	requestKey: string,
	expectedRevision: string,
	input: unknown,
): Promise<Outcome<DateResult>> {
	return write((w, db, authority) => w.choosePath(db, authority, { requestKey, expectedRevision, input }));
}

/** Record the milestone reached, correct the record with a reason, or clear it with a reason. */
export async function saveGathering(
	requestKey: string,
	expectedRevision: string,
	mode: "record" | "correct" | "clear",
	input: { date?: unknown; note?: unknown; reason?: unknown },
): Promise<Outcome<DateResult>> {
	return write((w, db, authority) => {
		const q = { requestKey, expectedRevision };
		if (mode === "record")
			return w.recordGathering(db, authority, { ...q, input: { date: input.date, note: input.note } });
		if (mode === "correct") return w.correctGathering(db, authority, { ...q, input });
		return w.clearGathering(db, authority, { ...q, input: { reason: input.reason } });
	});
}

/** The milestones the church's affiliations offer now, read again after a refused switch. */
export async function readGatheringOffers(): Promise<Outcome<GatheringOffer[]>> {
	return read((r, db, authority) => r.readGatheringOffers(db, authority));
}

/** People of the church a typed guest name may be. Offered only: nothing links until the planter picks one. */
export async function suggestGuests(query: string): Promise<Outcome<GuestMatch[]>> {
	return read((r, db, authority) => r.suggestGuests(db, authority, String(query)));
}

export async function readLaunchHistory(): Promise<Outcome<History>> {
	return read((r, db, authority) => r.readJournal(db, authority));
}
