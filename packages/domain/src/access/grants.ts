import "server-only";
import type { PoolClient } from "pg";
import { z } from "zod";
import { owner, type Owner, type sessionId } from "@everyfield/contracts/common";
import { plantAffiliationGrant, discoveryRelationshipGrant, platformGrant } from "@everyfield/contracts/access";
import { currentActor, liveOwner } from "./session.ts";
import { isAdministrator } from "./policy.ts";

export async function readPlantAffiliation(
	tx: PoolClient,
	session: z.infer<typeof sessionId>,
	selected: Owner,
	plant: Owner,
) {
	if (selected.kind !== "organization" || plant.kind !== "plant" || !(await liveOwner(tx, plant))) return null;
	const actor = await currentActor(tx, session, selected);
	if (actor.status !== "active" || actor.context.kind !== "seat") return null;
	const rows = await tx.query(
		`SELECT a.* FROM affiliation a WHERE plant_id=$1 AND organization_id=$2 AND ended_at IS NULL AND accepted_at<=clock_timestamp()
    AND NOT EXISTS(SELECT FROM lifecycle_witness w WHERE w.affiliation_id=a.id AND w.state NOT IN ('active','cancelled')) FOR SHARE`,
		[plant.id, selected.id],
	);
	if (rows.rows.length !== 1) return null;
	const a = rows.rows[0];
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
	tx: PoolClient,
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
	const rows = await tx.query(
		`SELECT a.id,a.revision,a.accepted_at FROM affiliation a WHERE account_id=$1 AND organization_id=$2 AND plant_id IS NULL AND sending_church_id IS NULL AND ended_at IS NULL AND accepted_at<=clock_timestamp()
    AND NOT EXISTS(SELECT FROM lifecycle_witness w WHERE w.affiliation_id=a.id AND w.state NOT IN ('active','cancelled')) FOR SHARE`,
		[actor.accountId, organization.id],
	);
	if (rows.rows.length !== 1) return null;
	const a = rows.rows[0];
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
	tx: PoolClient,
	session: z.infer<typeof sessionId>,
	selected: Owner,
	capability: z.infer<typeof platformGrant>["capability"],
) {
	const actor = await currentActor(tx, session, selected);
	if (actor.status !== "active" || selected.kind !== "account") return null;
	const rows = await tx.query(
		"SELECT id,revision,expires_at FROM platform_grant WHERE account_id=$1 AND capability=$2 AND revoked_at IS NULL AND (expires_at IS NULL OR expires_at>clock_timestamp()) FOR SHARE",
		[actor.accountId, capability],
	);
	if (rows.rows.length !== 1) return null;
	const g = rows.rows[0];
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
	tx: PoolClient,
	session: z.infer<typeof sessionId>,
	plant: Owner,
	weekId?: string,
): Promise<boolean> {
	if (plant.kind !== "plant") return false;
	const actor = await currentActor(tx, session, plant);
	if (actor.status !== "active" || !isAdministrator(actor)) return false;
	if (weekId === undefined) return true;
	const row = await tx.query("SELECT id FROM private_week WHERE id=$1 AND plant_id=$2 AND author_id=$3 FOR SHARE", [
		weekId,
		plant.id,
		actor.accountId,
	]);
	return row.rows.length === 1;
}
export const ownAccount = (id: string) => owner.parse({ kind: "account", id });
