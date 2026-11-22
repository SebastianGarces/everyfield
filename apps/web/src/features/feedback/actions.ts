"use server";

import type { SendContext, StatusChange, SubmittedFeedback } from "@everyfield/contracts/feedback";
import { appVersion, feedbackWriter, run, type Run } from "./server.ts";

export type DialogContext = SendContext & { appVersion: string | null };

export async function sendFeedback(input: unknown): Promise<Run<SubmittedFeedback>> {
	return run((db, authority) => feedbackWriter.submit(db, authority, input, { appVersion: appVersion() }));
}

export async function changeFeedbackStatus(input: unknown): Promise<Run<StatusChange>> {
	return run((db, authority) => feedbackWriter["admin.changeStatus"](db, authority, input));
}
