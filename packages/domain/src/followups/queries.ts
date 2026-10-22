import { instant, revision, timeZone, type Instant } from "@everyfield/contracts/common";
import * as c from "@everyfield/contracts/followups";
import * as tc from "@everyfield/contracts/tasks";
import { sql, type SQL } from "@everyfield/db/query";
import "server-only";
import { z } from "zod";
import type { RequestActor } from "../access/session.ts";
import { displayTitle } from "../meetings/rows.ts";
import { meetingType } from "@everyfield/contracts/meetings";
import { administers, parse, readerOf, type Tx } from "../tasks/core.ts";
import { dueOf, storedKind } from "../tasks/queries.ts";
import { COMMITTED, eligibleOwner, followUpTask, gated, now, OPEN, readAnswer, refuse } from "./core.ts";

const at = (d: Date) => instant.parse(d.toISOString());
const pageOf = (v: { page: number; limit: number }, total: number) => ({
	total,
	page: v.page,
	next: v.page * v.limit < total ? v.page + 1 : null,
});
function reader(authority: RequestActor, admin = false) {
	const viewer = readerOf(authority);
	if (admin && !administers(viewer)) refuse("unavailable");
	return viewer;
}
const seated = (account: SQL, plant: SQL) => sql`EXISTS(SELECT FROM seat s WHERE s.account_id=${account}
	AND s.plant_id=${plant} AND s.ended_at IS NULL AND s.accepted_at<=clock_timestamp())`;

/**
 * The church's open follow-up tasks with a live Person, as rows a caller filters further. `owner_id` is the stored
 * assignee only while they are an eligible owner: a demoted or departed assignee reads as Needs owner (REQ-TSK-012).
 */
const duties = (plantId: string, where: SQL = sql`true`) => sql`SELECT t.id, t.revision::text AS revision, t.title,
	t.status, t.due_kind, t.due_date::text AS due_date, t.due_time::text AS due_time, t.timezone, t.due_at, t.obligation_id,
	t.person_id, p.display_name AS person_label, t.assignee_id, pl.timezone AS plant_zone,
	CASE WHEN t.assignee_id IS NOT NULL AND ${eligibleOwner(sql`t.assignee_id`, sql`t.plant_id`)} THEN t.assignee_id END AS owner_id,
	coalesce(t.due_at, ((t.due_date + 1)::timestamp AT TIME ZONE pl.timezone)) AS due_key,
	(SELECT x.outcome FROM contact_outcome x WHERE x.task_id=t.id AND x.plant_id=t.plant_id AND x.voided_at IS NULL
		ORDER BY x.occurred_at DESC, x.recorded_at DESC, x.id DESC LIMIT 1) AS last_outcome
	FROM task t JOIN plant pl ON pl.id=t.plant_id
	JOIN person p ON p.id=t.person_id AND p.tenant_id=t.plant_id AND p.state='live'
	WHERE t.plant_id=${plantId}::uuid AND ${followUpTask(sql`t`)} AND t.status IN ${OPEN} AND ${where}`;
/** A duty row as JSON with its current owner's name. */
const dutyJson = (d: SQL) => sql`to_jsonb(${d}) || jsonb_build_object('owner_name',
	(SELECT display_name FROM seat_identity(${d}.owner_id)))`;
const dutyOrder = (d: SQL) => sql`${d}.due_key NULLS LAST, ${d}.id`;
const ownerTally = sql`(SELECT coalesce(jsonb_agg(jsonb_build_object('accountId',x.owner_id,'displayName',
	coalesce(x.name,''),'open',x.n) ORDER BY lower(x.name), x.owner_id),'[]') FROM (SELECT d.owner_id,
	(SELECT display_name FROM seat_identity(d.owner_id)) AS name, count(*)::int AS n FROM duty d
	WHERE d.owner_id IS NOT NULL GROUP BY d.owner_id) x)`;
