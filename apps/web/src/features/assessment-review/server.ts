import "server-only";
import type { AssessmentReply } from "@everyfield/contracts/intelligence";
import type { Database } from "@everyfield/db/client";
import type { RequestActor } from "@everyfield/domain/access";
import { createAssessments } from "@everyfield/domain/intelligence";
import { requestDatabase } from "@/server/database";
import { getViewer } from "@/server/request-context";

// The review reads run as the request's own signed-in account; the domain checks the operator grant in each statement.

export const assessments = createAssessments();

export type Run<T> =
	{ status: "ok"; value: T } | { status: "refused"; code: string } | { status: "signed_out" | "lost" };

export async function run<T>(
	operation: (db: Database, authority: RequestActor) => Promise<AssessmentReply<T>>,
): Promise<Run<T>> {
	const viewer = await getViewer();
	const db = requestDatabase();
	if (!db) return { status: "lost" };
	if (!viewer?.authority) return { status: "signed_out" };
	try {
		const reply = await operation(db, viewer.authority);
		return reply.status === "ok" ? reply : { status: "refused", code: reply.error.code };
	} catch (error) {
		console.error(
			JSON.stringify({
				component: "assessment-review",
				outcome: "failed",
				code: (error as { code?: string })?.code ?? null,
			}),
		);
		return { status: "lost" };
	}
}
