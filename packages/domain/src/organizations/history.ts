import type { PoolClient } from "pg";
import { z } from "zod";
import { owner, recordId, eventId, accountId } from "@everyfield/contracts/common";
import * as Q from "@everyfield/contracts/organizations";
import type { OrganizationAdapter } from "@everyfield/contracts/organizations";
import { active, administrator, currentActor, loadAffiliation, projection, sameOwner, unavailable } from "./core.ts";
const historyRow = z.object({
	id: eventId,
	pair: Q.relationshipPair,
	reason: z.string().nullable(),
	source_invitation_id: recordId.nullable(),
	kind: z.enum(["accept", "remove"]),
	occurred_at: z.date(),
	recorded_at: z.date(),
	actor_id: accountId.nullable(),
	actor_tombstone: z.string().nullable(),
});
export const getHistory: OrganizationAdapter<PoolClient>["associations.getHistory"] = async (
	tx,
	session,
	selected,
	raw,
) => {
	const q = Q.relationshipHistoryRequest.parse(raw),
		scope = Q.relationshipHistoryScope.parse(
			"plant" in q
				? { plant: q.plant }
				: "sendingChurch" in q
					? { sendingChurch: q.sendingChurch }
					: "organization" in q
						? { organization: q.organization }
						: { discoveryAccountId: q.discoveryAccountId },
		);
	const endpoint =
		"plant" in scope
			? scope.plant
			: "sendingChurch" in scope
				? scope.sendingChurch
				: "organization" in scope
					? scope.organization
					: owner.parse({ kind: "account", id: scope.discoveryAccountId });
	const actor = await currentActor(tx, session, selected);
	if (actor.status !== "active" || !sameOwner(selected, endpoint)) return unavailable();
	if (endpoint.kind === "account") {
		const d = await tx.query("SELECT id FROM discovery WHERE account_id=$1 FOR SHARE", [endpoint.id]);
		if (d.rowCount !== 1) return unavailable();
	}
	const where =
		"plant" in scope
			? "a.plant_id=$1"
			: "sendingChurch" in scope
				? "a.sending_church_id=$1"
				: "discoveryAccountId" in scope
					? "a.account_id=$1"
					: "(a.organization_id=$1 OR a.sending_church_id=$1)";
	const links = await tx.query<{ id: string }>(
		"SELECT a.id FROM affiliation a WHERE " + where + " ORDER BY a.id LIMIT 101",
		[endpoint.id],
	);
	const activeRelationships = [];
	for (const r of links.rows.slice(0, 100)) {
		const a = await loadAffiliation(tx, r.id);
		if (!a) continue;
		const p = projection(a);
		if (
			Q.hasHistoryEndpoint(scope, p.pair) &&
			(!q.pair || JSON.stringify(q.pair) === JSON.stringify(p.pair)) &&
			(await active(tx, a))
		)
			activeRelationships.push(p);
	}
	const rows = await tx.query(
		`SELECT h.*,e.kind,e.occurred_at,e.recorded_at,e.actor_id,e.actor_tombstone FROM relationship_history h JOIN affiliation a ON a.id=h.relationship_id JOIN event e ON e.id=h.id
    WHERE ${where} AND ($2::uuid IS NULL OR h.id>$2) ORDER BY h.id LIMIT 101`,
		[endpoint.id, q.after ?? null],
	);
	const items = rows.rows
		.map((r) => historyRow.parse(r))
		.filter(
			(r) => Q.hasHistoryEndpoint(scope, r.pair) && (!q.pair || JSON.stringify(q.pair) === JSON.stringify(r.pair)),
		)
		.slice(0, 100)
		.map((r) => ({
			id: r.id,
			pair: r.pair,
			event: r.kind === "accept" ? "approved" : "ended",
			reason:
				administrator(actor) || endpoint.kind === "account"
					? { status: "available", value: r.reason }
					: { status: "withheld" },
			occurredAt: r.occurred_at.toISOString(),
			recordedAt: r.recorded_at.toISOString(),
			actor: r.actor_id
				? { kind: "account", accountId: r.actor_id }
				: { kind: "deleted_account", token: r.actor_tombstone ?? "removed" },
			sourceInvitationId: r.source_invitation_id,
		}));
	return Q.relationshipHistoryResult.parse({
		status: "available",
		scope,
		activeRelationships,
		items,
		next: rows.rows.length > 100 ? recordId.parse(rows.rows[99]!.id) : null,
		completeness: links.rows.length > 100 ? "partial" : "complete",
	});
};
