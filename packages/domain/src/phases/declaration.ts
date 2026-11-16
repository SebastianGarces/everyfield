import { DECLARATION_REASON, type PhaseNumber } from "@everyfield/contracts/phases";
import { sql, type SQL } from "@everyfield/db/query";
import "server-only";

export function declaration(source: SQL, phase: PhaseNumber, operationId: string): SQL {
	return sql`declared AS (INSERT INTO phase_transition(plant_id,kind,from_phase,to_phase,reason,occurred_at,recorded_at,operation_id)
 SELECT s.id,'initial_declaration',s.phase,${phase}::int,${DECLARATION_REASON},clock_timestamp(),clock_timestamp(),${operationId}::uuid
 FROM ${source} s WHERE NOT EXISTS(SELECT FROM phase_transition m WHERE m.plant_id=s.id AND m.kind='movement')
 ON CONFLICT DO NOTHING RETURNING *)`;
}
