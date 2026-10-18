import { and, or, gt, getTableColumns, eq, asc } from "@everyfield/db/query";
import * as tables from "@everyfield/db/tables";
import type { Transaction } from "@everyfield/db/client";
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
	occurred_at: z.coerce.date(),
	recorded_at: z.coerce.date(),
	actor_id: accountId.nullable(),
	actor_tombstone: z.string().nullable(),
});
export const getHistory: OrganizationAdapter<Transaction>["associations.getHistory"] = async (
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
		const d = await tx
			.select({ id: tables.discovery.id })
			.from(tables.discovery)
			.where(eq(tables.discovery.account_id, endpoint.id))
			.for("share");
		if (d.length !== 1) return unavailable();
	}
	const where =
		"plant" in scope
			? eq(tables.affiliation.plant_id, endpoint.id)
			: "sendingChurch" in scope
				? eq(tables.affiliation.sending_church_id, endpoint.id)
				: "discoveryAccountId" in scope
					? eq(tables.affiliation.account_id, endpoint.id)
					: or(
							eq(tables.affiliation.organization_id, endpoint.id),
							eq(tables.affiliation.sending_church_id, endpoint.id),
						);
	const links = await tx
		.select({ id: tables.affiliation.id })
		.from(tables.affiliation)
		.where(where)
		.orderBy(asc(tables.affiliation.id))
		.limit(101);
	const activeRelationships = [];
	for (const r of links.slice(0, 100)) {
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
	const rows = await tx
		.select({
			...getTableColumns(tables.relationship_history),
			kind: tables.event.kind,
			occurred_at: tables.event.occurred_at,
			recorded_at: tables.event.recorded_at,
			actor_id: tables.event.actor_id,
			actor_tombstone: tables.event.actor_tombstone,
		})
		.from(tables.relationship_history)
		.innerJoin(tables.affiliation, eq(tables.affiliation.id, tables.relationship_history.relationship_id))
		.innerJoin(tables.event, eq(tables.event.id, tables.relationship_history.id))
		.where(and(where, q.after ? gt(tables.relationship_history.id, q.after) : undefined))
		.orderBy(asc(tables.relationship_history.id))
		.limit(101);
	const items = rows
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
		next: rows.length > 100 ? recordId.parse(rows[99]!.id) : null,
		completeness: links.length > 100 ? "partial" : "complete",
	});
};
