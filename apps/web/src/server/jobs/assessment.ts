import type { Drafter } from "@everyfield/domain/intelligence";
import { scriptedAssessmentDrafter } from "@everyfield/evry/scripted-assessment";
import "server-only";

/**
 * The scheduled runner's assessment model (WP-043). Only the scripted model exists (D77: building and testing make no
 * paid call), so it runs on local, development and preview deployments, and no assessment runs in production until a
 * real model is approved (T-380). An unknown environment fails closed.
 */
export function assessmentsMount(env: Record<string, string | undefined> = process.env): { drafter: Drafter } | null {
	const allowed = env.VERCEL_ENV === undefined || env.VERCEL_ENV === "development" || env.VERCEL_ENV === "preview";
	return allowed ? { drafter: scriptedAssessmentDrafter() } : null;
}
