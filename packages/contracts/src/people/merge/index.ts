import { z } from "zod";
import { instant, localDate } from "../../common/time.ts";
import { digest, personId, recordId, requestKey, revision } from "../../common/values.ts";
import { commandEnvelope } from "../../common/writes.ts";
import { criterionRating, interviewResult } from "../assessments/index.ts";
import { actorAttribution } from "../results.ts";
import { pageInput, reason, stage } from "../values.ts";
import { inverseConflict, mergeBlocker, referenceKind, referenceTreatment } from "./errors.ts";

export * from "./errors.ts";

// Duplicate review, merge, guarded Unmerge and record corrections (REQ-PPL-015, 016, 017, 024, 025, REQ-MUL-017).
// Owner and Admin only, except the merged-person destination, which any reader of the church may follow. The server
// takes the church or organization from the session and the actor from the request.

/** The Person facts a merge review lets the reviewer take from either side. Plant-only facts exist on plant people. */
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
export const plantOnlyMergeFields = ["source", "adultClassification", "household", "photo", "birthDate"] as const;
export const mergeSide = z.enum(["source", "survivor"]);

const pair = { sourceId: personId, survivorId: personId };
const distinct = (v: { sourceId: string; survivorId: string }) => v.sourceId !== v.survivorId;

export const mergeReviewRequest = z.strictObject(pair).refine(distinct);
const side = z.strictObject({ personId, revision, displayName: z.string(), linkedAccount: z.boolean() });
export const mergeReview = z.strictObject({
	source: side,
	survivor: side,
	// Every field whose values differ, with both values, so the reviewer chooses knowingly.
	fields: z
		.array(z.strictObject({ field: mergeField, source: z.unknown(), survivor: z.unknown() }))
		.max(mergeField.options.length),
	// Plant people only: the stage and current commitment the survivor keeps.
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
	blockers: z.strictObject({
		causes: z.array(mergeBlocker).max(3),
		references: z.array(referenceKind).max(referenceKind.options.length),
	}),
	// The exact state reviewed: both Persons and every reference they hold. A merge against a different state is refused.
	reviewDigest: digest,
});

export const mergePeopleRequest = z.strictObject({
	requestKey,
	input: z
		.strictObject({
			...pair,
			reviewDigest: digest,
			// A field left out keeps the survivor's value.
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
	// The Person to open: the survivor of a merged Person, otherwise the Person itself.
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
	// Survivor fields the merge changed, which Unmerge sets back.
	fields: z.array(mergeField).max(mergeField.options.length),
	conflicts: z.array(inverseConflict).max(3),
	// The survivor revision this preview saw; Unmerge is refused if it changed.
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

// REQ-PPL-015: ordinary correction fields only. Original recorder, recorded instant, witness and document stay; stage
// never replays.
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
// A card's date and kind change through people.correctCommitmentLifecycle; its notes change here.
export const commitmentCorrection = z.strictObject({ notes });
export const recordType = z.enum(["assessment", "interview", "commitment"]);
// The expected revision is the record's. The Person is the one the corrector reviewed: a record that has since moved to
// another Person, by merge or Unmerge, refuses the correction.
const corrected = { personId, recordId, reason };
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
	// Each changed field with its old and new value, as the record holds it.
	changes: z.array(z.strictObject({ field: z.string(), old: z.unknown(), new: z.unknown() })).min(1),
});
export const recordCorrectionsResult = z.strictObject({
	personId,
	items: z.array(recordCorrection).max(100),
	next: z.int().min(2).nullable(),
	total: z.int().min(0),
});

// MUL-017: organization people find duplicates of one Person, never a guess at identity.
export const organizationDuplicatesRequest = z.strictObject({ personId });
