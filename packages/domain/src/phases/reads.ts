import * as c from "@everyfield/contracts/phases";
import type { Database } from "@everyfield/db/client";
import { sql } from "@everyfield/db/query";
import "server-only";
import { z } from "zod";
import type { RequestActor } from "../access/session.ts";
import { declarable, deny, entryJson, entryOf, scopeOf, settle } from "./core.ts";

const historyRow = z.object({
	ok: z.boolean(),
	name: z.string().nullable(),
	timezone: z.string().nullable(),
	phase: c.phaseNumber.nullable(),
	revision: z.string().nullable(),
	declarable: z.boolean().nullable(),
	entries: z.array(z.unknown()),
	launch: z
		.object({
			id: z.uuid(),
			actualDate: z.string(),
			actorId: z.uuid().nullable(),
			actorName: z.string().nullable(),
			occurredAt: z.string(),
		})
		.nullable(),
});

/** Launch Sunday held, from the first recording of the outcome: the date is the current one, corrections included. */
function launchEntry(l: NonNullable<z.infer<typeof historyRow>["launch"]>): c.JourneyEntry {
	return c.journeyEntry.parse({
		kind: "launch_sunday",
		id: l.id,
		actualDate: l.actualDate,
		actor: l.actorId && l.actorName !== null ? { accountId: l.actorId, displayName: l.actorName } : null,
		occurredAt: l.occurredAt,
	});
}

export const phaseReader = {
	/**
	 * phases.readHistory (PHASE-007): the current phase and the journey in the order it happened, creation, declaration,
	 * moves and Launch Sunday held (WP-046), which is its own entry and never a made-up move. Rows are only ever appended, so a later correction is a new entry. Noop receipts are not moves and stay
	 * out. Each entry's actor is the account on its command's audit row; creation's command belongs to the founding
	 * account. One statement whose live Owner or Admin check gates every row it returns (C13, PHASE-CASE-007).
	 */
	async readHistory(db: Pick<Database, "execute">, authority: RequestActor) {
		return settle(async () => {
			const scope = scopeOf(authority);
			const { rows } = await db.execute(sql`SELECT g.ok,p.name,p.timezone,p.phase,p.revision::text AS revision,
 CASE WHEN p.id IS NOT NULL THEN ${declarable(sql`p.id`)} END AS declarable,
 coalesce((SELECT jsonb_agg(${entryJson(sql`t`, sql`a.actor_id`)} ORDER BY t.occurred_at,t.id)
  FROM phase_transition t LEFT JOIN audit_event a ON a.id=t.operation_id
  WHERE t.plant_id=p.id AND t.kind<>'noop'),'[]') AS entries,
 (SELECT jsonb_build_object('id',a.id,'actualDate',l.actual_date::text,'actorId',a.actor_id,
	'actorName',(SELECT display_name FROM seat_identity(a.actor_id) LIMIT 1),
	'occurredAt',to_char(a.occurred_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'))
  FROM launch l JOIN audit_event a ON a.tenant_id=l.plant_id AND a.action='launch.outcome_recorded'
  WHERE l.plant_id=p.id AND l.actual_date IS NOT NULL ORDER BY a.occurred_at LIMIT 1) AS launch
 FROM (SELECT ${scope.admin} AS ok) g LEFT JOIN plant p ON g.ok AND p.id=${scope.plantId}::uuid`);
			const r = historyRow.parse(rows[0]);
			if (!r.ok || r.phase === null) deny("access_denied");
			return c.historyResult.parse({
				state: { phase: r.phase, revision: r.revision, declarable: r.declarable },
				plantName: r.name,
				timeZone: r.timezone,
				entries: [...r.entries.map(entryOf), ...(r.launch ? [launchEntry(r.launch)] : [])].sort((a, b) =>
					a.occurredAt.localeCompare(b.occurredAt),
				),
			});
		});
	},
};
