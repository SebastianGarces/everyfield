import type { z } from "zod";
import type { Owner, sessionId } from "../common/values.ts";
import type * as Q from "./requests.ts";
import type * as R from "./results.ts";

type Boundary<I extends z.ZodType, O extends z.ZodType> = { input: z.infer<I>; output: z.infer<O> };
export interface OrganizationOperations {
  "associations.invite": Boundary<typeof Q.inviteRelationshipRequest, typeof R.invitationResult>;
  "associations.acceptInvitation": Boundary<typeof Q.acceptInvitationRequest, typeof R.acceptedInvitationResult>;
  "associations.respondInvitation": Boundary<typeof Q.respondInvitationRequest, typeof R.invitationDecisionResult>;
  "associations.declineInvitation": Boundary<typeof Q.declineInvitationRequest, typeof R.declinedInvitationResult>;
  "associations.resendInvitation": Boundary<typeof Q.invitationCommandRequest, typeof R.invitationResult>;
  "associations.revokeInvitation": Boundary<typeof Q.invitationCommandRequest, typeof R.mutationResult>;
  "associations.end": Boundary<typeof Q.endRelationshipRequest, typeof R.mutationResult>;
  "associations.getHistory": Boundary<typeof Q.relationshipHistoryRequest, typeof R.relationshipHistoryResult>;
  "organizations.getProfile": Boundary<typeof Q.organizationProfileRequest, typeof R.organizationProfileResult>;
  "organizations.updateProfile": Boundary<typeof Q.updateOrganizationProfileRequest, typeof R.mutationResult>;
  "organizations.correctReportingLocation": Boundary<typeof Q.correctReportingLocationRequest, typeof R.mutationResult>;
  "privacy.getSharing": Boundary<typeof Q.readSharingRequest, typeof R.sharingResult>;
  "privacy.setSharing": Boundary<typeof Q.setSharingRequest, typeof R.mutationResult>;
  "residency.readSharing": Boundary<typeof Q.residencySharingRequest, typeof R.residencySharingResult>;
  "residency.setSharing": Boundary<typeof Q.setResidencySharingRequest, typeof R.mutationResult>;
  "residency.leave": Boundary<typeof Q.leaveResidencyRequest, typeof R.mutationResult>;
  "pipelineSharing.readConsent": Boundary<typeof Q.pipelineConsentRequest, typeof R.pipelineConsentResult>;
  "pipelineSharing.setConsent": Boundary<typeof Q.setPipelineConsentRequest, typeof R.mutationResult>;
  "pipelineSharing.checkAggregateAccess": Boundary<typeof Q.pipelineAggregateAccessRequest, typeof R.pipelineAggregateAccessResult>;
}
// Implement only in server-only code. Tx is the producer's actual transaction.
// Re-read session, lifecycle, exact typed endpoint/current seat or self link,
// revisions and consent inside it. Native/Evry use identical domain inputs;
// trusted reviewed effects and original-address proof admission stay separate.
// History reads authorize their whole requested scope and each returned pair.
// Protected end reasons are withheld for Member and purpose-limited readers
// regardless of existence; only an entitled reader receives recorded text.
// First acceptance discloses exact-org defaults; rejoin preserves saved choices.
// Commit facts+history+safe audit+receipt+required notice/invalidation intents
// together. Replays return originals. Provider calls run after commit. Expiry,
// invite limits/cooldown and all live revocation fences are API responsibilities.
// Resident revoke applies to every derived read/history/job/byte/model path;
// genuine independently org-owned enrollment facts survive consent withdrawal.
// Aggregate check counts distinct currently eligible churches, never rows or the
// network's own pipeline; delivery/filtering/history remain deferred to stage 4.
export type OrganizationAdapter<Tx> = {
  [K in keyof OrganizationOperations]: (tx: Tx, session: z.infer<typeof sessionId>, selected: Owner,
    input: OrganizationOperations[K]["input"]) => Promise<OrganizationOperations[K]["output"]>;
};
