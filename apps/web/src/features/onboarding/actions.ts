"use server";

import { z } from "zod";
import { onboardingCommand, onboardingEntry, type Op } from "@/server/onboarding";

// The browser's only door to the onboarding mount (WP-009/ui R2). Both return plain contract values; port.ts parses
// them again before a screen sees them.

export async function loadOnboardingEntry() {
	return onboardingEntry();
}

const op = z.enum(["createPlant", "createDiscovery", "convertDiscovery", "declareJourney", "answerLead", "complete"]);

export async function runOnboardingCommand(name: Op, command: unknown) {
	const parsed = op.safeParse(name);
	if (!parsed.success) return { status: "refused" as const, error: null };
	return onboardingCommand(parsed.data, command);
}
