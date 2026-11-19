import { writeActor, loadAffiliations, type Reader } from "./core.ts";
import { revision, type Owner, type sessionId } from "@everyfield/contracts/common";
import { liveRead, type RequestActor, type WriteTx } from "../access/session.ts";
import type { OrganizationAdapter } from "@everyfield/contracts/organizations";
import * as Q from "@everyfield/contracts/organizations";
import { alias } from "@everyfield/db/columns";
import { and, eq, sql } from "@everyfield/db/query";
import * as tables from "@everyfield/db/tables";
import { z } from "zod";
import { auditSavepoint } from "../operations/writes.ts";
import { queueMilestoneJob } from "./notifications.ts";
import {
	active,
	administrator,
	appendEvent,
	beginCommand,
	checkRevision,
	choices,
	currentActor,
	finishCommand,
	invalidate,
	loadAffiliation,
	pairOf,
	refuse,
	pairLive,
	pairMatch,
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
): Pick<OrganizationAdapter<WriteTx>, "privacy.getSharing" | "privacy.setSharing"> {
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

export async function readSharingDisclosure(
	tx: WriteTx,
	session: z.infer<typeof sessionId>,
	selected: Owner,
	raw: unknown,
) {
	const pair = Q.relationshipPair.parse(raw),
		actor = await currentActor(tx, session, selected);
	if (
		pair.kind !== "plant" ||
		actor.status !== "active" ||
		!sameOwner(actor.context.owner, pair.subject) ||
		!administrator(actor)
	)
		return unavailable();
	const share = Object.values(columns).map((c) => sql`a.${sql.identifier(c)}`);
	const r = await tx.execute(
		sql`SELECT (${pairLive(pair)} AND ${liveRead({ session, owner: pair.subject }, true)}) AS allowed,
		a.consent_revision::text AS consent_revision, ${sql.join(share, sql`,`)}
		FROM (SELECT) one LEFT JOIN LATERAL (SELECT * FROM affiliation WHERE ${pairMatch(tables.affiliation, pair)} LIMIT 1) a ON true`,
	);
	const row = disclosureRow.parse(r.rows[0]);
	if (!row.allowed) return unavailable();
	if (row.consent_revision === null)
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
	return Q.sharingDisclosure.parse({
		kind: "existing_consent",
		organization: pair.organization,
		consentRevision: row.consent_revision,
		choices: Object.fromEntries(Q.sharingChoices.keyof().options.map((category) => [category, row[columns[category]]])),
	});
}
const disclosureRow = z.object({
	allowed: z.boolean(),
	consent_revision: revision.nullable(),
	share_people: z.boolean().nullable(),
	share_meetings: z.boolean().nullable(),
	share_tasks: z.boolean().nullable(),
	share_ministry_teams: z.boolean().nullable(),
	share_wiki: z.boolean().nullable(),
	share_activity: z.boolean().nullable(),
	shared_findings: z.boolean().nullable(),
});

export async function applySharingMutation(
	tx: WriteTx,
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
	c.writes.push(
		tx
			.update(tables.affiliation)
			.set({
				...patch,
				consent_revision: sql`${tables.affiliation.consent_revision}+1`,
				revision: sql`${tables.affiliation.revision}+1`,
			})
			.where(eq(tables.affiliation.id, a.id)),
	);
	const next = String(BigInt(a.revision) + 1n);
	const event = await appendEvent(tx, c, a.id, "preference", "sharing.changed", a.revision, next);
	invalidate(tx, effects, c, pairOf(a), a.id, next);
	if (a.plant_id)
		c.writes.push(
			queueMilestoneJob({ plantId: a.plant_id, affiliationId: a.id, occurrence: "sharing", revision: next }),
		);
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
