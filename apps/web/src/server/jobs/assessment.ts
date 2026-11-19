import type { Database } from "@everyfield/db/client";
import type { Drafter } from "@everyfield/domain/intelligence";
import { paidAssessment } from "@everyfield/evry/assessment-model";
import { scriptedAssessmentDrafter } from "@everyfield/evry/scripted-assessment";
import "server-only";
import { isTestDeployment } from "@everyfield/db/deployment";

export function assessmentsMount(
	db: Database | null,
	env: Record<string, string | undefined> = process.env,
): { drafter: Drafter } | null {
	if (!isTestDeployment(env)) return null;
	const paid = db && paidAssessment(db, env);
	return { drafter: paid ? paid.drafter : scriptedAssessmentDrafter() };
}
