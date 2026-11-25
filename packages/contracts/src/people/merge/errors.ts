import { z } from "zod";
import { defineSafeError } from "../../common/values.ts";

export const referenceKind = z.enum([
	"tag",
	"skill",
	"note",
	"assessment",
	"interview",
	"commitment",
	"merged_person",
	"correction",
	"commitment_change",
	"commitment_witness",
	"merge_record",
	"attestation",
	"attestation_history",
	"email_opt_out",
	"duplicate_dismissal",
	"contact_outcome",
	"development_enrollment",
	"invitation",
	"launch_guest",
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
	"training_assignment",
	"training_credit",
	"answer_review",
	"guardian_contact",
]);
export const referenceTreatment = z.enum(["move", "deduplicate", "keep"]);

export const mergeBlocker = z.enum([
	"linked_account_collision",
	"linked_source",
	"enrollment_collision",
	"leadership_conflict",
	"residency_invitation_collision",
]);
const label = z.string().min(1).max(200);
export const leadershipConflict = z.strictObject({ team: label, sourceRole: label, survivorRole: label });
export const blockers = {
	causes: z.array(mergeBlocker).max(mergeBlocker.options.length),
	leadership: z.array(leadershipConflict).max(100),
	invitations: z.array(z.strictObject({ recipientEmail: z.string().max(320) })).max(100),
};
export const inverseConflict = z.enum([
	"chained_merge",
	"survivor_retired",
	"survivor_changed",
	"source_changed",
	"references_changed",
	"household_deleted",
	"mail_sent",
]);
export const mergeField = z.enum([
	"displayName",
	"firstName",
	"lastName",
	"email",
	"phone",
	"address",
	"source",
	"summaryNotes",
	"birthDate",
	"adultClassification",
	"household",
	"photo",
]);
export const unmergeField = z.enum([...mergeField.options, "stage"]);
export const mergeErrors = [
	defineSafeError("merge_blocked", { ...blockers, causes: blockers.causes.min(1) }, "never"),
	defineSafeError(
		"inverse_conflict",
		{
			causes: z.array(inverseConflict).min(1).max(inverseConflict.options.length),
			changed: z.array(referenceKind).max(referenceKind.options.length),
			changedFields: z.array(unmergeField).max(unmergeField.options.length),
		},
		"refresh",
	),
] as const;
