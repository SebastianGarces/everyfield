import * as tables from "@everyfield/db/tables";
import { and, eq, gt, isNull, lte, or, sql } from "@everyfield/db/query";
import { alias } from "@everyfield/db/query";
import "server-only";
import type { Transaction } from "@everyfield/db/client";
import { z } from "zod";
import { owner, type Owner, type sessionId } from "@everyfield/contracts/common";
import { plantAffiliationGrant, discoveryRelationshipGrant, platformGrant } from "@everyfield/contracts/access";
import { currentActor, liveOwner } from "./session.ts";
import { isAdministrator } from "./policy.ts";
const affiliation_a = alias(tables.affiliation, "a");

export async function readPlantAffiliation(
	tx: Transaction,
	session: z.infer<typeof sessionId>,
	selected: Owner,
	plant: Owner,
) {
	if (selected.kind !== "organization" || plant.kind !== "plant" || !(await liveOwner(tx, plant))) return null;
	const actor = await currentActor(tx, session, selected);
	if (actor.status !== "active" || actor.context.kind !== "seat") return null;
	const rows = await tx
		.select()
		.from(affiliation_a)
		.where(
			and(
				and(
					and(
						and(eq(affiliation_a.plant_id, plant.id), eq(affiliation_a.organization_id, selected.id)),
						isNull(affiliation_a.ended_at),
					),
					lte(
						affiliation_a.accepted_at,
						sql<Date>`clock_timestamp()`.mapWith((value: string) => new Date(value)),
					),
				),
				sql<unknown>`(NOT EXISTS (SELECT  FROM lifecycle_witness  AS w  WHERE ((w .affiliation_id = a .id) AND (w .state NOT IN (('active'), ('cancelled'))))))`,
			),
		)
		.for("share");
	if (rows.length !== 1) return null;
	const a = rows[0]!;
	return plantAffiliationGrant.parse({
		kind: "plant_affiliation",
		id: a.id,
		revision: a.revision,
		acceptedAt: a.accepted_at.toISOString(),
		plant,
		organization: selected,
		sharing: {
			people: a.share_people,
			meetings: a.share_meetings,
			tasks: a.share_tasks,
			ministry: a.share_ministry,
			wiki: a.share_wiki,
			activity: a.share_activity,
			findings: a.shared_findings,
		},
	});
}
export async function readDiscoveryRelationship(
	tx: Transaction,
	session: z.infer<typeof sessionId>,
	selected: Owner,
	organization: Owner,
) {
	const actor = await currentActor(tx, session, selected);
	if (
		actor.status !== "active" ||
		selected.kind !== "account" ||
		organization.kind !== "organization" ||
		!(await liveOwner(tx, organization))
	)
		return null;
	const rows = await tx
		.select({ id: affiliation_a.id, revision: affiliation_a.revision, accepted_at: affiliation_a.accepted_at })
		.from(affiliation_a)
		.where(
			and(
				and(
					and(
						and(
							and(
								and(eq(affiliation_a.account_id, actor.accountId), eq(affiliation_a.organization_id, organization.id)),
								isNull(affiliation_a.plant_id),
							),
							isNull(affiliation_a.sending_church_id),
						),
						isNull(affiliation_a.ended_at),
					),
					lte(
						affiliation_a.accepted_at,
						sql<Date>`clock_timestamp()`.mapWith((value: string) => new Date(value)),
					),
				),
				sql<unknown>`(NOT EXISTS (SELECT  FROM lifecycle_witness  AS w  WHERE ((w .affiliation_id = a .id) AND (w .state NOT IN (('active'), ('cancelled'))))))`,
			),
		)
		.for("share");
	if (rows.length !== 1) return null;
	const a = rows[0]!;
	return discoveryRelationshipGrant.parse({
		kind: "discovery_relationship",
		id: a.id,
		revision: a.revision,
		acceptedAt: a.accepted_at.toISOString(),
		accountId: actor.accountId,
		organization,
	});
}
export async function readPlatformGrant(
	tx: Transaction,
	session: z.infer<typeof sessionId>,
	selected: Owner,
	capability: z.infer<typeof platformGrant>["capability"],
) {
	const actor = await currentActor(tx, session, selected);
	if (actor.status !== "active" || selected.kind !== "account") return null;
	const rows = await tx
		.select({
			id: tables.platform_grant.id,
			revision: tables.platform_grant.revision,
			expires_at: tables.platform_grant.expires_at,
		})
		.from(tables.platform_grant)
		.where(
			and(
				and(
					and(eq(tables.platform_grant.account_id, actor.accountId), eq(tables.platform_grant.capability, capability)),
					isNull(tables.platform_grant.revoked_at),
				),
				or(
					isNull(tables.platform_grant.expires_at),
					gt(
						tables.platform_grant.expires_at,
						sql<Date>`clock_timestamp()`.mapWith((value: string) => new Date(value)),
					),
				),
			),
		)
		.for("share");
	if (rows.length !== 1) return null;
	const g = rows[0]!;
	return platformGrant.parse({
		kind: "platform",
		id: g.id,
		revision: g.revision,
		accountId: actor.accountId,
		capability,
		expiresAt: g.expires_at?.toISOString() ?? null,
	});
}
// Separate native author boundary. No operation name, private DTO, count, signal
// or history enters the shared access checker or its general projections.
export async function checkPrivateCare(
	tx: Transaction,
	session: z.infer<typeof sessionId>,
	plant: Owner,
	weekId?: string,
): Promise<boolean> {
	if (plant.kind !== "plant") return false;
	const actor = await currentActor(tx, session, plant);
	if (actor.status !== "active" || !isAdministrator(actor)) return false;
	if (weekId === undefined) return true;
	const row = await tx
		.select({ id: tables.private_week.id })
		.from(tables.private_week)
		.where(
			and(
				and(eq(tables.private_week.id, weekId), eq(tables.private_week.plant_id, plant.id)),
				eq(tables.private_week.author_id, actor.accountId),
			),
		)
		.for("share");
	return row.length === 1;
}
export const ownAccount = (id: string) => owner.parse({ kind: "account", id });
