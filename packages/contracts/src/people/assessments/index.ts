import { z } from "zod";
import { instant, localDate } from "../../common/time.ts";
import { personId, recordId, requestKey, revision } from "../../common/values.ts";
import { commandEnvelope } from "../../common/writes.ts";
import { actorAttribution } from "../results.ts";
import { firstAcquisition, pageInput, stage } from "../values.ts";

const notes = z.string().trim().max(5000);
const score = z.int().min(1).max(5);
const lens = z.strictObject({ score, notes: notes.nullable().default(null) });
export const fourCs = ["committed", "compelled", "contagious", "courageous"] as const;
export const createAssessmentRequest = z.strictObject({
	requestKey,
	input: z.strictObject({
		personId,
		occurredOn: localDate,
		committed: lens,
		compelled: lens,
		contagious: lens,
		courageous: lens,
	}),
});

export const criterionRating = z.enum(["pass", "fail", "concern"]);
export const interviewResult = z.enum(["qualified", "qualified_with_notes", "not_qualified", "follow_up"]);
export const interviewCriteria = ["maturity", "gifted", "chemistry", "rightReasons", "season"] as const;
const criterion = z.strictObject({ rating: criterionRating, notes: notes.nullable().default(null) });
export const createInterviewRequest = z.strictObject({
	requestKey,
	input: z.strictObject({
		personId,
		occurredOn: localDate,
		maturity: criterion,
		gifted: criterion,
		chemistry: criterion,
		rightReasons: criterion,
		season: criterion,
		result: interviewResult,
		nextSteps: notes.nullable().default(null),
	}),
});

export const commitmentKind = z.enum(["core_group", "launch_team"]);
export const commitmentMime = z.enum(["application/pdf", "image/jpeg", "image/png"]);
export const COMMITMENT_MAX_BYTES = 10 * 1024 * 1024;
export const witnessInput = z.union([
	z.strictObject({ personId }),
	z.strictObject({ external: z.string().trim().min(1).max(200) }),
]);
export const createCommitmentRequest = z.strictObject({
	requestKey,
	input: z.strictObject({
		personId,
		kind: commitmentKind,
		occurredOn: localDate,
		witness: witnessInput.nullable().default(null),
		notes: notes.nullable().default(null),
	}),
});
export const signCommitmentDocumentRequest = z.strictObject({
	personId,
	mime: commitmentMime,
	byteLength: z.int().min(1).max(COMMITMENT_MAX_BYTES),
});
export const commitmentDocumentUpload = z.strictObject({
	uploadId: recordId,
	url: z.url(),
	headers: z.strictObject({
		"content-type": commitmentMime,
		"if-none-match": z.literal("*"),
		"cache-control": z.literal("private, no-store"),
	}),
	expiresAt: instant,
});
export const saveCommitmentDocumentRequest = z.strictObject({
	requestKey,
	input: z.strictObject({ ...createCommitmentRequest.shape.input.shape, documentUploadId: recordId }),
});
const lifecycleChange = z.strictObject({
	personId,
	effectiveOn: localDate,
	reason: notes.min(1).nullable().default(null),
});
export const withdrawCommitmentRequest = commandEnvelope(lifecycleChange);
export const reactivateCommitmentRequest = commandEnvelope(lifecycleChange);
export const correctCommitmentRequest = commandEnvelope(
	z.strictObject({
		commitmentId: recordId,
		correction: z.discriminatedUnion("action", [
			z
				.strictObject({
					action: z.literal("correct"),
					occurredOn: localDate.optional(),
					kind: commitmentKind.optional(),
				})
				.refine((v) => v.occurredOn !== undefined || v.kind !== undefined),
			z.strictObject({ action: z.literal("void") }),
		]),
		reason: notes.min(1),
	}),
);

export const personRecordsRequest = z.strictObject({ personId, ...pageInput });
export const commitmentDownloadRequest = z.strictObject({ commitmentId: recordId });

const recorded = {
	id: recordId,
	personId,
	occurredOn: localDate,
	recordedAt: instant,
	actor: actorAttribution,
	revision,
};
export const assessment = z.strictObject({
	...recorded,
	committed: lens.required(),
	compelled: lens.required(),
	contagious: lens.required(),
	courageous: lens.required(),
	total: z.int().min(4).max(20),
});
export const interview = z.strictObject({
	...recorded,
	maturity: criterion.required(),
	gifted: criterion.required(),
	chemistry: criterion.required(),
	rightReasons: criterion.required(),
	season: criterion.required(),
	result: interviewResult,
	nextSteps: notes.nullable(),
});
export const witness = z.discriminatedUnion("kind", [
	z.strictObject({ kind: z.literal("person"), personId }),
	z.strictObject({ kind: z.literal("external"), text: z.string() }),
]);
export const commitmentDocument = z.discriminatedUnion("status", [
	z.strictObject({ status: z.literal("none") }),
	z.strictObject({ status: z.literal("attached"), mediaType: commitmentMime, byteCount: z.int().min(1) }),
]);
export const commitment = z.strictObject({
	...recorded,
	kind: commitmentKind,
	witness: witness.nullable(),
	notes: notes.nullable(),
	document: commitmentDocument,
	voidedAt: instant.nullable(),
});
export const commitmentStatus = z.strictObject({
	state: z.enum(["active", "withdrawn", "unknown"]),
	effectiveOn: localDate.nullable(),
	personRevision: revision,
});
const page = { next: z.int().min(2).nullable(), total: z.int().min(0) };
export const assessmentsResult = z.strictObject({
	personId,
	latest: assessment.nullable(),
	items: z.array(assessment).max(100),
	...page,
});
export const interviewsResult = z.strictObject({
	personId,
	latest: interview.nullable(),
	items: z.array(interview).max(100),
	...page,
});
export const commitmentsResult = z.strictObject({
	personId,
	current: commitmentStatus,
	firstAcquisition,
	latest: commitment.nullable(),
	items: z.array(commitment).max(100),
	witnessNames: z.record(z.string(), z.string()),
	...page,
});

const outcome = z.enum(["changed", "noop"]);
export const recordedPerson = z.strictObject({
	personId,
	stage,
	revision,
	stageChange: z.strictObject({ from: stage, to: stage }).nullable(),
});
export const assessmentMutationResult = z.strictObject({
	assessment,
	person: recordedPerson,
	outcome,
	receiptId: recordId,
});
export const interviewMutationResult = z.strictObject({
	interview,
	person: recordedPerson,
	outcome,
	receiptId: recordId,
});
export const commitmentMutationResult = z.strictObject({
	commitment,
	person: recordedPerson,
	current: commitmentStatus,
	outcome,
	receiptId: recordId,
});
export const commitmentLifecycleResult = z.strictObject({
	personId,
	current: commitmentStatus,
	outcome,
	receiptId: recordId,
});
export const commitmentDownloadResult = z.strictObject({
	url: z.url(),
	expiresAt: instant,
	expiresInSeconds: z.literal(300),
});
