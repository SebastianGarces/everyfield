"use server";

import type {
	FeedbackCategory,
	FeedbackStatus,
	OwnFeedbackPage,
	SendContext,
	StatusChange,
	SubmitFeedbackRequest,
	SubmittedFeedback,
	TriagePage,
} from "@everyfield/contracts/feedback";
import { appVersion, feedbackWriter, run, type Run } from "./server.ts";

// Browser calls for feedback. Each one runs as the signed-in account; the domain parses every input again.

export type DialogContext = SendContext & { appVersion: string | null };
/** The church, role, reply address and app version the dialog lists before sending. */
export async function loadSendContext(): Promise<Run<DialogContext>> {
	const r = await run((db, authority) => feedbackWriter.getSendContext(db, authority));
	return r.status === "ok" ? { status: "ok", value: { ...r.value, appVersion: appVersion() } } : r;
}

/** Saves the feedback. A resend with the same request key returns the same saved feedback. */
export async function sendFeedback(input: SubmitFeedbackRequest): Promise<Run<SubmittedFeedback>> {
	return run((db, authority) => feedbackWriter.submit(db, authority, input, { appVersion: appVersion() }));
}

/** The next 25 of the caller's own feedback. */
export async function loadOwnFeedback(cursor: string): Promise<Run<OwnFeedbackPage>> {
	return run((db, authority) => feedbackWriter.listOwn(db, authority, { cursor }));
}

/** The next 25 feedback for a triager, with the same filters. */
export async function loadTriage(filter: {
	status: FeedbackStatus | null;
	category: FeedbackCategory | null;
	cursor: string;
}): Promise<Run<TriagePage>> {
	return run((db, authority) => feedbackWriter["admin.list"](db, authority, filter));
}

/** A triager moves one feedback to a status, from the revision they saw. */
export async function changeFeedbackStatus(input: {
	feedbackId: string;
	expectedRevision: string;
	status: FeedbackStatus;
}): Promise<Run<StatusChange>> {
	return run((db, authority) => feedbackWriter["admin.changeStatus"](db, authority, input));
}
