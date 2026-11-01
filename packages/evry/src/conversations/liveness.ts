import type { Database } from "@everyfield/db/client";
import { sql, type SQL } from "@everyfield/db/query";
import { liveRead } from "@everyfield/domain/access";
import type { EvryActor } from "../context/actor.ts";
import type { SourceRow } from "../catalog/types.ts";

/**
 * Whether a result row's source still exists, one rule per row kind. `id` is the row id as uuid text and `plant` the
 * conversation's plant (this product keeps tenant and plant equal). A rule is `null` when the kind is not a stored
 * source: such a row is never withheld. Replay (retained.ts) and the in-turn check (turn.ts) both build from this map.
 */
type Rule = ((id: SQL, plant: SQL) => SQL) | null;

export const ROW_LIVENESS: Record<SourceRow["kind"], Rule> = {
	// Unchanged: the person is live in this church.
	person: (id, plant) =>
		sql`EXISTS(SELECT FROM person p WHERE p.id=${id} AND p.tenant_id=${plant} AND p.plant_id=${plant} AND p.state='live')`,
	// A household table has no state column: the row existing in the plant is the test.
	household: (id, plant) => sql`EXISTS(SELECT FROM household h WHERE h.id=${id} AND h.plant_id=${plant})`,
	// A tag is live while it exists in the plant.
	tag: (id, plant) => sql`EXISTS(SELECT FROM tag t WHERE t.id=${id} AND t.plant_id=${plant})`,
	// Never withheld: an import row is a CSV line number or a preview's own row, not a stored record. A file row is a
	// digest, a receipt key or a name the tool computed, and an activity or skill row is a safe detail of a person that
	// the tool read under that person's own access; none of them names a source that this check could find gone.
	import: null,
	file: null,
	skill: null,
	activity: null,
};

/**
 * A SQL boolean for one result row, `row` being a jsonb `{kind,id,...}`. The uuid cast sits inside its kind's branch, so
 * a non-uuid id of a never-withheld kind (a CSV line, a digest) is never cast.
 */
export function rowLive(row: SQL, plant: SQL): SQL {
	const branches = (Object.keys(ROW_LIVENESS) as SourceRow["kind"][]).flatMap((kind) => {
		const rule = ROW_LIVENESS[kind];
		return rule ? [sql`WHEN ${kind} THEN ${rule(sql`(${row}->>'id')::uuid`, plant)}`] : [];
	});
	return sql`(CASE (${row}->>'kind') ${sql.join(branches, sql` `)} ELSE true END)`;
}

/**
 * The `kind:id` keys of these rows that are live for the actor now: the in-turn form of the same rule. One statement
 * for every row of a model call, carrying the lock-free live access check (C27), so an actor who lost access since
 * the last tool call keeps no row, whatever its kind.
 */
export async function liveRowKeys(
	db: Pick<Database, "execute">,
	actor: EvryActor,
	rows: readonly { kind: string; id: string }[],
): Promise<Set<string>> {
	if (!rows.length || actor.owner.kind !== "plant" || actor.role === null) return new Set();
	const r = await db.execute(sql`
		SELECT r.key FROM jsonb_to_recordset(${JSON.stringify(rows)}::jsonb) AS x(kind text,id text)
		CROSS JOIN LATERAL (SELECT x.kind||':'||x.id AS key, jsonb_build_object('kind',x.kind,'id',x.id) AS j) r
		WHERE ${rowLive(sql`r.j`, sql`${actor.owner.id}::uuid`)}
			AND ${liveRead({ session: actor.session, owner: actor.owner, seatId: actor.seatId ?? undefined })}`);
	return new Set(r.rows.map((raw) => String((raw as { key: string }).key)));
}
