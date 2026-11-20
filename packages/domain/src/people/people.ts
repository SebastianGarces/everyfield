import { and, eq, isNull, sql, type SQLWrapper } from "@everyfield/db/query";
import * as tables from "@everyfield/db/tables";

import { declareWrite, executeWrites } from "../operations/writes.ts";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import * as c from "@everyfield/contracts/people";
import type { PeopleWriter, AccountPersonProducer } from "@everyfield/contracts/people";
import { accountId, owner, recordId, revision } from "@everyfield/contracts/common";
import {
	deny,
	evidenceJson,
	evidenceOf,
	expected,
	live,
	hash,
	lockedWrite,
	lockPersonWith,
	mutation,
	parse,
	patchPerson,
	contactValues,
	personChanges,
	person,
	personQuery,
	personRow,
	project,
	projectWith,
	reply,
	replyWithoutSavepoint,
} from "./core.ts";
import type { Context, Evidence, LockedReads, WriteContext, Tx, Person } from "./core.ts";
import { columnStages, isCommitted, openDutiesOf } from "./pipeline.ts";
import { lockingTasks, managedTaskRows } from "../tasks/queries.ts";
import { reminderChange, syncAll, type TaskReminders } from "../tasks/writes.ts";

export function appendPerson(
	tx: Tx,
	context: Pick<Context, "selected">,
	raw: z.infer<typeof c.createPersonRequest>["input"] | z.infer<typeof c.createOrganizationPersonRequest>["input"],
	writes: SQLWrapper[],
	linkedAccountId: string | null = null,
) {
	return appendPeople(tx, context, [newPerson(context, raw, linkedAccountId)], writes)[0]!;
}
export function appendPeople(
	tx: Tx,
	context: Pick<Context, "selected">,
	rows: ReturnType<typeof newPerson>[],
	writes: SQLWrapper[],
) {
	if (!rows.length) return rows;
	writes.push(
		tx
			.insert(tables.person)
			.values(rows.map((row) => ({ ...row, birth_date: row.birth_date?.toISOString().slice(0, 10) ?? null }))),
	);
	if (context.selected.kind === "plant")
		writes.push(
			columnsChanged(
				context.selected.id,
				rows.map((row) => row.stage),
			),
		);
	return rows;
}
export function newPerson(
	context: Pick<Context, "selected">,
	raw: z.infer<typeof c.createPersonRequest>["input"] | z.infer<typeof c.createOrganizationPersonRequest>["input"],
	linkedAccountId: string | null = null,
	id: string = randomUUID(),
	at = new Date(),
) {
	const plant = context.selected.kind === "plant",
		p = c.createPersonRequest.shape.input.parse(raw);
	return personRow.parse({
		id,
		tenant_id: context.selected.id,
		plant_id: plant ? context.selected.id : null,
		organization_id: plant ? null : context.selected.id,
		display_name: p.displayName,
		first_name: null,
		last_name: null,
		email: null,
		phone: null,
		street: null,
		city: null,
		state_province: null,
		postal_code: null,
		country: null,
		source: plant ? p.source : "other",
		source_details: null,
		notes: null,
		stage: plant ? p.stage : null,
		adult_classification: plant ? p.adultClassification : null,
		birth_date: null,
		commitment_state: plant ? "unknown" : null,
		created_at: at,
		state: "live",
		retired_at: null,
		merged_into_person_id: null,
		linked_account_id: linkedAccountId,
		revision: "1",
		pipeline_position: plant ? freshPosition(id, at) : null,
		...contactValues(raw),
	});
}

export function freshPosition(id: string, at = new Date()): string {
	return `${at.getTime()}.${BigInt("0x" + id.replaceAll("-", "").slice(-12))
		.toString()
		.padStart(15, "0")}`;
}
export const sameColumn = (a: string, b: string) => a === b || (isCommitted(a) && isCommitted(b));
export function columnsChanged(plantId: string, stages: readonly (string | null)[]): SQLWrapper {
	const columns = [...new Set(stages.filter((s) => s !== null).map((s) => (isCommitted(s) ? "core_group" : s)))];
	return sql`INSERT INTO people_column(plant_id, column_name, revision) SELECT ${plantId}::uuid, c, 2 FROM unnest(${sql.param(columns)}::text[]) c ON CONFLICT (plant_id, column_name) DO UPDATE SET revision = people_column.revision + 1`;
}

