"use server";

import { requestDatabase } from "@/server/database";
import { getViewer } from "@/server/request-context";
import type { AssessmentError, RefreshReceipt } from "@everyfield/contracts/intelligence";
import { createAssessments } from "@everyfield/domain/intelligence";

// The browser boundary of a fresh Plant Intelligence assessment (intelligence.requestRefresh, WP-043). WP-044 places the
// control. The plant and the requester come from the session's seat, never from the request; the domain refuses
// anyone but the plant's Owner or Admin, and a repeated request id queues one run.

const assessments = createAssessments();

export type RefreshOutcome =
	| { status: "ok"; value: RefreshReceipt }
	| { status: "refused"; error: AssessmentError }
	| { status: "signed_out" | "lost" };

export async function requestAssessmentRefresh(requestId: unknown): Promise<RefreshOutcome> {
	const viewer = await getViewer();
	if (!viewer?.authority) return { status: "signed_out" };
	const db = requestDatabase();
	if (!db) return { status: "lost" };
	try {
		return await assessments.requestRefresh(db, viewer.authority, { requestId });
	} catch (error) {
		console.error(
			JSON.stringify({
				component: "assessment",
				outcome: "refresh_failed",
				code: (error as { code?: string })?.code ?? null,
			}),
		);
		return { status: "lost" };
	}
}
