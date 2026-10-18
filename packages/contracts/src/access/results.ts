import { z } from "zod";
import { accountId, owner, personId, recordId, revision, role } from "../common/values.ts";
import { instant } from "../common/time.ts";

// Narrow the C0 parser rather than copying its owner shapes or refinements.
export const tenantOwner = owner.transform((value, ctx) => {
  if (value.kind === "plant" || value.kind === "organization") return value;
  ctx.addIssue({ code: "custom", message: "Expected a tenant owner" });
  return z.NEVER;
});
export const organizationOwner = tenantOwner.transform((value, ctx) => {
  if (value.kind === "organization") return value;
  ctx.addIssue({ code: "custom", message: "Expected an organization owner" });
  return z.NEVER;
});
const accountOwner = owner.transform((value, ctx) => {
  if (value.kind === "account") return value;
  ctx.addIssue({ code: "custom", message: "Expected an account owner" });
  return z.NEVER;
});
const context = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("account"), owner: accountOwner }),
  z.strictObject({ kind: z.literal("seat"), owner: tenantOwner, seatId: recordId, role, revision }),
]);

// This is a bounded observation, not authority that can be saved or replayed.
// Inconsistent/duplicate current seats must yield unavailable in the API loader.
export const currentActorResult = z.discriminatedUnion("status", [
  z.strictObject({ status: z.literal("unavailable") }),
  z.strictObject({ status: z.literal("pending_domain"), accountId }),
  z.strictObject({ status: z.literal("active"), accountId, context })
    .refine(v => v.context.kind !== "account" || v.context.owner.id === v.accountId),
]);
export type CurrentActorResult = z.infer<typeof currentActorResult>;

// Refusals disclose neither a hidden subject nor a policy reason. A positive
// observation never replaces the operation's own fresh transaction checks.
export const operationCheckResult = z.discriminatedUnion("status", [
  z.strictObject({ status: z.literal("unavailable") }),
  z.strictObject({ status: z.literal("allowed") }),
]);
export type OperationCheckResult = z.infer<typeof operationCheckResult>;

// Fixed duty projections, not configurable permission rows. Multiple current
// duties may coexist; directing alone cannot imply responsible-staff notes.
export const pipelineDuty = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("organization_administration"),
    canReadStaffNotes: z.literal(true) }),
  z.strictObject({ kind: z.literal("responsible_staff"),
    canReadStaffNotes: z.literal(true) }),
  z.strictObject({ kind: z.literal("program_director"),
    canReadStaffNotes: z.literal(false) }),
]);
export const pipelineAccessResult = z.discriminatedUnion("status", [
  z.strictObject({ status: z.literal("unavailable") }),
  z.strictObject({ status: z.literal("allowed"), organization: organizationOwner, personId,
    duties: z.array(pipelineDuty).min(1).max(3)
      .refine(v => new Set(v.map(d => d.kind)).size === v.length) }),
]);
export type PipelineAccessResult = z.infer<typeof pipelineAccessResult>;

// A seatless resident receives only their own link identity here. Later product
// producers add reviewed self projections, never internal pipeline row spreads.
export const ownResidencyProjection = z.strictObject({
  organization: organizationOwner, personId, linkId: recordId, revision,
});
export type OwnResidencyProjection = z.infer<typeof ownResidencyProjection>;

// Protected native-only output of orgPeople.readNotes, after exact live duty
// checks. These bodies are absent from all general/model/export results above.
export const organizationNotesResult = z.discriminatedUnion("status", [
  z.strictObject({ status: z.literal("unavailable") }),
  z.strictObject({ status: z.literal("allowed"), purpose: z.literal("native_org_person_notes"),
    organization: organizationOwner, personId,
    duty: z.enum(["organization_administration", "responsible_staff"]),
    notes: z.array(z.strictObject({ id: recordId, author: z.discriminatedUnion("kind", [
      z.strictObject({ kind: z.literal("account"), accountId }),
      z.strictObject({ kind: z.literal("removed") }),
    ]),
      body: z.string().max(100_000), occurredAt: instant, revision })).max(100),
    next: recordId.nullable() }),
]);
export type OrganizationNotesResult = z.infer<typeof organizationNotesResult>;
