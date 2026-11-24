import type { Database } from "@everyfield/db/client";
import type { Drafter } from "@everyfield/domain/intelligence";
import "server-only";
import { serverEnv, type ServerEnv } from "../config.ts";
import { assessmentDrafter } from "../models.ts";

export async function assessmentsMount(
	db: Database,
	env: ServerEnv = serverEnv(),
): Promise<{ drafter: Drafter } | null> {
	const drafter = await assessmentDrafter(db, env);
	return drafter && { drafter };
}
