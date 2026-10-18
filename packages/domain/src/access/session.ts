import "server-only";
import type { PoolClient } from "pg";
import { z } from "zod";
import { accountId, owner, recordId, revision, role, sessionId } from "@everyfield/contracts/common";
import type { Owner } from "@everyfield/contracts/common";
import { currentActorResult } from "@everyfield/contracts/access";

const sessionRow = z.strictObject({ account_id: accountId, registration_state: z.enum(["active", "pending_domain"]), expires_at: z.date() });
const seatRow = z.strictObject({ id: recordId, plant_id: recordId.nullable(), organization_id: recordId.nullable(), role, revision, accepted_at: z.date() });
export async function liveOwner(tx: PoolClient, selected: Owner): Promise<boolean> {
  const r = await tx.query("SELECT t.kind,o.kind AS organization_kind FROM tenant t LEFT JOIN organization o ON o.id=t.id WHERE t.id=$1", [selected.id]);
  if (r.rows.length !== 1 || r.rows[0].kind !== selected.kind ||
    (selected.kind === "organization" && r.rows[0].organization_kind !== selected.organizationKind)) return false;
  if (selected.kind === "global") return false;
  if (selected.kind === "plant") {
    const plant = await tx.query("SELECT id FROM plant WHERE id=$1 FOR SHARE", [selected.id]);
    if (plant.rows.length !== 1) return false;
  }
  const hidden = await tx.query("SELECT id FROM lifecycle_witness WHERE opaque_subject_id=$1 AND kind=$2 AND state NOT IN ('active','cancelled') LIMIT 1 FOR SHARE", [selected.id, selected.kind]);
  return hidden.rows.length === 0;
}
export async function currentActor(tx: PoolClient, session: z.infer<typeof sessionId>, selected: Owner) {
  // The adapter supplies a Better Auth-validated session handle. This function
  // rechecks its current database row without giving runtime auth-table access.
  const r = await tx.query("SELECT * FROM access_session($1)", [sessionId.parse(session)]);
  if (r.rows.length !== 1) return currentActorResult.parse({ status: "unavailable" });
  const row = sessionRow.parse(r.rows[0]);
  const now = (await tx.query<{ now: Date }>("SELECT clock_timestamp() AS now")).rows[0]!.now;
  if (row.expires_at <= now || !await liveOwner(tx, owner.parse({ kind: "account", id: row.account_id }))) return currentActorResult.parse({ status: "unavailable" });
  // Lock current seats before checking the requested context. The DB unique
  // constraint prevents simultaneous active seats; legacy inconsistency denies.
  const seats = await tx.query("SELECT id,plant_id,organization_id,role,revision,accepted_at FROM seat WHERE account_id=$1 AND ended_at IS NULL ORDER BY id FOR SHARE", [row.account_id]);
  if (seats.rows.length > 1) return currentActorResult.parse({ status: "unavailable" });
  if (row.registration_state === "pending_domain") return currentActorResult.parse({ status: "pending_domain", accountId: row.account_id });
  if (!await liveOwner(tx, selected)) return currentActorResult.parse({ status: "unavailable" });
  if (selected.kind === "account") return currentActorResult.parse(selected.id === row.account_id
    ? { status: "active", accountId: row.account_id, context: { kind: "account", owner: selected } } : { status: "unavailable" });
  const seat = seats.rows[0] && seatRow.parse(seats.rows[0]);
  if (!seat || seat.accepted_at > now || (selected.kind === "plant" ? seat.plant_id !== selected.id || seat.organization_id !== null : selected.kind !== "organization" || seat.organization_id !== selected.id || seat.plant_id !== null)) return currentActorResult.parse({ status: "unavailable" });
  const revoked = await tx.query("SELECT id FROM lifecycle_witness WHERE seat_id=$1 AND state NOT IN ('active','cancelled') LIMIT 1 FOR SHARE", [seat.id]);
  if (revoked.rowCount) return currentActorResult.parse({ status: "unavailable" });
  return currentActorResult.parse({ status: "active", accountId: row.account_id, context: { kind: "seat", owner: selected, seatId: seat.id, role: seat.role, revision: seat.revision } });
}
