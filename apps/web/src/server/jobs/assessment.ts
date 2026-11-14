import type { Database } from "@everyfield/db/client";
import type { Drafter } from "@everyfield/domain/intelligence";
import { paidAssessment } from "@everyfield/evry/assessment-model";
import { scriptedAssessmentDrafter } from "@everyfield/evry/scripted-assessment";
import "server-only";

/**
 * The scheduled runner's assessment model (WP-043, D92). Local, development and preview deployments run assessments;
 * production runs none, and an unknown environment fails closed. EVRY_SCRIPTED_MODEL=1 mounts the scripted drafter.
 * Otherwise an approved paid model (EVRY_MODEL=gpt-6-luna with OPENAI_API_KEY) mounts the paid drafter, metered on the
 * job database's model_spend under D77's cap, and without one the scripted drafter runs as before.
 */
export function assessmentsMount(
	db: Database | null,
	env: Record<string, string | undefined> = process.env,
): { drafter: Drafter } | null {
	const allowed = env.VERCEL_ENV === undefined || env.VERCEL_ENV === "development" || env.VERCEL_ENV === "preview";
	if (!allowed) return null;
	const paid = db && paidAssessment(db, env);
	return { drafter: paid ? paid.drafter : scriptedAssessmentDrafter() };
}
