"use server";

import { requestDatabase } from "@/server/database";
import { getViewer } from "@/server/request-context";
import type {
	AssessmentError,
	AssessmentReply,
	CitationView,
	FeedbackReceipt,
	RefreshReceipt,
	SeenReceipt,
} from "@everyfield/contracts/intelligence";
import type { Database } from "@everyfield/db/client";
import type { RequestActor } from "@everyfield/domain/access";
import { createAssessments, type Assessments } from "@everyfield/domain/intelligence";

const assessments = createAssessments();

export type ActionOutcome<T> =
	{ status: "ok"; value: T } | { status: "refused"; error: AssessmentError } | { status: "signed_out" | "lost" };

async function run<T>(
	component: string,
	body: (a: Assessments, db: Database, authority: RequestActor) => Promise<AssessmentReply<T>>,
): Promise<ActionOutcome<T>> {
	const viewer = await getViewer();
	if (!viewer?.authority) return { status: "signed_out" };
	const db = requestDatabase();
	if (!db) return { status: "lost" };
	try {
		return await body(assessments, db, viewer.authority);
	} catch (error) {
		console.error(
			JSON.stringify({
				component: "assessment",
				outcome: `${component}_failed`,
				code: (error as { code?: string })?.code ?? null,
			}),
		);
		return { status: "lost" };
	}
}

export async function requestAssessmentRefresh(requestId: unknown): Promise<ActionOutcome<RefreshReceipt>> {
	return run("refresh", (a, db, actor) => a.requestRefresh(db, actor, { requestId }));
}

export async function markAssessmentSeen(runId: unknown): Promise<ActionOutcome<SeenReceipt>> {
	return run("seen", (a, db, actor) => a.markAssessmentSeen(db, actor, { runId }));
}

export async function submitAssessmentFeedback(input: unknown): Promise<ActionOutcome<FeedbackReceipt>> {
	return run("feedback", (a, db, actor) => a.submitFeedback(db, actor, input));
}

export async function resolveAssessmentCitation(runId: unknown, key: unknown): Promise<ActionOutcome<CitationView>> {
	return run("citation", (a, db, actor) => a.resolveCitation(db, actor, { runId, key }));
}
