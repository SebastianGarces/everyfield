import { inArray, ne, count, and, asc, eq, gt, lte, isNull, or, sql, getTableColumns } from "@everyfield/db/query";
import type { SQL } from "@everyfield/db/query";
import * as tables from "@everyfield/db/tables";
import { alias } from "@everyfield/db/columns";
import { z } from "zod";
import * as c from "@everyfield/contracts/people";
import type { PeopleReader } from "@everyfield/contracts/people";
import {
	authorizeRead,
	canReadPerson,
	deny,
	hash,
	parse,
	person,
	personRow,
	project,
	projectPeople,
	readReply,
	type Person,
} from "./core.ts";
import type { RequestActor } from "../access/session.ts";
import { revision } from "@everyfield/contracts/common";
import type { Tx, Context } from "./core.ts";
const task_t = alias(tables.task, "t");
const plant_p = alias(tables.plant, "p");
const obligation_o = alias(tables.obligation, "o");
const activityRow = z.object({
	id: z.uuid(),
	occurred_at: z.coerce.date(),
	recorded_at: z.coerce.date(),
	actor_id: z.uuid().nullable(),
	revision: z.string(),
	body: z.string().nullable(),
	edited_at: z.coerce.date().nullable(),
	removed_at: z.coerce.date().nullable(),
	kind: z.string(),
	action: z.string().nullable(),
	before_value: z
		.object({ stage: c.stage.nullable().optional(), membership: c.householdMembership.nullable().optional() })
		.nullable(),
	after_value: z
		.object({ stage: c.stage.nullable().optional(), membership: c.householdMembership.nullable().optional() })
		.nullable(),
	obligation_id: z.uuid().nullable(),
	outcome: z.string().nullable(),
	record_id: z.uuid().nullable(),
	actor_exists: z.boolean(),
});
const warningsRow = z.object({
	review: z.string(),
	assessment: z.boolean(),
	interview: z.boolean(),
	committed: z.boolean(),
	duties: z.array(z.object({ id: z.uuid(), revision: z.string() })),
});
/** Row filters for one People query, with the reader's C13 gate. The list, the pipeline and the CSV export share them. */
export function peopleFilters(
	ctx: Pick<Context, "selected">,
	input: Omit<z.infer<typeof c.listPeopleRequest>, "page" | "limit" | "view" | "sort">,
	gate: SQL,
) {
	const filters = [eq(tables.person.plant_id, ctx.selected.id), gate];
	if (input.archived === "exclude") filters.push(eq(tables.person.state, "live"));
	else if (input.archived === "only") filters.push(ne(tables.person.state, "live"));
	if (input.search) {
		const term = input.search.toLowerCase();
		filters.push(
			sql`(strpos(lower(${tables.person.display_name}),${term})>0 OR strpos(lower(coalesce(${tables.person.email},'')),${term})>0 OR strpos(lower(coalesce(${tables.person.phone},'')),${term})>0)`,
		);
	}
	if (input.stages.length) filters.push(inArray(tables.person.stage, input.stages));
	if (input.sources.length) filters.push(inArray(tables.person.source, input.sources));
	if (input.tags.length)
		filters.push(
			sql`NOT EXISTS(SELECT unnest(${sql.param(input.tags)}::uuid[]) EXCEPT SELECT tag_id FROM person_tag WHERE person_id=${tables.person.id} AND plant_id=${tables.person.plant_id})`,
		);
	if (input.adultClassification) filters.push(eq(tables.person.adult_classification, input.adultClassification));
	if (input.commitment !== "any")
		filters.push(
			sql`(CASE WHEN EXISTS(SELECT FROM commitment e JOIN plant pl ON pl.id=e.plant_id WHERE e.plant_id=${tables.person.plant_id} AND e.person_id=${tables.person.id} AND e.voided_at IS NULL AND e.signed_on<=(clock_timestamp() AT TIME ZONE pl.timezone)::date) THEN ${tables.person.commitment_state} ELSE 'unknown' END)=${input.commitment}`,
		);
	return filters;
}
async function list(tx: Tx, ctx: Context, raw: unknown) {
	if (ctx.selected.kind !== "plant") deny();
	const input = parse(c.listPeopleRequest, raw);
	const { gate } = await authorizeRead(tx, ctx);
	const filters = peopleFilters(ctx, input, gate);
	// The count always returns one row, so it also says whether the reader still has access.
	const { total, allowed } = (
		await tx
			.select({ total: count(), allowed: sql<boolean>`${gate}` })
			.from(tables.person)
			.where(and(...filters))
	)[0]!;
	if (!allowed) deny();
	const result = await tx
		.select(getTableColumns(tables.person))
		.from(tables.person)
		.where(and(...filters))
		.orderBy(
			...(input.view === "pipeline" ? [asc(tables.person.pipeline_position)] : []),
			asc(tables.person.created_at),
			asc(tables.person.id),
		)
		.limit(input.limit + 1)
		.offset((input.page - 1) * input.limit);

	const rows = result.slice(0, input.limit).map((r) => personRow.parse(r));
	const items = await projectPeople(tx, ctx, rows, gate),
		more = result.length > input.limit;
	return c.peoplePage.parse({
		owner: ctx.selected,
		items,
		total,
		next: more ? input.page + 1 : null,
		completeness: more ? "partial" : "complete",
	});
}
const columnStages = (column: z.infer<typeof c.pipelineColumn>): z.infer<typeof c.stage>[] =>
	column === "core_group" ? ["core_group", "launch_team", "leader"] : [column];