const dutyRow = z.object({
	id: z.uuid(),
	revision,
	title: z.string(),
	status: tc.taskStatus,
	due_kind: z.enum(["undated", "date_only", "timed"]),
	due_date: z.string().nullable(),
	due_time: z.string().nullable(),
	timezone: z.string().nullable(),
	due_at: z.coerce.date().nullable(),
	obligation_id: z.uuid().nullable(),
	person_id: z.uuid(),
	person_label: z.string(),
	plant_zone: timeZone,
	owner_id: z.uuid().nullable(),
	owner_name: z.string().nullable(),
	last_outcome: c.outcome.nullable(),
});
function dutyOf(raw: unknown, asOf: Instant) {
	const d = dutyRow.parse(raw);
	const due = dueOf(d);
	return {
		taskId: d.id,
		revision: d.revision,
		title: d.title,
		status: d.status,
		due,
		overdue: due.kind === "undated" ? null : tc.overdueAt(due, d.plant_zone, asOf),
		obligationId: d.obligation_id,
		person: { id: d.person_id, label: d.person_label },
		owner: d.owner_id ? { accountId: d.owner_id, displayName: d.owner_name ?? "" } : null,
		lastOutcome: d.last_outcome,
	};
}
const tallyRow = z.array(z.object({ accountId: z.uuid(), displayName: z.string(), open: z.int() }));

const historyRow = z.object({
	id: z.uuid(),
	revision,
	person_id: z.uuid(),
	outcome: c.outcome,
	occurred_at: z.coerce.date(),
	recorded_at: z.coerce.date(),
	contact_channel: c.channel.nullable(),
	notes: z.string().nullable(),
	completes_task: z.boolean(),
	task_id: z.uuid().nullable(),
	obligation_id: z.uuid().nullable(),
	meeting_id: z.uuid().nullable(),
	supersedes_id: z.uuid().nullable(),
	voided_at: z.coerce.date().nullable(),
	corrected: z.boolean(),
	created: z
		.object({ actor_id: z.uuid().nullable(), name: z.string().nullable(), reason: z.string().nullable() })
		.nullable(),
	ended: z
		.object({ actor_id: z.uuid().nullable(), name: z.string().nullable(), reason: z.string().nullable() })
		.nullable(),
	corrects_reason: z.string().nullable(),
});
const actorOf = (a: { actor_id: string | null; name: string | null } | null) =>
	a?.actor_id
		? { kind: "account" as const, accountId: a.actor_id, displayName: a.name }
		: { kind: "former_account" as const };
// The first audit row of an entry made it; a later supersede or remove row withdrew it.
const event = (row: SQL, where: SQL, order: SQL) => sql`(SELECT jsonb_build_object('actor_id',a.actor_id,'name',
	(SELECT display_name FROM seat_identity(a.actor_id)),'reason',a.reason) FROM audit_event a
	WHERE a.tenant_id=${row}.plant_id AND a.subject_id=${row}.id AND ${where} ORDER BY ${order} LIMIT 1)`;

const obligationRow = z.object({
	id: z.uuid(),
	kind: storedKind,
	meeting_id: z.uuid(),
	meeting_title: z.string().nullable(),
	meeting_type: meetingType,
	vision_number: z.int().nullable(),
	person_id: z.uuid().nullable(),
	person_label: z.string().nullable(),
	origin_at: z.coerce.date(),
	origin_date: z.string(),
	timezone: z.string(),
	due_date: z.string(),
	waived_at: z.coerce.date().nullable(),
	waiver_reason: z.string().nullable(),
	state: c.obligationState,
	task_id: z.uuid().nullable(),
	task_revision: revision.nullable(),
	task_status: tc.taskStatus.nullable(),
	task_deleted: z.boolean().nullable(),
	owner_id: z.uuid().nullable(),
	owner_name: z.string().nullable(),
	completion: z.object({ id: z.uuid(), outcome: c.outcome, at: z.coerce.date() }).nullable(),
	contacted: z.boolean(),
	total: z.coerce.number().int(),
});

