import { getTableColumns, and, eq, isNotNull, isNull, lte, sql } from "@everyfield/db/query";
import * as tables from "@everyfield/db/tables";
import { alias } from "@everyfield/db/columns";
import type { Transaction } from "@everyfield/db/client";
import { z } from "zod";
import { recordId, accountId, tenantId, revision, type Owner, type sessionId } from "@everyfield/contracts/common";
import * as Q from "@everyfield/contracts/organizations";
import type { OrganizationAdapter } from "@everyfield/contracts/organizations";
import {
	active,
	administrator,
	appendEvent,
	beginCommand,
	checkRevision,
	currentActor,
	finishCommand,
	invalidate,
	liveOwner,
	loadAffiliation,
	pairOf,
	refuse,
	sameOwner,
	unavailable,
	type OrganizationEffects,
} from "./core.ts";
import { readOwnResidency, readPipelinePerson } from "@everyfield/domain/access";
const residency_link_l = alias(tables.residency_link, "l");
const affiliation_a = alias(tables.affiliation, "a");
const invitation_i = alias(tables.invitation, "i");
const person_p = alias(tables.person, "p");
const pipeline_sharing_p = alias(tables.pipeline_sharing, "p");
const residentRow = z.object({
	id: recordId,
	organization_id: tenantId,
	person_id: recordId,
	account_id: accountId.nullable(),
	affiliation_id: recordId,
	consent_revision: revision,
	revision,
	ended_at: z.coerce.date().nullable(),
	share_foundations: z.boolean(),
	share_milestones: z.boolean(),
	organization_kind: z.enum(["sending_church", "sending_network"]),
});
export async function loadResident(tx: Transaction, id: string, write = false) {
	const rows = await tx
		.select({ ...getTableColumns(tables.residency_link), organization_kind: tables.organization.kind })
		.from(tables.residency_link)
		.innerJoin(tables.organization, eq(tables.organization.id, tables.residency_link.organization_id))
		.where(eq(tables.residency_link.id, id))
		.for(write ? "update" : "share", { of: tables.residency_link });
	return rows[0] ? residentRow.parse(rows[0]) : null;
}
// All saved-result/export/job/byte/model consumers must pass the original witness
// through this current gate, before loading any progress. It returns no progress.
export async function canReadResidentProgress(
	tx: Transaction,
	session: z.infer<typeof sessionId>,
	selected: Owner,
	raw: unknown,
): Promise<boolean> {
	const q = z
		.strictObject({ linkId: recordId, consentRevision: revision, category: z.enum(["foundations", "milestones"]) })
		.parse(raw);
	const l = await loadResident(tx, q.linkId);
	if (
		!l ||
		l.ended_at !== null ||
		l.consent_revision !== q.consentRevision ||
		!(q.category === "foundations" ? l.share_foundations : l.share_milestones) ||
		selected.kind !== "organization" ||
		selected.id !== l.organization_id
	)
		return false;
	const access = await readPipelinePerson(tx, session, selected, { personId: l.person_id });
	if (access.status !== "allowed") return false;
	if (l.account_id === null || !(await liveOwner(tx, { kind: "account", id: l.account_id }))) return false;
	const source = await tx
		.select({ id: residency_link_l.id })
		.from(residency_link_l)
		.innerJoin(
			affiliation_a,
			and(
				and(
					eq(affiliation_a.id, residency_link_l.affiliation_id),
					eq(affiliation_a.account_id, residency_link_l.account_id),
				),
				eq(affiliation_a.organization_id, residency_link_l.organization_id),
			),
		)
		.innerJoin(
			invitation_i,
			and(
				and(
					eq(invitation_i.id, residency_link_l.invitation_id),
					eq(invitation_i.tenant_id, residency_link_l.organization_id),
				),
				eq(invitation_i.accepted_account_id, residency_link_l.account_id),
			),
		)
		.innerJoin(
			person_p,
			and(
				and(eq(person_p.id, residency_link_l.person_id), eq(person_p.tenant_id, residency_link_l.organization_id)),
				eq(person_p.linked_account_id, residency_link_l.account_id),
			),
		)
		.where(
			and(
				and(
					and(
						and(
							and(
								and(
									and(
										and(
											and(eq(residency_link_l.id, l.id), isNull(residency_link_l.ended_at)),
											lte(
												residency_link_l.accepted_at,
												sql<Date>`clock_timestamp()`.mapWith((value: string) => new Date(value)),
											),
										),
										isNull(affiliation_a.ended_at),
									),
									lte(
										affiliation_a.accepted_at,
										sql<Date>`clock_timestamp()`.mapWith((value: string) => new Date(value)),
									),
								),
								eq(invitation_i.state, "accepted"),
							),
							eq(invitation_i.purpose, "residency_link"),
						),
						eq(invitation_i.resident_person_id, residency_link_l.person_id),
					),
					eq(person_p.state, "live"),
				),
				sql<unknown>`(NOT exists(SELECT  FROM lifecycle_witness  AS w  WHERE ((w .affiliation_id = a .id) AND (w .state != ('active')))))`,
			),
		)
		.for("share", { of: [residency_link_l, affiliation_a, invitation_i, person_p] });
	return source.length === 1;
}
export function consentOperations(
	effects: OrganizationEffects,
): Pick<
	OrganizationAdapter<Transaction>,
	| "residency.readSharing"
	| "residency.setSharing"
	| "residency.leave"
	| "pipelineSharing.readConsent"
	| "pipelineSharing.setConsent"
	| "pipelineSharing.checkAggregateAccess"
