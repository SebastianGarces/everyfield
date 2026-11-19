"use server";

import { requestDatabase } from "@/server/database";
import { getViewer } from "@/server/request-context";
import type {
	AssessmentError,
	AssessmentReply,
	CitationView,
	FeedbackReceipt,
	SeenReceipt,
} from "@everyfield/contracts/intelligence";
import type { Database } from "@everyfield/db/client";
import type { RequestActor } from "@everyfield/domain/access";
import { createAssessments, type Assessments } from "@everyfield/domain/intelligence";
import { LOST, transient } from "../../server/platform/transient.ts";

const assessments = createAssessments();

export type ActionOutcome<T> =
	{ status: "ok"; value: T } | { status: "refused"; error: AssessmentError } | { status: "signed_out" | "lost" };

async function run<T>(
	component: "refresh" | "seen" | "feedback" | "citation",
	body: (a: Assessments, db: Database, authority: RequestActor) => Promise<AssessmentReply<T>>,
): Promise<ActionOutcome<T>> {
	const { authority } = await getViewer();
	if (!authority) return { status: "signed_out" };
	const db = requestDatabase();
	return transient(
		{ component: "assessment", outcome: `${component}_failed` },
		() => body(assessments, db, authority),
		LOST,
	);
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
