import type { Database } from "@everyfield/db/client";
import { sql, type SQL } from "@everyfield/db/query";
import { liveRead } from "@everyfield/domain/access";
import type { EvryActor } from "../context/actor.ts";
import type { SourceRow } from "../catalog/types.ts";

type Rule = ((id: SQL, plant: SQL, account: SQL) => SQL) | null;
const ownerOrAdmin = (plant: SQL, account: SQL) =>
	sql`EXISTS(SELECT FROM seat live_s WHERE live_s.account_id=${account} AND live_s.plant_id=${plant} AND live_s.ended_at IS NULL
		AND live_s.accepted_at<=clock_timestamp() AND live_s.role<>'member')`;

export const articleLive = (id: SQL, plant: SQL) =>
	sql`EXISTS(SELECT FROM article_revision wiki_r WHERE wiki_r.id=${id} AND (
		(wiki_r.tenant_id='00000000-0000-0000-0000-000000000000'::uuid
			AND wiki_r.release_id=(SELECT wiki_a.release_id FROM reference_activation wiki_a ORDER BY wiki_a.activation_number DESC LIMIT 1))
		OR EXISTS(SELECT FROM article_editor_state wiki_e JOIN affiliation wiki_f ON wiki_f.organization_id=wiki_e.organization_id
			WHERE wiki_e.current_revision_id=wiki_r.id AND wiki_e.organization_id=wiki_r.tenant_id AND wiki_e.state='published'
				AND wiki_f.plant_id=${plant} AND wiki_f.ended_at IS NULL AND wiki_f.share_wiki)))`;

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
	article: articleLive,
	venue: (id, plant) => sql`EXISTS(SELECT FROM venue lv WHERE lv.id=${id} AND lv.plant_id=${plant})`,
	item: null,
	document: (id, plant) =>
		sql`EXISTS(SELECT FROM document d WHERE d.id=${id} AND d.tenant_id=${plant} AND d.kind IN ('native','core_values','church_document')
			AND (d.kind<>'church_document' OR d.archived_at IS NULL))`,
	task: (id, plant) =>
		sql`EXISTS(SELECT FROM task t WHERE t.id=${id} AND t.plant_id=${plant} AND t.deleted_at IS NULL)`,
	follow_up: (id, plant) =>
		sql`(EXISTS(SELECT FROM task t WHERE t.id=${id} AND t.plant_id=${plant} AND t.deleted_at IS NULL)
			OR EXISTS(SELECT FROM obligation o WHERE o.id=${id} AND o.plant_id=${plant}))`,
	contact: (id, plant) => sql`EXISTS(SELECT FROM contact_outcome o WHERE o.id=${id} AND o.plant_id=${plant})`,
	account: (id, plant, account) =>
		sql`(${id}=${account} OR EXISTS(SELECT FROM seat s WHERE s.account_id=${id} AND s.plant_id=${plant} AND s.ended_at IS NULL))`,
	tally: null,
	history: null,
	import: null,
	file: null,
	template: null,
	skill: null,
	activity: null,
	record: (id, plant, account) =>
		sql`(${ownerOrAdmin(plant, account)} AND (EXISTS(SELECT FROM interview live_r WHERE live_r.id=${id} AND live_r.plant_id=${plant})
			OR EXISTS(SELECT FROM four_cs live_r WHERE live_r.id=${id} AND live_r.plant_id=${plant})
			OR EXISTS(SELECT FROM commitment live_r WHERE live_r.id=${id} AND live_r.plant_id=${plant})
			OR EXISTS(SELECT FROM person live_r WHERE live_r.id=${id} AND live_r.plant_id=${plant} AND live_r.state='live')))`,
	merge: (id, plant, account) =>
		sql`(${ownerOrAdmin(plant, account)} AND (EXISTS(SELECT FROM person_merge live_m WHERE live_m.id=${id} AND live_m.tenant_id=${plant})
			OR EXISTS(SELECT FROM person live_r WHERE live_r.id=${id} AND live_r.plant_id=${plant})))`,
	correction: (id, plant, account) =>
		sql`(${ownerOrAdmin(plant, account)} AND (EXISTS(SELECT FROM record_correction live_r WHERE live_r.id=${id} AND live_r.plant_id=${plant})
			OR EXISTS(SELECT FROM audit_event live_a WHERE live_a.id=${id} AND live_a.tenant_id=${plant})))`,
	phase: null,
	criterion: null,
	signal: null,
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
	date: null,
};

export function rowLive(row: SQL, plant: SQL, account: SQL): SQL {
	const branches = (Object.keys(ROW_LIVENESS) as SourceRow["kind"][]).flatMap((kind) => {
		const rule = ROW_LIVENESS[kind];
		return rule ? [sql`WHEN ${kind} THEN ${rule(sql`(${row}->>'id')::uuid`, plant, account)}`] : [];
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
		WHERE ${rowLive(sql`r.j`, sql`${actor.owner.id}::uuid`, sql`${actor.accountId}::uuid`)}
			AND ${liveRead({ session: actor.session, owner: actor.owner, seatId: actor.seatId ?? undefined })}`);
	return new Set(r.rows.map((raw) => String((raw as { key: string }).key)));
}
