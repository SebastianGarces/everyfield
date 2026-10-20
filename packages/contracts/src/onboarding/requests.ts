import { z } from "zod";
import { localDate } from "../common/time.ts";
import { recordId, revision } from "../common/values.ts";
import { commandEnvelope } from "../common/writes.ts";
import { organizationOwner, sharingChoices } from "../organizations/subjects.ts";

const name = z.string().trim().min(1).max(200);
const localityPart = z.string().trim().max(200).nullable().optional();
export const locality = z.strictObject({ city: localityPart, stateProvince: localityPart, country: localityPart });
// Confirmation belongs to the account owner. No resident prefill, organization
// actor, phase, inferred geography, readiness or seat-transfer input exists.
export const plantBasics = z.strictObject({ name, locality: locality.optional(), confirmed: z.literal(true) });
export const createPlantRequest = commandEnvelope(plantBasics);
export const createDiscoveryRequest = commandEnvelope(z.strictObject({}));
export const getDiscoveryProfileRequest = z.strictObject({});
export const getResumeRequest = z.strictObject({});
export const completeOnboardingRequest = commandEnvelope(z.strictObject({}));

export const selectedRelationship = z.strictObject({
	relationshipId: recordId,
	organization: organizationOwner,
	expectedRelationshipRevision: revision,
	expectedConsentRevision: revision,
	choices: sharingChoices,
});
export const convertDiscoveryRequest = commandEnvelope(
	plantBasics.extend({
		discoveryId: recordId,
		relationships: z
			.array(selectedRelationship)
			.max(100)
			.refine(
				(rows) =>
					new Set(rows.map((r) => r.relationshipId)).size === rows.length &&
					new Set(rows.map((r) => r.organization.id)).size === rows.length,
			),
	}),
);
// References are a proposal only. WP-037 rechecks private self ownership and
// target authority and copies the exact revision; creation never copies bodies.
export const documentCarryForwardProposal = z.strictObject({
	documentId: recordId,
	revisionId: recordId,
	expectedRevision: revision,
});

export const leadAssignmentSelection = z.discriminatedUnion("kind", [
	z.strictObject({
		kind: z.literal("existing_role"),
		teamId: recordId,
		roleId: recordId,
		expectedTeamRevision: revision,
		expectedRoleRevision: revision,
	}),
	z.strictObject({
		kind: z.literal("minimal_role"),
		roleName: name,
		container: z.discriminatedUnion("kind", [
			z.strictObject({ kind: z.literal("existing"), teamId: recordId, expectedRevision: revision }),
			z.strictObject({ kind: z.literal("minimal"), name }),
		]),
	}),
]);
export const answerLeadRequest = commandEnvelope(
	z.discriminatedUnion("answer", [
		z.strictObject({ answer: z.literal("yes"), assignment: leadAssignmentSelection }),
		z.strictObject({ answer: z.literal("no") }),
		z.strictObject({ answer: z.literal("skip") }),
	]),
);
export const journeyAnswer = z.discriminatedUnion("answer", [
	z.strictObject({ answer: z.literal("existing"), phase: z.int().min(0).max(6) }),
	z.strictObject({ answer: z.literal("unsure") }),
	z.strictObject({ answer: z.literal("discerning") }),
	z.strictObject({ answer: z.literal("skip") }),
]);
// no_date and skip preserve any current schedule. Clearing is not onboarding.
export const launchAnswer = z.discriminatedUnion("answer", [
	z.strictObject({ answer: z.literal("planned"), date: localDate, expectedScheduleRevision: revision }),
	z.strictObject({ answer: z.literal("no_date") }),
	z.strictObject({ answer: z.literal("skip") }),
]);
export const declareJourneyRequest = commandEnvelope(z.strictObject({ journey: journeyAnswer, launch: launchAnswer }));
export type CreatePlantRequest = z.infer<typeof createPlantRequest>;
export type ConvertDiscoveryRequest = z.infer<typeof convertDiscoveryRequest>;
export type AnswerLeadRequest = z.infer<typeof answerLeadRequest>;
export type DeclareJourneyRequest = z.infer<typeof declareJourneyRequest>;
