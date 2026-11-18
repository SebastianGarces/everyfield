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

export type DialogContext = SendContext & { appVersion: string | null };
export async function loadSendContext(): Promise<Run<DialogContext>> {
	const r = await run((db, authority) => feedbackWriter.getSendContext(db, authority));
	return r.status === "ok" ? { status: "ok", value: { ...r.value, appVersion: appVersion() } } : r;
}

export async function sendFeedback(input: SubmitFeedbackRequest): Promise<Run<SubmittedFeedback>> {
	return run((db, authority) => feedbackWriter.submit(db, authority, input, { appVersion: appVersion() }));
}

export async function loadOwnFeedback(cursor: string): Promise<Run<OwnFeedbackPage>> {
	return run((db, authority) => feedbackWriter.listOwn(db, authority, { cursor }));
}

export async function loadTriage(filter: {
	status: FeedbackStatus | null;
	category: FeedbackCategory | null;
	cursor: string;
}): Promise<Run<TriagePage>> {
	return run((db, authority) => feedbackWriter["admin.list"](db, authority, filter));
}

export async function changeFeedbackStatus(input: {
	feedbackId: string;
	expectedRevision: string;
	status: FeedbackStatus;
}): Promise<Run<StatusChange>> {
	return run((db, authority) => feedbackWriter["admin.changeStatus"](db, authority, input));
}
