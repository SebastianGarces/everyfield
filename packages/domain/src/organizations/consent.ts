import type { PoolClient } from "pg";
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
const residentRow = z.object({
	id: recordId,
	organization_id: tenantId,
	person_id: recordId,
	account_id: accountId.nullable(),
	affiliation_id: recordId,
	consent_revision: revision,
	revision,
	ended_at: z.date().nullable(),
	share_foundations: z.boolean(),
	share_milestones: z.boolean(),
	organization_kind: z.enum(["sending_church", "sending_network"]),
});
export async function loadResident(tx: PoolClient, id: string, write = false) {
	const r = await tx.query(
		`SELECT l.*,o.kind AS organization_kind FROM residency_link l JOIN organization o ON o.id=l.organization_id WHERE l.id=$1 ${write ? "FOR UPDATE OF l" : "FOR SHARE OF l"}`,
		[id],
	);
	return r.rows[0] ? residentRow.parse(r.rows[0]) : null;
}
// All saved-result/export/job/byte/model consumers must pass the original witness
// through this current gate, before loading any progress. It returns no progress.
export async function canReadResidentProgress(
	tx: PoolClient,
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
	const source = await tx.query(
		`SELECT l.id FROM residency_link l JOIN affiliation a ON a.id=l.affiliation_id AND a.account_id=l.account_id AND a.organization_id=l.organization_id
    JOIN invitation i ON i.id=l.invitation_id AND i.tenant_id=l.organization_id AND i.accepted_account_id=l.account_id
    JOIN person p ON p.id=l.person_id AND p.tenant_id=l.organization_id AND p.linked_account_id=l.account_id
    WHERE l.id=$1 AND l.ended_at IS NULL AND l.accepted_at<=clock_timestamp() AND a.ended_at IS NULL AND a.accepted_at<=clock_timestamp()
      AND i.state='accepted' AND i.purpose='residency_link' AND i.resident_person_id=l.person_id AND p.state='live'
      AND NOT EXISTS(SELECT FROM lifecycle_witness w WHERE w.affiliation_id=a.id AND w.state<>'active') FOR SHARE OF l,a,i,p`,
		[l.id],
	);
	return source.rowCount === 1;
}
export function consentOperations(
	effects: OrganizationEffects,
): Pick<
	OrganizationAdapter<PoolClient>,
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
			const r = await tx.query(
				"SELECT share_pipeline_totals FROM pipeline_sharing WHERE relationship_id=$1 AND organization_id=$2 AND network_id=$3 FOR SHARE",
				[a.id, a.sending_church_id, a.organization_id],
			);
			return Q.pipelineConsentResult.parse({
				status: "available",
				relationshipId: a.id,
				revision: a.revision,
				sharePipelineTotals: r.rows[0]?.share_pipeline_totals ?? false,
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
			await tx.query(
				`INSERT INTO pipeline_sharing(id,organization_id,relationship_id,network_id,share_pipeline_totals,changed_by,revision)
        VALUES(gen_random_uuid(),$1,$2,$3,$4,$5,1) ON CONFLICT(relationship_id) DO UPDATE SET share_pipeline_totals=excluded.share_pipeline_totals,changed_by=excluded.changed_by,revision=pipeline_sharing.revision+1`,
				[selected.id, a.id, a.organization_id, q.input.sharePipelineTotals, actor.accountId],
			);
			await tx.query("UPDATE affiliation SET revision=revision+1 WHERE id=$1", [a.id]);
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
			const r = await tx.query<{ id: string; organization_id: string }>(
				`SELECT a.id,p.organization_id FROM affiliation a JOIN pipeline_sharing p ON p.relationship_id=a.id AND p.organization_id=a.sending_church_id AND p.network_id=a.organization_id
        WHERE a.organization_id=$1 AND p.share_pipeline_totals AND a.sending_church_id IS NOT NULL AND a.ended_at IS NULL AND a.accepted_at<=clock_timestamp() FOR SHARE OF a,p`,
				[selected.id],
			);
			const contributors = new Set<string>();
			for (const row of r.rows) {
				const a = await loadAffiliation(tx, row.id);
				if (a && (await active(tx, a))) contributors.add(row.organization_id);
			}
			return Q.pipelineAggregateAccessResult.parse({ allowed: contributors.size >= 2, minimumContributors: 2 });
		},
	};
	async function changeResident(
		tx: PoolClient,
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
		await tx.query(
			"UPDATE residency_link SET share_foundations=$2,share_milestones=$3,consent_revision=consent_revision+1,revision=revision+1,ended_at=CASE WHEN $4 THEN clock_timestamp() ELSE NULL END WHERE id=$1",
			[l.id, choices.shareFoundations, choices.shareMilestones, leave],
		);
		const next = String(BigInt(l.revision) + 1n),
			event = await appendEvent(tx, c, l.id, leave ? "remove" : "preference", null, l.revision, next);
		await tx.query("UPDATE organization SET material_revision=material_revision+1 WHERE id=$1", [l.organization_id]);
		await effects.invalidate(tx, { owner: organization, sourceId: l.id, revision: next });
		return finishCommand(tx, c, (r) => Q.mutationResult.parse({ status: "committed", receipt: r }), [event]);
	}
}
