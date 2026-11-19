"use server";

import { z } from "zod";
import { onboardingCommand, type Op } from "./mount";

const op = z.enum(["createPlant", "createDiscovery", "convertDiscovery", "declareJourney", "answerLead", "complete"]);

export async function runOnboardingCommand(name: Op, command: unknown) {
	const parsed = op.safeParse(name);
	if (!parsed.success) return { status: "refused" as const, error: null };
	return onboardingCommand(parsed.data, command);
}
