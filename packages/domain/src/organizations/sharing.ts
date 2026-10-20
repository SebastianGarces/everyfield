import { writeActor, loadAffiliations, type Reader } from "./core.ts";
import { revision, type Owner, type sessionId } from "@everyfield/contracts/common";
import type { RequestActor } from "../access/session.ts";
import type { OrganizationAdapter } from "@everyfield/contracts/organizations";
import * as Q from "@everyfield/contracts/organizations";
import type { Transaction } from "@everyfield/db/client";
import { alias } from "@everyfield/db/columns";
import { and, eq, sql } from "@everyfield/db/query";
import * as tables from "@everyfield/db/tables";
import type { z } from "zod";
import { auditSavepoint } from "../operations/writes.ts";
import {
	active,
	administrator,
	appendEvent,
	beginCommand,
	checkRevision,
	choices,
	currentActor,
	endpointValues,
	finishCommand,
	invalidate,
	loadAffiliation,
	pairOf,
	refuse,
	sameOwner,
	subjectAuthority,
	unavailable,
	validPair,
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
			if (!a || !active(a) || !sameOwner(pairOf(a).organization, q.organization)) return unavailable();
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
			return auditSavepoint(tx, async () => {
				const q = Q.setSharingRequest.parse(raw),
					a = await loadAffiliation(tx, q.input.relationshipId, true),
					actor = await writeActor(tx, session, selected);
				if (
					!a ||
					actor.status !== "active" ||
					!administrator(actor) ||
					!sameOwner(selected, q.input.plant) ||
					a.plant_id !== q.input.plant.id ||
					!sameOwner(pairOf(a).organization, q.input.organization) ||
					!active(a)
				)
					refuse();
				const c = await beginCommand(tx, actor, selected, "privacy.setSharing", q);
				if (c.kind === "replay") return Q.mutationResult.parse(c.result);
				checkRevision(q.expectedRevision, a.revision);
				checkRevision(q.input.expectedConsentRevision, a.consent_revision);
				await applySharingMutation(tx, a, c, { ...choices(a), [q.input.category]: q.input.enabled }, effects);
				return finishCommand(tx, c, () => Q.mutationResult.parse({ status: "committed" }));
			});
		},
	};
}

/**
 * What each of a plant's live connections can see, for the plant's own seat: one statement on the pool with the
 * request actor (D59), keyed by relationship id. An Owner or Admin gets the choices and the consent revision a change
 * must carry; a Member sees that Owners and Admins choose. `organization` narrows the read to one connection.
 */
export async function readPlantSharing(db: Reader, authority: RequestActor, organization?: string) {
	const actor = authority.actor,
		selected = actor.context.owner;
	if (selected.kind !== "plant") return {};
	const rows = await loadAffiliations(
		db,
		sql`${tables.affiliation.plant_id}=${selected.id} AND ${tables.affiliation.ended_at} IS NULL${
			organization ? sql` AND ${tables.affiliation.organization_id}=${organization}` : sql``
		}`,
	);
	const out: Record<string, { sharing: z.infer<typeof Q.sharingResult>; relationshipRevision: string }> = {};
	for (const a of rows.filter((a) => a.active)) {
		const base = {
			plant: selected,
			organization: pairOf(a).organization,
			organizationDisplayName: a.organization_name,
			activeAffiliation: true,
		};
		out[a.id] = {
			sharing: Q.sharingResult.parse(
				administrator(actor)
					? { view: "plant_administration", ...base, consentRevision: a.consent_revision, choices: choices(a) }
					: { view: "plant_member", ...base },
			),
			relationshipRevision: revision.parse(a.revision),
		};
	}
	return out;
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
	if (
		actor.status !== "active" ||
		!(await validPair(tx, pair, false)) ||
		!(await subjectAuthority(tx, actor, pair, false))
	)
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

// Both privacy and settings use one locked revision update, audit, invalidation and
// coarse notice. Caller has freshly checked the exact pair and both CAS revisions.
export async function applySharingMutation(
	tx: Transaction,
	a: NonNullable<Awaited<ReturnType<typeof loadAffiliation>>>,
	c: Extract<Awaited<ReturnType<typeof beginCommand>>, { kind: "new" }>,
	nextChoices: ReturnType<typeof choices>,
	effects: OrganizationEffects,
) {
	const before = choices(a);
	const patch: Partial<Record<(typeof columns)[keyof typeof columns], boolean>> = {};
	for (const category of Q.sharingChoices.keyof().options)
		if (before[category] !== nextChoices[category]) patch[columns[category]] = nextChoices[category];
	if (!Object.keys(patch).length) return { changed: false, events: [] as string[], current: a };
	await tx
		.update(tables.affiliation)
		.set({
			...patch,
			consent_revision: sql`${tables.affiliation.consent_revision}+1`,
			revision: sql`${tables.affiliation.revision}+1`,
		})
		.where(eq(tables.affiliation.id, a.id));
	const next = String(BigInt(a.revision) + 1n);
	const event = await appendEvent(tx, c, a.id, "preference", "sharing.changed", a.revision, next);
	await invalidate(tx, effects, pairOf(a), a.id, next);
	await effects.notice(tx, {
		eventId: event,
		relationshipId: a.id,
		pair: pairOf(a),
		kind: "sharing_changed",
		revision: next,
		operationId: c.id,
	});
	return {
		changed: true,
		events: [event],
		current: {
			...a,
			...patch,
			revision: revision.parse(next),
			consent_revision: revision.parse(String(BigInt(a.consent_revision) + 1n)),
		},
	};
}
