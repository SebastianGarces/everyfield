import "server-only";
import { randomUUID } from "node:crypto";
import * as t from "@everyfield/db/tables";
import { event, now, type Tx, type NewCommand } from "../../onboarding/core.ts";

// Only the actual insert path calls this collaborator. The database's unique
// creation slot is separate from the unique later initial-declaration slot.
export async function recordCreationEntry(tx: Tx, c: NewCommand, plantId: string) {
	const id = randomUUID();
	const [row] = await tx
		.insert(t.phase_transition)
		.values({
			id,
			plant_id: plantId,
			kind: "creation",
			from_phase: null,
			to_phase: 1,
			reason: "Plant created in EveryField.",
			occurred_at: now,
			recorded_at: now,
			operation_id: c.id,
		})
		.returning({ recordedAt: t.phase_transition.recorded_at });
	const eventId = await event(tx, c, id, "phase.created", "create");
	return {
		kind: "church_creation" as const,
		eventId,
		fromPhase: null,
		toPhase: 1 as const,
		recordedAt: row!.recordedAt.toISOString(),
	};
}
