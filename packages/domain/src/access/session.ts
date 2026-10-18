import * as tables from "@everyfield/db/tables";
import { and, asc, eq, isNull, sql } from "@everyfield/db/query";
import { alias } from "@everyfield/db/query";
import "server-only";
import type { Transaction } from "@everyfield/db/client";
import { z } from "zod";
import { accountId, owner, recordId, revision, role, sessionId, tenantId } from "@everyfield/contracts/common";
import type { Owner } from "@everyfield/contracts/common";
import { currentActorResult } from "@everyfield/contracts/access";
const tenant_t = alias(tables.tenant, "t");
const organization_o = alias(tables.organization, "o");

const sessionRow = z.strictObject({ account_id: accountId, registration_state: z.enum(["active", "pending_domain"]), expires_at: z.coerce.date() });
const seatRow = z.strictObject({ id: recordId, plant_id: tenantId.nullable(), organization_id: tenantId.nullable(), role, revision, accepted_at: z.date() });
export async function liveOwner(tx: Transaction, selected: Owner): Promise<boolean> {
  const r = await tx.select({ "kind": tenant_t.kind, "organization_kind": organization_o.kind }).from(tenant_t).leftJoin(organization_o, eq(organization_o.id, tenant_t.id)).where(eq(tenant_t.id, selected.id));
  if (r.length !== 1 || r[0]!.kind !== selected.kind ||
    (selected.kind === "organization" && r[0]!.organization_kind !== selected.organizationKind)) return false;
  if (selected.kind === "global") return false;
  if (selected.kind === "plant") {
    const plant = await tx.select({ "id": tables.plant.id }).from(tables.plant).where(eq(tables.plant.id, selected.id)).for("share");
    if (plant.length !== 1) return false;
  }
  const hidden = await tx.select({ "id": tables.lifecycle_witness.id }).from(tables.lifecycle_witness).where(and(and(eq(tables.lifecycle_witness.opaque_subject_id, selected.id), eq(tables.lifecycle_witness.kind, sql`${selected.kind}`)), sql<boolean>`(${tables.lifecycle_witness.state} NOT IN ('active', 'cancelled'))`)).limit(1).for("share");
  return hidden.length === 0;
}
export async function currentActor(tx: Transaction, session: z.infer<typeof sessionId>, selected: Owner) {
  // The adapter supplies a Better Auth-validated session handle. This function
  // rechecks its current database row without giving runtime auth-table access.
  const r = await tx.execute(sql`SELECT * FROM access_session(${sessionId.parse(session)})`);
  if (r.rows.length !== 1) return currentActorResult.parse({ status: "unavailable" });
  const row = sessionRow.parse(r.rows[0]!);
  const now = z.coerce.date().parse((await tx.execute(sql`SELECT clock_timestamp() AS now`)).rows[0]?.now);
  if (row.expires_at <= now || !await liveOwner(tx, owner.parse({ kind: "account", id: row.account_id }))) return currentActorResult.parse({ status: "unavailable" });
  // Lock current seats before checking the requested context. The DB unique
  // constraint prevents simultaneous active seats; legacy inconsistency denies.
  const seats = await tx.select({ "id": tables.seat.id, "plant_id": tables.seat.plant_id, "organization_id": tables.seat.organization_id, "role": tables.seat.role, "revision": tables.seat.revision, "accepted_at": tables.seat.accepted_at }).from(tables.seat).where(and(eq(tables.seat.account_id, row.account_id), isNull(tables.seat.ended_at))).orderBy(asc(tables.seat.id)).for("share");
  if (seats.length > 1) return currentActorResult.parse({ status: "unavailable" });
  if (row.registration_state === "pending_domain") return currentActorResult.parse({ status: "pending_domain", accountId: row.account_id });
  if (!await liveOwner(tx, selected)) return currentActorResult.parse({ status: "unavailable" });
  if (selected.kind === "account") return currentActorResult.parse(selected.id === row.account_id
    ? { status: "active", accountId: row.account_id, context: { kind: "account", owner: selected } } : { status: "unavailable" });
  const seat = seats[0]! && seatRow.parse(seats[0]!);
  if (!seat || seat.accepted_at > now || (selected.kind === "plant" ? seat.plant_id !== selected.id || seat.organization_id !== null : selected.kind !== "organization" || seat.organization_id !== selected.id || seat.plant_id !== null)) return currentActorResult.parse({ status: "unavailable" });
  const revoked = await tx.select({ "id": tables.lifecycle_witness.id }).from(tables.lifecycle_witness).where(and(eq(tables.lifecycle_witness.seat_id, seat.id), sql<boolean>`(${tables.lifecycle_witness.state} NOT IN ('active', 'cancelled'))`)).limit(1).for("share");
  if (revoked.length) return currentActorResult.parse({ status: "unavailable" });
  return currentActorResult.parse({ status: "active", accountId: row.account_id, context: { kind: "seat", owner: selected, seatId: seat.id, role: seat.role, revision: seat.revision } });
}