export const peopleReader: PeopleReader<Tx> = {
	async getPerson(tx, ctx, raw) {
		return readReply(async () => {
			const input = parse(c.personRequest, raw);
			const { actor, gate } = await authorizeRead(tx, ctx);
			const p = await person(tx, ctx, input.personId, gate);
			await canReadPerson(tx, ctx, p, actor);
			return c.personResult.parse({
				status: "available",
				person: await project(tx, ctx, p, gate),
			});
		});
	},
	async listPeople(tx, ctx, raw) {
		return readReply(() => list(tx, ctx, raw));
	},
	async getOwnAccountPerson(tx, ctx, raw) {
		return readReply(async () => {
			parse(c.ownAccountPersonRequest, raw);
			const { actor, gate } = await authorizeRead(tx, ctx);
			// The gate row is always present, so a refused reader and an unlinked one stay distinct.
			const r = await tx.execute(sql`SELECT g.allowed,p.id FROM (SELECT ${gate} AS allowed) g
 LEFT JOIN person p ON g.allowed AND p.tenant_id=${ctx.selected.id}::uuid AND p.linked_account_id=${actor.accountId}::uuid
 AND p.state='live'`);
			const row = z.object({ allowed: z.boolean(), id: z.uuid().nullable() }).parse(r.rows[0]);
			if (!row.allowed) deny();
			return c.accountLinkResult.parse(row.id ? { status: "linked", personId: row.id } : { status: "unlinked" });
		});
	},
	async getStatusWarnings(tx, ctx, raw) {
		return readReply(async () => {
			if (ctx.selected.kind !== "plant") deny();
			const input = parse(c.personRequest, raw);
			const { actor, gate } = await authorizeRead(tx, ctx);
			const p = await person(tx, ctx, input.personId, gate);
			await canReadPerson(tx, ctx, p, actor);
			// One read, no locks: the dialog needs three booleans, the review revision and the open duties.
			const result = await tx.execute(sql`SELECT pl.material_revision::text AS review,
      EXISTS(SELECT FROM four_cs f WHERE f.person_id=${p.id} AND f.plant_id=${ctx.selected.id}) AS assessment,
      EXISTS(SELECT FROM interview i WHERE i.person_id=${p.id} AND i.plant_id=${ctx.selected.id}) AS interview,
      (${p.commitment_state === "active"} AND EXISTS(SELECT FROM commitment e WHERE e.plant_id=${ctx.selected.id} AND e.person_id=${p.id} AND e.voided_at IS NULL)) AS committed,
      coalesce((SELECT jsonb_agg(jsonb_build_object('id',t.id,'revision',t.revision::text) ORDER BY t.id) FROM task t
        WHERE t.plant_id=${ctx.selected.id} AND (t.person_id=${p.id} OR t.assignee_id=${p.linked_account_id}::uuid)
        AND t.deleted_at IS NULL AND t.status NOT IN ('complete','no_longer_needed')),'[]'::jsonb) AS duties
      FROM plant pl WHERE pl.id=${ctx.selected.id} AND ${gate}`);
			if (!result.rows[0]) deny();
			const row = warningsRow.parse(result.rows[0]);
			return c.statusWarningsResult.parse({
				personId: p.id,
				revision: p.revision,
				reviewRevision: row.review,
				openDuties: row.duties,
				warnings: [
					// REQ-PPL-012: advisory only; the stage command never requires an assessment.
					...(!row.assessment ? ["assessment_not_recorded"] : []),
					...(!row.interview ? ["interview_not_recorded"] : []),
					...(!row.committed ? ["commitment_not_recorded"] : []),
					...(row.duties.length ? ["open_duties"] : []),
				],
				allowedStages: c.stage.options,
				hardGate: false,
			});
		});
	},
	async getPipelineData(tx, ctx, raw) {
		return readReply(async () => {
			const input = parse(c.listPeopleRequest, raw);
			if (ctx.selected.kind !== "plant") deny();
			const { gate } = await authorizeRead(tx, ctx);
			// The page read takes all five columns; "Show more" names one and reads only that one.
			const columns: readonly z.infer<typeof c.pipelineColumn>[] = input.column
				? [input.column]
				: c.pipelineColumn.options;
			const stages = columns.flatMap((column) =>
				input.stages.length ? input.stages.filter((s) => columnStages(column).includes(s)) : columnStages(column),
			);
			// The gate row is always present, so a refused reader and a church without saved columns stay distinct.
			const saved = await tx.execute(sql`SELECT g.allowed,pc.column_name AS column,pc.revision::text AS revision
 FROM (SELECT ${gate} AS allowed) g LEFT JOIN people_column pc ON g.allowed AND pc.plant_id=${ctx.selected.id}::uuid`);
			if (saved.rows[0]?.allowed !== true) deny();
			const revisions = z
				.array(z.object({ column: z.string().nullable(), revision: z.string().nullable() }))
				.parse(saved.rows)
				.filter((r) => r.column !== null);
			// One window over every read column: each row carries its column, its rank in that column and the column total.
			const column = sql<string>`CASE WHEN ${tables.person.stage} IN ('core_group','launch_team','leader') THEN 'core_group' ELSE ${tables.person.stage} END`;
			const window = tx
				.select({
					...getTableColumns(tables.person),
					pipeline_column: column.as("pipeline_column"),
					rank: sql<number>`(row_number() OVER (PARTITION BY ${column} ORDER BY ${tables.person.pipeline_position}, ${tables.person.created_at}, ${tables.person.id}))::int`.as(
						"rank",
					),
					total: sql<number>`(count(*) OVER (PARTITION BY ${column}))::int`.as("total"),
				})
				.from(tables.person)
				.where(and(...peopleFilters(ctx, { ...input, archived: "exclude", stages }, gate)))
				.as("w");
			const offset = (input.page - 1) * input.limit,
				last = offset + input.limit;
			// Each column's first row rides along so that a page past the end still reports the column total.
			const rows = stages.length
				? await tx
						.select()
						.from(window)
						.where(or(eq(window.rank, 1), and(gt(window.rank, offset), lte(window.rank, last + 1))))
						.orderBy(asc(window.pipeline_column), asc(window.rank))
				: [];
			const people = await projectPeople(
				tx,
				ctx,
				rows.filter((r) => r.rank > offset && r.rank <= last).map((r) => personRow.parse(r)),
				gate,
			);
			const projected = new Map<string, (typeof people)[number]>(people.map((p) => [p.id, p]));
			const groups = c.pipelineColumn.options.map((name) => {
				const revision = revisions.find((r) => r.column === name)?.revision ?? "1";
				if (!columns.includes(name)) return { column: name, revision, cards: [], total: null, next: null };
				const own = rows.filter((r) => r.pipeline_column === name),
					page = own.filter((r) => r.rank > offset);
				return {
					column: name,
					revision,
					cards: page.slice(0, input.limit).map((r) => projected.get(r.id)!),
					total: own[0]?.total ?? 0,
					next: page.length > input.limit ? input.page + 1 : null,
				};
			});
			const ids = groups.flatMap((g) => g.cards.map((p) => p.id));
			// Limit each person's duties independently, including the overflow witness.
			const duties = tx
				.select({ id: task_t.id, due_date: task_t.due_date })
				.from(task_t)
				.leftJoin(
					obligation_o,
					and(eq(obligation_o.id, task_t.obligation_id), eq(obligation_o.plant_id, task_t.plant_id)),
				)
				.where(
					and(
						eq(task_t.plant_id, ctx.selected.id),
						eq(task_t.person_id, tables.person.id),
						isNull(task_t.parent_id),
						isNull(task_t.deleted_at),
						sql<boolean>`${task_t.status} NOT IN ('complete', 'no_longer_needed')`,
						or(isNull(task_t.obligation_id), and(isNull(obligation_o.waived_at), isNull(obligation_o.superseded_at))),
					),
				)
				.orderBy(asc(task_t.id))
				.limit(101)
				.as("duties");
			// REQ-PPL-007 (WP-023): the latest recorded activity the Person's history shows, against the church's
			// inactivity days in Settings. New activity clears the warning.
			const lastActivity = sql`greatest(${tables.person.created_at},
				(SELECT max(n.occurred_at) FROM person_note n WHERE n.tenant_id=${tables.person.tenant_id} AND n.person_id=${tables.person.id}),
				(SELECT max(a.occurred_at) FROM audit_event a WHERE a.tenant_id=${tables.person.tenant_id} AND a.subject_id=${tables.person.id} AND a.kind<>'noop'),
				(SELECT max(x.occurred_at) FROM contact_outcome x WHERE x.plant_id=${tables.person.tenant_id} AND x.person_id=${tables.person.id} AND x.voided_at IS NULL))`;
			const cards = ids.length
				? await tx
						.select({
							personId: tables.person.id,
							id: duties.id,
							due_date: duties.due_date,
							today: sql<string>`(clock_timestamp() AT TIME ZONE ${plant_p.timezone})::date`,
							lastActivity: sql<string>`to_json(${lastActivity})#>>'{}'`,
							inactivity: sql<"none" | "warning" | "alert">`CASE
								WHEN clock_timestamp()-${lastActivity} > make_interval(days => ${plant_p.alert_days}) THEN 'alert'
								WHEN clock_timestamp()-${lastActivity} > make_interval(days => ${plant_p.warning_days}) THEN 'warning'
								ELSE 'none' END`,
						})
						.from(tables.person)
						.innerJoin(plant_p, eq(plant_p.id, tables.person.plant_id))
						.leftJoinLateral(duties, sql`true`)
						.where(and(eq(tables.person.plant_id, ctx.selected.id), inArray(tables.person.id, ids), gate))
						.orderBy(asc(duties.id))
				: [];
			const activity = new Map(
				cards.map((r) => [r.personId, { lastActivityAt: new Date(r.lastActivity).toISOString(), level: r.inactivity }]),
			);
			const tasks = cards.flatMap((r) => (r.id === null ? [] : [{ ...r, id: r.id }]));
			const byPerson = new Map<string, typeof tasks>();
			for (const task of tasks) {
				const own = byPerson.get(task.personId) ?? [];
				own.push(task);
				if (own.length > 100) deny("source_unavailable");
				byPerson.set(task.personId, own);
			}
			return c.pipelineResult.parse({
				owner: ctx.selected,
				groups: groups.map((g) => ({
					...g,
					cards: g.cards.map((person) => {
						const tasks = byPerson.get(person.id) ?? [];
						return {
							person,
							activeParentDuties: tasks.map((t) => ({
								id: t.id,
								dueOn: t.due_date ?? null,
								warning: !t.due_date ? "missing_due_date" : t.due_date < t.today ? "overdue" : "none",
							})),
							coverage: tasks.length ? "covered" : "uncovered",
							inactivity: activity.get(person.id)!,
						};
					}),
				})),
				completeness: groups.some((g) => g.next) ? "partial" : "complete",
			});
		});
	},
	async getActivities(tx, ctx, raw) {
		return readReply(async () => {
			if (ctx.selected.kind !== "plant") deny();
			const input = parse(c.activityRequest, raw);
			const { actor, gate } = await authorizeRead(tx, ctx);
			const p = await person(tx, ctx, input.personId, gate);
			await canReadPerson(tx, ctx, p, actor);
			return activities(tx, ctx, p, input, gate);
		});
	},
};
/**
 * One statement: notes, audit events and follow-ups in one window, with the actor account joined for attribution. The
 * history of people merged into this one shows here too (REQ-PPL-025).
 */
