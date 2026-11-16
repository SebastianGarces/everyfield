import type { Database } from "@everyfield/db/client";
import { sql, type SQL } from "@everyfield/db/query";
import { liveRead } from "@everyfield/domain/access";
import type { EvryActor } from "../context/actor.ts";
import type { SourceRow } from "../catalog/types.ts";

type Rule = ((id: SQL, plant: SQL) => SQL) | null;

const ROW_LIVENESS: Record<SourceRow["kind"], Rule> = {
	person: (id, plant) =>
		sql`EXISTS(SELECT FROM person p WHERE p.id=${id} AND p.tenant_id=${plant} AND coalesce(p.plant_id,p.organization_id)=${plant} AND p.state='live')`,
	household: (id, plant) => sql`EXISTS(SELECT FROM household h WHERE h.id=${id} AND h.plant_id=${plant})`,
	tag: (id, plant) => sql`EXISTS(SELECT FROM tag t WHERE t.id=${id} AND t.plant_id=${plant})`,
	message: (id, plant) => sql`EXISTS(SELECT FROM communication m WHERE m.id=${id} AND m.plant_id=${plant})`,
	notice: (id) =>
		sql`EXISTS(SELECT FROM notice n WHERE n.id=${id} AND n.cancelled_at IS NULL AND n.archived_at IS NULL)`,
	team: (id, plant) => sql`EXISTS(SELECT FROM team lt WHERE lt.id=${id} AND lt.plant_id=${plant})`,
	role: (id, plant) => sql`EXISTS(SELECT FROM team_role lr WHERE lr.id=${id} AND lr.plant_id=${plant})`,
	training: (id, plant) => sql`EXISTS(SELECT FROM training_program lg WHERE lg.id=${id} AND lg.plant_id=${plant})`,
	meeting: (id, plant) =>
		sql`EXISTS(SELECT FROM meeting lm WHERE lm.id=${id} AND lm.plant_id=${plant} AND lm.retired_at IS NULL)`,
	responsibility: (id, plant) =>
		sql`EXISTS(SELECT FROM responsibility ls WHERE ls.id=${id} AND ls.plant_id=${plant} AND ls.removed_at IS NULL)`,
	template: null,
	venue: (id, plant) => sql`EXISTS(SELECT FROM venue lv WHERE lv.id=${id} AND lv.plant_id=${plant})`,
	item: null,
	import: null,
	file: null,
	skill: null,
	activity: null,
	seat: null,
	invitation: null,
	connection: null,
	step: null,
	relationship: null,
	stage: null,
	milestone: (id, plant) =>
		sql`EXISTS(SELECT FROM launch_milestone lx WHERE lx.id=${id} AND lx.plant_id=${plant} AND lx.removed_at IS NULL)`,
	setting: null,
	digest: null,
};

export function rowLive(row: SQL, plant: SQL): SQL {
	const branches = (Object.keys(ROW_LIVENESS) as SourceRow["kind"][]).flatMap((kind) => {
		const rule = ROW_LIVENESS[kind];
		return rule ? [sql`WHEN ${kind} THEN ${rule(sql`(${row}->>'id')::uuid`, plant)}`] : [];
	});
	return sql`(CASE (${row}->>'kind') ${sql.join(branches, sql` `)} ELSE true END)`;
}

export async function liveRowKeys(
	db: Pick<Database, "execute">,
	actor: EvryActor,
	rows: readonly { kind: string; id: string }[],
): Promise<Set<string>> {
	if (!rows.length) return new Set();
	const r = await db.execute(sql`
		SELECT r.key FROM jsonb_to_recordset(${JSON.stringify(rows)}::jsonb) AS x(kind text,id text)
		CROSS JOIN LATERAL (SELECT x.kind||':'||x.id AS key, jsonb_build_object('kind',x.kind,'id',x.id) AS j) r
		WHERE ${rowLive(sql`r.j`, sql`${actor.owner.id}::uuid`)}
			AND ${liveRead({ session: actor.session, owner: actor.owner, seatId: actor.seatId ?? undefined })}`);
	return new Set(r.rows.map((raw) => String((raw as { key: string }).key)));
}
