import { z } from "zod";
import { accountId, tenantId, personId, recordId, operationId, eventId, effectId, digest, revision, role, owner, sameOwner } from "./values.ts";
import { instant } from "./time.ts";
import { auditActions, recordKinds } from "./vocabulary.ts";
import type { CommandScope, Attribution } from "./scope.ts";

const registeredActions = new Set<string>(auditActions);
const personOwner = owner.refine(v => v.kind === "plant" || v.kind === "organization");
// The Person variant preserves its semantic ID. Other registered records stay typed
// by their actual kind. Real owner/kind relations are checked by the SQL producer.
export const subject = z.union([
  z.strictObject({ kind: z.literal("person"), id: personId, owner: personOwner }),
  z.strictObject({ kind: z.enum(recordKinds.filter(k => k !== "person")), id: recordId, owner }),
]).refine(value => !["account", "plant", "organization"].includes(value.kind) ||
  (value.kind === value.owner.kind && String(value.id) === String(value.owner.id)), { message: "invalid_root_subject" });
export type Subject = z.infer<typeof subject>;
export const attribution = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("human"), accountId }),
  z.strictObject({ kind: z.literal("service"), cause: z.enum(["job", "provider_callback", "recovery"]), operationId }),
  z.strictObject({ kind: z.literal("tombstone"), owner: tenantId, token: z.string().regex(/^[a-f0-9]{64}$/) }),
]);
// Versioned examples. Extend ONLY with each named producer's reviewed safe fields.
// Text values, whole rows and generic metadata dictionaries have no route here.
const changedFields = z.array(z.enum(["name", "stage", "status", "profile", "classification"])).max(5);
export const auditChange = z.discriminatedUnion("action", [
  z.strictObject({ action: z.literal("people.updated"), diff: z.strictObject({
    before: z.strictObject({ revision }), after: z.strictObject({ revision }), changedFields,
  }) }),
  z.strictObject({ action: z.literal("people.merged"), diff: z.strictObject({
    before: z.strictObject({ revision }), after: z.strictObject({ revision }), manifestHash: digest,
  }) }),
  z.strictObject({ action: z.literal("membership.role_changed"), diff: z.strictObject({
    before: z.strictObject({ role }), after: z.strictObject({ role }),
  }) }),
  z.strictObject({ action: z.literal("execution.completed"), diff: z.strictObject({
    before: z.strictObject({ status: z.literal("running") }),
    after: z.strictObject({ status: z.literal("complete"), manifestHash: digest }),
  }) }),
]).refine(value => registeredActions.has(value.action));
// Postgres jsonb::text uses spaces after commas/colons; bound that representation,
// not just compact JSON or UTF-16 length. Allowed diff strings contain no controls.
export function auditDiffBytes(diff: unknown): number {
  const encode = (value: unknown): string => {
    if (Array.isArray(value)) return `[${value.map(encode).join(", ")}]`;
    if (value !== null && typeof value === "object") {
      return `{${Object.entries(value).map(([key, item]) => `${JSON.stringify(key)}: ${encode(item)}`).join(", ")}}`;
    }
    if (value === null || typeof value === "string" || typeof value === "boolean" ||
        (typeof value === "number" && Number.isFinite(value))) return JSON.stringify(value);
    throw new TypeError("Audit diff must be JSON");
  };
  return new TextEncoder().encode(encode(diff)).byteLength;
}
export function boundedAuditDiff<T extends z.ZodType>(projection: T) {
  return projection.refine(value => auditDiffBytes(value) <= 2048, { message: "audit_diff_too_large" });
}
export const auditInput = z.strictObject({
  id: eventId, subject, operationId,
  effectId: effectId.nullable(), recordedAt: instant, change: auditChange,
});
export const auditEntry = auditInput.extend({ actor: attribution }).superRefine((entry, ctx) => {
  if (auditDiffBytes(entry.change.diff) > 2048) ctx.addIssue({ code: "custom", message: "audit_diff_too_large" });
  if (entry.actor.kind === "tombstone" && entry.actor.owner !== entry.subject.owner.id) {
    ctx.addIssue({ code: "custom", message: "invalid_attribution_scope" });
  }
  if (entry.change.action.startsWith("people.") && entry.subject.kind !== "person") {
    ctx.addIssue({ code: "custom", message: "invalid_subject" });
  }
  if (entry.change.action === "membership.role_changed" && entry.subject.kind !== "seat") {
    ctx.addIssue({ code: "custom", message: "invalid_subject" });
  }
  if (entry.change.action === "execution.completed" && entry.subject.kind !== "operation") {
    ctx.addIssue({ code: "custom", message: "invalid_subject" });
  }
});
export type AuditEntry = z.infer<typeof auditEntry>;
export function buildHumanAudit(scope: CommandScope, input: Omit<z.input<typeof auditEntry>, "actor">): AuditEntry | null {
  const parsed = auditEntry.safeParse({ ...input, actor: scope.actor });
  if (!parsed.success || !sameOwner(parsed.data.subject.owner, scope.owner)) return null;
  return parsed.data;
}
// Service attribution is an adapter-owned cause, never a claimed human approval.
export function buildServiceAudit(actor: Extract<Attribution, {kind: "service"}>, selectedOwner: z.infer<typeof owner>,
  input: Omit<z.input<typeof auditEntry>, "actor">): AuditEntry | null {
  const parsed = auditEntry.safeParse({ ...input, actor });
  if (!parsed.success || !sameOwner(parsed.data.subject.owner, selectedOwner)) return null;
  return parsed.data;
}
