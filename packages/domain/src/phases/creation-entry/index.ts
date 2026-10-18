import "server-only";
import { randomUUID } from "node:crypto";
import { eq } from "@everyfield/db/query";
import * as t from "@everyfield/db/tables";
import { event, now, type Tx, type NewCommand } from "../../onboarding/core.ts";

// Only the actual insert path calls this collaborator. The database's unique
// creation slot is separate from the unique later initial-declaration slot.
export async function recordCreationEntry(tx: Tx, c: NewCommand, plantId: string) {
	const id = randomUUID();
	await tx.insert(t.phase_transition).values({
		id,
		plant_id: plantId,
		kind: "creation",
		from_phase: null,
		to_phase: 1,
		reason: "Plant created in EveryField.",
		occurred_at: now,
		recorded_at: now,
		operation_id: c.id,
	});
	const eventId = await event(tx, c, id, "phase.created", "create");
	const [row] = await tx
		.select({ recordedAt: t.phase_transition.recorded_at })
		.from(t.phase_transition)
		.where(eq(t.phase_transition.id, id));
	return {
		kind: "church_creation" as const,
		eventId,
		fromPhase: null,
		toPhase: 1 as const,
		recordedAt: row!.recordedAt.toISOString(),
	};
}
