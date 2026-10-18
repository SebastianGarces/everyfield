import { z } from "zod";

// Parse semantic primitives once at the transport/database boundary.
export const accountId = z.uuid().brand<"AccountId">();
export const tenantId = z.uuid().brand<"TenantId">();
export const personId = z.uuid().brand<"PersonId">();
export const recordId = z.uuid().brand<"RecordId">();
export const operationId = z.uuid().brand<"OperationId">();
export const reviewId = z.uuid().brand<"ReviewId">();
export const conversationId = z.uuid().brand<"ConversationId">();
export const eventId = z.uuid().brand<"EventId">();
export const effectId = z.uuid().brand<"EffectId">();
export const sessionId = z.string().min(1).max(256).brand<"SessionId">();
export const requestKey = z.string().min(1).max(200).brand<"RequestKey">();
export const digest = z.string().regex(/^[a-f0-9]{64}$/).brand<"Digest">();
// PostgreSQL bigint revisions cross JSON as decimal strings, never lossy numbers.
export const revision = z.string().regex(/^(0|[1-9]\d*)$/)
  .refine(v => BigInt(v) <= 9223372036854775807n).brand<"Revision">();
export const role = z.enum(["owner", "admin", "member"]);
export const organizationKind = z.enum(["sending_church", "sending_network"]);
export const owner = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("account"), id: accountId }),
  z.strictObject({ kind: z.literal("plant"), id: tenantId }),
  z.strictObject({ kind: z.literal("organization"), id: tenantId, organizationKind }),
  z.strictObject({ kind: z.literal("global"), id: tenantId.refine(v => v === "00000000-0000-0000-0000-000000000000") }),
]).refine(v => v.kind === "global" || v.id !== "00000000-0000-0000-0000-000000000000");
export type Owner = z.infer<typeof owner>;
export type Revision = z.infer<typeof revision>;
export function sameOwner(a: Owner, b: Owner): boolean {
  return a.kind === b.kind && a.id === b.id &&
    (a.kind !== "organization" || (b.kind === "organization" && a.organizationKind === b.organizationKind));
}

export const correlationId = z.uuid().brand<"CorrelationId">();
export const safeError = z.discriminatedUnion("code", [
  z.strictObject({ code: z.literal("invalid_input"), correlationId, retry: z.literal("never") }),
  // Missing and forbidden share one envelope to avoid existence disclosure.
  z.strictObject({ code: z.literal("unavailable"), correlationId, retry: z.literal("never") }),
  z.strictObject({ code: z.literal("conflict"), correlationId, retry: z.literal("refresh") }),
  z.strictObject({ code: z.literal("temporary"), correlationId, retry: z.literal("same_request") }),
  z.strictObject({ code: z.literal("unknown"), correlationId, retry: z.literal("reconcile") }),
]);
export type SafeError = z.infer<typeof safeError>;
