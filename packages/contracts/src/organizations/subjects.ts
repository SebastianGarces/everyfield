import { z } from "zod";
import { accountId, owner, sameOwner } from "../common/values.ts";
import { organizationOwner } from "../access/results.ts";

export { organizationOwner };
export const plantOwner = owner.transform((value, ctx) => {
  if (value.kind === "plant") return value;
  ctx.addIssue({ code: "custom", message: "Expected a plant owner" });
  return z.NEVER;
});
export const sendingChurchOwner = organizationOwner.transform((value, ctx) => {
  if (value.organizationKind === "sending_church") return { ...value, organizationKind: value.organizationKind };
  ctx.addIssue({ code: "custom", message: "Expected a sending church" });
  return z.NEVER;
});
export const networkOwner = organizationOwner.transform((value, ctx) => {
  if (value.organizationKind === "sending_network") return { ...value, organizationKind: value.organizationKind };
  ctx.addIssue({ code: "custom", message: "Expected a sending network" });
  return z.NEVER;
});
// These are exact endpoints, never a graph of inherited grants.
export const relationshipPair = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("plant"), subject: plantOwner, organization: organizationOwner })
    .refine(v => v.subject.id !== v.organization.id),
  z.strictObject({ kind: z.literal("sending_church"), subject: sendingChurchOwner, organization: networkOwner })
    .refine(v => v.subject.id !== v.organization.id),
  z.strictObject({ kind: z.literal("discovery"), accountId, organization: organizationOwner }),
]);
export type RelationshipPair = z.infer<typeof relationshipPair>;

// Names follow REQ-IDN-022. SQL column mapping belongs to the API producer.
export const sharingCategory = z.enum(["people", "meetings", "tasks", "ministry_teams", "wiki", "activity", "shared_findings"]);
export const sharingChoices = z.strictObject({ people: z.boolean(), meetings: z.boolean(), tasks: z.boolean(),
  ministry_teams: z.boolean(), wiki: z.boolean(), activity: z.boolean(), shared_findings: z.boolean() });
export const residentChoices = z.strictObject({ shareFoundations: z.boolean(), shareMilestones: z.boolean() });

// Scope identifies requested endpoints only. The API still authorizes current
// subjects and organization seats; an endpoint match never grants access.
export const relationshipHistoryScope = z.union([
  z.strictObject({ plant: plantOwner }),
  z.strictObject({ sendingChurch: sendingChurchOwner }),
  z.strictObject({ discoveryAccountId: accountId }),
  z.strictObject({ organization: organizationOwner }),
]);
export type RelationshipHistoryScope = z.infer<typeof relationshipHistoryScope>;
export function hasHistoryEndpoint(scope: RelationshipHistoryScope, pair: RelationshipPair): boolean {
  if ("plant" in scope) return pair.kind === "plant" && sameOwner(scope.plant, pair.subject);
  if ("sendingChurch" in scope) return pair.kind === "sending_church" && sameOwner(scope.sendingChurch, pair.subject);
  if ("discoveryAccountId" in scope) return pair.kind === "discovery" && scope.discoveryAccountId === pair.accountId;
  return sameOwner(scope.organization, pair.organization) ||
    (pair.kind === "sending_church" && sameOwner(scope.organization, pair.subject));
}