> {
	return {
		async "residency.readSharing"(tx, session, selected, raw) {
			const q = Q.residencySharingRequest.parse(raw),
				l = await loadResident(tx, q.linkId),
				actor = await currentActor(tx, session, selected);
			if (!l || actor.status !== "active" || selected.kind !== "account" || l.account_id !== actor.accountId)
				return unavailable();
			if (l.ended_at !== null) return Q.residencySharingResult.parse({ status: "ended", linkId: l.id });
			const organization = Q.organizationOwner.parse({
				kind: "organization",
				id: l.organization_id,
				organizationKind: l.organization_kind,
			});
			if (!(await readOwnResidency(tx, session, organization, { personId: l.person_id }))) return unavailable();
			return Q.residencySharingResult.parse({
				status: "active",
				linkId: l.id,
				organization,
				consentRevision: l.consent_revision,
				choices: { shareFoundations: l.share_foundations, shareMilestones: l.share_milestones },
			});
		},
		async "residency.setSharing"(tx, session, selected, raw) {
			return changeResident(tx, session, selected, raw, false);
		},
		async "residency.leave"(tx, session, selected, raw) {
			return changeResident(tx, session, selected, raw, true);
		},
		async "pipelineSharing.readConsent"(tx, session, selected, raw) {
			const q = Q.pipelineConsentRequest.parse(raw),
				a = await loadAffiliation(tx, q.relationshipId),
				actor = await currentActor(tx, session, selected);
			if (
				!a ||
				actor.status !== "active" ||
				!administrator(actor) ||
				selected.kind !== "organization" ||
				selected.organizationKind !== "sending_church" ||
				a.sending_church_id !== selected.id ||
				!(await active(tx, a))
			)
				return unavailable();
			const r = await tx
				.select({ share_pipeline_totals: tables.pipeline_sharing.share_pipeline_totals })
				.from(tables.pipeline_sharing)
				.where(
					and(
						and(
							eq(tables.pipeline_sharing.relationship_id, a.id),
							eq(tables.pipeline_sharing.organization_id, a.sending_church_id),
						),
						eq(tables.pipeline_sharing.network_id, a.organization_id),
					),
				)
				.for("share");
			return Q.pipelineConsentResult.parse({
				status: "available",
				relationshipId: a.id,
				revision: a.revision,
				sharePipelineTotals: r[0]?.share_pipeline_totals ?? false,
				minimumContributors: 2,
			});
		},
		async "pipelineSharing.setConsent"(tx, session, selected, raw) {
			const q = Q.setPipelineConsentRequest.parse(raw),
				a = await loadAffiliation(tx, q.input.relationshipId, true),
				actor = await currentActor(tx, session, selected);
			if (
				!a ||
				actor.status !== "active" ||
				!administrator(actor) ||
				selected.kind !== "organization" ||
				selected.organizationKind !== "sending_church" ||
				a.sending_church_id !== selected.id ||
				!(await active(tx, a))
			)
				refuse();
			const c = await beginCommand(tx, actor, selected, "pipelineSharing.setConsent", q);
			if (c.kind === "replay") return Q.mutationResult.parse(c.result);
			checkRevision(q.expectedRevision, a.revision);
			await tx
				.insert(tables.pipeline_sharing)
				.values({
					id: sql`gen_random_uuid()`,
					organization_id: selected.id,
					relationship_id: a.id,
					network_id: a.organization_id,
					share_pipeline_totals: q.input.sharePipelineTotals,
					changed_by: actor.accountId,
					revision: "1",
				})
				.onConflictDoUpdate({
					target: tables.pipeline_sharing.relationship_id,
					set: {
						share_pipeline_totals: q.input.sharePipelineTotals,
						changed_by: actor.accountId,
						revision: sql`${tables.pipeline_sharing.revision}+1`,
					},
				});
			await tx
				.update(tables.affiliation)
				.set({ revision: sql<unknown>`(${tables.affiliation.revision} + 1)` })
				.where(eq(tables.affiliation.id, a.id));
			const next = String(BigInt(a.revision) + 1n),
				event = await appendEvent(tx, c, a.id, "preference", "sharing.changed", a.revision, next);
			await invalidate(tx, effects, pairOf(a), a.id, next);
			return finishCommand(tx, c, (r) => Q.mutationResult.parse({ status: "committed", receipt: r }), [event]);
		},
		async "pipelineSharing.checkAggregateAccess"(tx, session, selected, raw) {
			const q = Q.pipelineAggregateAccessRequest.parse(raw),
				actor = await currentActor(tx, session, selected);
			if (actor.status !== "active" || !sameOwner(selected, q.network))
				return Q.pipelineAggregateAccessResult.parse({ allowed: false, minimumContributors: 2 });
			const r = await tx
				.select({ id: affiliation_a.id, organization_id: pipeline_sharing_p.organization_id })
				.from(affiliation_a)
				.innerJoin(
					pipeline_sharing_p,
					and(
						and(
							eq(pipeline_sharing_p.relationship_id, affiliation_a.id),
							eq(pipeline_sharing_p.organization_id, affiliation_a.sending_church_id),
						),
						eq(pipeline_sharing_p.network_id, affiliation_a.organization_id),
					),
				)
				.where(
					and(
						and(
							and(
								and(eq(affiliation_a.organization_id, selected.id), pipeline_sharing_p.share_pipeline_totals),
								isNotNull(affiliation_a.sending_church_id),
							),
							isNull(affiliation_a.ended_at),
						),
						lte(
							affiliation_a.accepted_at,
							sql<Date>`clock_timestamp()`.mapWith((value: string) => new Date(value)),
						),
					),
				)
				.for("share", { of: [affiliation_a, pipeline_sharing_p] });
			const contributors = new Set<string>();
			for (const row of r) {
				const a = await loadAffiliation(tx, row.id);
				if (a && (await active(tx, a))) contributors.add(row.organization_id);
			}
			return Q.pipelineAggregateAccessResult.parse({ allowed: contributors.size >= 2, minimumContributors: 2 });
		},
	};
	async function changeResident(
		tx: Transaction,
		session: z.infer<typeof sessionId>,
		selected: Owner,
		raw: unknown,
		leave: boolean,
	) {
		const q = leave ? Q.leaveResidencyRequest.parse(raw) : Q.setResidencySharingRequest.parse(raw),
			l = await loadResident(tx, q.input.linkId, true),
			actor = await currentActor(tx, session, selected);
		if (!l || actor.status !== "active" || selected.kind !== "account" || selected.id !== l.account_id) refuse();
		const organization = Q.organizationOwner.parse({
			kind: "organization",
			id: l.organization_id,
			organizationKind: l.organization_kind,
		});
		if (l.ended_at === null && !(await readOwnResidency(tx, session, organization, { personId: l.person_id })))
			refuse();
		const c = await beginCommand(tx, actor, selected, leave ? "residency.leave" : "residency.setSharing", q);
		if (c.kind === "replay") return Q.mutationResult.parse(c.result);
		if (l.ended_at !== null) {
			if (!leave) refuse();
			return finishCommand(tx, c, (r) => Q.mutationResult.parse({ status: "committed", receipt: r }), [], false);
		}
		checkRevision(q.expectedRevision, l.revision);
		checkRevision(q.input.expectedConsentRevision, l.consent_revision);
		const choices =
			"choices" in q.input
				? Q.residentChoices.parse(q.input.choices)
				: { shareFoundations: false, shareMilestones: false };
		await tx
			.update(tables.residency_link)
			.set({
				share_foundations: choices.shareFoundations,
				share_milestones: choices.shareMilestones,
				consent_revision: sql<unknown>`(${tables.residency_link.consent_revision} + 1)`,
				revision: sql<unknown>`(${tables.residency_link.revision} + 1)`,
				ended_at: sql<unknown>`CASE WHEN ${sql.param(leave)} THEN clock_timestamp() ELSE NULL END`,
			})
			.where(eq(tables.residency_link.id, l.id));
		const next = String(BigInt(l.revision) + 1n),
			event = await appendEvent(tx, c, l.id, leave ? "remove" : "preference", null, l.revision, next);
		await tx
			.update(tables.organization)
			.set({ material_revision: sql<unknown>`(${tables.organization.material_revision} + 1)` })
			.where(eq(tables.organization.id, l.organization_id));
		await effects.invalidate(tx, { owner: organization, sourceId: l.id, revision: next });
		return finishCommand(tx, c, (r) => Q.mutationResult.parse({ status: "committed", receipt: r }), [event]);
	}
}
