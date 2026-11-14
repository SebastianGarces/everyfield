import type { Database } from "@everyfield/db/client";
import { sql, type SQL } from "@everyfield/db/query";
import { liveRead } from "@everyfield/domain/access";
import type { EvryActor } from "../context/actor.ts";
import type { SourceRow } from "../catalog/types.ts";

/**
 * Whether a result row's source still exists, one rule per row kind. `id` is the row id as uuid text, `plant` the
 * conversation's plant (this product keeps tenant and plant equal) and `account` the conversation's account. A rule is
 * `null` when the kind is not a stored source: such a row is never withheld. Replay (retained.ts) and the in-turn check
 * (turn.ts) both build from this map.
 */
type Rule = ((id: SQL, plant: SQL, account: SQL) => SQL) | null;
/**
 * The assessment area (interviews, 4 C's, commitments, merges, corrections) is for the church's Owners and Admins: its
 * rows stay only while the conversation's account still holds such a seat, so a seat moved to Member never sees them
 * again, in replay or in a later model call. Its own aliases (live_*) never capture a caller's alias.
 */
const ownerOrAdmin = (plant: SQL, account: SQL) =>
	sql`EXISTS(SELECT FROM seat live_s WHERE live_s.account_id=${account} AND live_s.plant_id=${plant} AND live_s.ended_at IS NULL
		AND live_s.accepted_at<=clock_timestamp() AND live_s.role<>'member')`;

/**
 * A Wiki revision is live while the church's Wiki can still show it: a global revision of the active release, or the
 * current published version of a sending church or network the church still shares its Wiki with. Once that
 * connection ends, or the organization hides or replaces its version, the quoted text is withheld (GAP-EVR-418). Its
 * aliases are its own: the replay query around it already names `r`, `e` and `t`.
 */
export const articleLive = (id: SQL, plant: SQL) =>
	sql`EXISTS(SELECT FROM article_revision wiki_r WHERE wiki_r.id=${id} AND (
		(wiki_r.tenant_id='00000000-0000-0000-0000-000000000000'::uuid
			AND wiki_r.release_id=(SELECT wiki_a.release_id FROM reference_activation wiki_a ORDER BY wiki_a.activation_number DESC LIMIT 1))
		OR EXISTS(SELECT FROM article_editor_state wiki_e JOIN affiliation wiki_f ON wiki_f.organization_id=wiki_e.organization_id
			WHERE wiki_e.current_revision_id=wiki_r.id AND wiki_e.organization_id=wiki_r.tenant_id AND wiki_e.state='published'
				AND wiki_f.plant_id=${plant} AND wiki_f.ended_at IS NULL AND wiki_f.share_wiki)))`;

