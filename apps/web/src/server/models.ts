import type { Database } from "@everyfield/db/client";
import { isTestDeployment, runsOffVercel } from "@everyfield/db/deployment";
import type { Drafter } from "@everyfield/domain/intelligence";
import { selectQualifiedModel, type QualifiedModel } from "@everyfield/evry";
import { paidAssessment } from "@everyfield/evry/assessment-model";
import "server-only";
import { serverEnv, type ServerEnv } from "./config.ts";

const scriptedRequested = (env: ServerEnv) => env.EVRY_SCRIPTED_MODEL === "1";

export async function evryModel(env: ServerEnv = serverEnv()): Promise<QualifiedModel> {
	if (runsOffVercel(env) && scriptedRequested(env)) {
		const { scriptedQualifiedModel } = await import("@everyfield/evry-scripted");
		return scriptedQualifiedModel();
	}
	return selectQualifiedModel(env);
}

export async function assessmentDrafter(db: Database, env: ServerEnv = serverEnv()): Promise<Drafter | null> {
	if (!isTestDeployment(env)) return null;
	const paid = scriptedRequested(env) ? null : paidAssessment(db, env);
	if (paid) return paid.drafter;
	const { scriptedAssessmentDrafter } = await import("@everyfield/evry-scripted");
	return scriptedAssessmentDrafter();
}
