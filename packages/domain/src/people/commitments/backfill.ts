import type { Backfill } from "@everyfield/db/migrate";
import { sql } from "@everyfield/db/query";
import { z } from "zod";
import { factsOf, parseFacts, referencesDigest } from "../merge/index.ts";
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

const activeMerge = z.object({
	id: z.uuid(),
	tenant_id: z.uuid(),
	source_id: z.uuid(),
	survivor_id: z.uuid(),
	references_digest: z.string(),
	from_source: z.array(z.uuid()),
	survivor: z.unknown(),
});

/**
 * C100 for merges made before commitment_change existed: the survivor now holds change rows its reviewed reference
 * digest never covered, and the source's changes (backfilled to the survivor) are not in the merge's moved list. For
 * each active merge whose survivor is otherwise unchanged since the merge, record those changes as moved and the
 * digest with them, so Unmerge proceeds and gives the source its own changes back. A merge already blocked by a
 * later change stays blocked.
 */
export function mergeReferencesBackfill(batch = 200): Backfill {
	return {
		name: "merge_references_c100",
		async run(tx) {
			let changed = 0,
				after = "00000000-0000-0000-0000-000000000000";
			for (;;) {
				const result = await tx.execute(sql`SELECT m.id,m.tenant_id,m.source_id,m.survivor_id,m.references_digest,
 (SELECT coalesce(jsonb_agg(e.id),'[]') FROM commitment_change e JOIN audit_event a ON a.id=e.id
  WHERE e.person_id=m.survivor_id AND e.plant_id=m.tenant_id AND a.subject_id=m.source_id) AS from_source,
 ${factsOf(sql`m.survivor_id`, sql`m.tenant_id`)} AS survivor
 FROM person_merge m WHERE m.unmerged_at IS NULL AND m.id>${after}::uuid
 AND EXISTS(SELECT FROM commitment_change e WHERE e.person_id=m.survivor_id AND e.plant_id=m.tenant_id)
 ORDER BY m.id LIMIT ${batch} FOR UPDATE OF m`);
				if (!result.rows.length) return changed;
				for (const raw of result.rows) {
					const m = activeMerge.parse(raw);
					after = m.id;
					const survivor = parseFacts(m.survivor);
					if (!survivor) continue;
					const others = survivor.refs.filter((r) => r.kind !== "commitment_change");
					if (referencesDigest(others) !== m.references_digest) continue;
					await tx.execute(sql`UPDATE person_merge SET references_digest=${referencesDigest(survivor.refs)},
 moved=moved||jsonb_build_object('commitment_change',${JSON.stringify(m.from_source)}::jsonb) WHERE id=${m.id}::uuid`);
					changed++;
				}
			}
		},
	};
}
