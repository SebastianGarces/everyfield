"use server";

import type { FeedbackReceipt, RefreshReceipt, SeenReceipt } from "@everyfield/contracts/intelligence";
import type { ActionOutcome } from "./assessment-model.ts";
import { runAssessment } from "./assessment-server.ts";

export async function requestAssessmentRefresh(requestId: unknown): Promise<ActionOutcome<RefreshReceipt>> {
	return runAssessment("refresh", (a, db, actor) => a.requestRefresh(db, actor, { requestId }));
}

export async function markAssessmentSeen(runId: unknown): Promise<ActionOutcome<SeenReceipt>> {
	return runAssessment("seen", (a, db, actor) => a.markAssessmentSeen(db, actor, { runId }));
}

export async function submitAssessmentFeedback(input: unknown): Promise<ActionOutcome<FeedbackReceipt>> {
	return runAssessment("feedback", (a, db, actor) => a.submitFeedback(db, actor, input));
}
