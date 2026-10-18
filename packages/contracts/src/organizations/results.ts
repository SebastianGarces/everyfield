import { z } from "zod";
import { accountId, eventId, recordId, revision } from "../common/values.ts";
import { instant, timeZone } from "../common/time.ts";
import { receipt } from "../common/transaction.ts";
import { organizationOwner, plantOwner, relationshipPair, residentChoices, sharingChoices } from "./subjects.ts";
import { profileFields } from "./requests.ts";

export const unavailableResult = z.strictObject({ status: z.literal("unavailable") });
export const relationshipProjection = z.strictObject({ id: recordId, pair: relationshipPair, revision,
  acceptedAt: instant, endedAt: instant.nullable() })
  .refine(v => v.endedAt === null || v.endedAt >= v.acceptedAt);
export const invitationResult = z.strictObject({ status: z.literal("pending"), invitationId: recordId,
  pair: relationshipPair, revision, expiresAt: instant, inviterDescription: z.string().trim().min(1).max(500),
  receipt });
// A committed response never claims mail delivery. Delivery/retry is outbox-owned.
export const mutationResult = z.union([unavailableResult,
  z.strictObject({ status: z.literal("committed"), receipt })]);
export const invitationDecisionResult = z.union([unavailableResult,
  z.strictObject({ status: z.literal("accepted"), relationship: relationshipProjection, receipt }),
  z.strictObject({ status: z.literal("declined"), invitationId: recordId, receipt }),
]);

const pairInfo = { plant: plantOwner, organization: organizationOwner,
  organizationDisplayName: z.string().trim().min(1).max(200), activeAffiliation: z.boolean() };
export const sharingResult = z.union([unavailableResult,
  z.strictObject({ view: z.literal("plant_administration"), ...pairInfo, consentRevision: revision, choices: sharingChoices }),
  z.strictObject({ view: z.literal("plant_member"), ...pairInfo }),
  z.strictObject({ view: z.literal("organization"), ...pairInfo, availability: sharingChoices }),
]);
// Show this before first acceptance. The server supplies the prior exact-pair
// choices on rejoin; parsing a disclosure cannot reset stored consent.
export const sharingDisclosure = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("self_start"),
    choices: z.strictObject({ people: z.literal(false), meetings: z.literal(false), tasks: z.literal(false),
      ministry_teams: z.literal(false), wiki: z.literal(false), activity: z.literal(false), shared_findings: z.literal(false) }) }),
  z.strictObject({ kind: z.literal("first_invitation"), organization: organizationOwner,
    choices: z.strictObject({ people: z.literal(true), meetings: z.literal(true), tasks: z.literal(true),
      ministry_teams: z.literal(true), wiki: z.literal(true), activity: z.literal(true), shared_findings: z.literal(true) }) }),
  z.strictObject({ kind: z.literal("existing_consent"), organization: organizationOwner,
    consentRevision: revision, choices: sharingChoices }),
]);
export const organizationProfileResult = z.union([unavailableResult,
  z.strictObject({ status: z.literal("available"), organization: organizationOwner, revision, profile: profileFields, timeZone: timeZone }),
]);
// Minimal typed history is separate from current entitlement and protected reason.
const attribution = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("account"), accountId }),
  z.strictObject({ kind: z.literal("deleted_account"), token: z.string().min(1).max(200) }),
]);
export const relationshipHistoryResult = z.union([unavailableResult,
  z.strictObject({ status: z.literal("available"), pair: relationshipPair,
    items: z.array(z.strictObject({ id: eventId, event: z.enum(["approved", "ended"]),
      occurredAt: instant, recordedAt: instant, actor: attribution, sourceInvitationId: recordId.nullable() })).max(100),
    next: recordId.nullable(), completeness: z.enum(["complete", "partial"]) }),
]);
export const residencySharingResult = z.union([unavailableResult,
  z.strictObject({ status: z.literal("active"), linkId: recordId, organization: organizationOwner,
    consentRevision: revision, choices: residentChoices }),
  z.strictObject({ status: z.literal("ended"), linkId: recordId }),
]);
export const pipelineConsentResult = z.union([unavailableResult,
  z.strictObject({ status: z.literal("available"), relationshipId: recordId, revision,
    sharePipelineTotals: z.boolean(), minimumContributors: z.literal(2) }),
]);
// No count, contributor IDs, private progress or withheld-versus-zero payload.
export const pipelineAggregateAccessResult = z.strictObject({ allowed: z.boolean(), minimumContributors: z.literal(2) });

// Fixed producer projections. The dispatcher still rechecks current relationship,
// category and recipient eligibility; a coarse sever notice uses its own event.
export const relationshipNotice = z.strictObject({ eventId, relationshipId: recordId,
  kind: z.enum(["relationship_approved", "relationship_ended", "sharing_changed"]) });
export const oversightActivityLine = z.strictObject({ date: z.iso.date(),
  activity: z.enum(["people", "meetings", "tasks", "ministry_teams", "wiki"]), count: z.number().int().nonnegative() });