async function output(
	tx: Tx,
	ctx: Context,
	p: Person,
	id: string,
	needsOwner: string[] = [],
	outcome = "changed",
	evidence?: Evidence[],
) {
	return {
		person: evidence ? projectWith(ctx, [p], evidence)[0]! : await project(tx, ctx, p, lockedWrite),
		receiptId: id,
		outcome,
		needsOwner,
	};
}
const handoffRows = z.object({
	duties: managedTaskRows,
	targets: z.array(z.object({ id: z.uuid(), state: personRow.shape.state, linked_account_id: z.uuid().nullable() })),
	seats: z.array(z.uuid()),
});
async function handoffReads(tx: Tx, ctx: Context, p: Person, choices: z.infer<typeof c.handoffChoice>[]) {
	if (ctx.selected.kind !== "plant") return { duties: [], targets: [], seats: [] };
	const plant = ctx.selected.id,
		duties = choices.map((choice) => choice.dutyId),
		matched = new Set(duties).size === duties.length,
		targets = matched ? choices.flatMap((choice) => (choice.kind === "assign" ? [choice.toPersonId] : [])) : [];
	const dutiesMatchChoices = sql`(SELECT count(*) FROM duties)=${duties.length}
		AND NOT EXISTS (SELECT FROM duties d WHERE d.id<>ALL(${sql.param(duties)}::uuid[]))`;
	const r =
		await tx.execute(sql`WITH duties AS MATERIALIZED (${lockingTasks(plant, openDutiesOf(p.id, p.linked_account_id))}),
		targets AS MATERIALIZED (SELECT x.id, x.state, x.linked_account_id FROM person x
			WHERE x.id=ANY(${sql.param(targets)}::uuid[]) AND x.tenant_id=${plant}::uuid AND ${dutiesMatchChoices}
			ORDER BY x.id FOR UPDATE OF x),
		seats AS MATERIALIZED (SELECT s.account_id FROM seat s WHERE s.account_id IN (SELECT linked_account_id FROM targets)
			AND s.plant_id=${plant}::uuid AND s.ended_at IS NULL AND s.accepted_at<=clock_timestamp() FOR SHARE OF s)
		SELECT (SELECT coalesce(json_agg(d ORDER BY d.id),'[]') FROM duties d) AS duties,
			(SELECT coalesce(json_agg(x ORDER BY x.id),'[]') FROM targets x) AS targets,
			(SELECT coalesce(json_agg(s.account_id),'[]') FROM seats s) AS seats`);
	return handoffRows.parse(r.rows[0]);
}
async function handoff(
	tx: Tx,
	ctx: Context,
	p: Person,
	choices: z.infer<typeof c.handoffChoice>[],
	reminders: TaskReminders,
) {
	const { duties, targets, seats } = await handoffReads(tx, ctx, p, choices),
		byId = new Map(choices.map((c) => [c.dutyId, c]));
	if (
		byId.size !== choices.length ||
		duties.length !== choices.length ||
		duties.some((d) => !byId.has(recordId.parse(d.id)))
	)
		deny("conflict");

	const needsOwner: string[] = [];
	const changes = duties.map((duty) => {
		const choice = byId.get(recordId.parse(duty.id))!;
		if (choice.expectedRevision !== duty.revision) deny("conflict");
		if (choice.kind !== "assign") {
			needsOwner.push(duty.id);
			return { id: duty.id, account: null };
		}
		const target = targets.find((target) => target.id === choice.toPersonId);
		if (!target || target.state !== "live") deny("unavailable");
		if (target.id === p.id) deny("invalid_subject");
		if (!seats.some((seat) => seat === target.linked_account_id)) deny("unavailable");
		return { id: duty.id, account: target.linked_account_id };
	});
	if (changes.length) {
		const source = p.linked_account_id;
		await tx.execute(
			sql`WITH v AS (SELECT * FROM jsonb_to_recordset(${JSON.stringify(changes)}::jsonb) v(id uuid,account uuid)),
				bump AS (UPDATE task t SET revision=t.revision+1 FROM v WHERE t.id=v.id RETURNING 1),
				gone AS (DELETE FROM task_assignee a USING v WHERE a.task_id=v.id AND a.account_id IS DISTINCT FROM v.account
					AND (a.account_id=${source}::uuid OR NOT EXISTS (SELECT 1 FROM task_assignee x WHERE x.task_id=v.id AND x.account_id=${source}::uuid)) RETURNING 1),
				joined AS (INSERT INTO task_assignee(plant_id,task_id,account_id)
					SELECT ${ctx.selected.id}::uuid,v.id,v.account FROM v WHERE v.account IS NOT NULL
					ON CONFLICT DO NOTHING RETURNING 1)
				SELECT 1`,
		);
		const moved = changes.map(({ id, account }) => {
			const row = duties.find((duty) => duty.id === id)!;
			const held = row.assignees.some((a) => a.accountId === source);
			const kept = held ? row.assignees.filter((a) => a.accountId !== source && a.accountId !== account) : [];
			return reminderChange(ctx.selected.id, row, {
				...row,
				assignees: account ? [...kept, { accountId: accountId.parse(account), displayName: "", seated: true }] : kept,
				revision: revision.parse(String(BigInt(row.revision) + 1n)),
			});
		});
		await syncAll(reminders, tx, moved)?.();
	}
	return needsOwner;
}
export const peopleWriter: PeopleWriter<Tx, TaskReminders> = {
	async createPerson(tx, ctx, raw) {
		return reply(tx, async () => {
			if (ctx.selected.kind !== "plant") deny("unavailable");
			const input = parse(c.createPersonRequest, raw);
			return c.plantPersonMutationResult.parse(
				await mutation(tx, ctx, "people.createPerson", input, async (_a, id, audit) => {
					const after = appendPerson(tx, ctx, input.input, audit.writes);
					return {
						value: await output(tx, ctx, after, id),
						subject: after.id,
						action: "people.created",
						after,
					};
				}),
			);
		});
	},
	async updatePerson(tx, ctx, raw) {
		return reply(tx, async () => {
			if (ctx.selected.kind !== "plant") deny("unavailable");
			const input = parse(c.updatePersonRequest, raw);
			return c.plantPersonMutationResult.parse(
				await mutation(tx, ctx, "people.updatePerson", input, async (_a, id, audit) => {
					const { before, after } = await patchPerson(
						tx,
						ctx,
						input.input.personId,
						input.expectedRevision,
						input.input.patch,
						audit.writes,
					);
					return {
						value: await output(tx, ctx, after, id),
						subject: before.id,
						action: "people.updated",
						before,
						after,
					};
				}),
			);
		});
	},
	async changeStatus(tx, ctx, raw, reminders) {
		return reply(tx, async () => {
			if (ctx.selected.kind !== "plant") deny("unavailable");
			const input = parse(c.changeStatusRequest, raw);
			return c.plantPersonMutationResult.parse(
				await mutation(tx, ctx, "people.changeStatus", input, async (_a, id, audit) => {
					const before = await person(tx, ctx, input.input.personId, true);
					live(before);
					expected(before, input.expectedRevision);
					const noop = before.stage === input.input.stage;
					const leaving = isCommitted(before.stage) && !isCommitted(input.input.stage);
					const needsOwner = !noop && leaving ? await handoff(tx, ctx, before, input.input.handoffs, reminders) : [];
					if (!leaving && input.input.handoffs.length) deny("invalid_input");
					const position = sameColumn(before.stage!, input.input.stage)
						? before.pipeline_position
						: freshPosition(before.id);
					if (!noop)
						audit.writes.push(
							tx
								.update(tables.person)
								.set({
									stage: input.input.stage,
									pipeline_position: position,
									revision: sql<unknown>`(${tables.person.revision} + 1)`,
								})
								.where(eq(tables.person.id, before.id)),
						);
					if (!noop && !sameColumn(before.stage!, input.input.stage))
						audit.writes.push(columnsChanged(ctx.selected.id, [before.stage, input.input.stage]));
					const after = personRow.parse({
						...before,
						stage: noop ? before.stage : input.input.stage,
						pipeline_position: noop ? before.pipeline_position : position,
						revision: noop ? before.revision : String(BigInt(before.revision) + 1n),
					});
					return {
						value: await output(tx, ctx, after, id, needsOwner, noop ? "noop" : "changed"),
						subject: before.id,
						action: "people.stage_changed",
						before,
						after,
						reason: input.input.reason,
						outcome: noop ? "noop" : "changed",
					};
				}),
			);
		});
	},
	async retirePerson(tx, ctx, raw, reminders) {
		return reply(tx, async () => {
			if (ctx.selected.kind !== "plant") deny("unavailable");
			const input = parse(c.retirePersonRequest, raw);
			return c.plantPersonMutationResult.parse(await retire(tx, ctx, input, reminders));
		});
	},
	async restorePerson(tx, ctx, raw) {
		return reply(tx, async () => {
			if (ctx.selected.kind !== "plant") deny("unavailable");
			const input = parse(c.restorePersonRequest, raw);
			return c.plantPersonMutationResult.parse(await restore(tx, ctx, input));
		});
	},
	async addNote(tx, ctx, raw) {
		return reply(tx, async () => {
			const input = parse(c.addNoteRequest, raw);
			return c.noteMutationResult.parse(await note(tx, ctx, input, "add"));
		});
	},
	async editNote(tx, ctx, raw) {
		return reply(tx, async () => {
			const input = parse(c.editNoteRequest, raw);
			return c.noteMutationResult.parse(await note(tx, ctx, input, "edit"));
		});
	},
	async deleteNote(tx, ctx, raw) {
		return reply(tx, async () => {
			const input = parse(c.deleteNoteRequest, raw);
			return c.noteMutationResult.parse(await note(tx, ctx, input, "delete"));
		});
	},
	async recordAdultClassification(tx, ctx, raw) {
		return classify(tx, ctx, raw, false);
	},
	async correctAdultClassification(tx, ctx, raw) {
		return classify(tx, ctx, raw, true);
	},
	async reorderPipeline(tx, ctx, raw) {
		return reply(tx, async () => {
			if (ctx.selected.kind !== "plant") deny("unavailable");
			const input = parse(c.reorderPipelineRequest, raw);
			return pipelineOrder(tx, ctx, input);
		});
	},
};
async function retire(
	tx: Tx,
	ctx: WriteContext,
	input: z.infer<typeof c.retirePersonRequest>,
	reminders: TaskReminders,
) {
	return mutation(tx, ctx, "people.deletePerson", input, async (_a, id, audit) => {
		const { person: before, row } = await lockPersonWith(tx, ctx, input.input.personId, {
			columns: sql`(SELECT material_revision::text FROM plant WHERE id=${ctx.selected.id}::uuid
				AND subject.revision=${input.expectedRevision}::bigint AND subject.state<>'merged' FOR SHARE) AS review`,
		});
		expected(before, input.expectedRevision);
		if (before.state === "merged") deny("use_reviewed_unmerge");
		if (input.input.reviewRevision !== row.review) deny("conflict");
		let after = before;
		const needsOwner = before.state === "live" ? await handoff(tx, ctx, before, input.input.handoffs, reminders) : [];
		if (before.state === "live") {
			const [updated] = await tx
				.update(tables.person)
				.set({
					state: "retired",
					household_id: null,
					household_role: null,
					retired_at: sql<Date>`clock_timestamp()`.mapWith((value: string) => new Date(value)),
					revision: sql<unknown>`(${tables.person.revision} + 1)`,
				})
				.where(eq(tables.person.id, before.id))
				.returning();
			after = personRow.parse({ ...updated, plant_today: before.plant_today });
			audit.writes.push(columnsChanged(ctx.selected.id, [before.stage]));
			audit.writes.push(
				tx
					.update(tables.team_tenure)
					.set({
						ended_on: sql<string>`(clock_timestamp() AT TIME ZONE (SELECT timezone FROM ${tables.plant} WHERE ${tables.plant.id}=${ctx.selected.id}))::date`,
						revision: sql<unknown>`(${tables.team_tenure.revision} + 1)`,
					})
					.where(
						and(
							and(eq(tables.team_tenure.person_id, before.id), eq(tables.team_tenure.plant_id, ctx.selected.id)),
							isNull(tables.team_tenure.ended_on),
						),
					),
			);
			audit.writes.push(
				tx
					.update(tables.team)
					.set({
						leader_person_id: null,
						leader_source: null,
						leader_role_id: null,
						revision: sql<unknown>`(${tables.team.revision} + 1)`,
					})
					.where(and(eq(tables.team.plant_id, ctx.selected.id), eq(tables.team.leader_person_id, before.id))),
			);
		}
		const outcome = before.state === "retired" ? "noop" : "changed";
		return {
			value: await output(tx, ctx, after, id, needsOwner, outcome),
			subject: before.id,
			action: "people.retired",
			before,
			after,
			reason: input.input.reason,
			outcome,
		};
	});
}
async function restore(tx: Tx, ctx: WriteContext, input: z.infer<typeof c.restorePersonRequest>) {
	return mutation(tx, ctx, "people.restorePerson", input, async (_a, id, audit) => {
		const before = await person(tx, ctx, input.input.personId, true);
		expected(before, input.expectedRevision);
		if (before.state === "merged") deny("use_reviewed_unmerge");
		let after = before;
		if (before.state === "retired") {
			try {
				const [updated] = await tx
					.update(tables.person)
					.set({
						state: "live",
						retired_at: null,
						pipeline_position: freshPosition(before.id),
						revision: sql<unknown>`(${tables.person.revision} + 1)`,
					})
					.where(eq(tables.person.id, before.id))
					.returning();
				after = personRow.parse({ ...updated, plant_today: before.plant_today });
				audit.writes.push(columnsChanged(ctx.selected.id, [before.stage]));
			} catch (error) {
				if (
					error instanceof Error &&
					error.cause instanceof Error &&
					"code" in error.cause &&
					error.cause.code === "23505" &&
					"constraint" in error.cause &&
					error.cause.constraint === "person_uq_1"
				)
					deny("conflict");
				throw error;
			}
		}
		const outcome = before.state === "live" ? "noop" : "changed";
		return {
			value: await output(tx, ctx, after, id, [], outcome),
			subject: before.id,
			action: "people.restored",
			before,
			after,
			outcome,
		};
	});
}
const lockedNote = z.object({ author_id: z.uuid().nullable(), revision, body: z.string() });
const noteRead = (ctx: Context, noteId: string): LockedReads => ({
	columns: sql`(SELECT jsonb_build_object('author_id',n.author_id,'revision',n.revision::text,'body',n.body)
		FROM person_note n WHERE n.id=${noteId}::uuid AND n.tenant_id=${ctx.selected.id}::uuid AND n.person_id=subject.id
		AND n.removed_at IS NULL AND subject.state='live' FOR UPDATE OF n) AS note`,
});
const participationRead = (ctx: Context, meetingId: string, personRevision: string): LockedReads => ({
	columns: sql`(SELECT coalesce(json_agg(x.id),'[]') FROM (SELECT q.id FROM participation q
		WHERE q.meeting_id=${meetingId}::uuid AND q.person_id=subject.id AND q.plant_id=${ctx.selected.id}::uuid
		AND subject.state='live' AND subject.revision=${personRevision}::bigint FOR SHARE OF q) x) AS participations`,
});
type NoteInput =
	z.infer<typeof c.addNoteRequest> | z.infer<typeof c.editNoteRequest> | z.infer<typeof c.deleteNoteRequest>;
