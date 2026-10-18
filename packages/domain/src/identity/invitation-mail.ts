import "server-only";
import { accountId } from "@everyfield/contracts/common";
import type { Transaction } from "@everyfield/db/client";
import { and, eq, isNull, notInArray, sql } from "@everyfield/db/query";
import * as t from "@everyfield/db/tables";
import { liveOwner } from "../access/session.ts";
import { workspace, expires } from "./invitation-core.ts";
// WP-031 calls this for both enqueue and the final handoff. The frozen ledger
// supplies these values; no client-selected address, purpose or key is accepted.
export async function authorizeInvitationMail(
	tx: Transaction,
	m: {
		tenant: string;
		purpose: string;
		recipient: string | null;
		logicalKey: string;
		addressHash: string;
		operation: string | null;
	},
	addressHash: (email: string) => string,
) {
	const [prefix, id, rev, ...extra] = m.logicalKey.split("/");
	if (extra.length || !id || !["invitation", "invitation-accepted"].includes(prefix!)) return false;
	const [i] = await tx
		.select()
		.from(t.invitation)
		.where(and(eq(t.invitation.id, id), eq(t.invitation.tenant_id, m.tenant)))
		.for("share");
	if (
		!i ||
		(i.purpose !== "seat" && i.purpose !== "residency_link") ||
		addressHash(i.recipient_email) !== m.addressHash
	)
		return false;
	const [op] = m.operation
		? await tx
				.select({ id: t.operation.id })
				.from(t.operation)
				.where(and(eq(t.operation.id, m.operation), eq(t.operation.tenant_id, m.tenant)))
		: [];
	if (!op) return false;
	try {
		await workspace(tx, m.tenant);
	} catch {
		return false;
	}
	if (prefix === "invitation-accepted")
		return (
			!rev && i.state === "accepted" && m.recipient === i.accepted_account_id && m.purpose === "relationship_receipt"
		);
	if (
		!i.inviter_id ||
		i.state !== "pending" ||
		i.revision !== rev ||
		expires(i) <= new Date() ||
		m.recipient !== null ||
		m.purpose !== (i.purpose === "seat" ? "seat_invitation" : "relationship_invitation")
	)
		return false;
	const seats = await tx
		.select({ id: t.seat.id })
		.from(t.seat)
		.where(
			and(
				eq(t.seat.account_id, i.inviter_id),
				sql`coalesce(${t.seat.plant_id},${t.seat.organization_id})=${i.tenant_id}`,
				isNull(t.seat.ended_at),
				notInArray(t.seat.role, ["member"]),
			),
		)
		.for("share");
	if (!seats.length || !(await liveOwner(tx, { kind: "account", id: accountId.parse(i.inviter_id) }))) return false;
	const blocked = await tx
		.select({ id: t.lifecycle_witness.id })
		.from(t.lifecycle_witness)
		.where(
			and(
				eq(t.lifecycle_witness.seat_id, seats[0]!.id),
				notInArray(t.lifecycle_witness.state, ["active", "cancelled"]),
			),
		)
		.for("share");
	if (blocked.length) return false;
	if (i.purpose === "residency_link") {
		const [p] = await tx
			.select({ id: t.person.id })
			.from(t.person)
			.where(
				and(
					eq(t.person.id, i.resident_person_id!),
					eq(t.person.organization_id, i.tenant_id),
					eq(t.person.state, "live"),
					isNull(t.person.linked_account_id),
				),
			)
			.for("share");
		if (!p) return false;
		const removed = await tx
			.select({ id: t.organization_person_removal.id })
			.from(t.organization_person_removal)
			.where(
				and(
					eq(t.organization_person_removal.person_record_id, i.resident_person_id!),
					eq(t.organization_person_removal.organization_id, i.tenant_id),
				),
			);
		if (removed.length) return false;
	}
	return true;
}
