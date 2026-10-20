import { z } from "zod";
import { instant, localDate } from "../common/time.ts";
import { defineSafeError, eventId, personId, recordId, revision, safeError, sameOwner } from "../common/values.ts";
import { organizationOwner, plantOwner, sharingCategory, sharingChoices } from "../organizations/subjects.ts";
import { foundationReading, ownDiscoveryReading } from "./reading.ts";
import { documentCarryForwardProposal, journeyAnswer, launchAnswer } from "./requests.ts";

const phase = z.int().min(0).max(6);
export const creationEntry = z.strictObject({
	kind: z.literal("church_creation"),
	eventId,
	fromPhase: z.null(),
	toPhase: z.literal(1),
	recordedAt: instant,
});
const creationFields = {
	plant: plantOwner,
	revision,
	materialRevision: revision,
	ownerSeat: z.strictObject({ seatId: recordId, role: z.literal("owner"), personId }),
	creation: creationEntry,
};
// Replays return the current phase, plus the original creation evidence. They
// cannot claim a new entry or demote a plant whose journey advanced afterwards.
// Creation settings remain original evidence even if sharing changes later.
export const selfStartSharing = z.record(sharingCategory, z.literal(false));
export const createPlantResult = z.discriminatedUnion("status", [
	z.strictObject({
		status: z.literal("created"),
		...creationFields,
		initialSharing: selfStartSharing,
		currentPhase: z.literal(1),
	}),
	z.strictObject({
		status: z.literal("existing"),
		...creationFields,
		initialSharing: selfStartSharing,
		currentPhase: phase,
	}),
]);

export const conversionRelationship = z.strictObject({
	relationshipId: recordId,
	organization: organizationOwner,
	revision,
	consentRevision: revision,
	choices: sharingChoices,
});
const conversionFields = {
	discoveryId: recordId,
	...creationFields,
	relationships: z.array(conversionRelationship).max(100),
	convertedAt: instant,
	documentProposals: z.array(documentCarryForwardProposal).max(100),
};
export const convertDiscoveryResult = z.discriminatedUnion("status", [
	z.strictObject({ status: z.literal("converted"), ...conversionFields, currentPhase: z.literal(1) }),
	z.strictObject({ status: z.literal("existing"), ...conversionFields, currentPhase: phase }),
]);

const savedJourney = z.discriminatedUnion("status", [
	z.strictObject({ status: z.literal("pending") }),
	z.strictObject({ status: z.literal("saved"), value: journeyAnswer, savedAt: instant }),
]);
const leadAssignment = z.strictObject({ teamId: recordId, roleId: recordId, personId });
const recordedLead = z.discriminatedUnion("answer", [
	z.strictObject({ answer: z.literal("yes"), assignment: leadAssignment, savedAt: instant }),
	z.strictObject({ answer: z.literal("no"), savedAt: instant }),
	z.strictObject({ answer: z.literal("skip"), savedAt: instant }),
]);
export const leadSetup = z.union([z.strictObject({ answer: z.literal("pending") }), recordedLead]);
const savedLaunch = z.discriminatedUnion("status", [
	z.strictObject({ status: z.literal("pending") }),
	z.strictObject({ status: z.literal("saved"), value: launchAnswer, savedAt: instant }),
]);
const completion = z.discriminatedUnion("status", [
	z.strictObject({ status: z.literal("unfinished") }),
	z.strictObject({ status: z.literal("completed"), completedAt: instant, materialRevision: revision }),
]);
// These are independent persisted facts. Completing setup changes no reading,
// values, People, phase or launch fact and generates no synchronous assessment.
const setupFacts = {
	plant: plantOwner,
	revision,
	materialRevision: revision,
	currentPhase: phase,
	lead: leadSetup,
	journey: savedJourney,
	launch: savedLaunch,
	scheduledLaunchDate: localDate.nullable(),
	peopleStep: z.enum(["pending", "saved", "skipped"]),
	completion,
	reading: foundationReading,
	values: z.enum(["missing", "recorded"]),
};
export const resumeResult = z.union([
	z.strictObject({ status: z.literal("unavailable") }),
	z
		.strictObject({ status: z.literal("available"), ...setupFacts, basics: z.literal("created") })
		.refine((v) => v.reading.status !== "complete" || sameOwner(v.plant, v.reading.plant)),
]);
export const leadAnswerResult = z.strictObject({ plant: plantOwner, revision, lead: recordedLead });
export const journeyResult = z.strictObject({
	plant: plantOwner,
	revision,
	currentPhase: phase,
	journey: savedJourney.options[1],
	launch: savedLaunch.options[1],
	scheduledLaunchDate: localDate.nullable(),
});
export const completeOnboardingResult = z.strictObject({
	plant: plantOwner,
	revision,
	completion: completion.options[1],
});

// Explicit profile, never inferred from a missing seat. No tenant/phase/private
// body fields; Wiki/editor and account/creation controls are account-scoped.
const discoveryProfile = z.strictObject({
	discoveryId: recordId,
	revision,
	relationships: z.array(conversionRelationship).max(100),
	reading: ownDiscoveryReading,
	documentProposals: z.array(documentCarryForwardProposal).max(100),
});
export const discoveryProfileResult = z.union([
	z.strictObject({ status: z.literal("unavailable") }),
	z.strictObject({ status: z.literal("active"), profile: discoveryProfile }),
	z.strictObject({ status: z.literal("converted"), discoveryId: recordId, plant: plantOwner, convertedAt: instant }),
]);
export const createDiscoveryResult = z.strictObject({ status: z.literal("active"), profile: discoveryProfile });
export const onboardingError = z.discriminatedUnion("code", [
	...safeError.options,
	defineSafeError("active_seat_conflict", {}, "refresh"),
	defineSafeError("association_resolution_required", {}, "refresh"),
	defineSafeError("already_declared", {}, "refresh"),
	defineSafeError("idempotency_conflict", {}, "never"),
]);

export type CreatePlantResult = z.infer<typeof createPlantResult>;
export type ConvertDiscoveryResult = z.infer<typeof convertDiscoveryResult>;
export type ResumeResult = z.infer<typeof resumeResult>;
