"use server";

import type { Milestone, Plan } from "@everyfield/contracts/launch";
import { z } from "zod";
import type { Outcome } from "./model.ts";
import { write } from "./server.ts";

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
	input: unknown,
): Promise<Outcome<DateResult>> {
	return write((w, db, authority) => w.recordOutcome(db, authority, { requestKey, expectedRevision, input }));
}

export async function correctOutcome(
	requestKey: string,
	expectedRevision: string,
	input: unknown,
): Promise<Outcome<DateResult>> {
	return write((w, db, authority) => w.correctOutcome(db, authority, { requestKey, expectedRevision, input }));
}

export async function addGuest(requestKey: string, input: unknown): Promise<Outcome<DateResult>> {
	return write((w, db, authority) => w.addGuestAttendance(db, authority, { requestKey, input }));
}

export async function saveDebrief(
	requestKey: string,
	expectedRevision: string,
	draftId: unknown,
	answers: unknown,
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

export async function chooseGatheringPath(
	requestKey: string,
	expectedRevision: string,
	input: unknown,
): Promise<Outcome<DateResult>> {
	return write((w, db, authority) => w.choosePath(db, authority, { requestKey, expectedRevision, input }));
}

const gatheringFields = z.object({ date: z.unknown(), note: z.unknown(), reason: z.unknown() }).partial();

export async function saveGathering(
	requestKey: string,
	expectedRevision: string,
	mode: unknown,
	input: unknown,
): Promise<Outcome<DateResult>> {
	const picked = gatheringFields.safeParse(input);
	const fields = picked.success ? picked.data : {};
	return write((w, db, authority) => {
		const q = { requestKey, expectedRevision };
		if (mode === "record")
			return w.recordGathering(db, authority, { ...q, input: { date: fields.date, note: fields.note } });
		if (mode === "correct") return w.correctGathering(db, authority, { ...q, input });
		return w.clearGathering(db, authority, { ...q, input: { reason: fields.reason } });
	});
}