async function activities(tx: Tx, ctx: Context, p: Person, input: z.infer<typeof c.activityRequest>, gate: SQL) {
	const result = await tx.execute(sql`SELECT ${activitiesJson(ctx, sql`${p.id}::uuid`, input, gate)} AS rows`);
	return activityFeed(ctx, p.id, input, result.rows[0]?.rows);
}
/**
 * One page of a Person's activity as one JSON array, the window's rows plus one that says whether more follow. A scalar
 * subquery: `personId` may name the outer `person`.
 */
export function activitiesJson(ctx: Context, personId: SQL, input: z.infer<typeof c.activityRequest>, gate: SQL) {
	return sql`(SELECT coalesce(jsonb_agg(jsonb_build_object('id',a.id,'occurred_at',a.occurred_at,'recorded_at',a.recorded_at,
 'actor_id',a.actor_id,'revision',a.revision::text,'body',a.body,'edited_at',a.edited_at,'removed_at',a.removed_at,'kind',a.kind,
 'action',a.action,'before_value',a.before_value,'after_value',a.after_value,'obligation_id',a.obligation_id,'outcome',a.outcome,
 'record_id',a.record_id,'actor_exists',EXISTS(SELECT FROM account WHERE id=a.actor_id)) ORDER BY a.occurred_at,a.id),'[]') FROM (SELECT * FROM (
      SELECT id,occurred_at,recorded_at,author_id AS actor_id,revision,body,edited_at,removed_at,'note' AS category,'note' AS kind,NULL::text AS action,NULL::jsonb AS before_value,NULL::jsonb AS after_value,NULL::uuid AS obligation_id,NULL::text AS outcome,NULL::uuid AS record_id FROM person_note WHERE tenant_id=${sql.param(ctx.selected.id)} AND person_id=${personId}
      UNION ALL
      SELECT id,occurred_at,recorded_at,actor_id,after_revision AS revision,NULL,NULL,NULL,'activity',CASE WHEN metadata ? 'event' THEN 'record' WHEN action='people.stage_changed' THEN 'stage_changed' WHEN coalesce(before_value ? 'membership' OR after_value ? 'membership',false) THEN 'household_changed' ELSE 'activity' END,coalesce(metadata->>'event',action),CASE WHEN action='people.stage_changed' AND NOT coalesce(before_value ? 'stage',false) THEN jsonb_build_object('stage',(SELECT prev.after_value->'stage' FROM audit_event prev WHERE prev.subject_id=h.subject_id AND prev.tenant_id=h.tenant_id AND prev.after_revision<=h.after_revision AND prev.after_value ? 'stage' ORDER BY prev.after_revision DESC,prev.occurred_at DESC,prev.id DESC LIMIT 1)) ELSE before_value END,CASE WHEN action='people.stage_changed' AND NOT coalesce(after_value ? 'stage',false) THEN jsonb_build_object('stage',(SELECT prev.after_value->'stage' FROM audit_event prev WHERE prev.subject_id=h.subject_id AND prev.tenant_id=h.tenant_id AND prev.after_revision<=h.after_revision AND prev.after_value ? 'stage' ORDER BY prev.after_revision DESC,prev.occurred_at DESC,prev.id DESC LIMIT 1)) ELSE after_value END,NULL,NULL,(metadata->>'recordId')::uuid FROM audit_event h WHERE metadata->>'category' IS DISTINCT FROM 'note' AND kind<>'noop' AND tenant_id=${sql.param(ctx.selected.id)} AND subject_id IN (SELECT ${personId} UNION ALL SELECT m.id FROM person m WHERE m.merged_into_person_id=${personId} AND m.tenant_id=${sql.param(ctx.selected.id)}) AND action IN ('people.created','people.updated','people.retired','people.restored','people.stage_changed','people.recorded','people.corrected','people.merged','people.unmerged')
      UNION ALL
      SELECT id,occurred_at,recorded_at,(SELECT actor_id FROM audit_event WHERE subject_id=contact_outcome.id ORDER BY recorded_at,id LIMIT 1),revision,notes,NULL,NULL,'follow_up','follow_up',contact_channel,NULL,NULL,obligation_id,outcome,NULL FROM contact_outcome WHERE plant_id=${sql.param(ctx.selected.id)} AND person_id=${personId} AND voided_at IS NULL
    ) x WHERE ${gate} AND category=ANY(${sql.param(input.kinds ?? ["note", "activity", "follow_up"])}) ORDER BY occurred_at,id LIMIT ${sql.param(input.limit + 1)} OFFSET ${sql.param((input.page - 1) * input.limit)}) a)`;
}
export function activityFeed(ctx: Context, personId: string, input: z.infer<typeof c.activityRequest>, raw: unknown) {
	const found = z.array(z.unknown()).parse(raw);
	const rows = found.slice(0, input.limit).map((row) => activityRow.parse(row)),
		items = [];
	const actions: Record<string, string> = {
		"people.created": "created",
		"people.updated": "updated",
		"people.retired": "retired",
		"people.restored": "restored",
		"people.recorded": "classification_recorded",
		"people.corrected": "classification_corrected",
	};
	for (const r of rows) {
		const base = {
			id: r.id,
			occurredAt: r.occurred_at.toISOString(),
			recordedAt: r.recorded_at.toISOString(),
			actor:
				r.actor_id && r.actor_exists
					? { kind: "current_account", accountId: r.actor_id }
					: { kind: "former_account", scopeLocalToken: hash([ctx.selected.id, r.id]) },
		};
		if (r.kind === "note")
			items.push({
				...base,
				kind: r.removed_at ? "note_removed" : "note",
				revision: r.revision,
				...(!r.removed_at ? { body: r.body, editedAt: r.edited_at?.toISOString() ?? null } : {}),
			});
		else if (r.kind === "stage_changed")
			items.push({
				...base,
				kind: "stage_changed",
				from: c.stage.parse(r.before_value?.stage),
				to: c.stage.parse(r.after_value?.stage),
			});
		else if (r.kind === "household_changed")
			items.push({
				...base,
				kind: "activity",
				action: actions[r.action ?? ""],
				household: { from: r.before_value?.membership ?? null, to: r.after_value?.membership ?? null },
			});
		else if (r.kind === "record") {
			// An assessment, interview or commitment event, with the stage advance it caused.
			const from = r.before_value?.stage,
				to = r.after_value?.stage;
			items.push({
				...base,
				kind: "activity",
				action: r.action,
				...(r.record_id ? { recordId: r.record_id } : {}),
				...(from && to && from !== to ? { stage: { from, to } } : {}),
			});
		} else if (r.kind === "follow_up")
			items.push({
				...base,
				kind: "follow_up",
				outcome: r.outcome,
				obligationId: r.obligation_id,
				// A follow-up entry carries how it happened and its note in the shared body and action columns.
				channel: r.action ?? null,
				notes: r.body ?? null,
			});
		else items.push({ ...base, kind: "activity", action: actions[r.action ?? ""] });
	}
	const more = found.length > input.limit;
	return c.activitiesResult.parse({
		owner: ctx.selected,
		personId,
		items,
		next: more ? input.page + 1 : null,
		completeness: more ? "partial" : "complete",
	});
}

