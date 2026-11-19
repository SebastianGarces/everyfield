import "server-only";
import type { AssessmentReply } from "@everyfield/contracts/intelligence";
import type { Database } from "@everyfield/db/client";
import type { RequestActor } from "@everyfield/domain/access";
import { createAssessments } from "@everyfield/domain/intelligence";
import { requestDatabase } from "@/server/database";
import { getViewer } from "@/server/request-context";
import { logFailure } from "@everyfield/domain/log";

export const assessments = createAssessments();

export type Run<T> =
	{ status: "ok"; value: T } | { status: "refused"; code: string } | { status: "signed_out" | "lost" };

export async function run<T>(
	operation: (db: Database, authority: RequestActor) => Promise<AssessmentReply<T>>,
): Promise<Run<T>> {
	const viewer = await getViewer();
	const db = requestDatabase();
	if (!viewer.authority) return { status: "signed_out" };
	try {
		const reply = await operation(db, viewer.authority);
		return reply.status === "ok" ? reply : { status: "refused", code: reply.error.code };
	} catch (error) {
		logFailure({ component: "assessment-review", outcome: "failed" }, error);
		return { status: "lost" };
	}
}
