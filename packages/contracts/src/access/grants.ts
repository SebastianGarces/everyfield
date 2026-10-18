import { z } from "zod";
import { accountId, owner, personId, recordId, revision } from "../common/values.ts";
import { instant } from "../common/time.ts";
import { organizationOwner } from "./results.ts";

const plantOwner = owner.transform((value, ctx) => {
  if (value.kind === "plant") return value;
  ctx.addIssue({ code: "custom", message: "Expected a plant owner" });
  return z.NEVER;
});
// Server adapter observations only. Parsing these never authenticates a caller.
// Missing/ended/revoked/unaccepted rows produce no current grant. Every decision
// re-reads exact endpoints and lifecycle, and never traverses these as a graph.
// Sharing selects bounded category projections, never raw plant CRM. A sending
// church's network link supplies no inherited plant or network content grant.
const currentEpisode = { id: recordId, revision, acceptedAt: instant };
export const plantAffiliationGrant = z.strictObject({
  kind: z.literal("plant_affiliation"), ...currentEpisode,
  plant: plantOwner, organization: organizationOwner,
  sharing: z.strictObject({ people: z.boolean(), meetings: z.boolean(), tasks: z.boolean(),
    ministry: z.boolean(), wiki: z.boolean(), activity: z.boolean(), findings: z.boolean() }),
});
export const discoveryRelationshipGrant = z.strictObject({
  kind: z.literal("discovery_relationship"), ...currentEpisode, accountId, organization: organizationOwner,
});
export const residencyLinkGrant = z.strictObject({
  kind: z.literal("residency_link"), ...currentEpisode, accountId, organization: organizationOwner, personId,
  consentRevision: revision, shareFoundations: z.boolean(), shareMilestones: z.boolean(),
});
export const platformCapability = z.enum(["feedback_triage", "reference_publish", "recovery_operator"]);
export const platformGrant = z.strictObject({
  kind: z.literal("platform"), id: recordId, revision, accountId,
  capability: platformCapability, expiresAt: instant.nullable(),
});
// No common "role"/wildcard field or inheritance across these independent cases.
export const independentGrant = z.discriminatedUnion("kind", [
  plantAffiliationGrant, discoveryRelationshipGrant, residencyLinkGrant, platformGrant,
]);
export type IndependentGrant = z.infer<typeof independentGrant>;
