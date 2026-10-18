import { and, eq, sql } from "@everyfield/db/query";
import * as tables from "@everyfield/db/tables";
import { alias } from "@everyfield/db/columns";
import type { Transaction } from "@everyfield/db/client";
import type { z } from "zod";
import type { Owner, sessionId } from "@everyfield/contracts/common";
import type { OrganizationAdapter } from "@everyfield/contracts/organizations";
import * as Q from "@everyfield/contracts/organizations";
import {
	subjectAuthority,
	validPair,
	endpointValues,
	choices,
	active,
	administrator,
	appendEvent,
	beginCommand,
	checkRevision,
	currentActor,
	finishCommand,
	invalidate,
	loadAffiliation,
	pairOf,
	refuse,
	sameOwner,
	unavailable,
	type OrganizationEffects,
} from "./core.ts";
const affiliation_a = alias(tables.affiliation, "a");
const organization_o = alias(tables.organization, "o");
const columns = {
	people: "share_people",
	meetings: "share_meetings",
	tasks: "share_tasks",
	ministry_teams: "share_ministry_teams",
	wiki: "share_wiki",
	activity: "share_activity",
	shared_findings: "shared_findings",
} as const;
export function sharingOperations(
	effects: OrganizationEffects,
): Pick<OrganizationAdapter<Transaction>, "privacy.getSharing" | "privacy.setSharing"> {
	return {
		async "privacy.getSharing"(tx, session, selected, raw) {
			const q = Q.readSharingRequest.parse(raw),
				actor = await currentActor(tx, session, selected);
			if (actor.status !== "active" || (!sameOwner(selected, q.plant) && !sameOwner(selected, q.organization)))
				return unavailable();
			const r = await tx
				.select({ id: affiliation_a.id, name: organization_o.name })
				.from(affiliation_a)
				.innerJoin(organization_o, eq(organization_o.id, affiliation_a.organization_id))
				.where(and(eq(affiliation_a.plant_id, q.plant.id), eq(affiliation_a.organization_id, q.organization.id)));
			if (!r[0]) return unavailable();
			const a = await loadAffiliation(tx, r[0].id);
			if (!a || !(await active(tx, a)) || !sameOwner(pairOf(a).organization, q.organization)) return unavailable();
			const base = {
				plant: q.plant,
				organization: q.organization,
				organizationDisplayName: r[0].name,
				activeAffiliation: true,
			};
			return Q.sharingResult.parse(
				sameOwner(selected, q.organization)
					? { view: "organization", ...base, availability: choices(a) }
					: administrator(actor)
						? { view: "plant_administration", ...base, consentRevision: a.consent_revision, choices: choices(a) }
						: { view: "plant_member", ...base },
			);
		},
		async "privacy.setSharing"(tx, session, selected, raw) {
			const q = Q.setSharingRequest.parse(raw),
				a = await loadAffiliation(tx, q.input.relationshipId, true),
				actor = await currentActor(tx, session, selected);
			if (
				!a ||
				actor.status !== "active" ||
				!administrator(actor) ||
				!sameOwner(selected, q.input.plant) ||
				a.plant_id !== q.input.plant.id ||
				!sameOwner(pairOf(a).organization, q.input.organization) ||
				!(await active(tx, a))
			)
				refuse();
			const c = await beginCommand(tx, actor, selected, "privacy.setSharing", q);
			if (c.kind === "replay") return Q.mutationResult.parse(c.result);
			checkRevision(q.expectedRevision, a.revision);
			checkRevision(q.input.expectedConsentRevision, a.consent_revision);
			if (choices(a)[q.input.category] === q.input.enabled)
				return finishCommand(tx, c, (r) => Q.mutationResult.parse({ status: "committed", receipt: r }), [], false);
			await tx
				.update(tables.affiliation)
				.set({
					[columns[q.input.category]]: q.input.enabled,
					consent_revision: sql`${tables.affiliation.consent_revision}+1`,
					revision: sql`${tables.affiliation.revision}+1`,
				})
				.where(eq(tables.affiliation.id, a.id));
			const next = String(BigInt(a.revision) + 1n),
				event = await appendEvent(tx, c, a.id, "preference", "sharing.changed", a.revision, next);
			await invalidate(tx, effects, pairOf(a), a.id, next);
			// Coarse event only. Never copy the changed category or private body to notices.
			await effects.notice(tx, {
				eventId: event,
				relationshipId: a.id,
				pair: pairOf(a),
				kind: "sharing_changed",
				revision: next,
				operationId: c.id,
			});
			return finishCommand(tx, c, (r) => Q.mutationResult.parse({ status: "committed", receipt: r }), [event]);
		},
	};
}

// Native review disclosure. Re-read before approving; this observation grants no
// authority and never overwrites the exact pair's persisted consent on rejoin.
export async function readSharingDisclosure(
	tx: Transaction,
	session: z.infer<typeof sessionId>,
	selected: Owner,
	raw: unknown,
) {
	const pair = Q.relationshipPair.parse(raw),
		actor = await currentActor(tx, session, selected);
	if (actor.status !== "active" || !(await validPair(tx, pair)) || !(await subjectAuthority(tx, actor, pair)))
		return unavailable();
	const r = await tx.execute<{ id: string }>(
		sql`SELECT id FROM affiliation WHERE plant_id IS NOT DISTINCT FROM ${sql.param(endpointValues(pair)[0])}::uuid AND account_id IS NOT DISTINCT FROM ${sql.param(endpointValues(pair)[1])}::uuid AND sending_church_id IS NOT DISTINCT FROM ${sql.param(endpointValues(pair)[2])}::uuid AND organization_id=${sql.param(endpointValues(pair)[3])}`,
	);
	const previous = r.rows[0] ? await loadAffiliation(tx, r.rows[0].id) : null;
	if (previous && pair.kind === "plant")
		return Q.sharingDisclosure.parse({
			kind: "existing_consent",
			organization: pair.organization,
			consentRevision: previous.consent_revision,
			choices: choices(previous),
		});
	if (pair.kind !== "plant") return unavailable();
	return Q.sharingDisclosure.parse({
		kind: "first_invitation",
		organization: pair.organization,
		choices: {
			people: true,
			meetings: true,
			tasks: true,
			ministry_teams: true,
			wiki: true,
			activity: true,
			shared_findings: true,
		},
	});
}
