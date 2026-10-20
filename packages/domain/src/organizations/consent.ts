import { writeActor } from "./core.ts";
import { accountId, recordId, revision, tenantId, type Owner, type sessionId } from "@everyfield/contracts/common";
import type { OrganizationAdapter } from "@everyfield/contracts/organizations";
import * as Q from "@everyfield/contracts/organizations";
import type { Transaction } from "@everyfield/db/client";
import { alias } from "@everyfield/db/columns";
import { and, eq, getTableColumns, inArray, isNotNull, isNull, lte, sql } from "@everyfield/db/query";
import * as tables from "@everyfield/db/tables";
import { readOwnResidency } from "@everyfield/domain/access";
import { z } from "zod";
import { auditSavepoint } from "../operations/writes.ts";
import {
	active,
	administrator,
	appendEvent,
	beginCommand,
	checkRevision,
	currentActor,
	finishCommand,
	invalidate,
	loadAffiliation,
	loadAffiliations,
	pairOf,
	refuse,
	sameOwner,
	unavailable,
	type OrganizationEffects,
} from "./core.ts";
const affiliation_a = alias(tables.affiliation, "a");
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
	const query = tx
		.select({ ...getTableColumns(tables.residency_link), organization_kind: tables.organization.kind })
		.from(tables.residency_link)
		.innerJoin(tables.organization, eq(tables.organization.id, tables.residency_link.organization_id))
		.where(eq(tables.residency_link.id, id));
	const rows = await (write ? query.for("update", { of: tables.residency_link }) : query);
	return rows[0] ? residentRow.parse(rows[0]) : null;
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
			return auditSavepoint(tx, async () => {
				return changeResident(tx, session, selected, raw, false);
			});
		},
		async "residency.leave"(tx, session, selected, raw) {
			return auditSavepoint(tx, async () => {
				return changeResident(tx, session, selected, raw, true);
			});
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
				!active(a)
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
				);
			return Q.pipelineConsentResult.parse({
				status: "available",
				relationshipId: a.id,
				revision: a.revision,
				sharePipelineTotals: r[0]?.share_pipeline_totals ?? false,
				minimumContributors: 2,
			});
		},
		async "pipelineSharing.setConsent"(tx, session, selected, raw) {
			return auditSavepoint(tx, async () => {
				const q = Q.setPipelineConsentRequest.parse(raw),
					a = await loadAffiliation(tx, q.input.relationshipId, true),
					actor = await writeActor(tx, session, selected);
				if (
					!a ||
					actor.status !== "active" ||
					!administrator(actor) ||
					selected.kind !== "organization" ||
					selected.organizationKind !== "sending_church" ||
					a.sending_church_id !== selected.id ||
					!active(a)
				)
					refuse();
				const c = await beginCommand(tx, actor, selected, "pipelineSharing.setConsent", q);
				if (c.kind === "replay") return Q.mutationResult.parse(c.result);
				checkRevision(q.expectedRevision, a.revision);
				c.writes.push(
					tx
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
						}),
					tx
						.update(tables.affiliation)
						.set({ revision: sql<unknown>`(${tables.affiliation.revision} + 1)` })
						.where(eq(tables.affiliation.id, a.id)),
				);
				const next = String(BigInt(a.revision) + 1n);
				await appendEvent(tx, c, a.id, "preference", "sharing.changed", a.revision, next);
				invalidate(tx, effects, c, pairOf(a), a.id, next);
				return finishCommand(tx, c, () => Q.mutationResult.parse({ status: "committed" }));
			});
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
				);
			const contributors = new Set<string>();
			if (r.length)
				for (const a of await loadAffiliations(
					tx,
					inArray(
						tables.affiliation.id,
						r.map((row) => row.id),
					),
				))
					if (a.active && a.sending_church_id) contributors.add(a.sending_church_id);
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
			actor = await writeActor(tx, session, selected);
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
			return finishCommand(tx, c, () => Q.mutationResult.parse({ status: "committed" }));
		}
		checkRevision(q.expectedRevision, l.revision);
		checkRevision(q.input.expectedConsentRevision, l.consent_revision);
		const choices =
			"choices" in q.input
				? Q.residentChoices.parse(q.input.choices)
				: { shareFoundations: false, shareMilestones: false };
		const next = String(BigInt(l.revision) + 1n);
		c.writes.push(
			tx
				.update(tables.residency_link)
				.set({
					share_foundations: choices.shareFoundations,
					share_milestones: choices.shareMilestones,
					consent_revision: sql<unknown>`(${tables.residency_link.consent_revision} + 1)`,
					revision: sql<unknown>`(${tables.residency_link.revision} + 1)`,
					ended_at: sql<unknown>`CASE WHEN ${sql.param(leave)} THEN clock_timestamp() ELSE NULL END`,
				})
				.where(eq(tables.residency_link.id, l.id)),
			tx
				.update(tables.organization)
				.set({ material_revision: sql<unknown>`(${tables.organization.material_revision} + 1)` })
				.where(eq(tables.organization.id, l.organization_id)),
			effects.invalidate(tx, { owners: [organization], sourceId: l.id, revision: next }),
		);
		await appendEvent(tx, c, l.id, leave ? "remove" : "preference", null, l.revision, next);
		return finishCommand(tx, c, () => Q.mutationResult.parse({ status: "committed" }));
	}
}
