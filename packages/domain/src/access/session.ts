import * as tables from "@everyfield/db/tables";
import { and, eq, sql } from "@everyfield/db/query";
import { alias } from "@everyfield/db/query";
import "server-only";
import type { Transaction } from "@everyfield/db/client";
import { z } from "zod";
import { accountId, owner, recordId, revision, role, sessionId, tenantId } from "@everyfield/contracts/common";
import type { Owner } from "@everyfield/contracts/common";
import { currentActorResult } from "@everyfield/contracts/access";
const tenant_t = alias(tables.tenant, "t");
const organization_o = alias(tables.organization, "o");

const sessionRow = z.strictObject({
	account_id: accountId,
	registration_state: z.enum(["active", "pending_domain"]),
	expires_at: z.coerce.date(),
	now: z.coerce.date(),
	seats: z.array(z.unknown()),
	account_exists: z.boolean(),
	selected_exists: z.boolean(),
	selected_owner: owner,
});
const seatRow = z.strictObject({
	id: recordId,
	plant_id: tenantId.nullable(),
	organization_id: tenantId.nullable(),
	role,
	revision,
	accepted_at: z.coerce.date(),
});
export async function liveOwner(tx: Transaction, selected: Owner): Promise<boolean> {
	const r = await tx
		.select({ kind: tenant_t.kind, organization_kind: organization_o.kind })
		.from(tenant_t)
		.leftJoin(organization_o, eq(organization_o.id, tenant_t.id))
		.where(eq(tenant_t.id, selected.id));
	if (
		r.length !== 1 ||
		r[0]!.kind !== selected.kind ||
		(selected.kind === "organization" && r[0]!.organization_kind !== selected.organizationKind)
	)
		return false;
	if (selected.kind === "global") return false;
	if (selected.kind === "plant") {
		const plant = await tx
			.select({ id: tables.plant.id })
			.from(tables.plant)
			.where(eq(tables.plant.id, selected.id))
			.for("share");
		if (plant.length !== 1) return false;
	}
	// The root exists even before its first witness. Lock it to close the absent-row
	// race with deletion; a witness-only read cannot serialize its first insertion.
	if (selected.kind === "account") {
		const root = await tx
			.select({ id: tables.account.id })
			.from(tables.account)
			.where(eq(tables.account.id, selected.id))
			.for("share");
		if (root.length !== 1) return false;
	}
	const hidden = await tx
		.select({ id: tables.lifecycle_witness.id })
		.from(tables.lifecycle_witness)
		.where(
			and(
				and(
					eq(tables.lifecycle_witness.opaque_subject_id, selected.id),
					eq(tables.lifecycle_witness.kind, sql`${selected.kind}`),
				),
				sql<boolean>`(${tables.lifecycle_witness.state} NOT IN ('active', 'cancelled'))`,
			),
		)
		.limit(1)
		.for("share");
	return hidden.length === 0;
}
async function resolveActor(tx: Transaction, session: z.infer<typeof sessionId>, requested?: Owner) {
	// access_session takes shared session/account locks first. Materialized seats
	// precede the selected root, preserving the account-before-seat/root order.
	const r = await tx.execute(sql`
		WITH identity AS MATERIALIZED (
			SELECT * FROM access_session(${sessionId.parse(session)})
		), seats AS MATERIALIZED (
			SELECT s.id, s.plant_id, s.organization_id, s.role, s.revision::text, s.accepted_at
			FROM seat s JOIN identity i ON i.account_id=s.account_id
			WHERE s.ended_at IS NULL ORDER BY s.id FOR SHARE OF s
		), selected AS MATERIALIZED (
			SELECT coalesce(${requested ? JSON.stringify(requested) : null}::jsonb,
				CASE WHEN s.plant_id IS NOT NULL THEN jsonb_build_object('kind','plant','id',s.plant_id)
					WHEN s.organization_id IS NOT NULL THEN jsonb_build_object('kind','organization','id',s.organization_id,'organizationKind',o.kind)
					ELSE jsonb_build_object('kind','account','id',i.account_id) END) AS owner
			FROM identity i LEFT JOIN (SELECT * FROM seats LIMIT 1) s ON true
			LEFT JOIN organization o ON o.id=s.organization_id
		), selected_root AS MATERIALIZED (
			SELECT p.id FROM plant p
			WHERE (SELECT owner->>'kind' FROM selected)='plant' AND p.id=(SELECT (owner->>'id')::uuid FROM selected)
				AND EXISTS (SELECT 1 FROM identity WHERE registration_state='active')
				AND (SELECT count(*) FROM seats)<=1 FOR SHARE OF p
		), selected_account AS MATERIALIZED (
			SELECT a.id FROM account a
			WHERE (SELECT owner->>'kind' FROM selected)='account' AND a.id=(SELECT (owner->>'id')::uuid FROM selected)
				AND EXISTS (SELECT 1 FROM identity WHERE registration_state='active')
				AND (SELECT count(*) FROM seats)<=1 FOR SHARE OF a
		)
		SELECT i.*, selected.owner AS selected_owner, clock_timestamp() AS now,
			(SELECT coalesce(jsonb_agg(s), '[]'::jsonb) FROM seats s) AS seats,
			EXISTS (SELECT 1 FROM tenant WHERE id=i.account_id AND kind='account') AS account_exists,
			EXISTS (
				SELECT 1 FROM tenant t LEFT JOIN organization o ON o.id=t.id
				WHERE t.id=(selected.owner->>'id')::uuid AND t.kind=selected.owner->>'kind'
					AND CASE selected.owner->>'kind'
						WHEN 'plant' THEN EXISTS (SELECT 1 FROM selected_root)
						WHEN 'account' THEN EXISTS (SELECT 1 FROM selected_account)
						WHEN 'organization' THEN o.kind=selected.owner->>'organizationKind'
						ELSE false END
			) AS selected_exists
		FROM identity i CROSS JOIN selected
	`);
	if (r.rows.length !== 1) return currentActorResult.parse({ status: "unavailable" });
	const row = sessionRow.parse(r.rows[0]!);
	const { now, seats, selected_owner: selected } = row;
	if (row.expires_at <= now || !row.account_exists || seats.length > 1)
		return currentActorResult.parse({ status: "unavailable" });
	// A separate statement sees witnesses committed while a root/seat lock was
	// waiting. Combining this with the first snapshot can miss a new deletion.
	const witnesses = await tx.execute(sql`
		SELECT kind, opaque_subject_id, seat_id FROM lifecycle_witness
		WHERE state NOT IN ('active', 'cancelled') AND (
			(kind='account' AND opaque_subject_id=${row.account_id}::uuid)
			OR (kind=${selected.kind} AND opaque_subject_id=${selected.id}::uuid)
			OR seat_id IN (SELECT id FROM seat WHERE account_id=${row.account_id}::uuid AND ended_at IS NULL)
		) FOR SHARE
	`);
	const hidden = z
		.array(
			z.object({
				kind: z.string(),
				opaque_subject_id: z.uuid(),
				seat_id: z.uuid().nullable(),
			}),
		)
		.parse(witnesses.rows);
	if (hidden.some((w) => w.kind === "account" && w.opaque_subject_id === row.account_id))
		return currentActorResult.parse({ status: "unavailable" });
	if (row.registration_state === "pending_domain")
		return currentActorResult.parse({ status: "pending_domain", accountId: row.account_id });
	if (!row.selected_exists || hidden.some((w) => w.kind === selected.kind && w.opaque_subject_id === selected.id))
		return currentActorResult.parse({ status: "unavailable" });
	if (selected.kind === "account")
		return currentActorResult.parse(
			selected.id === row.account_id
				? { status: "active", accountId: row.account_id, context: { kind: "account", owner: selected } }
				: { status: "unavailable" },
		);
	const seat = seats[0]! && seatRow.parse(seats[0]!);
	if (
		!seat ||
		seat.accepted_at > now ||
		(selected.kind === "plant"
			? seat.plant_id !== selected.id || seat.organization_id !== null
			: selected.kind !== "organization" || seat.organization_id !== selected.id || seat.plant_id !== null)
	)
		return currentActorResult.parse({ status: "unavailable" });
	if (hidden.some((w) => w.seat_id === seat.id)) return currentActorResult.parse({ status: "unavailable" });
	return currentActorResult.parse({
		status: "active",
		accountId: row.account_id,
		context: { kind: "seat", owner: selected, seatId: seat.id, role: seat.role, revision: seat.revision },
	});
}

export function currentActor(tx: Transaction, session: z.infer<typeof sessionId>, selected: Owner) {
	return resolveActor(tx, session, selected);
}

type ActiveActor = Extract<z.infer<typeof currentActorResult>, { status: "active" }>;

/** Server-only authority for one request. Constructed from a live session, never from JSON. */
export class RequestActor {
	readonly status = "active";
	#actor: ActiveActor;
	private constructor(
		readonly session: z.infer<typeof sessionId>,
		actor: ActiveActor,
	) {
		this.#actor = actor;
	}
	get actor() {
		return this.#actor;
	}

	static async resolve(tx: Transaction, session: z.infer<typeof sessionId>) {
		const actor = await resolveActor(tx, session);
		return actor.status === "active" ? new RequestActor(session, actor) : actor;
	}
}