export const followUpReader = {
	/**
	 * A Person's contact log, newest first, with corrected and withdrawn entries kept, and the latest effective
	 * contacted instant (REQ-MTG-022). A retired Person keeps their history. Any seat. One statement.
	 */
	async listContactHistory(tx: Tx, authority: RequestActor, raw: unknown) {
		return readAnswer(async () => {
			const viewer = reader(authority),
				v = parse(c.listContactHistoryRequest, raw);
			const plant = sql`${viewer.plantId}::uuid`,
				person = sql`${v.personId}::uuid`;
			const found = await gated(
				tx,
				viewer,
				sql`SELECT 0::bigint AS ord, NULL::jsonb AS item,
					(SELECT max(x.occurred_at) FROM contact_outcome x WHERE x.plant_id=${plant} AND x.person_id=${person}
						AND x.voided_at IS NULL AND x.outcome='contacted') AS last_contact,
					(SELECT count(*)::int FROM contact_outcome x WHERE x.plant_id=${plant} AND x.person_id=${person}) AS total
				FROM person p WHERE p.id=${person} AND p.tenant_id=${plant} AND p.plant_id IS NOT NULL
				UNION ALL (SELECT row_number() OVER (ORDER BY o.occurred_at DESC, o.recorded_at DESC, o.id DESC),
					to_jsonb(o) || jsonb_build_object('revision', o.revision::text,
						'corrected', EXISTS(SELECT FROM contact_outcome n WHERE n.supersedes_id=o.id AND n.plant_id=o.plant_id),
						'created', ${event(sql`o`, sql`true`, sql`a.occurred_at, a.id`)},
						'ended', CASE WHEN o.voided_at IS NOT NULL THEN ${event(sql`o`, sql`a.kind IN ('supersede','remove')`, sql`a.occurred_at DESC, a.id DESC`)} END,
						'corrects_reason', CASE WHEN o.supersedes_id IS NOT NULL THEN ${event(sql`o`, sql`true`, sql`a.occurred_at, a.id`)}->>'reason' END),
					NULL, NULL
				FROM contact_outcome o WHERE o.plant_id=${plant} AND o.person_id=${person}
				ORDER BY 1 LIMIT ${v.limit} OFFSET ${(v.page - 1) * v.limit})`,
			);
			const [head, ...rows] = found;
			if (!head || Number(head.ord) !== 0) refuse("unavailable");
			const total = z.int().parse(head.total);
			const last = z.coerce.date().nullable().parse(head.last_contact);
			return c.contactHistory.parse({
				personId: v.personId,
				lastConfirmedContactAt: last ? at(last) : null,
				items: rows.map((raw) => {
					const r = historyRow.parse(raw.item);
					const state = r.voided_at ? (r.corrected ? "corrected" : "voided") : "effective";
					return {
						id: r.id,
						revision: r.revision,
						personId: r.person_id,
						outcome: r.outcome,
						occurredAt: at(r.occurred_at),
						recordedAt: at(r.recorded_at),
						channel: r.contact_channel,
						notes: r.notes,
						completedTask: r.completes_task,
						taskId: r.task_id,
						obligationId: r.obligation_id,
						meetingId: r.meeting_id,
						actor: actorOf(r.created),
						state,
						corrects: r.supersedes_id ? { id: r.supersedes_id, reason: r.corrects_reason } : null,
						voided: r.voided_at
							? { at: at(r.voided_at), actor: actorOf(r.ended), reason: r.ended?.reason ?? null }
							: null,
						contact: state === "effective" && r.outcome === "contacted",
					};
				}),
				...pageOf(v, total),
				completeness: "complete",
			});
		});
	},
	/**
	 * Generated meeting duties with their current state, owner, completing outcome, contact fact and 48-hour measure at
	 * asOf (REQ-MTG-021). A waived duty stays no_longer_needed through task edits and deletion. Any seat. One statement.
	 */
	async readObligations(tx: Tx, authority: RequestActor, raw: unknown) {
		return readAnswer(async () => {
			const viewer = reader(authority),
				v = parse(c.readObligationsRequest, raw);
			const asOf = v.asOf ?? now();
			const filters = [
				v.personId ? sql`o.person_id=${v.personId}::uuid` : null,
				v.meetingId ? sql`o.meeting_id=${v.meetingId}::uuid` : null,
			].filter((f) => f !== null);
			const found = await gated(
				tx,
				viewer,
				sql`SELECT q.*, count(*) OVER () AS total, row_number() OVER (ORDER BY q.origin_at DESC, q.id) AS ord FROM (
					SELECT o.id, o.kind, o.meeting_id, m.title AS meeting_title, m.type AS meeting_type, m.vision_number,
						o.person_id, p.display_name AS person_label, o.origin_at, o.origin_date::text AS origin_date, o.timezone,
						o.due_date::text AS due_date, o.waived_at, o.waiver_reason,
						CASE WHEN o.superseded_at IS NOT NULL THEN 'superseded'
							WHEN o.waived_at IS NOT NULL OR (t.deleted_at IS NULL AND t.status='no_longer_needed') THEN 'no_longer_needed'
							WHEN t.deleted_at IS NULL AND t.status='complete' THEN 'complete' ELSE 'open' END AS state,
						t.id AS task_id, t.revision::text AS task_revision, t.status AS task_status,
						t.deleted_at IS NOT NULL AS task_deleted,
						CASE WHEN t.deleted_at IS NULL AND t.assignee_id IS NOT NULL AND CASE WHEN o.kind='follow_up'
							THEN ${eligibleOwner(sql`t.assignee_id`, sql`o.plant_id`)} ELSE ${seated(sql`t.assignee_id`, sql`o.plant_id`)} END
							THEN t.assignee_id END AS owner_id,
						(SELECT display_name FROM seat_identity(t.assignee_id)) AS owner_name,
						(SELECT jsonb_build_object('id',x.id,'outcome',x.outcome,'at',x.occurred_at) FROM contact_outcome x
							WHERE x.plant_id=o.plant_id AND x.obligation_id=o.id AND x.voided_at IS NULL AND x.completes_task
							ORDER BY x.occurred_at, x.id LIMIT 1) AS completion,
						EXISTS(SELECT FROM contact_outcome x WHERE x.plant_id=o.plant_id AND x.obligation_id=o.id
							AND x.voided_at IS NULL AND x.outcome='contacted') AS contacted
					FROM obligation o JOIN meeting m ON m.id=o.meeting_id AND m.plant_id=o.plant_id
					LEFT JOIN person p ON p.id=o.person_id AND p.tenant_id=o.plant_id
					LEFT JOIN LATERAL (SELECT k.* FROM task k WHERE k.obligation_id=o.id AND k.plant_id=o.plant_id
						ORDER BY k.deleted_at NULLS FIRST, k.created_at DESC LIMIT 1) t ON true
					WHERE o.plant_id=${viewer.plantId}::uuid ${filters.length ? sql`AND ${sql.join(filters, sql` AND `)}` : sql``}) q
				${v.state === "any" ? sql`` : sql`WHERE q.state=${v.state}`}
				ORDER BY q.origin_at DESC, q.id LIMIT ${v.limit} OFFSET ${(v.page - 1) * v.limit}`,
			);
			const rows = z.array(obligationRow).parse(found);
			const total = rows[0]?.total ?? 0;
			return c.obligationPage.parse({
				asOf,
				items: rows.map((r) => {
					const completion =
						r.state === "complete" && r.completion
							? { outcomeId: r.completion.id, outcome: r.completion.outcome, occurredAt: at(r.completion.at) }
							: null;
					const originAt = at(r.origin_at);
					return {
						id: r.id,
						kind: r.kind,
						meeting: {
							id: r.meeting_id,
							label: displayTitle({ title: r.meeting_title, type: r.meeting_type, vision_number: r.vision_number }),
						},
						person: r.person_id ? { id: r.person_id, label: r.person_label ?? "" } : null,
						origin: { at: originAt, date: r.origin_date, zone: r.timezone },
						dueDate: r.due_date,
						state: r.state,
						waiver: r.waived_at ? { at: at(r.waived_at), reason: r.waiver_reason } : null,
						task: r.task_id
							? { id: r.task_id, revision: r.task_revision, status: r.task_status, deleted: r.task_deleted }
							: null,
						owner: r.owner_id ? { accountId: r.owner_id, displayName: r.owner_name ?? "" } : null,
						completion,
						contacted: r.contacted,
						measurement:
							r.kind === "first_vision_follow_up"
								? c.measure({ originAt, state: r.state, completion: completion?.occurredAt ?? null }, asOf)
								: null,
					};
				}),
				...pageOf(v, total),
				completeness: "complete",
			});
		});
	},
	/**
	 * Assignment coverage by Person (REQ-TSK-012): each live contact not yet committed, and anyone with an open
	 * follow-up, with their open follow-ups and whether they are owned, need an owner or have no explicit duty.
	 * Uncovered is not urgent work: no due date or urgency is invented. Owner/Admin. One statement.
	 */
	async followUpCoverage(tx: Tx, authority: RequestActor, raw: unknown) {
		return readAnswer(async () => {
			const viewer = reader(authority, true),
				v = parse(c.followUpCoverageRequest, raw);
			const asOf = v.asOf ?? now();
			const plant = sql`${viewer.plantId}::uuid`;
			const onePerson = (column: SQL) => (v.personId ? sql`${column}=${v.personId}::uuid` : sql`true`);
			const found = await gated(
				tx,
				viewer,
				sql`WITH duty AS MATERIALIZED (${duties(viewer.plantId, onePerson(sql`t.person_id`))}),
				people AS MATERIALIZED (SELECT p.id, p.display_name, p.stage,
					CASE WHEN NOT EXISTS(SELECT FROM duty d WHERE d.person_id=p.id) THEN 'uncovered'
						WHEN EXISTS(SELECT FROM duty d WHERE d.person_id=p.id AND d.owner_id IS NULL) THEN 'needs_owner'
						ELSE 'owned' END AS coverage
					FROM person p WHERE p.tenant_id=${plant} AND p.plant_id IS NOT NULL AND p.state='live'
					AND ${onePerson(sql`p.id`)}
					AND (p.stage IS NULL OR p.stage NOT IN ${COMMITTED} OR EXISTS(SELECT FROM duty d WHERE d.person_id=p.id))),
				matched AS MATERIALIZED (SELECT * FROM people ${v.coverage === "any" ? sql`` : sql`WHERE coverage=${v.coverage}`})
				SELECT 0::bigint AS ord, NULL::uuid AS id, NULL::text AS label, NULL::text AS stage, NULL::text AS coverage,
					NULL::jsonb AS duties, (SELECT count(*)::int FROM matched) AS total,
					(SELECT count(*)::int FROM people WHERE coverage='uncovered') AS uncovered,
					(SELECT count(*)::int FROM duty WHERE owner_id IS NULL) AS needs_owner, ${ownerTally} AS owners
				UNION ALL (SELECT row_number() OVER (ORDER BY array_position(ARRAY['needs_owner','uncovered','owned'], m.coverage),
					lower(m.display_name), m.id), m.id, m.display_name, m.stage, m.coverage,
					(SELECT coalesce(jsonb_agg(${dutyJson(sql`d`)} ORDER BY ${dutyOrder(sql`d`)}),'[]') FROM
						(SELECT * FROM duty d WHERE d.person_id=m.id ORDER BY ${dutyOrder(sql`d`)} LIMIT 20) d),
					NULL, NULL, NULL, NULL
				FROM matched m ORDER BY 1 LIMIT ${v.limit} OFFSET ${(v.page - 1) * v.limit})`,
				true,
			);
			const [head, ...rows] = found;
			const totals = z
				.object({ total: z.int(), uncovered: z.int(), needs_owner: z.int(), owners: tallyRow })
				.parse(head);
			return c.followUpCoverage.parse({
				items: rows.map((r) => {
					const row = z
						.object({
							id: z.uuid(),
							label: z.string(),
							stage: z.string().nullable(),
							coverage: z.enum(["owned", "needs_owner", "uncovered"]),
							duties: z.array(z.unknown()),
						})
						.parse(r);
					return {
						person: { id: row.id, label: row.label, stage: row.stage },
						coverage: row.coverage,
						duties: row.duties.map((d) => dutyOf(d, asOf)),
					};
				}),
				owners: totals.owners,
				needsOwner: totals.needs_owner,
				uncovered: totals.uncovered,
				...pageOf(v, totals.total),
				completeness: "complete",
			});
		});
	},
	/**
	 * Open follow-ups by current owner (REQ-TSK-012): one page of duties, the owners with their open counts and how
	 * many need an owner. A stored assignee who lost eligibility reads as Needs owner. Any seat. One statement.
	 */
	async listFollowUpOwners(tx: Tx, authority: RequestActor, raw: unknown) {
		return readAnswer(async () => {
			const viewer = reader(authority),
				v = parse(c.listFollowUpOwnersRequest, raw);
			const asOf = v.asOf ?? now();
			const person = v.personId ? sql`t.person_id=${v.personId}::uuid` : sql`true`;
			const owner =
				v.owner === undefined
					? sql`true`
					: v.owner === "needs_owner"
						? sql`d.owner_id IS NULL`
						: sql`d.owner_id=${v.owner}::uuid`;
			const found = await gated(
				tx,
				viewer,
				sql`WITH duty AS MATERIALIZED (${duties(viewer.plantId, person)}),
				matched AS MATERIALIZED (SELECT * FROM duty d WHERE ${owner})
				SELECT 0::bigint AS ord, NULL::jsonb AS duty, (SELECT count(*)::int FROM matched) AS matched,
					(SELECT count(*)::int FROM duty WHERE owner_id IS NULL) AS unassigned, ${ownerTally} AS owners
				UNION ALL (SELECT row_number() OVER (ORDER BY ${dutyOrder(sql`d`)}), ${dutyJson(sql`d`)}, NULL, NULL, NULL
				FROM matched d ORDER BY 1 LIMIT ${v.limit} OFFSET ${(v.page - 1) * v.limit})`,
			);
			const [head, ...rows] = found;
			const totals = z.object({ matched: z.int(), unassigned: z.int(), owners: tallyRow }).parse(head);
			return c.followUpOwners.parse({
				items: rows.map((r) => dutyOf(r.duty, asOf)),
				owners: totals.owners,
				unassigned: totals.unassigned,
				matched: totals.matched,
				page: v.page,
				next: v.page * v.limit < totals.matched ? v.page + 1 : null,
				completeness: "complete",
			});
		});
	},
	/**
	 * Preview a handoff (REQ-TSK-013): the account's open follow-ups with their revisions, whether it is still eligible
	 * or holds the Owner seat, and the current eligible recipients. Changes nothing. Owner/Admin. One statement.
	 */
	async planHandoff(tx: Tx, authority: RequestActor, raw: unknown) {
		return readAnswer(async () => {
			const viewer = reader(authority, true),
				v = parse(c.planHandoffRequest, raw);
			const plant = sql`${viewer.plantId}::uuid`,
				from = sql`${v.fromAccountId}::uuid`;
			const found = await gated(
				tx,
				viewer,
				sql`WITH duty AS MATERIALIZED (${duties(viewer.plantId, sql`t.assignee_id=${from}`)})
				SELECT 0::bigint AS ord, NULL::jsonb AS duty,
					(SELECT display_name FROM seat_identity(${from})) AS name, ${eligibleOwner(from, plant)} AS eligible,
					EXISTS(SELECT FROM seat s WHERE s.account_id=${from} AND s.plant_id=${plant} AND s.role='owner'
						AND s.ended_at IS NULL) AS protected,
					(SELECT count(*)::int FROM duty) AS total,
					(SELECT coalesce(jsonb_agg(jsonb_build_object('accountId',r.account_id,'displayName',r.name)
						ORDER BY lower(r.name), r.account_id),'[]') FROM (SELECT s.account_id, i.display_name AS name FROM seat s
						CROSS JOIN LATERAL seat_identity(s.account_id) i WHERE s.plant_id=${plant} AND s.account_id<>${from}
						AND ${eligibleOwner(sql`s.account_id`, plant)} AND s.ended_at IS NULL LIMIT 500) r) AS recipients
				FROM (SELECT 1) seed WHERE EXISTS(SELECT FROM seat s WHERE s.account_id=${from} AND s.plant_id=${plant})
				UNION ALL (SELECT row_number() OVER (ORDER BY ${dutyOrder(sql`d`)}), ${dutyJson(sql`d`)}, NULL, NULL, NULL,
					NULL, NULL FROM duty d ORDER BY 1 LIMIT 1000)`,
				true,
			);
			const [head, ...rows] = found;
			// Only an account that has held a seat in this church can be the source; others reveal nothing.
			if (!head || Number(head.ord) !== 0) refuse("unavailable");
			const plan = z
				.object({
					name: z.string().nullable(),
					eligible: z.boolean(),
					protected: z.boolean(),
					total: z.int(),
					recipients: z.array(z.object({ accountId: z.uuid(), displayName: z.string() })),
				})
				.parse(head);
			const asOf = now();
			return c.handoffPlan.parse({
				from: {
					accountId: v.fromAccountId,
					displayName: plan.name,
					eligible: plan.eligible,
					protectedOwner: plan.protected,
				},
				duties: rows.map((r) => dutyOf(r.duty, asOf)),
				total: plan.total,
				recipients: plan.recipients,
			});
		});
	},
};
