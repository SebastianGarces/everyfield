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
	"pipelineSharing.checkAggregateAccess": Boundary<
		typeof Q.pipelineAggregateAccessRequest,
		typeof R.pipelineAggregateAccessResult
	>;
}
export type OrganizationAdapter<Tx> = {
	[K in keyof OrganizationOperations]: (
		tx: Tx,
		session: z.infer<typeof sessionId>,
		selected: Owner,
		input: OrganizationOperations[K]["input"],
	) => Promise<OrganizationOperations[K]["output"]>;
};
