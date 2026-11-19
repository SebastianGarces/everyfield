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
import { logFailure } from "@everyfield/domain/log";

export { appVersion } from "../../server/app-version.ts";

export const publicationSetup = (): PublicationSetup => ({
	publication: githubConfig() !== null,
	mail: operatorMailConfigured(),
});

export type Run<T> =
	{ status: "ok"; value: T } | { status: "refused"; code: string } | { status: "signed_out" | "lost" };

type Operation<T> = (db: Database, authority: RequestActor) => Promise<FeedbackReply<T>>;

export const run = async <T>(operation: Operation<T>) => runAs(await getViewer(), operation);

export async function runAs<T>(
	viewer: Awaited<ReturnType<typeof getViewer>>,
	operation: Operation<T>,
): Promise<Run<T>> {
	const db = requestDatabase();
	if (!viewer.authority) return { status: "signed_out" };
	try {
		const reply = await operation(db, viewer.authority);
		return reply.status === "ok" ? reply : { status: "refused", code: reply.error.code };
	} catch (error) {
		logFailure({ component: "feedback", outcome: "failed" }, error);
		return { status: "lost" };
	}
}

export { feedbackWriter };