const ROW_LIVENESS: Record<SourceRow["kind"], Rule> = {
	// The person is live in this church, or in this organization's pipeline.
	person: (id, plant) =>
		sql`EXISTS(SELECT FROM person p WHERE p.id=${id} AND p.tenant_id=${plant} AND coalesce(p.plant_id,p.organization_id)=${plant} AND p.state='live')`,
	// A household table has no state column: the row existing in the plant is the test.
	household: (id, plant) => sql`EXISTS(SELECT FROM household h WHERE h.id=${id} AND h.plant_id=${plant})`,
	// A tag is live while it exists in the plant.
	tag: (id, plant) => sql`EXISTS(SELECT FROM tag t WHERE t.id=${id} AND t.plant_id=${plant})`,
	// A message is live while it exists in the church.
	message: (id, plant) => sql`EXISTS(SELECT FROM communication m WHERE m.id=${id} AND m.plant_id=${plant})`,
	// A notice is live while the bell can still show it: not cancelled or archived. The read that returned it was the
	// account's own, and the in-turn check repeats the live access check.
	notice: (id) =>
		sql`EXISTS(SELECT FROM notice n WHERE n.id=${id} AND n.cancelled_at IS NULL AND n.archived_at IS NULL)`,
	// A ministry, role, training program, meeting or responsibility is live while it exists in the church (an archived
	// ministry or a retired role still exists and is shown as such). Each alias is its own: the replay check names the
	// row being checked `r`, so a rule's table alias must never shadow it.
	team: (id, plant) => sql`EXISTS(SELECT FROM team lt WHERE lt.id=${id} AND lt.plant_id=${plant})`,
	role: (id, plant) => sql`EXISTS(SELECT FROM team_role lr WHERE lr.id=${id} AND lr.plant_id=${plant})`,
	training: (id, plant) => sql`EXISTS(SELECT FROM training_program lg WHERE lg.id=${id} AND lg.plant_id=${plant})`,
	meeting: (id, plant) =>
		sql`EXISTS(SELECT FROM meeting lm WHERE lm.id=${id} AND lm.plant_id=${plant} AND lm.retired_at IS NULL)`,
	responsibility: (id, plant) =>
		sql`EXISTS(SELECT FROM responsibility ls WHERE ls.id=${id} AND ls.plant_id=${plant} AND ls.removed_at IS NULL)`,
	article: articleLive,
	// A venue is live while it exists in the church, archived or not.
	venue: (id, plant) => sql`EXISTS(SELECT FROM venue lv WHERE lv.id=${id} AND lv.plant_id=${plant})`,
	// Never withheld: an item row is a part of a meeting or venue read (an agenda section, a kit item, a report line).
	item: null,
	// Never withheld: an import row is a CSV line number or a preview's own row, not a stored record. A file row is a
	// digest, a receipt key or a name the tool computed, and an activity or skill row is a safe detail of a person that
	// the tool read under that person's own access; none of them names a source that this check could find gone.
	// A task, or a follow-up named by its task or (with no task) its obligation, is live while it is not deleted.
	task: (id, plant) =>
		sql`EXISTS(SELECT FROM task t WHERE t.id=${id} AND t.plant_id=${plant} AND t.deleted_at IS NULL)`,
	follow_up: (id, plant) =>
		sql`(EXISTS(SELECT FROM task t WHERE t.id=${id} AND t.plant_id=${plant} AND t.deleted_at IS NULL)
			OR EXISTS(SELECT FROM obligation o WHERE o.id=${id} AND o.plant_id=${plant}))`,
	// A recorded outcome stays in the log, corrected or withdrawn: it is live while it exists.
	contact: (id, plant) => sql`EXISTS(SELECT FROM contact_outcome o WHERE o.id=${id} AND o.plant_id=${plant})`,
	// An account is live while it holds a current seat in the church.
	account: (id, plant) =>
		sql`EXISTS(SELECT FROM seat s WHERE s.account_id=${id} AND s.plant_id=${plant} AND s.ended_at IS NULL)`,
	// A tally and a status change are computed or audit facts, never a source that can go.
	tally: null,
	history: null,
	import: null,
	file: null,
	// A system template is not a stored row, and a church template's name and origin are all a row says.
	template: null,
	skill: null,
	activity: null,
	// A recorded interview, 4 C's assessment or commitment card, or the person's current commitment.
	record: (id, plant, account) =>
		sql`(${ownerOrAdmin(plant, account)} AND (EXISTS(SELECT FROM interview live_r WHERE live_r.id=${id} AND live_r.plant_id=${plant})
			OR EXISTS(SELECT FROM four_cs live_r WHERE live_r.id=${id} AND live_r.plant_id=${plant})
			OR EXISTS(SELECT FROM commitment live_r WHERE live_r.id=${id} AND live_r.plant_id=${plant})
			OR EXISTS(SELECT FROM person live_r WHERE live_r.id=${id} AND live_r.plant_id=${plant} AND live_r.state='live')))`,
	// A merge review names a person (live or merged); an Unmerge preview names its merge.
	merge: (id, plant, account) =>
		sql`(${ownerOrAdmin(plant, account)} AND (EXISTS(SELECT FROM person_merge live_m WHERE live_m.id=${id} AND live_m.tenant_id=${plant})
			OR EXISTS(SELECT FROM person live_r WHERE live_r.id=${id} AND live_r.plant_id=${plant})))`,
	// A field correction is a plant history row; a card's date, kind or void correction is its audit row.
	correction: (id, plant, account) =>
		sql`(${ownerOrAdmin(plant, account)} AND (EXISTS(SELECT FROM record_correction live_r WHERE live_r.id=${id} AND live_r.plant_id=${plant})
			OR EXISTS(SELECT FROM audit_event live_a WHERE live_a.id=${id} AND live_a.tenant_id=${plant})))`,
	// A phase, criterion or signal row is reference metadata or an append-only journey or attestation entry of the
	// church itself, read under the Owner or Admin floor (adapters/intelligence); none is ever removed.
	phase: null,
	criterion: null,
	signal: null,
	// Never withheld: a seat, an invitation or a connection is the church's own access setting, which the person asking
	// changes themselves through reviews; an answer that named one stays readable after the change.
	seat: null,
	invitation: null,
	connection: null,
	// Never withheld: a setup step is an answer the person gives themselves, and a Discovery relationship is the
	// account's own link, read under its own access.
	step: null,
	relationship: null,
	// Never withheld: a pipeline stage row is a column of the board, with its count.
	stage: null,
	// Never withheld: a setting row is the account's own choice and a digest row a preview the tool computed.
	setting: null,
	digest: null,
	// A date row is the calendar's own answer about a local time, not a stored record.
	date: null,
};

/**
 * A SQL boolean for one result row, `row` being a jsonb `{kind,id,...}`. The uuid cast sits inside its kind's branch, so
 * a non-uuid id of a never-withheld kind (a CSV line, a digest) is never cast.
 */
export function rowLive(row: SQL, plant: SQL, account: SQL): SQL {
	const branches = (Object.keys(ROW_LIVENESS) as SourceRow["kind"][]).flatMap((kind) => {
		const rule = ROW_LIVENESS[kind];
		return rule ? [sql`WHEN ${kind} THEN ${rule(sql`(${row}->>'id')::uuid`, plant, account)}`] : [];
	});
	return sql`(CASE (${row}->>'kind') ${sql.join(branches, sql` `)} ELSE true END)`;
}

/**
 * The `kind:id` keys of these rows that are live for the actor now: the in-turn form of the same rule, for a seat in a
 * church or an organization. One statement for every row of a model call, carrying the lock-free live access check
 * (C27), so an actor who lost access since the last tool call keeps no row, whatever its kind.
 */
export async function liveRowKeys(
	db: Pick<Database, "execute">,
	actor: EvryActor,
	rows: readonly { kind: string; id: string }[],
): Promise<Set<string>> {
	// Any seat's rows are checked: a church seat's sources are rows of its church, and an organization seat's prepared
	// review of its own profile is never withheld. An account context's rows are its own setup and Discovery rows, kept
	// while its session is live.
	if (!rows.length) return new Set();
	const r = await db.execute(sql`
		SELECT r.key FROM jsonb_to_recordset(${JSON.stringify(rows)}::jsonb) AS x(kind text,id text)
		CROSS JOIN LATERAL (SELECT x.kind||':'||x.id AS key, jsonb_build_object('kind',x.kind,'id',x.id) AS j) r
		WHERE ${rowLive(sql`r.j`, sql`${actor.owner.id}::uuid`, sql`${actor.accountId}::uuid`)}
			AND ${liveRead({ session: actor.session, owner: actor.owner, seatId: actor.seatId ?? undefined })}`);
	return new Set(r.rows.map((raw) => String((raw as { key: string }).key)));
}