export async function getAccountLink(tx: Tx, ctx: Context, raw: unknown) {
	return readReply(async () => {
		const input = parse(c.personRequest, raw);
		const { actor, gate } = await authorizeRead(tx, ctx);
		const p = await person(tx, ctx, input.personId, gate);
		await canReadPerson(tx, ctx, p, actor);
		return c.accountLinkResult.parse(
			p.linked_account_id ? { status: "linked", personId: p.id } : { status: "unlinked" },
		);
	});
}

/** The People viewer of a plant seat: the actor plus the own Person name the layout shows. Null for any other seat. */
export function peopleViewer(authority: RequestActor, own: { id: string; name: string } | null) {
	const actor = authority.actor;
	if (actor.context.kind !== "seat" || actor.context.owner.kind !== "plant") return null;
	return {
		session: authority.session,
		accountId: actor.accountId,
		selected: actor.context.owner,
		role: actor.context.role,
		authority,
		displayName: own?.name ?? "You",
		ownPersonId: own?.id ?? null,
	};
}

/**
 * Pipeline columns' saved order and revision, in one query inside the move's own transaction (D68). A reorder answers
 * with its column, a stage change with the column the person left and the one they joined, instead of re-reading the
 * whole pipeline. Each column lists every person's revision, which the page's next move must send.
 */
