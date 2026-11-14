import "server-only";
import type { FeedbackReply } from "@everyfield/contracts/feedback";
import type { Database } from "@everyfield/db/client";
import type { RequestActor } from "@everyfield/domain/access";
import { feedbackWriter } from "@everyfield/domain/feedback";
import { requestDatabase } from "@/server/database";
import { githubConfig } from "@/server/jobs/github";
import { getViewer } from "@/server/request-context";
import type { PublicationSetup } from "./model.ts";
import { operatorMailConfigured } from "./mail.ts";

// The feedback reads and writes run as the request's own signed-in account. The domain checks access in each statement.

/** The deployed version, from the host's build, or null when it does not say (a local build). */
export const appVersion = () => process.env.VERCEL_GIT_COMMIT_SHA?.slice(0, 7) ?? null;

/** Whether this deployment names a feedback repository and an operator inbox; the triage pages say so when not. */
export const publicationSetup = (): PublicationSetup => ({
	publication: githubConfig() !== null,
	mail: operatorMailConfigured(),
});

export type Run<T> =
	{ status: "ok"; value: T } | { status: "refused"; code: string } | { status: "signed_out" | "lost" };

/** Runs one feedback operation for the signed-in account. */
export async function run<T>(
	operation: (db: Database, authority: RequestActor) => Promise<FeedbackReply<T>>,
): Promise<Run<T>> {
	const viewer = await getViewer();
	const db = requestDatabase();
	if (!db) return { status: "lost" };
	if (!viewer?.authority) return { status: "signed_out" };
	try {
		const reply = await operation(db, viewer.authority);
		return reply.status === "ok" ? reply : { status: "refused", code: reply.error.code };
	} catch (error) {
		console.error(JSON.stringify({ component: "feedback", outcome: "failed", error: String(error) }));
		return { status: "lost" };
	}
}

export { feedbackWriter };