async function note(tx: Tx, ctx: WriteContext, input: NoteInput, kind: "add" | "edit" | "delete") {
	return mutation(
		tx,
		ctx,
		kind === "add" ? "people.addNote" : kind === "edit" ? "people.editNote" : "people.deleteNote",
		input,
		async (actor, id, audit) => {
			const meetingId = "meetingId" in input.input ? (input.input.meetingId ?? null) : null;
			const noteId = "noteId" in input.input ? input.input.noteId : randomUUID();
			if (meetingId) await declareWrite(tx, "established");
			const reads =
				kind !== "add"
					? noteRead(ctx, noteId)
					: meetingId
						? participationRead(ctx, meetingId, input.expectedRevision)
						: null;
			const { person: before, row } = reads
				? await lockPersonWith(tx, ctx, input.input.personId, reads)
				: { person: await person(tx, ctx, input.input.personId, true), row: {} };
			live(before);
			let noteRevision = "1";
			if (kind === "add") {
				expected(before, input.expectedRevision);
				let participation: string | null = null;
				if (meetingId) {
					const r = z.array(z.uuid()).parse(row.participations);
					if (r.length !== 1) deny("unavailable");
					participation = r[0]!;
				}
				if (!("body" in input.input)) deny("invalid_input");
				audit.writes.push(
					tx.insert(tables.person_note).values({
						id: noteId,
						tenant_id: ctx.selected.id,
						plant_id: before.plant_id,
						person_id: before.id,
						author_id: actor,
						participation_id: participation,
						body: input.input.body,
						occurred_at: sql<Date>`clock_timestamp()`.mapWith((value: string) => new Date(value)),
						recorded_at: sql<Date>`clock_timestamp()`.mapWith((value: string) => new Date(value)),
					}),
				);
			} else {
				const found = lockedNote.nullable().parse(row.note);
				if (!found || found.author_id !== actor) deny("unavailable");
				if (found.revision !== input.expectedRevision) deny("conflict");
				const body = kind === "delete" ? "" : "body" in input.input ? input.input.body : deny("invalid_input");
				audit.events.push({
					id,
					tenant_id: ctx.selected.id,
					subject_id: before.id,
					subject_type: "person",
					actor_id: actor,
					actor_token: hash([ctx.selected.id, actor]),
					action: "people.updated",
					kind: "edit",
					before_value: { body: found.body },
					after_value: { body },
					reason: "reason" in input.input ? input.input.reason : null,
					metadata: { category: "note", noteId, correction: true },
				});
				audit.writes.push(
					tx
						.update(tables.person_note)
						.set({
							body: body,
							edited_at: sql<Date>`clock_timestamp()`.mapWith((value: string) => new Date(value)),
							removed_at: sql<unknown>`CASE WHEN ${sql.param(kind === "delete")} THEN clock_timestamp() ELSE NULL END`,
							revision: sql<unknown>`(${tables.person_note.revision} + 1)`,
						})
						.where(eq(tables.person_note.id, noteId)),
				);
				noteRevision = (BigInt(found.revision) + 1n).toString();
			}
			audit.writes.push(
				tx
					.update(tables.person)
					.set({ revision: sql<unknown>`(${tables.person.revision} + 1)` })
					.where(eq(tables.person.id, before.id)),
			);
			const after = personRow.parse({ ...before, revision: String(BigInt(before.revision) + 1n) });
			return {
				value: {
					receiptId: id,
					noteId,
					revision: noteRevision,
					personRevision: after.revision,
					outcome: "changed",
				},
				subject: before.id,
				action: "people.updated",
				before,
				after,
			};
		},
	);
}
async function classify(tx: Tx, ctx: WriteContext, raw: unknown, correction: boolean) {
	return reply(tx, async () => {
		if (ctx.selected.kind !== "plant") deny("unavailable");
		const input = parse(c.classifyAdultRequest, raw);
		return c.plantPersonMutationResult.parse(
			await mutation(
				tx,
				ctx,
				correction ? "people.correctAdultClassification" : "people.recordAdultClassification",
				input,
				async (_a, id, audit) => {
					const { person: before, row } = await lockPersonWith(tx, ctx, input.input.personId, {
						columns: sql`${evidenceJson(ctx.selected.id, sql`subject.id`)} AS evidence`,
					});
					live(before);
					expected(before, input.expectedRevision);
					if (before.birth_date) deny("invalid_input", { reason: "birth_date_decides" });
					if (input.input.occurredOn > z.string().parse(before.plant_today))
						deny("invalid_input", { reason: "future_date" });
					audit.writes.push(
						tx
							.update(tables.person)
							.set({
								adult_classification: input.input.classification,
								revision: sql<unknown>`(${tables.person.revision} + 1)`,
							})
							.where(eq(tables.person.id, before.id)),
					);
					const after = personRow.parse({
						...before,
						adult_classification: input.input.classification,
						revision: String(BigInt(before.revision) + 1n),
					});
					return {
						value: await output(tx, ctx, after, id, [], "changed", evidenceOf(row.evidence)),
						subject: before.id,
						action: correction ? "people.corrected" : "people.recorded",
						before,
						after,
						reason: input.input.reason,
					};
				},
			),
		);
	});
}
async function pipelineOrder(tx: Tx, ctx: WriteContext, input: z.infer<typeof c.reorderPipelineRequest>) {
	return c.noteMutationResult.pick({ receiptId: true, outcome: true }).parse(
		await mutation(tx, ctx, "people.reorderPipeline", input, async (actor, id, audit) => {
			const { column, personId: moving, afterId } = input.input;
			const stages = columnStages(column);
			const found = placeRow.parse(
				(
					await tx.execute(sql`WITH lock AS (
						INSERT INTO people_column(plant_id, column_name, revision) VALUES (${ctx.selected.id}, ${column}, 2)
						ON CONFLICT (plant_id, column_name) DO UPDATE SET revision = people_column.revision + 1 RETURNING revision),
					col AS (
						SELECT id, pipeline_position AS k, row_number() OVER (ORDER BY pipeline_position, created_at, id) AS n
						FROM person WHERE plant_id=${ctx.selected.id} AND state='live' AND stage=ANY(${sql.param(stages)}) AND id<>${moving}),
					anchor AS (SELECT coalesce((SELECT n FROM col WHERE id=${afterId}::uuid), 0) AS n, (SELECT k FROM col WHERE id=${afterId}::uuid) AS k)
					SELECT (SELECT revision FROM lock)::text AS revision,
						${afterId}::uuid IS NULL OR EXISTS(SELECT FROM col WHERE id=${afterId}::uuid) AS found,
						(CASE WHEN ${afterId}::uuid IS NULL
							THEN coalesce((SELECT k - 1 FROM col WHERE n=1), (SELECT pipeline_position FROM person WHERE id=${moving}::uuid))
							ELSE (SELECT CASE WHEN nx.k IS NULL THEN a.k + 1 WHEN nx.k > a.k THEN (a.k + nx.k) * 0.5 END
								FROM anchor a LEFT JOIN col nx ON nx.n = a.n + 1) END)::text AS key`)
				).rows[0],
			);
			if (BigInt(found.revision) - 1n !== BigInt(input.expectedRevision)) deny("conflict");
			const before = await person(tx, ctx, moving, true);
			if (before.state !== "live" || !stages.includes(before.stage!)) deny("conflict");
			if (!found.found) deny("conflict");
			const after = personRow.parse({
				...before,
				pipeline_position: z.string().parse(found.key),
				revision: String(BigInt(before.revision) + 1n),
			});
			audit.writes.push(
				tx
					.update(tables.person)
					.set({ pipeline_position: after.pipeline_position, revision: sql<unknown>`(${tables.person.revision} + 1)` })
					.where(and(eq(tables.person.plant_id, ctx.selected.id), eq(tables.person.id, moving))),
			);
			return {
				value: { receiptId: id, outcome: "changed" },
				subject: moving,
				action: "people.updated",
				before,
				after,
			};
		}),
	);
}
const placeRow = z.object({ revision: z.string(), found: z.boolean(), key: z.string().nullable() });
export const accountPersonProducer: AccountPersonProducer<Tx> = {
	async ensureAccountPerson(tx, raw) {
		return replyWithoutSavepoint(tx, async () => {
			const input = raw,
				selected = owner.parse(input.owner);
			if (selected.kind !== "plant") deny("unavailable");
			const ctx = { selected };
			let reviewed: string | null = null,
				candidates: string[] = [],
				row: Record<string, unknown> = {};
			if (input.selection.kind !== "first") {
				const locked =
					await tx.execute(sql`WITH a AS MATERIALIZED (SELECT id FROM account WHERE id=${input.accountId}::uuid FOR UPDATE)
	 SELECT (SELECT count(*) FROM a)::int AS accounts, (SELECT count(*) FROM (SELECT id FROM plant WHERE id=${selected.id}::uuid
	 AND EXISTS(SELECT FROM a) FOR UPDATE) p)::int AS plants`);
				if (!z.object({ accounts: z.number() }).parse(locked.rows[0]).accounts) deny("unavailable");
				const selection = input.selection,
					looks = selection.kind === "resolve" || selection.kind === "reviewed_contact";
				reviewed =
					selection.kind === "reviewed_contact" &&
					selection.person.owner.id === selected.id &&
					selection.person.owner.kind === "plant"
						? selection.person.personId
						: null;
				const found = looks
					? sql`, found AS MATERIALIZED (SELECT p.id FROM person p JOIN access_account_contact(${sql.param(input.accountId)}) a
						ON lower(p.email)=lower(a.email) WHERE NOT EXISTS (SELECT FROM exact) AND p.plant_id=${sql.param(selected.id)}
						AND p.state='live' AND p.linked_account_id IS NULL AND a.verified ORDER BY p.id LIMIT 100 FOR UPDATE OF p)`
					: sql``;
				const afterCandidates = sql`(SELECT count(*) FROM found)>=0`;
				const subject = reviewed
					? sql`, subject AS MATERIALIZED (${personQuery(tx, ctx, reviewed, sql`NOT EXISTS (SELECT FROM exact) AND ${afterCandidates}`).getSQL()} FOR UPDATE OF ${tables.person})`
					: sql``;
				const r =
					await tx.execute(sql`WITH exact AS MATERIALIZED (SELECT id FROM person WHERE plant_id=${selected.id}::uuid
					AND linked_account_id=${input.accountId}::uuid AND state='live' FOR UPDATE)${found}${subject}
					SELECT (SELECT coalesce(json_agg(e.id),'[]') FROM exact e) AS exact,
					${looks ? sql`(SELECT coalesce(json_agg(f.id ORDER BY f.id),'[]') FROM found f)` : sql`'[]'::json`} AS found
					${reviewed ? sql`, s.*` : sql``} FROM (SELECT 1) seed ${reviewed ? sql`LEFT JOIN subject s ON true` : sql``}`);
				row = r.rows[0]!;
				const exact = z.array(z.uuid()).parse(row.exact);
				if (exact.length)
					return c.accountPersonResolution.parse({
						status: "linked",
						personId: exact[0]!,
					});
				candidates = z.array(z.uuid()).parse(row.found);
			}
			if (input.selection.kind === "resolve")
				return candidates.length
					? c.accountPersonResolution.parse({
							status: "needs_selection",
							candidatePersonIds: candidates,
						})
					: deny("invalid_subject");
			const writes: SQLWrapper[] = [];
			let before: Person | undefined, linked: Person;
			if (input.selection.kind === "reviewed_contact") {
				if (!reviewed || row.id === null) deny("unavailable");
				before = personRow.parse(row);
				live(before);
				expected(before, input.selection.person.revision);
				if (before.linked_account_id || !candidates.includes(before.id)) deny("unavailable");
				linked = personRow.parse({
					...before,
					linked_account_id: input.accountId,
					revision: String(BigInt(before.revision) + 1n),
				});
				writes.push(
					tx
						.update(tables.person)
						.set({ linked_account_id: input.accountId, revision: linked.revision })
						.where(eq(tables.person.id, before.id)),
				);
			} else
				linked = appendPerson(
					tx,
					ctx,
					{
						displayName: input.selection.displayName,
						stage: "leader",
						source: "other",
						adultClassification: "unknown",
					},
					writes,
					input.accountId,
				);
			const delta = personChanges(before, linked);
			writes.push(
				tx.insert(tables.audit_event).values({
					tenant_id: selected.id,
					subject_id: linked.id,
					subject_type: "person",
					actor_id: input.accountId,
					actor_token: hash([selected.id, input.accountId]),
					action: before ? "people.updated" : "people.created",
					kind: before ? "edit" : "create",
					before_revision: before?.revision ?? null,
					after_revision: linked.revision,
					before_value: delta.before,
					after_value: delta.after,
				}),
				tx
					.update(tables.plant)
					.set({ material_revision: sql`${tables.plant.material_revision}+1` })
					.where(eq(tables.plant.id, selected.id)),
			);
			await executeWrites(tx, writes);
			return c.accountPersonResolution.parse({
				status: "linked",
				personId: linked.id,
			});
		});
	},
};
