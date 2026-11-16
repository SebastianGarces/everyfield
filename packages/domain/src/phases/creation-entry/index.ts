import "server-only";
import { randomUUID } from "node:crypto";
import { sql, type SQL } from "@everyfield/db/query";
import { event, type Tx, type NewCommand } from "../../onboarding/core.ts";

export function creationEntry(tx: Tx, c: NewCommand, plantId: string) {
	const id = randomUUID();
	return {
		insert: (plant: SQL) =>
			sql`INSERT INTO phase_transition(id,plant_id,kind,from_phase,to_phase,reason,occurred_at,recorded_at,operation_id)
 SELECT ${id}::uuid, p.id, 'creation', NULL, 1, 'Plant created in EveryField.', clock_timestamp(), clock_timestamp(), ${c.id}::uuid
 FROM ${plant} p WHERE p.id=${plantId}::uuid RETURNING recorded_at`,
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
