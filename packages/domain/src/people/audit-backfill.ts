import type { Backfill } from "@everyfield/db/migrate";
import { sql } from "@everyfield/db/query";
import { z } from "zod";
import { allowedPeopleValues } from "./core.ts";

const values = z.record(z.string(), z.unknown()).nullable();
const stored = z.object({
	id: z.uuid(),
	before_value: values,
	after_value: values,
	note_correction: z.boolean(),
});

function scrubbed(row: z.infer<typeof stored>) {
	if (row.note_correction) return { id: row.id, before: null, after: null };
	const { fields, ...after } = row.after_value ?? {};
	const named = z.array(z.string()).optional().parse(fields);
	const kept = allowedPeopleValues({ before: row.before_value, after: row.after_value && after }, named);
	return { id: row.id, before: kept.before, after: kept.after };
}

export function peopleAuditScrubBackfill(batch = 500): Backfill {
	return {
		name: "people_audit_values_scrub_t677",
		async run(tx) {
			let changed = 0,
				after = "00000000-0000-0000-0000-000000000000";
			for (;;) {
				const result = await tx.execute(sql`SELECT a.id,a.before_value,a.after_value,
 (a.metadata->>'category'='note' AND a.metadata->'correction'='true'::jsonb) IS TRUE AS note_correction
 FROM audit_event a WHERE a.action IN ('people.created','people.updated') AND a.id>${after}::uuid
 ORDER BY a.id LIMIT ${batch} FOR UPDATE OF a`);
				if (!result.rows.length) return changed;
				const rows = result.rows.map((raw) => stored.parse(raw));
				after = rows.at(-1)?.id ?? after;
				const updated = await tx.execute(sql`UPDATE audit_event a SET before_value=u.before,after_value=u.after
 FROM jsonb_to_recordset(${JSON.stringify(rows.map(scrubbed))}::jsonb) AS u(id uuid,before jsonb,after jsonb)
 WHERE a.id=u.id AND (a.before_value IS DISTINCT FROM u.before OR a.after_value IS DISTINCT FROM u.after) RETURNING a.id`);
				changed += updated.rows.length;
			}
		},
	};
}
