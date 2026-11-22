import "server-only";
import type { z } from "zod";
import { outcomeOf, type Outcome } from "@everyfield/contracts/common";
import type { FeedbackReply, feedbackErrorCode } from "@everyfield/contracts/feedback";
import type { Database } from "@everyfield/db/client";
import type { RequestActor } from "@everyfield/domain/access";
import { feedbackWriter } from "@everyfield/domain/feedback";
import { requestDatabase } from "@/server/database";
import { githubConfig } from "@/server/jobs/github";
import { getViewer } from "@/server/request-context";
import type { PublicationSetup } from "./model.ts";
import { operatorMailConfigured } from "./mail.ts";
import { LOST, transient } from "../../server/platform/transient.ts";

export { appVersion } from "../../server/app-version.ts";

export const publicationSetup = (): PublicationSetup => ({
	publication: githubConfig() !== null,
	mail: operatorMailConfigured(),
});

export type Run<T> = Outcome<T, z.infer<typeof feedbackErrorCode>> | { status: "signed_out" };

type Operation<T> = (db: Database, authority: RequestActor) => Promise<FeedbackReply<T>>;

export const run = async <T>(operation: Operation<T>) => runAs(await getViewer(), operation);

export async function runAs<T>(
	viewer: Awaited<ReturnType<typeof getViewer>>,
	operation: Operation<T>,
): Promise<Run<T>> {
	const authority = viewer.authority;
	if (!authority) return { status: "signed_out" };
	const db = requestDatabase();
	return transient(
		{ component: "feedback", outcome: "failed" },
		async () => outcomeOf(await operation(db, authority)),
		LOST,
	);
}

export { feedbackWriter };
