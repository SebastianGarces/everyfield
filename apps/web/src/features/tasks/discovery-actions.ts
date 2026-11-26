"use server";

import { discoverySteps } from "@everyfield/contracts/onboarding";
import type { z } from "zod";
import { onboardingCommand } from "../onboarding/mount.ts";

export type SavedSteps =
	{ status: "ok"; steps: z.infer<typeof discoverySteps> } | { status: "refused"; code: string | null };

export async function saveDiscoveryStep(command: unknown): Promise<SavedSteps> {
	const r = await onboardingCommand("setDiscoveryStep", command);
	if (r.status === "refused") return { status: "refused", code: r.error.code };
	return { status: "ok", steps: discoverySteps.parse(r.value) };
}
