import type { Database } from "@everyfield/db/client";
import type { Drafter } from "@everyfield/domain/intelligence";
import { paidAssessment } from "@everyfield/evry/assessment-model";
import { scriptedAssessmentDrafter } from "@everyfield/evry/scripted-assessment";
import "server-only";
import { isTestDeployment } from "@everyfield/db/deployment";
import { serverEnv, type ServerEnv } from "../config.ts";

export function assessmentsMount(db: Database, env: ServerEnv = serverEnv()): { drafter: Drafter } | null {
	if (!isTestDeployment(env)) return null;
	const paid = paidAssessment(db, env);
	return { drafter: paid ? paid.drafter : scriptedAssessmentDrafter() };
}
