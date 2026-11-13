"use server";

import type { Milestone, Plan } from "@everyfield/contracts/launch";
import type { Outcome } from "./model.ts";
import { write } from "./server.ts";

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
	return write((w, db, authority) => w.schedule(db, authority, { requestKey, expectedRevision, input: { date, reason } }));
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
