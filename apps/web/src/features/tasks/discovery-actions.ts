"use server";

import { discoverySteps } from "@everyfield/contracts/onboarding";
import type { z } from "zod";
import { onboardingCommand } from "../onboarding/mount.ts";

export type SavedSteps = { status: "ok"; steps: z.infer<typeof discoverySteps> } | { status: "refused" };

export async function saveDiscoveryStep(command: unknown): Promise<SavedSteps> {
	const r = await onboardingCommand("setDiscoveryStep", command);
	if (r.status === "refused") return { status: "refused" };
	return { status: "ok", steps: discoverySteps.parse(r.value) };
}
