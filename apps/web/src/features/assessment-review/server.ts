import "server-only";
import { outcomeOf, type Outcome } from "@everyfield/contracts/common";
import type { AssessmentError, AssessmentReply } from "@everyfield/contracts/intelligence";
import type { Database } from "@everyfield/db/client";
import type { RequestActor } from "@everyfield/domain/access";
import { createAssessments } from "@everyfield/domain/intelligence";
import { requestDatabase } from "@/server/database";
import { viewerActor } from "@/server/request-context";
import { LOST, transient } from "../../server/platform/transient.ts";

export const assessments = createAssessments();

export type Run<T> = Outcome<T, AssessmentError["code"]> | { status: "signed_out" };

export async function run<T>(
	operation: (db: Database, authority: RequestActor) => Promise<AssessmentReply<T>>,
): Promise<Run<T>> {
	const authority = await viewerActor();
	if (!authority) return { status: "signed_out" };
	const db = requestDatabase();
	return transient(
		{ component: "assessment-review", outcome: "failed" },
		async () => outcomeOf(await operation(db, authority)),
		LOST,
	);
}
