import "server-only";
import type { PoolClient } from "pg";
import type { z } from "zod";
import { sameOwner, type Owner, type sessionId, type Subject } from "@everyfield/contracts/common";
import { sharedOperationCheckRequest, operationCheckResult, type CurrentActorResult } from "@everyfield/contracts/access";
import { currentActor } from "./session.ts";
import { operationRegistry } from "./operations.generated.ts";

type ActiveActor = Extract<CurrentActorResult, { status: "active" }>;
// Registered server producers own narrower duties, consent, exact subject and
// output projection. A positive observation never grants a durable invocation.
export interface OperationPolicy {
  operation: keyof typeof operationRegistry;
  subjectKinds: readonly Subject["kind"][];
  authorize(tx: PoolClient, actor: ActiveActor, subject: Subject, purpose: "native" | "model" | "export" | "organization_aggregate"): Promise<boolean>;
}
export const isAdministrator = (actor: ActiveActor) => actor.context.kind === "seat" && ["owner", "admin"].includes(actor.context.role);

export function accessPolicies(policies: readonly OperationPolicy[]) {
  const byName = new Map<string, OperationPolicy>(policies.map(policy => [policy.operation, policy]));
  if (byName.size !== policies.length) throw Error("duplicate_access_policy");
  return {
    async checkOperation(tx: PoolClient, session: z.infer<typeof sessionId>, selected: Owner, raw: unknown) {
      const parsed = sharedOperationCheckRequest.safeParse(raw);
      const denied = operationCheckResult.parse({ status: "unavailable" });
      if (!parsed.success) return denied;
      const input = parsed.data;
      // Resolve kind and model eligibility from the generated catalog, never
      // a caller tag. A missing producer policy always denies.
      const policy = byName.get(input.operation);
      if (!policy) return denied;
      const registered = operationRegistry[policy.operation];
      if (registered.kind !== input.kind || !policy.subjectKinds.includes(input.subject.kind) || !sameOwner(selected, input.subject.owner)) return denied;
      if (input.kind === "read" && input.purpose === "model" && !registered.model) return denied;
      const actor = await currentActor(tx, session, selected);
      if (actor.status !== "active") return denied;
      if (policy.operation === "churches.requestWorkspaceDeletion" && (selected.kind !== "plant" || actor.context.kind !== "seat" || actor.context.role !== "owner")) return denied;
      if (["private_week", "private_week_revision"].includes(input.subject.kind)) return denied;
      const record = await tx.query("SELECT kind,tenant_id FROM record WHERE id=$1", [input.subject.id]);
      if (record.rows.length !== 1 || record.rows[0].kind !== input.subject.kind || record.rows[0].tenant_id !== selected.id) return denied;
      // Identifiers are chosen only from the closed producer subjectKinds plus
      // the canonical C0 subject parser. Values always remain SQL parameters.
      const resource = await tx.query(`SELECT to_jsonb(r)->>'revision' AS revision FROM "${input.subject.kind}" r WHERE id=$1 FOR SHARE`, [input.subject.id]);
      if (resource.rows.length !== 1 || (input.kind === "write" && resource.rows[0].revision !== input.expectedRevision)) return denied;
      const purpose = input.kind === "read" ? input.purpose : "native";
      if (!await policy.authorize(tx, actor, input.subject, purpose)) return denied;
      return operationCheckResult.parse({ status: "allowed" });
    },
  };
}

// These operations share C1 administration. Their producers still own exact
// effect review, receipts, launch revisions and atomic writes.
export function plantAdministration(operation: "plant.updateProfile" | "churches.requestWorkspaceDeletion" | "launch.addGuestAttendance" | "launch.saveDebriefDraft" | "launch.publishDebriefSummary", subjectKinds: OperationPolicy["subjectKinds"]): OperationPolicy {
  return { operation, subjectKinds, async authorize(_tx, actor, subject) {
    return subject.owner.kind === "plant" && isAdministrator(actor);
  } };
}
export const ordinarySeatAdministration: OperationPolicy = {
  operation: "seats.changeOrdinaryRole", subjectKinds: ["seat"],
  async authorize(tx, actor, subject) {
    if (!isAdministrator(actor)) return false;
    const target = await tx.query("SELECT role FROM seat WHERE id=$1 AND coalesce(plant_id,organization_id)=$2 AND ended_at IS NULL FOR SHARE", [subject.id, subject.owner.id]);
    return target.rows.length === 1 && ["admin", "member"].includes(target.rows[0].role);
  },
};