export async function readColumnOrders(tx: Tx, ctx: Context, columns: readonly z.infer<typeof c.pipelineColumn>[]) {
	const result = await tx.execute(sql`SELECT u.c AS column,
		coalesce((SELECT revision::text FROM people_column WHERE plant_id=${ctx.selected.id} AND column_name=u.c), '1') AS revision,
		coalesce((SELECT json_agg(json_build_object('id', id, 'revision', revision::text) ORDER BY pipeline_position, created_at, id)
			FROM person WHERE plant_id=${ctx.selected.id} AND state='live'
			AND stage=ANY(CASE WHEN u.c='core_group' THEN ARRAY['core_group','launch_team','leader'] ELSE ARRAY[u.c] END)), '[]') AS people
		FROM unnest(${sql.param(columns)}::text[]) WITH ORDINALITY AS u(c, i) ORDER BY u.i`);
	return result.rows.map((r) => {
		const row = columnRow.parse(r);
		return {
			column: row.column,
			revision: row.revision,
			personIds: row.people.map((p) => p.id),
			personRevisions: Object.fromEntries(row.people.map((p) => [p.id, p.revision])),
		};
	});
}
const columnRow = z.object({
	column: c.pipelineColumn,
	revision: z.string(),
	people: z.array(z.object({ id: z.uuid(), revision })),
});
