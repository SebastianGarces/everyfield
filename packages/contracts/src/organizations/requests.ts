import { z } from "zod";
import { recordId, revision } from "../common/values.ts";
import { commandEnvelope } from "../common/transaction.ts";
import { normalizedEmail } from "../identity/requests.ts";
import { organizationOwner, plantOwner, relationshipPair, residentChoices, sharingCategory, networkOwner, relationshipHistoryScope, hasHistoryEndpoint } from "./subjects.ts";

// Session, actor, roles, current scope, approval and clock come from server adapters.
export const inviteRelationshipRequest = commandEnvelope(z.strictObject({ pair: relationshipPair,
  recipientEmail: normalizedEmail.pipe(z.string().max(320)) }));
const invitation = z.strictObject({ invitationId: recordId });
export const invitationCommandRequest = commandEnvelope(invitation);
// Native original-address proof is ephemeral, never stored in receipts or model input.
export const respondInvitationRequest = commandEnvelope(invitation.extend({
  proof: z.string().min(1).max(4096), decision: z.enum(["accept", "decline"]),
}));
export const acceptInvitationRequest = commandEnvelope(invitation.extend({
  proof: z.string().min(1).max(4096), decision: z.literal("accept"),
}));
export const declineInvitationRequest = commandEnvelope(invitation.extend({ decision: z.literal("decline") }));
export const endRelationshipRequest = commandEnvelope(z.strictObject({ relationshipId: recordId,
  pair: relationshipPair, confirmed: z.literal(true), reason: z.string().trim().min(1).max(1000).nullable() }));
const historyFilters = { pair: relationshipPair.optional(), after: recordId.optional() };
export const relationshipHistoryRequest = z.union([
  relationshipHistoryScope.options[0].extend(historyFilters),
  relationshipHistoryScope.options[1].extend(historyFilters),
  relationshipHistoryScope.options[2].extend(historyFilters),
  relationshipHistoryScope.options[3].extend(historyFilters),
]).refine(value => value.pair === undefined || hasHistoryEndpoint(value, value.pair));
export const readSharingRequest = z.strictObject({ plant: plantOwner, organization: organizationOwner });
export const setSharingRequest = commandEnvelope(readSharingRequest.extend({ relationshipId: recordId,
  expectedConsentRevision: revision, category: sharingCategory, enabled: z.boolean() }));

const boundedText = z.string().trim().max(200).nullable();
export const profileFields = z.strictObject({ name: z.string().trim().min(1).max(200), city: boundedText,
  stateProvince: boundedText, country: boundedText, description: z.string().trim().max(5000).nullable(),
  contactEmail: normalizedEmail.pipe(z.string().max(320)).nullable(), contactPhone: z.string().trim().max(50).nullable() });
export const organizationProfileRequest = z.strictObject({ organization: organizationOwner });
export const updateOrganizationProfileRequest = commandEnvelope(organizationProfileRequest.extend({
  patch: profileFields.partial().refine(v => Object.keys(v).length > 0),
}));
// Plant settings, despite the historical operation name. Never accepts street,
// coordinates, guessed geography, a caller clock or a phase attestation.
export const correctReportingLocationRequest = commandEnvelope(z.strictObject({ plant: plantOwner,
  locality: z.strictObject({ city: boundedText, stateProvince: boundedText, country: boundedText }),
  referenceVersionId: recordId, regionItemId: recordId.nullable(),
}));
export const residencySharingRequest = z.strictObject({ linkId: recordId });
export const setResidencySharingRequest = commandEnvelope(residencySharingRequest.extend({
  expectedConsentRevision: revision, choices: residentChoices,
}));
export const leaveResidencyRequest = commandEnvelope(residencySharingRequest.extend({ expectedConsentRevision: revision }));
export const pipelineConsentRequest = z.strictObject({ relationshipId: recordId });
export const setPipelineConsentRequest = commandEnvelope(pipelineConsentRequest.extend({ sharePipelineTotals: z.boolean() }));
// No filters/contributor list/asOf override can turn this S0 check into totals delivery.
export const pipelineAggregateAccessRequest = z.strictObject({ network: networkOwner });
