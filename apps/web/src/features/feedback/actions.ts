"use server";

import type {
	FeedbackStatus,
	SendContext,
	StatusChange,
	SubmitFeedbackRequest,
	SubmittedFeedback,
} from "@everyfield/contracts/feedback";
import { appVersion, feedbackWriter, run, type Run } from "./server.ts";

export type DialogContext = SendContext & { appVersion: string | null };

export async function sendFeedback(input: SubmitFeedbackRequest): Promise<Run<SubmittedFeedback>> {
	return run((db, authority) => feedbackWriter.submit(db, authority, input, { appVersion: appVersion() }));
}

export async function changeFeedbackStatus(input: {
	feedbackId: string;
	expectedRevision: string;
	status: FeedbackStatus;
}): Promise<Run<StatusChange>> {
	return run((db, authority) => feedbackWriter["admin.changeStatus"](db, authority, input));
}
