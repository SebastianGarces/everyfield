import { inArray, ne, count, and, asc, eq, isNull, or, sql, getTableColumns } from "@everyfield/db/query";
import * as tables from "@everyfield/db/tables";
import { alias } from "@everyfield/db/columns";
import { z } from "zod";
import * as c from "@everyfield/contracts/people";
import type { PeopleReader } from "@everyfield/contracts/people";
import {
	authorize,
	canReadPerson,
	deny,
	hash,
	parse,
	person,
	personRow,
	project,
	projectPeople,
	readReply,
	attribution,
} from "./core.ts";
import { RequestActor } from "../access/session.ts";
import { PeopleReadContext } from "./core.ts";
import { revision, type sessionId } from "@everyfield/contracts/common";
import type { Tx, Context } from "./core.ts";
import { openDuties } from "./people.ts";
import { pipelineMetrics } from "./metrics.ts";
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
	before_value: z.object({ stage: c.stage.nullable().optional() }).nullable(),
	after_value: z.object({ stage: c.stage.nullable().optional() }).nullable(),
	obligation_id: z.uuid().nullable(),
	outcome: z.string().nullable(),
});
async function list(tx: Tx, ctx: Context, raw: unknown, authorized = false) {
	if (ctx.selected.kind !== "plant") deny();
	const input = parse(c.listPeopleRequest, raw);
	if (!authorized) await authorize(tx, ctx);

	const filters = [eq(tables.person.plant_id, ctx.selected.id)];
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
	const total = (
		await tx
			.select({ total: count() })
			.from(tables.person)
			.where(and(...filters))
	)[0]!.total;
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
	const items = await projectPeople(tx, ctx, rows),
		more = result.length > input.limit;
	return c.peoplePage.parse({
		owner: ctx.selected,
		items,
		total,
		next: more ? input.page + 1 : null,
		completeness: more ? "partial" : "complete",
	});
}
export const peopleReader: PeopleReader<Tx> = {
	async getPerson(tx, ctx, raw) {
		return readReply(async () => {
			const input = parse(c.personRequest, raw);
			await authorize(tx, ctx);
			const p = await person(tx, ctx, input.personId);
			await canReadPerson(tx, ctx, p);
			return c.personResult.parse({
				status: "available",
				person: await project(tx, ctx, p),
			});
		});
	},
	async listPeople(tx, ctx, raw) {
		return readReply(() => list(tx, ctx, raw));
	},
	async getOwnAccountPerson(tx, ctx, raw) {
		return readReply(async () => {
			parse(c.ownAccountPersonRequest, raw);
			const actor = await authorize(tx, ctx);
			const r = await tx
				.select({ id: tables.person.id })
				.from(tables.person)
				.where(
					and(
						and(eq(tables.person.tenant_id, ctx.selected.id), eq(tables.person.linked_account_id, actor.accountId)),
						eq(tables.person.state, "live"),
					),
				);
			return c.accountLinkResult.parse(r.length ? { status: "linked", personId: r[0]!.id } : { status: "unlinked" });
		});
	},
	async getStatusWarnings(tx, ctx, raw) {
		return readReply(async () => {
			if (ctx.selected.kind !== "plant") deny();
			const input = parse(c.personRequest, raw);
			await authorize(tx, ctx);
			const p = await person(tx, ctx, input.personId);
			await canReadPerson(tx, ctx, p);
			const review = (
				await tx
					.select({ material_revision: tables.plant.material_revision })
					.from(tables.plant)
					.where(eq(tables.plant.id, ctx.selected.id))
					.for("share")
			)[0]!.material_revision;
			const duties = await openDuties(tx, ctx, p),
				interview = await tx
					.select({ id: tables.interview.id })
					.from(tables.interview)
					.where(and(eq(tables.interview.person_id, p.id), eq(tables.interview.plant_id, ctx.selected.id)));
			const dto = c.plantPerson.parse(await project(tx, ctx, p));
			return c.statusWarningsResult.parse({
				personId: p.id,
				revision: p.revision,
				reviewRevision: review,
				openDuties: duties.map((d) => ({ id: d.id, revision: d.revision })),
				warnings: [
					...(!interview.length ? ["interview_not_recorded"] : []),
					...(dto.commitment.state !== "active" ? ["commitment_not_recorded"] : []),
					...(duties.length ? ["open_duties"] : []),
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
			await authorize(tx, ctx);
			const groups = [];
			const columnRevisions = await tx
				.select({ column: tables.people_column.column_name, revision: tables.people_column.revision })
				.from(tables.people_column)
				.where(eq(tables.people_column.plant_id, ctx.selected.id));
			const queries = c.pipelineColumn.options.map((column) => {
				const stages = column === "core_group" ? ["core_group", "launch_team", "leader"] : [column];
				const selected = input.stages.length ? input.stages.filter((s) => stages.includes(s)) : stages;
				const query = c.listPeopleRequest.parse({ ...input, view: "pipeline", archived: "exclude", stages: selected });
				return { column, stages, selected, query };
			});
			// Every column reads the same page number; "Show more" keeps the one column it asked for.
			for (const { column, stages, selected, query } of queries) {
				const revision = columnRevisions.find((r) => r.column === column)?.revision ?? "1";
				if (!selected.length) {
					groups.push({ column, revision, cards: [], total: 0, next: null });
					continue;
				}
				const page = await list(tx, ctx, query, true);

				groups.push({
					column,
					revision,
					cards: page.items.filter((dto) => stages.includes(dto.stage)),
					total: input.stages.length && !input.stages.some((s) => stages.includes(s)) ? 0 : page.total,
					next: page.next,
				});
			}
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
			const tasks = ids.length
				? await tx
						.select({
							personId: tables.person.id,
							id: duties.id,
							due_date: duties.due_date,
							today: sql<string>`(clock_timestamp() AT TIME ZONE ${plant_p.timezone})::date`,
						})
						.from(tables.person)
						.innerJoin(plant_p, eq(plant_p.id, tables.person.plant_id))
						.innerJoinLateral(duties, sql`true`)
						.where(and(eq(tables.person.plant_id, ctx.selected.id), inArray(tables.person.id, ids)))
						.orderBy(asc(duties.id))
				: [];
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
			await authorize(tx, ctx);
			const p = await person(tx, ctx, input.personId);
			await canReadPerson(tx, ctx, p);
			const result = await tx.execute(sql`SELECT * FROM (
      SELECT id,occurred_at,recorded_at,author_id AS actor_id,revision,body,edited_at,removed_at,'note' AS category,'note' AS kind,NULL::text AS action,NULL::jsonb AS before_value,NULL::jsonb AS after_value,NULL::uuid AS obligation_id,NULL::text AS outcome FROM person_note WHERE tenant_id=${sql.param(ctx.selected.id)} AND person_id=${sql.param(p.id)}
      UNION ALL
      SELECT id,occurred_at,recorded_at,actor_id,after_revision AS revision,NULL,NULL,NULL,'activity',CASE WHEN action='people.stage_changed' THEN 'stage_changed' ELSE 'activity' END,action,before_value,after_value,NULL,NULL FROM people_history WHERE tenant_id=${sql.param(ctx.selected.id)} AND person_id=${sql.param(p.id)} AND action IN ('people.created','people.updated','people.retired','people.restored','people.stage_changed','people.recorded','people.corrected')
      UNION ALL
      SELECT id,occurred_at,recorded_at,(SELECT actor_id FROM event WHERE target_record_id=contact_outcome.id ORDER BY recorded_at,id LIMIT 1),revision,NULL,NULL,NULL,'follow_up','follow_up',NULL,NULL,NULL,obligation_id,outcome FROM contact_outcome WHERE plant_id=${sql.param(ctx.selected.id)} AND person_id=${sql.param(p.id)} AND voided_at IS NULL
    ) a WHERE category=ANY(${sql.param(input.kinds ?? ["note", "activity", "follow_up"])}) ORDER BY occurred_at,id LIMIT ${sql.param(input.limit + 1)} OFFSET ${sql.param((input.page - 1) * input.limit)}`);
			const rows = result.rows.slice(0, input.limit).map((row) => activityRow.parse(row)),
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
					actor: await attribution(tx, r.actor_id, hash([ctx.selected.id, r.id])),
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
				else if (r.kind === "follow_up")
					items.push({
						...base,
						kind: "follow_up",
						outcome: r.outcome,
						obligationId: r.obligation_id,
					});
				else items.push({ ...base, kind: "activity", action: actions[r.action ?? ""] });
			}
			const more = result.rows.length > input.limit;
			return c.activitiesResult.parse({
				owner: ctx.selected,
				personId: p.id,
				items,
				next: more ? input.page + 1 : null,
				completeness: more ? "partial" : "complete",
			});
		});
	},
	async readPipelineMetrics(tx, ctx, raw) {
		return readReply(() => pipelineMetrics(tx, ctx, raw));
	},
};
export async function getAccountLink(tx: Tx, ctx: Context, raw: unknown) {
	return readReply(async () => {
		const input = parse(c.personRequest, raw);
		await authorize(tx, ctx);
		const p = await person(tx, ctx, input.personId);
		await canReadPerson(tx, ctx, p);
		return c.accountLinkResult.parse(
			p.linked_account_id ? { status: "linked", personId: p.id } : { status: "unlinked" },
		);
	});
}

/** The layout needs the own Person name/id, not a full projected Person read. */
export async function getViewerSummary(tx: Tx, ctx: Context) {
	return readReply(async () => {
		const actor = await authorize(tx, ctx);
		const rows = await tx
			.select({ personId: tables.person.id, displayName: tables.person.display_name })
			.from(tables.person)
			.where(
				and(
					eq(tables.person.tenant_id, ctx.selected.id),
					eq(tables.person.linked_account_id, actor.accountId),
					eq(tables.person.state, "live"),
				),
			);
		return rows[0] ?? null;
	});
}

/** Request DAL entry: one current actor and one bounded own-Person summary. */
export async function readPeopleViewer(tx: Tx, session: z.infer<typeof sessionId>, observed?: RequestActor) {
	const authority = observed ?? (await RequestActor.resolve(tx, session));
	if (!(authority instanceof RequestActor)) return { status: "no_access" } as const;
	const actor = authority.actor;
	if (actor.context.kind !== "seat" || actor.context.owner.kind !== "plant") return { status: "no_access" } as const;
	const summary = await getViewerSummary(tx, new PeopleReadContext(authority, "native"));
	if (summary.status !== "ok") return { status: "no_access" } as const;
	return {
		status: "viewer",
		viewer: {
			session,
			accountId: actor.accountId,
			selected: actor.context.owner,
			role: actor.context.role,
			authority,
			displayName: summary.value?.displayName ?? "You",
			ownPersonId: summary.value?.personId ?? null,
		},
	} as const;
}

/**
 * One pipeline column's saved order and revision, read in the reorder's own transaction (D68). The reorder answers with
 * this pair instead of re-reading the whole pipeline. The writer has already authorized and locked the column.
 */
export async function readColumnOrder(tx: Tx, ctx: Context, column: z.infer<typeof c.pipelineColumn>) {
	const stages = column === "core_group" ? (["core_group", "launch_team", "leader"] as const) : [column];
	const [col] = await tx
		.select({ revision: tables.people_column.revision })
		.from(tables.people_column)
		.where(and(eq(tables.people_column.plant_id, ctx.selected.id), eq(tables.people_column.column_name, column)));
	const rows = await tx
		.select({ id: tables.person.id, revision: tables.person.revision })
		.from(tables.person)
		.where(
			and(
				eq(tables.person.plant_id, ctx.selected.id),
				eq(tables.person.state, "live"),
				inArray(tables.person.stage, [...stages]),
			),
		)
		.orderBy(asc(tables.person.pipeline_position), asc(tables.person.created_at), asc(tables.person.id));
	// A reorder changes every listed person's revision too; the page needs them for its next stage change.
	return {
		revision: col?.revision ?? "1",
		personIds: rows.map((r) => r.id),
		personRevisions: Object.fromEntries(rows.map((r) => [r.id, revision.parse(r.revision)])),
	};
}
