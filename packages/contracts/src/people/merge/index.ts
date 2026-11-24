import { z } from "zod";
import { instant, localDate } from "../../common/time.ts";
import { digest, personId, recordId, requestKey, revision } from "../../common/values.ts";
import { commandEnvelope } from "../../common/writes.ts";
import { criterionRating, interviewResult } from "../assessments/index.ts";
import { actorAttribution } from "../results.ts";
import { pageInput, stage } from "../values.ts";
import { blockers, inverseConflict, mergeField, referenceKind, referenceTreatment, unmergeField } from "./errors.ts";

export * from "./errors.ts";

export const plantOnlyMergeFields = ["source", "adultClassification", "household", "photo", "birthDate"] as const;
export const mergeSide = z.enum(["source", "survivor"]);

const pair = { sourceId: personId, survivorId: personId };
const distinct = (v: { sourceId: string; survivorId: string }) => v.sourceId !== v.survivorId;

export const mergeReviewRequest = z.strictObject(pair).refine(distinct);
const side = z.strictObject({ personId, revision, displayName: z.string(), linkedAccount: z.boolean() });
const meeting = z.string().min(1).max(300);
export const attendanceChange = z.discriminatedUnion("change", [
	z.strictObject({ change: z.literal("combined"), meeting, presence: z.enum(["attended", "excused", "absent"]) }),
	z.strictObject({
		change: z.literal("rsvp_replaced"),
		meeting,
		pendingPersonId: personId,
		answer: z.enum(["confirmed", "declined"]),
	}),
	z.strictObject({ change: z.literal("inviter_cleared"), meeting, inviterPersonId: personId }),
	z.strictObject({
		change: z.literal("follow_up_combined"),
		meeting,
		state: z.enum(["open", "complete", "no_longer_needed"]),
	}),
]);
export const mergeReview = z.strictObject({
	source: side,
	survivor: side,
	fields: z
		.array(z.strictObject({ field: mergeField, source: z.unknown(), survivor: z.unknown() }))
		.max(mergeField.options.length),
	stage: z.strictObject({ source: stage, survivor: stage, result: stage }).nullable(),
	commitment: z
		.strictObject({
			result: z.enum(["active", "withdrawn", "unknown"]),
			effectiveOn: localDate.nullable(),
		})
		.nullable(),
	references: z
		.array(z.strictObject({ kind: referenceKind, count: z.int().min(1), treatment: referenceTreatment }))
		.max(referenceKind.options.length),
	blockers: z.strictObject(blockers),
	openFollowUps: z.array(z.strictObject({ personId, meeting: z.string(), dueDate: localDate })).max(200),
	attendance: z.array(attendanceChange).max(600),
	openTasks: z.array(z.strictObject({ title: z.string(), dueDate: localDate.nullable() })).max(200),
	openKitItems: z.array(z.strictObject({ meeting, text: z.string() })).max(200),
	reviewDigest: digest,
});

export const mergePeopleRequest = z.strictObject({
	requestKey,
	input: z
		.strictObject({
			...pair,
			reviewDigest: digest,
			fieldChoices: z.partialRecord(mergeField, mergeSide).default({}),
		})
		.refine(distinct),
});
const moved = z.array(z.strictObject({ kind: referenceKind, count: z.int().min(1) })).max(referenceKind.options.length);
export const mergeResult = z.strictObject({
	mergeId: recordId,
	sourceId: personId,
	survivorId: personId,
	survivorRevision: revision,
	moved,
	outcome: z.literal("changed"),
	receiptId: recordId,
});

export const mergedPersonDestinationRequest = z.strictObject({ personId });
export const mergedPersonDestination = z.strictObject({
	personId,
	status: z.enum(["live", "retired", "merged"]),
	destinationId: personId,
	mergeId: recordId.nullable(),
});

export const unmergePreviewRequest = z.strictObject({ mergeId: recordId });
export const unmergePreview = z.strictObject({
	mergeId: recordId,
	sourceId: personId,
	survivorId: personId,
	mergedAt: instant,
	state: z.enum(["merged", "unmerged"]),
	restores: moved,
	fields: z.array(mergeField).max(mergeField.options.length),
	conflicts: z.array(inverseConflict).max(inverseConflict.options.length),
	changed: z.array(referenceKind).max(referenceKind.options.length),
	changedFields: z.array(unmergeField).max(unmergeField.options.length),
	stays: moved,
	staysFields: z.array(unmergeField).max(unmergeField.options.length),
	attendance: z.array(attendanceChange).max(600),
	reviewRevision: revision,
});
export const unmergePeopleRequest = commandEnvelope(z.strictObject({ mergeId: recordId }));
export const unmergeResult = z.strictObject({
	mergeId: recordId,
	sourceId: personId,
	survivorId: personId,
	sourceRevision: revision,
	survivorRevision: revision,
	restored: moved,
	outcome: z.enum(["changed", "noop"]),
	receiptId: recordId,
});

const notes = z.string().trim().max(5000).nullable();
const lens = z.strictObject({ score: z.int().min(1).max(5), notes });
const criterion = z.strictObject({ rating: criterionRating, notes });
const someChange = (v: object) => Object.values(v).some((x) => x !== undefined);
export const assessmentCorrection = z
	.strictObject({
		occurredOn: localDate.optional(),
		committed: lens.optional(),
		compelled: lens.optional(),
		contagious: lens.optional(),
		courageous: lens.optional(),
	})
	.refine(someChange);
export const interviewCorrection = z
	.strictObject({
		occurredOn: localDate.optional(),
		maturity: criterion.optional(),
		gifted: criterion.optional(),
		chemistry: criterion.optional(),
		rightReasons: criterion.optional(),
		season: criterion.optional(),
		result: interviewResult.optional(),
		nextSteps: notes.optional(),
	})
	.refine(someChange);
export const commitmentCorrection = z.strictObject({ notes });
export const recordType = z.enum(["assessment", "interview", "commitment"]);
export const EDIT_REASON_MAX = 5000;
const editReason = z
	.string()
	.max(EDIT_REASON_MAX)
	.transform((text) => text.trim() || undefined)
	.optional();
const corrected = { personId, recordId, reason: editReason };
export const correctPersonRecordRequest = commandEnvelope(
	z.discriminatedUnion("recordType", [
		z.strictObject({ recordType: z.literal("assessment"), ...corrected, changes: assessmentCorrection }),
		z.strictObject({ recordType: z.literal("interview"), ...corrected, changes: interviewCorrection }),
		z.strictObject({ recordType: z.literal("commitment"), ...corrected, changes: commitmentCorrection }),
	]),
);
export const correctionResult = z.strictObject({
	recordType,
	recordId,
	personId,
	revision,
	correctionId: recordId.nullable(),
	outcome: z.enum(["changed", "noop"]),
	receiptId: recordId,
});

export const recordCorrectionsRequest = z.strictObject({ personId, recordId: recordId.optional(), ...pageInput });
export const recordCorrection = z.strictObject({
	id: recordId,
	recordType,
	recordId,
	correctedAt: instant,
	actor: actorAttribution,
	reason: z.string().nullable(),
	changes: z.array(z.strictObject({ field: z.string(), old: z.unknown(), new: z.unknown() })).min(1),
});
export const recordCorrectionsResult = z.strictObject({
	personId,
	items: z.array(recordCorrection).max(100),
	next: z.int().min(2).nullable(),
	total: z.int().min(0),
});

export const organizationDuplicatesRequest = z.strictObject({ personId });
export * from "./copy.ts";
