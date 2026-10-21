import { z } from "zod";
import { defineSafeError } from "../../common/values.ts";

/**
 * The reference kinds the registry knows. People references move to the survivor (tags deduplicate). Account links,
 * private authorship and audit history never move. Kinds whose package has not registered its merge behavior block a
 * merge until it does (REQ-PPL-024: each domain proves its own references).
 */
export const referenceKind = z.enum([
	"tag",
	"skill",
	"note",
	"assessment",
	"interview",
	"commitment",
	"merged_person",
	"correction",
	"commitment_witness",
	"merge_record",
	"attestation",
	"contact_outcome",
	"development_enrollment",
	"invitation",
	"mail",
	"meeting_kit_item",
	"obligation",
	"participation",
	"participation_inviter",
	"pipeline_person",
	"residency_link",
	"task",
	"team_leader",
	"team_tenure",
]);
export const referenceTreatment = z.enum(["move", "deduplicate", "keep", "block"]);

export const mergeBlocker = z.enum(["linked_account_collision", "linked_source", "unregistered_reference"]);
export const inverseConflict = z.enum(["survivor_changed", "source_changed", "references_changed"]);
export const mergeErrors = [
	defineSafeError(
		"merge_blocked",
		{ causes: z.array(mergeBlocker).min(1).max(3), references: z.array(referenceKind).max(24) },
		"never",
	),
	defineSafeError("inverse_conflict", { causes: z.array(inverseConflict).min(1).max(3) }, "refresh"),
] as const;
