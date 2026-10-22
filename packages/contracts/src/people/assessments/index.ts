import { z } from "zod";
import { instant, localDate } from "../../common/time.ts";
import { personId, recordId, requestKey, revision } from "../../common/values.ts";
import { commandEnvelope } from "../../common/writes.ts";
import { actorAttribution } from "../results.ts";
import { firstAcquisition, pageInput, stage } from "../values.ts";

// Four Cs assessments, five-criterion interviews and commitments on a plant Person (REQ-PPL-012, 013, 014, 020).
// Owner and Admin only. The server takes the church from the session and the actor from the request.

const notes = z.string().trim().max(5000);
const score = z.int().min(1).max(5);
const lens = z.strictObject({ score, notes: notes.nullable().default(null) });
// REQ-PPL-012: four human scores. The total is the server's; a request that sends one is refused.
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

// REQ-PPL-013: every criterion is rated; any result means the interview happened.
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
		// Recorded text only; it creates no task.
		nextSteps: notes.nullable().default(null),
	}),
});

// REQ-PPL-014: a signed card, its actual signed date, an optional same-church witness or external witness text,
// notes and an optional private document (saveCommitmentDocumentRequest).
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
// The document upload (RT-2 design B): sign a five-minute PUT URL for one pending upload, let the browser put the bytes
// straight into the private bucket, then save the card with that upload in one request. The save checks the bytes.
export const signCommitmentDocumentRequest = z.strictObject({
	personId,
	mime: commitmentMime,
	byteLength: z.int().min(1).max(COMMITMENT_MAX_BYTES),
});
export const commitmentDocumentUpload = z.strictObject({
	uploadId: recordId,
	// The browser PUTs the file's exact bytes to this URL with exactly these headers; it works until expiresAt.
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
// Withdrawal and reactivation change the Person's current commitment, never its stage. The expected revision is the
// Person's.
const lifecycleChange = z.strictObject({
	personId,
	effectiveOn: localDate,
	reason: notes.min(1).nullable().default(null),
});
export const withdrawCommitmentRequest = commandEnvelope(lifecycleChange);
export const reactivateCommitmentRequest = commandEnvelope(lifecycleChange);
// Correct one card's signed date or kind, or void a card that was never genuine. The expected revision is the card's.
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

// Results. Each history is ordered latest first: occurrence date, then recorded instant, then ID.
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
	// The card names its witness; the history read supplies current names, so a saved card never changes with a rename.
	z.strictObject({ kind: z.literal("person"), personId }),
	z.strictObject({ kind: z.literal("external"), text: z.string() }),
]);
export const commitmentDocument = z.discriminatedUnion("status", [
	z.strictObject({ status: z.literal("none") }),
	// The download operation issues a short-lived link for this exact object; no storage key leaves the server.
	z.strictObject({ status: z.literal("attached"), mediaType: commitmentMime, byteCount: z.int().min(1) }),
]);
export const commitment = z.strictObject({
	...recorded,
	kind: commitmentKind,
	witness: witness.nullable(),
	notes: notes.nullable(),
	document: commitmentDocument,
	// A voided card stays in the history and is never evidence.
	voidedAt: instant.nullable(),
});
// The Person's current commitment: the state, the date it took effect and the person revision a lifecycle change sends.
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
	// The earliest valid card: withdrawal and reactivation never move it.
	firstAcquisition,
	latest: commitment.nullable(),
	items: z.array(commitment).max(100),
	// Current display names of the witness Persons these cards name, by Person ID.
	witnessNames: z.record(z.string(), z.string()),
	...page,
});

const outcome = z.enum(["changed", "noop"]);
// The Person as the write left it: the stage, any advance the record caused and the revision for the next change.
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
