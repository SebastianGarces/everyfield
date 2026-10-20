import { z } from "zod";
import { instant, timeZone } from "../common/time.ts";
import { accountId, eventId, recordId, revision } from "../common/values.ts";
import { profileFields } from "./requests.ts";
import {
	hasHistoryEndpoint,
	organizationOwner,
	plantOwner,
	relationshipHistoryScope,
	relationshipPair,
	residentChoices,
	sharingChoices,
} from "./subjects.ts";

export const unavailableResult = z.strictObject({ status: z.literal("unavailable") });
export const relationshipProjection = z
	.strictObject({ id: recordId, pair: relationshipPair, revision, acceptedAt: instant, endedAt: instant.nullable() })
	.refine((v) => v.endedAt === null || v.endedAt >= v.acceptedAt);
export const invitationResult = z.strictObject({
	status: z.literal("pending"),
	invitationId: recordId,
	pair: relationshipPair,
	revision,
	expiresAt: instant,
	inviterDescription: z.string().trim().min(1).max(500),
});
// A committed response never claims mail delivery. Delivery/retry is outbox-owned.
export const mutationResult = z.union([unavailableResult, z.strictObject({ status: z.literal("committed") })]);
const acceptedInvitation = z.strictObject({
	status: z.literal("accepted"),
	relationship: relationshipProjection,
});
const declinedInvitation = z.strictObject({ status: z.literal("declined"), invitationId: recordId });
export const acceptedInvitationResult = z.union([unavailableResult, acceptedInvitation]);
export const declinedInvitationResult = z.union([unavailableResult, declinedInvitation]);
export const invitationDecisionResult = z.union([unavailableResult, acceptedInvitation, declinedInvitation]);

const pairInfo = {
	plant: plantOwner,
	organization: organizationOwner,
	organizationDisplayName: z.string().trim().min(1).max(200),
	activeAffiliation: z.boolean(),
};
export const sharingResult = z.union([
	unavailableResult,
	z.strictObject({
		view: z.literal("plant_administration"),
		...pairInfo,
		consentRevision: revision,
		choices: sharingChoices,
	}),
	z.strictObject({ view: z.literal("plant_member"), ...pairInfo }),
	z.strictObject({ view: z.literal("organization"), ...pairInfo, availability: sharingChoices }),
]);
// Show this before first acceptance. The server supplies the prior exact-pair
// choices on rejoin; parsing a disclosure cannot reset stored consent.
export const sharingDisclosure = z.discriminatedUnion("kind", [
	z.strictObject({
		kind: z.literal("self_start"),
		choices: z.strictObject({
			people: z.literal(false),
			meetings: z.literal(false),
			tasks: z.literal(false),
			ministry_teams: z.literal(false),
			wiki: z.literal(false),
			activity: z.literal(false),
			shared_findings: z.literal(false),
		}),
	}),
	z.strictObject({
		kind: z.literal("first_invitation"),
		organization: organizationOwner,
		choices: z.strictObject({
			people: z.literal(true),
			meetings: z.literal(true),
			tasks: z.literal(true),
			ministry_teams: z.literal(true),
			wiki: z.literal(true),
			activity: z.literal(true),
			shared_findings: z.literal(true),
		}),
	}),
	z.strictObject({
		kind: z.literal("existing_consent"),
		organization: organizationOwner,
		consentRevision: revision,
		choices: sharingChoices,
	}),
]);
export const organizationProfileResult = z.union([
	unavailableResult,
	z.strictObject({
		status: z.literal("available"),
		organization: organizationOwner,
		revision,
		profile: profileFields,
		timeZone: timeZone,
	}),
]);
// Domain history is separate from current entitlement and central audit.
const attribution = z.discriminatedUnion("kind", [
	z.strictObject({ kind: z.literal("account"), accountId }),
	z.strictObject({ kind: z.literal("deleted_account"), token: z.string().min(1).max(200) }),
]);
export const relationshipHistoryResult = z.union([
	unavailableResult,
	z
		.strictObject({
			status: z.literal("available"),
			scope: relationshipHistoryScope,
			activeRelationships: z.array(relationshipProjection.refine((value) => value.endedAt === null)).max(100),
			items: z
				.array(
					z.strictObject({
						id: eventId,
						pair: relationshipPair,
						event: z.enum(["approved", "ended"]),
						// Members and other purpose-limited readers get withheld regardless of
						// whether a reason exists. Only entitled readers receive the recorded value.
						reason: z.discriminatedUnion("status", [
							z.strictObject({ status: z.literal("withheld") }),
							z.strictObject({ status: z.literal("available"), value: z.string().max(1000).nullable() }),
						]),
						occurredAt: instant,
						recordedAt: instant,
						actor: attribution,
						sourceInvitationId: recordId.nullable(),
					}),
				)
				.max(100),
			next: recordId.nullable(),
			completeness: z.enum(["complete", "partial"]),
		})
		.refine(
			(value) =>
				value.activeRelationships.every((row) => hasHistoryEndpoint(value.scope, row.pair)) &&
				value.items.every((row) => hasHistoryEndpoint(value.scope, row.pair)),
		),
]);
export const residencySharingResult = z.union([
	unavailableResult,
	z.strictObject({
		status: z.literal("active"),
		linkId: recordId,
		organization: organizationOwner,
		consentRevision: revision,
		choices: residentChoices,
	}),
	z.strictObject({ status: z.literal("ended"), linkId: recordId }),
]);
export const pipelineConsentResult = z.union([
	unavailableResult,
	z.strictObject({
		status: z.literal("available"),
		relationshipId: recordId,
		revision,
		sharePipelineTotals: z.boolean(),
		minimumContributors: z.literal(2),
	}),
]);
// No count, contributor IDs, private progress or withheld-versus-zero payload.
export const pipelineAggregateAccessResult = z.strictObject({
	allowed: z.boolean(),
	minimumContributors: z.literal(2),
});

// Fixed producer projections. The dispatcher still rechecks current relationship,
// category and recipient eligibility; a coarse sever notice uses its own event.
export const relationshipNotice = z.strictObject({
	eventId,
	relationshipId: recordId,
	kind: z.enum(["relationship_approved", "relationship_ended", "sharing_changed"]),
});
export const oversightActivityLine = z.strictObject({
	date: z.iso.date(),
	activity: z.enum(["people", "meetings", "tasks", "ministry_teams", "wiki"]),
	count: z.number().int().nonnegative(),
});
