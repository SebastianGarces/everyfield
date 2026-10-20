import { getTableColumns, and, asc, eq, isNotNull, isNull, or, sql } from "@everyfield/db/query";
import * as tables from "@everyfield/db/tables";
import { alias } from "@everyfield/db/columns";
import { randomUUID } from "node:crypto";
import * as c from "@everyfield/contracts/people";
import type { OrganizationPeopleProducer } from "@everyfield/contracts/people";
import {
	authorize,
	canReadPerson,
	deny,
	expected,
	live,
	mutation,
	parse,
	patchPerson,
	person,
	project,
	reply,
	attribution,
} from "./core.ts";
import type { Context, Tx } from "./core.ts";
import { insertPerson, retire, restore } from "./people.ts";
const enrollment_milestone_m = alias(tables.enrollment_milestone, "m");
const development_enrollment_e = alias(tables.development_enrollment, "e");
const residency_link_l = alias(tables.residency_link, "l");
const affiliation_a = alias(tables.affiliation, "a");
const invitation_i = alias(tables.invitation, "i");
const pipeline_stage_move_m = alias(tables.pipeline_stage_move, "m");
const pipeline_stage_s = alias(tables.pipeline_stage, "s");
function organization(ctx: Context) {
	if (ctx.selected.kind !== "organization") deny();
	return ctx.selected;
}
export const organizationPeople: OrganizationPeopleProducer<Tx> = {
	async create(tx, ctx, raw) {
		return reply(tx, async () => {
			organization(ctx);
			const input = parse(c.createOrganizationPersonRequest, raw);
			return c.organizationPersonMutationResult.parse(
				await mutation(tx, ctx, "orgPeople.create", input, async (_actor, id) => {
					const after = await insertPerson(tx, ctx, input.input);
					return {
						value: {
							person: await project(tx, ctx, after),
							receiptId: id,
							outcome: "changed",
							needsOwner: [],
						},
						subject: after.id,
						action: "people.created",
						after,
					};
				}),
			);
		});
	},
	async read(tx, ctx, raw) {
		return reply(tx, async () => {
			organization(ctx);
			const input = parse(c.personRequest, raw);
			await authorize(tx, ctx);
			const p = await person(tx, ctx, input.personId);
			await canReadPerson(tx, ctx, p);
			return c.organizationPerson.parse(await project(tx, ctx, p));
		});
	},
	async update(tx, ctx, raw) {
		return reply(tx, async () => {
			organization(ctx);
			const input = parse(c.updateOrganizationPersonRequest, raw);
			return c.organizationPersonMutationResult.parse(
				await mutation(tx, ctx, "orgPeople.update", input, async (_actor, id) => {
					const { before, after } = await patchPerson(
						tx,
						ctx,
						input.input.personId,
						input.expectedRevision,
						input.input.patch,
					);
					return {
						value: {
							person: await project(tx, ctx, after),
							receiptId: id,
							outcome: "changed",
							needsOwner: [],
						},
						subject: before.id,
						action: "people.updated",
						before,
						after,
					};
				}),
			);
		});
	},
	async retire(tx, ctx, raw) {
		return reply(tx, async () => {
			organization(ctx);
			const input = parse(c.retirePersonRequest, raw);
			if (input.input.handoffs.length) deny("invalid_input");
			return c.organizationPersonMutationResult.parse(await retire(tx, ctx, input, "orgPeople.retire"));
		});
	},
	async restore(tx, ctx, raw) {
		return reply(tx, async () => {
			organization(ctx);
			return c.organizationPersonMutationResult.parse(
				await restore(tx, ctx, parse(c.restorePersonRequest, raw), "orgPeople.restore"),
			);
		});
	},
	async export(tx, ctx, raw) {
		return reply(tx, () => exportPerson(tx, ctx, raw));
	},
	async remove(tx, ctx, raw) {
		return reply(tx, async () => {
			const org = organization(ctx),
				input = parse(c.removeOrganizationPersonRequest, raw);
			if (ctx.purpose !== "native") deny();
			return c.removalResult.parse(
				await mutation(tx, ctx, "orgPeople.remove", input, async (actor, id) => {
					const before = await person(tx, ctx, input.input.personId, true);
					expected(before, input.expectedRevision);
					const links=await tx.execute(sql`WITH ended AS (
 UPDATE residency_link SET ended_at=coalesce(ended_at,clock_timestamp()),share_foundations=false,share_milestones=false,consent_revision=consent_revision+1,revision=revision+1
 WHERE organization_id=${org.id}::uuid AND person_id=${before.id}::uuid RETURNING affiliation_id
) UPDATE affiliation a SET ended_at=coalesce(a.ended_at,clock_timestamp()),revision=a.revision+1 FROM ended WHERE a.id=ended.affiliation_id RETURNING a.id`);
					await tx
						.update(tables.invitation)
						.set({
							state: sql<unknown>`CASE WHEN (${tables.invitation.state} = 'pending') THEN 'revoked' ELSE ${tables.invitation.state} END`,
							recipient_email: "removed@example.invalid",
							revision: sql<unknown>`(${tables.invitation.revision} + 1)`,
						})
						.where(and(eq(tables.invitation.tenant_id, org.id), eq(tables.invitation.resident_person_id, before.id)));
					await tx
						.update(tables.person_note)
						.set({
							body: "",
							removed_at: sql<Date>`coalesce(${tables.person_note.removed_at}, clock_timestamp())`.mapWith(
								(value: string) => new Date(value),
							),
							revision: sql<unknown>`(${tables.person_note.revision} + 1)`,
						})
						.where(and(eq(tables.person_note.tenant_id, org.id), eq(tables.person_note.person_id, before.id)));
					await tx
						.update(tables.leadership_conversation)
						.set({ note: null, revision: sql<unknown>`(${tables.leadership_conversation.revision} + 1)` })
						.where(
							and(
								eq(tables.leadership_conversation.organization_id, org.id),
								eq(tables.leadership_conversation.person_id, before.id),
							),
						);
					await tx
						.update(tables.pipeline_stage_move)
						.set({ reason: "Removed", revision: sql<unknown>`(${tables.pipeline_stage_move.revision} + 1)` })
						.where(
							and(
								eq(tables.pipeline_stage_move.organization_id, org.id),
								eq(tables.pipeline_stage_move.person_id, before.id),
							),
						);
					// Feedback bodies are not needed to preserve independently owned completions.
					await tx
						.update(tables.assignment_feedback)
						.set({
							body: "",
							withdrawn_at: sql<Date>`coalesce(${tables.assignment_feedback.withdrawn_at}, clock_timestamp())`.mapWith(
								(value: string) => new Date(value),
							),
							revision: sql<unknown>`(${tables.assignment_feedback.revision} + 1)`,
						})
						.where(
							and(
								eq(tables.assignment_feedback.organization_id, org.id),
								sql<boolean>`(${tables.assignment_feedback.enrollment_milestone_id} IN (SELECT m .id  FROM enrollment_milestone  AS m INNER JOIN development_enrollment  AS e ON ((e .id = m .enrollment_id) AND (e .organization_id = m .organization_id))  WHERE ((e .person_id = (${before.id})) AND (e .organization_id = (${org.id})))))`,
							),
						);
					await tx
						.update(tables.pipeline_person)
						.set({
							assessed_on: null,
							assessor_label: null,
							responsible_seat_id: null,
							revision: sql<unknown>`(${tables.pipeline_person.revision} + 1)`,
						})
						.where(
							and(eq(tables.pipeline_person.organization_id, org.id), eq(tables.pipeline_person.person_id, before.id)),
						);
					const completions = await tx
						.select({ id: enrollment_milestone_m.id })
						.from(enrollment_milestone_m)
						.innerJoin(
							development_enrollment_e,
							and(
								eq(development_enrollment_e.id, enrollment_milestone_m.enrollment_id),
								eq(development_enrollment_e.organization_id, enrollment_milestone_m.organization_id),
							),
						)
						.where(
							and(
								and(
									eq(development_enrollment_e.organization_id, org.id),
									eq(development_enrollment_e.person_id, before.id),
								),
								isNotNull(enrollment_milestone_m.completed_at),
							),
						);
					const enrollments = await tx
						.update(tables.development_enrollment)
						.set({
							status: sql<unknown>`CASE WHEN (${tables.development_enrollment.status} = 'active') THEN 'withdrawn' ELSE ${tables.development_enrollment.status} END`,
							cohort_label: "",
							next_meeting_at: null,
							revision: sql<unknown>`(${tables.development_enrollment.revision} + 1)`,
						})
						.where(
							and(
								eq(tables.development_enrollment.organization_id, org.id),
								eq(tables.development_enrollment.person_id, before.id),
							),
						)
						.returning({ id: tables.development_enrollment.id });
					await tx
						.update(tables.person)
						.set({
							display_name: "Former participant",
							first_name: null,
							last_name: null,
							email: null,
							phone: null,
							street: null,
							city: null,
							state_province: null,
							postal_code: null,
							country: null,
							source_details: null,
							notes: null,
							birth_date: null,
							linked_account_id: null,
							photo_object_id: null,
							state: "retired",
							retired_at: sql<Date>`coalesce(${tables.person.retired_at}, clock_timestamp())`.mapWith(
								(value: string) => new Date(value),
							),
							revision: sql<unknown>`(${tables.person.revision} + 1)`,
						})
						.where(eq(tables.person.id, before.id));
					const after = await person(tx, ctx, before.id, true);
					const witness = (
						await tx
							.insert(tables.organization_person_removal)
							.values({
								id: randomUUID(),
								organization_id: org.id,
								person_record_id: before.id,
								removed_at: sql<Date>`clock_timestamp()`.mapWith((value: string) => new Date(value)),
								requested_by: actor,
								witness_checkpoint: sql`${after.revision}`,
								revision: sql`${after.revision}`,
							})
							.returning()
					)[0]!;
					await tx.execute(sql`SELECT purge_organization_person_history(${sql.param(org.id)},${sql.param(before.id)})`);
					const retained = [
						...(completions.length
							? [
									{
										category: "program_completion",
										reason: "independent_organization_fact",
										attribution: "scope_local",
									},
								]
							: []),
						...(enrollments.length
							? [
									{
										category: "enrollment",
										reason: "independent_organization_fact",
										attribution: "scope_local",
									},
								]
							: []),
						...(links.rowCount
							? [
									{
										category: "relationship_receipt",
										reason: "revocation_enforcement",
										attribution: "scope_local",
									},
								]
							: []),
					];
					// No identifiable pre-removal snapshot or free-text reason is reintroduced.
					return {
						value: {
							witness: {
								organization: org,
								personRecordId: before.id,
								removedAt: witness.removed_at.toISOString(),
								revision: witness.revision,
								checkpoint: witness.witness_checkpoint,
							},
							receiptId: id,
							retained,
						},
						subject: before.id,
						action: "people.retired",
						after,
					};
				}),
			);
		});
	},
};
async function exportPerson(tx: Tx, ctx: Context, raw: unknown) {
	const org = organization(ctx);
	if (!["native", "export"].includes(ctx.purpose)) deny();
	const input = parse(c.exportOrganizationPersonRequest, raw);
	const actor = await authorize(tx, ctx, true);
	const p = await person(tx, ctx, input.personId),
		dto = c.organizationPerson.parse(await project(tx, ctx, p));
	const links = await tx
		.select({
			consent_revision: residency_link_l.consent_revision,
			share_milestones: residency_link_l.share_milestones,
		})
		.from(residency_link_l)
		.innerJoin(
			affiliation_a,
			and(
				eq(affiliation_a.id, residency_link_l.affiliation_id),
				eq(affiliation_a.organization_id, residency_link_l.organization_id),
			),
		)
		.innerJoin(
			invitation_i,
			and(
				eq(invitation_i.id, residency_link_l.invitation_id),
				eq(invitation_i.tenant_id, residency_link_l.organization_id),
			),
		)
		.where(
			and(
				and(
					and(
						and(
							and(eq(residency_link_l.organization_id, org.id), eq(residency_link_l.person_id, p.id)),
							isNull(residency_link_l.ended_at),
						),
						isNull(affiliation_a.ended_at),
					),
					eq(invitation_i.state, "accepted"),
				),
				sql<unknown>`(NOT exists(SELECT  FROM lifecycle_witness  AS w  WHERE ((w .account_id = l .account_id) AND (w .state NOT IN (('active'), ('cancelled'))))))`,
			),
		)
		.for("share", { of: [residency_link_l, affiliation_a, invitation_i] });
	const link = links[0]!;
	const history = await tx
		.select({
			id: pipeline_stage_move_m.id,
			to_stage_id: pipeline_stage_move_m.to_stage_id,
			moved_at: pipeline_stage_move_m.moved_at,
			actor_id: pipeline_stage_move_m.actor_id,
			label: pipeline_stage_move_m.new_label,
		})
		.from(pipeline_stage_move_m)
		.innerJoin(
			pipeline_stage_s,
			and(
				eq(pipeline_stage_s.id, pipeline_stage_move_m.to_stage_id),
				eq(pipeline_stage_s.organization_id, pipeline_stage_move_m.organization_id),
			),
		)
		.where(and(eq(pipeline_stage_move_m.organization_id, org.id), eq(pipeline_stage_move_m.person_id, p.id)))
		.orderBy(asc(pipeline_stage_move_m.moved_at), asc(pipeline_stage_move_m.id))
		.limit(1001);
	const enrollments = await tx
		.select({
			id: tables.development_enrollment.id,
			program_id: tables.development_enrollment.program_id,
			status: tables.development_enrollment.status,
		})
		.from(tables.development_enrollment)
		.where(
			and(eq(tables.development_enrollment.organization_id, org.id), eq(tables.development_enrollment.person_id, p.id)),
		)
		.orderBy(asc(tables.development_enrollment.id))
		.limit(1001);
	const milestones = await tx
		.select(getTableColumns(enrollment_milestone_m))
		.from(enrollment_milestone_m)
		.innerJoin(
			development_enrollment_e,
			and(
				eq(development_enrollment_e.id, enrollment_milestone_m.enrollment_id),
				eq(development_enrollment_e.organization_id, enrollment_milestone_m.organization_id),
			),
		)
		.where(
			and(
				and(
					and(eq(development_enrollment_e.organization_id, org.id), eq(development_enrollment_e.person_id, p.id)),
					isNotNull(enrollment_milestone_m.completed_at),
				),
				or(
					eq(enrollment_milestone_m.completion_source, "program_leader_recorded"),
					sql`${link?.share_milestones ?? false}`,
				),
			),
		)
		.orderBy(asc(enrollment_milestone_m.id))
		.limit(1001)
		.for("share", { of: [enrollment_milestone_m, development_enrollment_e] });
	if ([history, enrollments, milestones].some((r) => r.length > 1000)) deny("source_unavailable");
	const stageHistory = [];
	for (const h of history)
		stageHistory.push({
			stageId: h.to_stage_id,
			label: h.label,
			occurredAt: h.moved_at.toISOString(),
			actor: await attribution(tx, h.actor_id, org.id + ":" + h.id),
		});
	const completions = [];
	for (const m of milestones)
		completions.push({
			milestoneId: m.milestone_id,
			completedAt: m.completed_at!.toISOString(),
			source: m.completion_source === "resident_self" ? "resident" : "program_leader_recorded",
			recordedBy: await attribution(tx, m.completed_by, org.id + ":" + m.id),
			confirmation: m.confirmed_at
				? {
						status: "confirmed",
						at: m.confirmed_at.toISOString(),
						by: await attribution(tx, m.confirmed_by, org.id + ":" + m.id),
					}
				: { status: "pending" },
		});
	const { displayName, firstName, lastName, email, phone, street, city, stateProvince, postalCode, country } = dto;
	await tx.insert(tables.event).values({
		tenant_id: org.id,
		target_record_id: p.id,
		actor_id: actor.accountId,
		kind: "read",
		occurred_at: sql<Date>`clock_timestamp()`.mapWith((value: string) => new Date(value)),
		recorded_at: sql<Date>`clock_timestamp()`.mapWith((value: string) => new Date(value)),
		event_key: randomUUID(),
		action: "security.bulk_export",
	});
	return c.organizationExport.parse({
		organization: org,
		personId: p.id,
		sourceRevision: p.revision,
		consentRevision: link?.consent_revision ?? null,
		producedAt: new Date().toISOString(),
		contact: {
			displayName,
			firstName,
			lastName,
			email,
			phone,
			street,
			city,
			stateProvince,
			postalCode,
			country,
		},
		stageHistory,
		programs: enrollments.map((e) => ({
			programId: e.program_id,
			status: e.status === "withdrawn" ? "ended" : e.status,
		})),
		completions,
	});
}
// Streaming adapters call this again at download, rather than issuing reusable
// bearer URLs or returning bytes copied before authority/consent changed.
export async function downloadOrganizationExport(tx: Tx, ctx: Context, raw: unknown) {
	return reply(tx, async () => {
		const data = await exportPerson(tx, ctx, raw);
		const rows = [
			["category", "field", "value"],
			...Object.entries(data.contact).map(([k, v]) => ["contact", k, v ?? ""]),
			...data.stageHistory.map((h) => ["stage", h.stageId, h.label]),
			...data.programs.map((p) => ["program", p.programId, p.status]),
			...data.completions.map((m) => ["completion", m.milestoneId, m.completedAt]),
		];
		const escape = (v: unknown) => {
			let s = String(v);
			if (/^[\s\u0000-\u001f]*[=+@-]/.test(s)) s = "'" + s;
			return '"' + s.replaceAll('"', '""') + '"';
		};
		return {
			mediaType: "text/csv; charset=utf-8",
			filename: "person.csv",
			bytes: Buffer.from(rows.map((r) => r.map(escape).join(",")).join("\r\n") + "\r\n"),
		};
	});
}
