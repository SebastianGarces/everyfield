import { and, asc, inArray, eq, isNotNull, isNull, or, sql, type SQLWrapper } from "@everyfield/db/query";
import * as tables from "@everyfield/db/tables";

import { executeWrites } from "../operations/writes.ts";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import * as c from "@everyfield/contracts/people";
import type { PeopleWriter, AccountPersonProducer } from "@everyfield/contracts/people";
import { owner, recordId } from "@everyfield/contracts/common";
import {
	authorize,
	deny,
	expected,
	live,
	hash,
	lockOwner,
	mutation,
	parse,
	patchPerson,
	contactValues,
	personChanges,
	person,
	personRow,
	project,
	reply,
} from "./core.ts";
import type { Context, WriteContext, Tx, Person } from "./core.ts";

export function appendPerson(
	tx: Tx,
	context: Pick<Context, "selected">,
	raw: z.infer<typeof c.createPersonRequest>["input"] | z.infer<typeof c.createOrganizationPersonRequest>["input"],
	writes: SQLWrapper[],
	linkedAccountId: string | null = null,
) {
	const plant = context.selected.kind === "plant",
		p = c.createPersonRequest.shape.input.parse(raw);
	const id = randomUUID(),
		at = new Date();
	const row = personRow.parse({
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
	writes.push(
		tx.insert(tables.person).values({ ...row, birth_date: row.birth_date?.toISOString().slice(0, 10) ?? null }),
	);
	return row;
}

/**
 * A key at the end of a pipeline column (D68): the time in milliseconds, with a fixed-width fraction from the person's
 * ID so that two people never share a key. New people, a stage change into another column and a restore get one;
 * moves inside a column then always find a key strictly between two neighbours.
 */
function freshPosition(id: string, at = new Date()): string {
	return `${at.getTime()}.${BigInt("0x" + id.replaceAll("-", "").slice(-12))
		.toString()
		.padStart(15, "0")}`;
}
const COMMITTED = ["core_group", "launch_team", "leader"];
const sameColumn = (a: string, b: string) => a === b || (COMMITTED.includes(a) && COMMITTED.includes(b));

async function output(tx: Tx, ctx: Context, p: Person, id: string, needsOwner: string[] = [], outcome = "changed") {
	return {
		person: await project(tx, ctx, p),
		receiptId: id,
		outcome,
		needsOwner,
	};
}
export async function openDuties(tx: Tx, ctx: Context, p: Person) {
	if (ctx.selected.kind !== "plant") return [];
	// Tasks store account assignees; Person subjects are separate references.
	const r = await tx
		.select({
			id: tables.task.id,
			revision: tables.task.revision,
			due_date: tables.task.due_date,
			parent_id: tables.task.parent_id,
		})
		.from(tables.task)
		.where(
			and(
				and(
					and(
						eq(tables.task.plant_id, ctx.selected.id),
						or(
							eq(tables.task.person_id, p.id),
							and(
								sql`${tables.task.assignee_id} = ${p.linked_account_id}`,
								isNotNull(sql<string>`(${sql.param(p.linked_account_id)})::uuid`),
							),
						),
					),
					isNull(tables.task.deleted_at),
				),
				sql<boolean>`(${tables.task.status} NOT IN ('complete', 'no_longer_needed'))`,
			),
		)
		.orderBy(asc(tables.task.id))
		.for("update");
	return r;
}
async function handoff(tx: Tx, ctx: Context, p: Person, choices: z.infer<typeof c.handoffChoice>[]) {
	const duties = await openDuties(tx, ctx, p),
		byId = new Map(choices.map((c) => [c.dutyId, c]));
	if (
		byId.size !== choices.length ||
		duties.length !== choices.length ||
		duties.some((d) => !byId.has(recordId.parse(d.id)))
	)
		deny("conflict");

	const assignments = choices.filter((choice) => choice.kind === "assign");
	const targetIds = assignments.map((choice) => choice.toPersonId);
	const targets = targetIds.length
		? await tx
				.select()
				.from(tables.person)
				.where(and(inArray(tables.person.id, targetIds), eq(tables.person.tenant_id, ctx.selected.id)))
				.orderBy(tables.person.id)
				.for("update")
		: [];
	const accounts = targets.flatMap((target) => (target.linked_account_id ? [target.linked_account_id] : []));
	const seats = accounts.length
		? await tx
				.select({ account: tables.seat.account_id })
				.from(tables.seat)
				.where(
					and(
						inArray(tables.seat.account_id, accounts),
						eq(tables.seat.plant_id, ctx.selected.id),
						isNull(tables.seat.ended_at),
						sql`${tables.seat.accepted_at}<=clock_timestamp()`,
					),
				)
				.for("share")
		: [];
	const needsOwner: string[] = [];
	const changes = duties.map((duty) => {
		const choice = byId.get(recordId.parse(duty.id))!;
		if (choice.expectedRevision !== duty.revision) deny("conflict");
		if (choice.kind !== "assign") {
			needsOwner.push(duty.id);
			return { id: duty.id, account: null };
		}
		const target = targets.find((target) => target.id === choice.toPersonId);
		if (!target || target.state !== "live") deny();
		if (target.id === p.id) deny("invalid_subject");
		if (!seats.some((seat) => seat.account === target.linked_account_id)) deny();
		return { id: duty.id, account: target.linked_account_id };
	});
	if (changes.length)
		await tx.execute(
			sql`UPDATE task t SET assignee_id=v.account,revision=t.revision+1 FROM jsonb_to_recordset(${JSON.stringify(changes)}::jsonb) v(id uuid,account uuid) WHERE t.id=v.id`,
		);

	return needsOwner;
}
export const peopleWriter: PeopleWriter<Tx> = {
	async createPerson(tx, ctx, raw) {
		return reply(tx, async () => {
			if (ctx.selected.kind !== "plant") deny();
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
			if (ctx.selected.kind !== "plant") deny();
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
	async changeStatus(tx, ctx, raw) {
		return reply(tx, async () => {
			if (ctx.selected.kind !== "plant") deny();
			const input = parse(c.changeStatusRequest, raw);
			return c.plantPersonMutationResult.parse(
				await mutation(tx, ctx, "people.changeStatus", input, async (_a, id, audit) => {
					const before = await person(tx, ctx, input.input.personId, true);
					live(before);
					expected(before, input.expectedRevision);
					const noop = before.stage === input.input.stage;
					const leaving =
						["core_group", "launch_team", "leader"].includes(before.stage!) &&
						!["core_group", "launch_team", "leader"].includes(input.input.stage);
					const needsOwner = !noop && leaving ? await handoff(tx, ctx, before, input.input.handoffs) : [];
					if (!leaving && input.input.handoffs.length) deny("invalid_input");
					// Into another column: the person goes to its end with a fresh key (D68).
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
	async retirePerson(tx, ctx, raw) {
		return reply(tx, async () => {
			if (ctx.selected.kind !== "plant") deny();
			const input = parse(c.retirePersonRequest, raw);
			return c.plantPersonMutationResult.parse(await retire(tx, ctx, input, "people.deletePerson"));
		});
	},
	async restorePerson(tx, ctx, raw) {
		return reply(tx, async () => {
			if (ctx.selected.kind !== "plant") deny();
			const input = parse(c.restorePersonRequest, raw);
			return c.plantPersonMutationResult.parse(await restore(tx, ctx, input, "people.restorePerson"));
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
			if (ctx.selected.kind !== "plant") deny();
			const input = parse(c.reorderPipelineRequest, raw);
			return pipelineOrder(tx, ctx, input);
		});
	},
};
export async function retire(
	tx: Tx,
	ctx: WriteContext,
	input: z.infer<typeof c.retirePersonRequest>,
	name: Parameters<typeof mutation>[2],
) {
	return mutation(tx, ctx, name, input, async (_a, id, audit) => {
		const before = await person(tx, ctx, input.input.personId, true);
		expected(before, input.expectedRevision);
		if (before.state === "merged") deny("use_reviewed_unmerge");
		const review =
			ctx.selected.kind === "plant"
				? (
						await tx
							.select({ material_revision: tables.plant.material_revision })
							.from(tables.plant)
							.where(eq(tables.plant.id, ctx.selected.id))
							.for("share")
					)[0]!.material_revision
				: before.revision;
		if (input.input.reviewRevision !== review) deny("conflict");
		let after = before;
		const needsOwner = before.state === "live" ? await handoff(tx, ctx, before, input.input.handoffs) : [];
		// Existing historical endpoints remain; current leadership is ended explicitly.
		if (before.state === "live") {
			const [updated] = await tx
				.update(tables.person)
				.set({
					state: "retired",
					...(ctx.selected.kind === "plant" ? { household_id: null, household_role: null } : {}),
					retired_at: sql<Date>`clock_timestamp()`.mapWith((value: string) => new Date(value)),
					revision: sql<unknown>`(${tables.person.revision} + 1)`,
				})
				.where(eq(tables.person.id, before.id))
				.returning();
			after = personRow.parse(updated);
			if (ctx.selected.kind === "plant") {
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
export async function restore(
	tx: Tx,
	ctx: WriteContext,
	input: z.infer<typeof c.restorePersonRequest>,
	name: Parameters<typeof mutation>[2],
) {
	return mutation(tx, ctx, name, input, async (_a, id) => {
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
						// Back at the end of its column with a fresh key (D68); organization people have no position.
						...(before.pipeline_position === null ? {} : { pipeline_position: freshPosition(before.id) }),
						revision: sql<unknown>`(${tables.person.revision} + 1)`,
					})
					.where(eq(tables.person.id, before.id))
					.returning();
				after = personRow.parse(updated);
			} catch (error) {
				// The unique live account/plant index also arbitrates concurrent relinks.
				// reply() rolls this statement back to its savepoint before returning.
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
type NoteInput =
	z.infer<typeof c.addNoteRequest> | z.infer<typeof c.editNoteRequest> | z.infer<typeof c.deleteNoteRequest>;
async function note(tx: Tx, ctx: WriteContext, input: NoteInput, kind: "add" | "edit" | "delete") {
	// Organization notes remain native-only, including when the author is an admin.
	if (ctx.selected.kind === "organization" && false) deny();
	return mutation(
		tx,
		ctx,
		kind === "add" ? "people.addNote" : kind === "edit" ? "people.editNote" : "people.deleteNote",
		input,
		async (actor, id, audit) => {
			const before = await person(tx, ctx, input.input.personId, true);
			live(before);
			const noteId = "noteId" in input.input ? input.input.noteId : randomUUID();
			let noteRevision = "1";
			if (kind === "add") {
				expected(before, input.expectedRevision);
				let participation: string | null = null;
				if ("meetingId" in input.input && input.input.meetingId) {
					const r = await tx
						.select({ id: tables.participation.id })
						.from(tables.participation)
						.where(
							and(
								and(
									eq(tables.participation.meeting_id, input.input.meetingId),
									eq(tables.participation.person_id, before.id),
								),
								eq(tables.participation.plant_id, ctx.selected.id),
							),
						)
						.for("share");
					if (r.length !== 1) deny();
					participation = r[0]!.id;
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
				const r = await tx
					.select()
					.from(tables.person_note)
					.where(
						and(
							and(
								and(eq(tables.person_note.id, noteId), eq(tables.person_note.tenant_id, ctx.selected.id)),
								eq(tables.person_note.person_id, before.id),
							),
							isNull(tables.person_note.removed_at),
						),
					)
					.for("update");
				if (!r.length || r[0]!.author_id !== actor) deny();
				if (r[0]!.revision !== input.expectedRevision) deny("conflict");
				const body = kind === "delete" ? "" : "body" in input.input ? input.input.body : deny("invalid_input");
				// Exact old/new note bodies live only in protected Person history.
				audit.events.push({
					id,
					tenant_id: ctx.selected.id,
					subject_id: before.id,
					subject_type: "person",
					actor_id: actor,
					actor_token: hash([ctx.selected.id, actor]),
					action: "people.updated",
					kind: "edit",
					before_value: { body: r[0]!.body },
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
				noteRevision = (BigInt(r[0]!.revision) + 1n).toString();
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
		if (ctx.selected.kind !== "plant") deny();
		const input = parse(c.classifyAdultRequest, raw);
		return c.classificationMutationResult.parse(
			await mutation(
				tx,
				ctx,
				correction ? "people.correctAdultClassification" : "people.recordAdultClassification",
				input,
				async (_a, id, audit) => {
					const before = await person(tx, ctx, input.input.personId, true);
					live(before);
					expected(before, input.expectedRevision);
					const now = (
						await tx
							.select({
								today: sql<string>`((clock_timestamp() AT TIME ZONE ${tables.plant.timezone}))::date`,
								timezone: tables.plant.timezone,
							})
							.from(tables.plant)
							.where(eq(tables.plant.id, ctx.selected.id))
					)[0]!;
					if (input.input.occurredOn > now.today) deny("invalid_input");
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
						}),
						dto = c.plantPerson.parse(await project(tx, ctx, after));
					const first = await tx
						.select({ id: tables.commitment.id, signed_on: tables.commitment.signed_on })
						.from(tables.commitment)
						.where(
							and(
								and(eq(tables.commitment.plant_id, ctx.selected.id), eq(tables.commitment.person_id, before.id)),
								isNull(tables.commitment.voided_at),
							),
						)
						.orderBy(asc(tables.commitment.signed_on), asc(tables.commitment.id))
						.limit(1);
					return {
						value: {
							receiptId: id,
							outcome: "changed",
							observation: {
								owner: ctx.selected,
								personId: after.id,
								asOf: new Date().toISOString(),
								zone: now.timezone,
								sourceRevision: after.revision,
								lifecycle: dto.lifecycle,
								classification: dto.adultClassification,
								current: dto.commitment,
								firstAcquisition: first.length
									? {
											status: "known",
											occurredOn: first[0]!.signed_on,
											evidenceId: first[0]!.id,
										}
									: { status: "unknown" },
							},
						},
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
/**
 * Places one person in a pipeline column (D68): right after `afterId`, or first. The person gets a sortable key between
 * the two neighbours, so a move changes one row and writes one audit event, whatever the column's size. The column's
 * revision is the lock: a move against an order that changed meanwhile is refused (REQ-PPL-007).
 */
async function pipelineOrder(tx: Tx, ctx: WriteContext, input: z.infer<typeof c.reorderPipelineRequest>) {
	return c.noteMutationResult.pick({ receiptId: true, outcome: true }).parse(
		await mutation(tx, ctx, "people.reorderPipeline", input, async (actor, id, audit) => {
			const { column, personId: moving, afterId } = input.input;
			const stages = column === "core_group" ? ["core_group", "launch_team", "leader"] : [column];
			// One statement locks the column row and takes its next revision (a first move creates it at 2), and finds the
			// key between the anchor and the next person in column order; the key is null when those two share one.
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
							ELSE (SELECT CASE WHEN nx.k IS NULL THEN a.k + 1 WHEN nx.k > a.k THEN (a.k + nx.k) / 2 END
								FROM anchor a LEFT JOIN col nx ON nx.n = a.n + 1) END)::text AS key`)
				).rows[0],
			);
			if (BigInt(found.revision) - 1n !== BigInt(input.expectedRevision)) deny("conflict");
			const before = await person(tx, ctx, moving, true);
			if (before.state !== "live" || !stages.includes(before.stage!)) deny("conflict");
			if (!found.found) deny("conflict");
			// Keys are unique in a column (new, re-staged and restored people get a fresh key, and migration 0014 spread the
			// old ones), so a key strictly between two neighbours always exists and a move changes exactly one row.
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
			// The write's one audit event, from the wrapper, names the moved person (D70).
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
		return reply(tx, async () => {
			const input = raw,
				selected = owner.parse(input.owner);
			if (selected.kind !== "plant") deny();
			// Trusted collaborator, never a client account selector. Provisioning owns
			// account proof/eligibility and enclosing transaction; these locks arbitrate retries.
			const account = await tx
				.select({ id: tables.account.id })
				.from(tables.account)
				.where(eq(tables.account.id, input.accountId))
				.for("update");
			if (!account.length) deny();
			await tx.select({ id: tables.plant.id }).from(tables.plant).where(eq(tables.plant.id, selected.id)).for("update");
			const exact = await tx
				.select({ id: tables.person.id })
				.from(tables.person)
				.where(
					and(
						and(eq(tables.person.plant_id, selected.id), eq(tables.person.linked_account_id, input.accountId)),
						eq(tables.person.state, "live"),
					),
				)
				.for("update");
			if (exact.length)
				return c.accountPersonResolution.parse({
					status: "linked",
					personId: exact[0]!.id,
				});
			const ctx = { selected };
			const candidates = await tx.execute(
				sql`SELECT p.id FROM person p JOIN access_account_contact(${sql.param(input.accountId)}) a ON lower(p.email)=lower(a.email) WHERE p.plant_id=${sql.param(selected.id)} AND p.state='live' AND p.linked_account_id IS NULL AND a.verified ORDER BY p.id LIMIT 100 FOR UPDATE OF p`,
			);
			if (input.selection.kind === "resolve")
				return candidates.rowCount
					? c.accountPersonResolution.parse({
							status: "needs_selection",
							candidatePersonIds: candidates.rows.map((p) => p.id),
						})
					: deny("invalid_subject");
			const writes: SQLWrapper[] = [];
			let before: Person | undefined, linked: Person;
			if (input.selection.kind === "reviewed_contact") {
				if (input.selection.person.owner.id !== selected.id || input.selection.person.owner.kind !== "plant") deny();
				before = await person(tx, ctx, input.selection.person.personId, true);
				live(before);
				expected(before, input.selection.person.revision);
				if (before.linked_account_id || !candidates.rows.some((x) => x.id === before!.id)) deny();
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
	async ensureGuest(tx, ctx, raw) {
		return reply(tx, async () => {
			const input = parse(c.guestSelection, raw);
			if (ctx.selected.kind !== "plant") deny();
			await lockOwner(tx, ctx);
			await authorize(tx, ctx, true);
			let p: Person;
			if (input.kind === "existing") p = await person(tx, ctx, input.personId, true);
			else {
				const created = await peopleWriter.createPerson(
					tx,
					ctx,
					c.createPersonRequest.parse({
						requestKey: randomUUID(),
						input: {
							displayName: input.displayName,
							email: input.email,
							phone: input.phone,
						},
					}),
				);
				if (created.status !== "ok") deny(created.error.code);
				return c.lockedPersonReference.parse({
					owner: ctx.selected,
					personId: created.value.person.id,
					revision: created.value.person.revision,
					state: "live",
				});
			}
			live(p);
			return c.lockedPersonReference.parse({
				owner: ctx.selected,
				personId: p.id,
				revision: p.revision,
				state: "live",
			});
		});
	},
};
