import { DECLARATION_REASON, type PhaseNumber } from "@everyfield/contracts/phases";
import { sql, type SQL } from "@everyfield/db/query";
import "server-only";

/**
 * The only writer of an `initial_declaration` row (PHASE-001), as the CTE `declared`. Onboarding's declareJourney and
 * phases.declare both run it inside their own statement. `source` names a CTE with the plant's `id` and current
 * `phase`, which the caller has locked. The row records where the plant was when it joined, with the reserved
 * sentence; it synthesizes no earlier phase. The unique declaration slot and the absence of any ordinary move decide
 * whether it writes: `declared` is empty when either is used, and the caller refuses with already_declared. The caller
 * sets the plant's phase from `declared.to_phase` in the same statement.
 */
export function declaration(source: SQL, phase: PhaseNumber, operationId: string): SQL {
	return sql`declared AS (INSERT INTO phase_transition(plant_id,kind,from_phase,to_phase,reason,occurred_at,recorded_at,operation_id)
 SELECT s.id,'initial_declaration',s.phase,${phase}::int,${DECLARATION_REASON},clock_timestamp(),clock_timestamp(),${operationId}::uuid
 FROM ${source} s WHERE NOT EXISTS(SELECT FROM phase_transition m WHERE m.plant_id=s.id AND m.kind='movement')
 ON CONFLICT DO NOTHING RETURNING *)`;
}
