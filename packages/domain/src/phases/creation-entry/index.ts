import "server-only";
import { randomUUID } from "node:crypto";
import { sql, type SQL } from "@everyfield/db/query";
import { event, type Tx, type NewCommand } from "../../onboarding/core.ts";

// Only the actual insert path calls this collaborator. The database's unique
// creation slot is separate from the unique later initial-declaration slot.
export function creationEntry(tx: Tx, c: NewCommand, plantId: string) {
	const id = randomUUID();
	return {
		/** The entry's insert, after the new plant: `plant` names the caller's CTE that returns the plant's id. */
		insert: (plant: SQL) =>
			sql`INSERT INTO phase_transition(id,plant_id,kind,from_phase,to_phase,reason,occurred_at,recorded_at,operation_id)
 SELECT ${id}::uuid, p.id, 'creation', NULL, 1, 'Plant created in EveryField.', clock_timestamp(), clock_timestamp(), ${c.id}::uuid
 FROM ${plant} p WHERE p.id=${plantId}::uuid RETURNING recorded_at`,
		/** The entry's audit event and its reply, once the insert has returned its recorded time. */
		async recorded(recordedAt: Date) {
			const eventId = await event(tx, c, id, "phase.created", "create");
			return {
				kind: "church_creation" as const,
				eventId,
				fromPhase: null,
				toPhase: 1 as const,
				recordedAt: recordedAt.toISOString(),
			};
		},
	};
}
