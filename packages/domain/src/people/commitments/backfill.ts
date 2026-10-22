import type { Backfill } from "@everyfield/db/migrate";
import { sql } from "@everyfield/db/query";
import { z } from "zod";
import { commitmentInputs, commitmentInputsJson, commitmentOf } from "./lifecycle.ts";

const cached = z.object({
	id: z.uuid(),
	state: z.enum(["active", "withdrawn", "unknown"]),
	effective_on: z.string().nullable(),
	inputs: commitmentInputs,
});

/**
 * C101: make every plant Person's commitment cache equal commitmentOf over its valid cards and dated changes, in
 * batches by Person ID, writing only the rows that differ. A merged Person keeps its value: Unmerge restores it.
 */
export function commitmentCacheBackfill(batch = 500): Backfill {
	return {
		name: "commitment_cache_c100",
		async run(tx) {
			let changed = 0,
				after = "00000000-0000-0000-0000-000000000000";
			for (;;) {
				const result = await tx.execute(sql`SELECT p.id,p.commitment_state AS state,
 p.commitment_effective_on::text AS effective_on,${commitmentInputsJson(sql`p.id`, sql`p.plant_id`)} AS inputs
 FROM person p WHERE p.plant_id IS NOT NULL AND p.state<>'merged' AND p.id>${after}::uuid
 ORDER BY p.id LIMIT ${batch} FOR UPDATE OF p`);
				if (!result.rows.length) return changed;
				const updates = [];
				for (const raw of result.rows) {
					const p = cached.parse(raw);
					after = p.id;
					const next = commitmentOf(p.inputs);
					if (next.state !== p.state || next.effectiveOn !== p.effective_on)
						updates.push({ id: p.id, state: next.state, effective_on: next.effectiveOn });
				}
				if (!updates.length) continue;
				await tx.execute(sql`UPDATE person p SET commitment_state=u.state,commitment_effective_on=u.effective_on
 FROM jsonb_to_recordset(${JSON.stringify(updates)}::jsonb) AS u(id uuid,state text,effective_on date) WHERE p.id=u.id`);
				changed += updates.length;
			}
		},
	};
}
