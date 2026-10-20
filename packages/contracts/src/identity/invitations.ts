import { plantOwner } from "../people/values.ts";
import { z } from "zod";
import { organizationOwner, tenantOwner } from "../access/results.ts";
import { instant } from "../common/time.ts";
import { accountId, defineSafeError, personId, recordId, revision, safeError, sameOwner } from "../common/values.ts";
import { commandEnvelope } from "../common/writes.ts";
import { relationshipPair, residentChoices } from "../organizations/subjects.ts";
import { normalizedEmail } from "./requests.ts";

export const ordinarySeatRole = z.enum(["admin", "member"]);
export const seatInvitationSubject = z.strictObject({
	purpose: z.literal("seat"),
	workspace: tenantOwner,
	role: ordinarySeatRole,
});
export const residentInvitationSubject = z.strictObject({
	purpose: z.literal("residency_link"),
	organization: organizationOwner,
	personId,
});
// Relationship ownership and consent remain with the WP-007 producer.
export const invitationSubject = z.discriminatedUnion("purpose", [
	seatInvitationSubject,
	residentInvitationSubject,
	z.strictObject({ purpose: z.literal("association"), pair: relationshipPair }),
]);
const proof = z.string().min(1).max(4096);
const addressedEmail = normalizedEmail.pipe(z.string().max(320));
const invitationIdInput = z.strictObject({ invitationId: recordId });

// Actor, clock, address verification and authority are loaded by the server.
export const inviteSeatRequest = commandEnvelope(
	z.strictObject({ workspace: tenantOwner, recipientEmail: addressedEmail, role: ordinarySeatRole }),
);
export const inviteResidentRequest = commandEnvelope(
	z.strictObject({ organization: organizationOwner, personId, recipientEmail: addressedEmail }),
);
export const resendInvitationRequest = commandEnvelope(invitationIdInput);
export const revokeInvitationRequest = commandEnvelope(invitationIdInput);
export const describeInvitationRequest = z.strictObject({ proof });
// These proofs are native-only transient inputs, never Evry tools or receipt fields.
export const acceptSeatInvitationRequest = commandEnvelope(invitationIdInput.extend({ proof }));
export const respondResidentInvitationRequest = commandEnvelope(
	z.discriminatedUnion("decision", [
		invitationIdInput.extend({ proof, decision: z.literal("accept"), choices: residentChoices }),
		invitationIdInput.extend({ proof, decision: z.literal("decline") }),
	]),
);
export const listInvitationsRequest = z.strictObject({ workspace: tenantOwner, after: recordId.optional() });

const unavailable = z.strictObject({ status: z.literal("unavailable") });
const description = {
	invitationId: recordId,
	subject: invitationSubject,
	revision,
	inviterDescription: z.string().trim().min(1).max(500),
	workspaceName: z.string().trim().min(1).max(200),
	expiresAt: instant,
};
// A description is an observation, never mailbox proof or permission to claim.
// Invalid, unrelated, expired and revoked proofs share unavailable.
export const invitationDescriptionResult = z.union([
	unavailable,
	z.strictObject({ status: z.literal("pending"), ...description }),
]);
export const pendingInvitation = z.strictObject({
	status: z.literal("pending"),
	...description,
	recipientEmail: addressedEmail,
	resendAvailableAt: instant,
});
export const invitationListResult = z
	.strictObject({
		workspace: tenantOwner,
		items: z.array(pendingInvitation).max(100),
		next: recordId.nullable(),
		completeness: z.enum(["complete", "partial"]),
	})
	.refine((v) =>
		v.items.every((i) =>
			i.subject.purpose === "seat"
				? sameOwner(i.subject.workspace, v.workspace)
				: i.subject.purpose === "residency_link" && sameOwner(i.subject.organization, v.workspace),
		),
	);
export const invitationSentResult = z.strictObject({ invitation: pendingInvitation });
export const invitationRevokedResult = z.strictObject({
	status: z.literal("revoked"),
	invitationId: recordId,
	revision,
});

// No accepted output can describe pending registration or a partial claim.
// API implements one locked transaction for claim, exact grant/link, Person,
// activation, receipt, audit and required mail intent. Dispatch is after commit.
const acceptedSeat = z.discriminatedUnion("kind", [
	z.strictObject({
		kind: z.literal("plant"),
		workspace: plantOwner,
		seatId: recordId,
		role: ordinarySeatRole,
		personId,
	}),
	z.strictObject({
		kind: z.literal("organization"),
		workspace: organizationOwner,
		seatId: recordId,
		role: ordinarySeatRole,
	}),
]);
export const seatInvitationAcceptedResult = z.strictObject({
	status: z.literal("accepted"),
	invitationId: recordId,
	accountId,
	registrationState: z.literal("active"),
	seat: acceptedSeat,
});
export const residentInvitationDecisionResult = z.union([
	z.strictObject({
		status: z.literal("accepted"),
		invitationId: recordId,
		linkId: recordId,
		organization: organizationOwner,
		personId,
		consentRevision: revision,
		choices: residentChoices,
	}),
	z.strictObject({ status: z.literal("declined"), invitationId: recordId }),
]);
export const invitationError = z.discriminatedUnion("code", [
	...safeError.options,
	defineSafeError("invitation_unavailable", {}, "never"),
	defineSafeError("invitation_rate_limited", { retryAt: instant }, "same_request"),
	defineSafeError("invitation_cooldown", { retryAt: instant }, "same_request"),
	defineSafeError("idempotency_conflict", {}, "never"),
]);
export type InvitationSubject = z.infer<typeof invitationSubject>;
export type AcceptSeatInvitationRequest = z.infer<typeof acceptSeatInvitationRequest>;
export type RespondResidentInvitationRequest = z.infer<typeof respondResidentInvitationRequest>;
export type SeatInvitationAcceptedResult = z.infer<typeof seatInvitationAcceptedResult>;
