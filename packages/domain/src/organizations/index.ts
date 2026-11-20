import type { OrganizationAdapter } from "@everyfield/contracts/organizations";
import { consentOperations } from "./consent.ts";
export { readPipelineConsents } from "./consent.ts";
import type { OrganizationEffects, OrganizationRefusalCode, RelationshipNotice } from "./core.ts";
import { getHistory } from "./history.ts";
export { readHistory } from "./history.ts";
import type { GeographyReference } from "./profile.ts";
import { profileOperations } from "./profile.ts";
import { relationshipCommands } from "./relationships.ts";
import { sharingOperations } from "./sharing.ts";
export function createOrganizationAdapter(
	effects: OrganizationEffects,
	geography: GeographyReference,
): OrganizationAdapter<WriteTx> {
	return {
		...relationshipCommands(effects),
		...sharingOperations(effects),
		...consentOperations(effects),
		...profileOperations(effects, geography),
		"associations.getHistory": getHistory,
	};
}
export { readAnswerableInvitation } from "./relationships.ts";
export { readPlantSharing, readSharingDisclosure } from "./sharing.ts";
export {
	milestone,
	milestoneCategory,
	planMilestoneNotice,
	planResidencyNotice,
	planReviewNotice,
	relationshipMailGrants,
	residencyCategory,
	residencyJobOf,
	residencyMailGrants,
	reviewJobOf,
	reviewMailGrants,
} from "./notifications.ts";
export type { GeographyReference, OrganizationEffects, OrganizationRefusalCode, RelationshipNotice };
export { OrganizationRefusal, refuse } from "./core.ts";

export { idsIn, namesFor, pairOf, pendingFor, residencyLinks, subjectFacts, targetsFor } from "./reads.ts";
export type { Kind, Viewer } from "./reads.ts";
export {
	pipelineWriter,
	readPipelineBoard,
	readPipelineChoices,
	readPipelineGoals,
	readPipelinePersonRecord,
} from "./pipeline.ts";
export {
	programWriter,
	readEnrollment,
	readProgram,
	readPrograms,
	readVersionReview,
	readVersionReviews,
	searchReadings,
} from "./programs.ts";
import type { WriteTx } from "../access/session.ts";
export { geographyReference, installGeographyRelease, readReportingLocation, suggestRegions } from "./geography.ts";
export { pipelineDataWriter, readPipelineExport } from "./data.ts";
export { readMyResidency, readResidentReading, residentWriter } from "./residency.ts";
export { pipelineImportWriter, previewPipelineImport } from "./import.ts";
export { readAnswerReview, readAnswerReviews, reviewWriter } from "./reviews.ts";
