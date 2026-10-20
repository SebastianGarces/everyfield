import { and, or, gt, eq, asc, sql } from "@everyfield/db/query";
import * as tables from "@everyfield/db/tables";
import type { Database, Transaction } from "@everyfield/db/client";
import { z } from "zod";
import { owner, recordId, eventId, accountId } from "@everyfield/contracts/common";
import * as Q from "@everyfield/contracts/organizations";
import type { OrganizationAdapter } from "@everyfield/contracts/organizations";
import type { RequestActor } from "../access/session.ts";
import {
	administrator,
	currentActor,
	loadAffiliations,
	projection,
	sameOwner,
	unavailable,
	type Actor,
	type Reader,
} from "./core.ts";
const historyRow = z.object({
	id: eventId,
	pair: Q.relationshipPair,
	reason: z.string().nullable(),
	source_invitation_id: recordId.nullable(),
	kind: z.enum(["accept", "remove"]),
	occurred_at: z.coerce.date(),
	recorded_at: z.coerce.date(),
	actor_id: accountId.nullable(),
	actor_token: z.string().nullable(),
});
/** One scope's connections and history: one affiliation statement with the live check joined in, one audit page. */
async function historyFor(db: Reader, actor: Actor, raw: unknown) {
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
	if (!sameOwner(actor.context.owner, endpoint)) return unavailable();
	if (endpoint.kind === "account") {
		const d = await db
			.select({ id: tables.discovery.id })
			.from(tables.discovery)
			.where(eq(tables.discovery.account_id, endpoint.id));
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
	const links = await loadAffiliations(db, sql`${where} AND ${tables.affiliation.ended_at} IS NULL`);
	const activeRelationships = links
		.filter((a) => a.active)
		.map((a) => projection(a))
		.filter(
			(p) => Q.hasHistoryEndpoint(scope, p.pair) && (!q.pair || JSON.stringify(q.pair) === JSON.stringify(p.pair)),
		)
		.slice(0, 100);
	const rows = await db
		.select({
			id: tables.audit_event.id,
			pair: sql`${tables.audit_event.metadata}->'pair'`,
			reason: tables.audit_event.reason,
			source_invitation_id: sql`${tables.audit_event.metadata}->>'sourceInvitationId'`,
			kind: tables.audit_event.kind,
			occurred_at: tables.audit_event.occurred_at,
			recorded_at: tables.audit_event.recorded_at,
			actor_id: tables.audit_event.actor_id,
			actor_token: tables.audit_event.actor_token,
		})
		.from(tables.audit_event)
		.innerJoin(tables.affiliation, eq(tables.affiliation.id, tables.audit_event.subject_id))
		.where(
			and(
				where,
				sql`${tables.audit_event.metadata} ? 'pair'`,
				q.after ? gt(tables.audit_event.id, q.after) : undefined,
			),
		)
		.orderBy(asc(tables.audit_event.id))
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
				: { kind: "deleted_account", token: r.actor_token ?? "removed" },
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
}
export const getHistory: OrganizationAdapter<Transaction>["associations.getHistory"] = async (
	tx,
	session,
	selected,
	raw,
) => {
	const actor = await currentActor(tx, session, selected);
	if (actor.status !== "active") return unavailable();
	return historyFor(tx, actor, raw);
};
/** The request's own viewer reads its history on the pool: no transaction, no second actor read (D59). */
export const readHistory = (db: Database, authority: RequestActor, raw: unknown) =>
	historyFor(db, authority.actor, raw);
