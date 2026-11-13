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
});

export const phaseReader = {
	/**
	 * phases.readHistory (PHASE-007): the current phase and the journey in the order it happened, creation, declaration
	 * and moves. Rows are only ever appended, so a later correction is a new entry. Noop receipts are not moves and stay
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
  WHERE t.plant_id=p.id AND t.kind<>'noop'),'[]') AS entries
 FROM (SELECT ${scope.admin} AS ok) g LEFT JOIN plant p ON g.ok AND p.id=${scope.plantId}::uuid`);
			const r = historyRow.parse(rows[0]);
			if (!r.ok || r.phase === null) deny("access_denied");
			return c.historyResult.parse({
				state: { phase: r.phase, revision: r.revision, declarable: r.declarable },
				plantName: r.name,
				timeZone: r.timezone,
				entries: r.entries.map(entryOf),
			});
		});
	},
};
