import { z } from "zod";
import { instant, localDate } from "../common/time.ts";
import { accountId, operationId, personId, recordId, requestKey, revision } from "../common/values.ts";
import { stage } from "../people/values.ts";
import { meetingId, meetingType, presence, rsvp } from "./values.ts";

// Attendance, finalization, evaluation and analytics (WP-022). The server derives the church, actor, meeting type,
// classification, average and every generated task; no body can name them.

/** How a finalized attendee counts: core_group for a committed stage, else first or returning Vision guest. */
export const classification = z.enum(["first_time", "returning", "core_group"]);

/** The eight Vision factors (REQ-MTG-014), version 1, in their stored order. */
export const evaluationFactors = [
	"attendanceScore",
	"locationScore",
	"logisticsScore",
	"agendaScore",
	"vibeScore",
	"messageScore",
	"closeScore",
	"nextStepsScore",
] as const;
export const factorVersion = 1;
const score = z.int().min(1).max(5);
export const scores = z.strictObject(
	Object.fromEntries(evaluationFactors.map((f) => [f, score])) as Record<
		(typeof evaluationFactors)[number],
		typeof score
	>,
);
/** The arithmetic mean of the eight scores, rounded to one decimal. */
export const averageOf = (s: z.infer<typeof scores>) =>
	Math.round((evaluationFactors.reduce((sum, f) => sum + s[f], 0) / evaluationFactors.length) * 10) / 10;

const unique = <T extends z.ZodType>(item: T, max: number) =>
	z
		.array(item)
		.max(max)
		.refine((ids) => new Set(ids).size === ids.length, "duplicate_entry");
const create = <T extends z.ZodType>(input: T) => z.strictObject({ requestKey, input });
const target = { meetingId, personId };
const assignee = accountId.nullable().default(null);

export const setAttendanceRequest = create(z.strictObject({ ...target, presence }));
/** Marks a Person attended; a live Person not yet on the guest list joins it as a walk-in. */
export const checkInRequest = create(z.strictObject(target));
/** Presence back to absent; the RSVP, card, inviter and notes stay. */
export const clearAttendanceRequest = create(z.strictObject(target));
/** Several presence values in one change: every row is valid or nothing is written. */
export const captureAttendanceBatchRequest = create(
	z.strictObject({
		meetingId,
		entries: z
			.array(z.strictObject({ personId, presence }))
			.min(1)
			.max(500)
			.refine((e) => new Set(e.map((x) => x.personId)).size === e.length, "duplicate_entry"),
	}),
);
/**
 * Finalize the reviewed attendee set at the reviewed attendance revision. Unowned generated work is Needs owner.
 * Retrying returns the first answer; a concurrent second finalize sees the first one.
 */
export const finalizeAttendanceRequest = z.strictObject({
	requestKey,
	expectedRevision: revision,
	input: z.strictObject({
		meetingId,
		attendeeIds: unique(personId, 500),
		followUpAssigneeId: assignee,
		evaluationAssigneeId: assignee,
	}),
});
/** Late additions, removals and same-count replacements of a finalized meeting, by exact identity. */
export const reconcileAttendanceRequest = z.strictObject({
	requestKey,
	expectedRevision: revision,
	input: z.strictObject({
		meetingId,
		attendeeIds: unique(personId, 500),
		followUpAssigneeId: assignee,
		reason: z.string().trim().min(1).max(500),
	}),
});
// The input strips unknown keys, so a client-sent average never reaches the server's computation.
export const recordEvaluationRequest = z.strictObject({
	requestKey,
	input: z.object({
		meetingId,
		scores,
		notes: z.string().trim().min(1).max(5000).nullable().default(null),
		evaluatedOn: localDate.optional(),
	}),
});
export const correctEvaluationRequest = z.strictObject({
	requestKey,
	expectedRevision: revision,
	input: z.strictObject({
		meetingId,
		changes: scores.partial(),
		notes: z.string().trim().min(1).max(5000).nullable().optional(),
		reason: z.string().trim().min(1).max(500),
	}),
});
export const addAttendeeNoteRequest = create(z.strictObject({ ...target, text: z.string().trim().min(1).max(5000) }));

export const attendanceListRequest = z.strictObject({
	meetingId,
	page: z.int().min(1).max(100_000).default(1),
	limit: z.int().min(1).max(500).default(100),
});
/** A report window over meeting occurrence dates, church-local and inclusive; open ends are unbounded. */
export const reportRequest = z.strictObject({
	types: z.array(meetingType).max(4).default(["vision_meeting"]),
	from: localDate.nullable().default(null),
	to: localDate.nullable().default(null),
	limit: z.int().min(1).max(100).default(12),
});

const receipt = { receiptId: operationId, outcome: z.enum(["changed", "noop"]) };
const personRef = z.strictObject({
	personId,
	displayName: z.string(),
	state: z.enum(["live", "retired", "merged"]),
});
export const attendee = z.strictObject({
	guestId: recordId,
	revision,
	person: personRef,
	presence,
	rsvp,
	hasCard: z.boolean(),
	/** Set when attendance is finalized; null before. */
	classification: classification.nullable(),
	/** The committed stage this classification used, as it was at finalization. */
	classificationStage: stage.nullable(),
	/** The earlier attended Vision that made this a returning visit; null for a first Vision. */
	priorVisionId: meetingId.nullable(),
});
const finalized = z.strictObject({ at: instant, revision }).nullable();
export const attendanceList = z.strictObject({
	meetingId,
	attendanceRevision: revision,
	finalized,
	items: z.array(attendee).max(500),
	matched: z.int().min(0),
	returned: z.int().min(0),
	page: z.int().min(1),
	next: z.int().min(2).nullable(),
	completeness: z.literal("complete"),
	/** The viewer may mark attendance: a current Owner or Admin, or the current leader of this team meeting's team. */
	viewerCanMarkAttendance: z.boolean(),
});
const counts = z.strictObject({ first_time: z.int().min(0), returning: z.int().min(0), core_group: z.int().min(0) });
export const attendanceSummary = z.strictObject({
	meetingId,
	attendanceRevision: revision,
	finalized,
	guests: z.int().min(0),
	/** Attended Persons, each once, including a planter who attended. */
	attended: z.int().min(0),
	absent: z.int().min(0),
	excused: z.int().min(0),
	classifications: counts,
});
export const attendanceMutationResult = z.strictObject({
	...receipt,
	meetingId,
	attendanceRevision: revision,
	attendees: z.array(attendee).max(500),
});

export const generatedWork = z.strictObject({
	/** The meeting that owes the duty: this one, or a later Vision that a correction made a Person's first. */
	meetingId,
	kind: z.enum(["first_vision_follow_up", "meeting_evaluation"]),
	personId: personId.nullable(),
	obligationId: recordId,
	taskId: recordId.nullable(),
	outcome: z.enum(["created", "existing", "closed"]),
	assigneeId: accountId.nullable(),
	/** No current owner: the task shows Needs owner. */
	needsOwner: z.boolean(),
});
export const finalizationResult = z.strictObject({
	...receipt,
	meetingId,
	attendanceRevision: revision,
	finalizedAt: instant,
	attendeeIds: z.array(personId).max(500),
	added: z.array(personId).max(500),
	removed: z.array(personId).max(500),
	classifications: z
		.array(
			z.strictObject({
				personId,
				classification,
				firstVision: z.boolean(),
				priorVisionId: meetingId.nullable(),
			}),
		)
		.max(500),
	stageChanges: z.array(z.strictObject({ personId, from: stage, to: stage })).max(500),
	work: z.array(generatedWork).max(1100),
});

const attribution = z.discriminatedUnion("kind", [
	z.strictObject({ kind: z.literal("current_account"), accountId }),
	z.strictObject({ kind: z.literal("former_account") }),
]);
export const evaluation = z.strictObject({
	evaluationId: recordId,
	meetingId,
	factorVersion: z.literal(factorVersion),
	scores,
	average: z.number().min(1).max(5),
	notes: z.string().nullable(),
	evaluatedOn: localDate,
	recordedAt: instant,
	evaluator: attribution,
	revision,
	corrections: z.strictObject({ count: z.int().min(0), lastAt: instant.nullable() }),
});
export const evaluationResult = z.discriminatedUnion("status", [
	z.strictObject({ status: z.literal("available"), evaluation }),
	z.strictObject({ status: z.literal("none"), meetingId }),
]);
export const evaluationMutationResult = z.strictObject({
	...receipt,
	evaluation,
	/** The evaluation task this submission completed; a correction completes nothing. */
	taskCompleted: z.boolean(),
});
export const evaluationHistory = z.strictObject({
	meetingId,
	entries: z
		.array(
			z.strictObject({
				kind: z.enum(["recorded", "corrected"]),
				at: instant,
				actor: attribution,
				before: scores.partial().nullable(),
				after: scores.partial(),
				average: z.strictObject({ before: z.number().nullable(), after: z.number() }),
				notesChanged: z.boolean(),
				reason: z.string().nullable(),
				revision,
			}),
		)
		.max(1000),
});

/** A report value that may be missing: unknown is never shown as zero. */
const known = <T extends z.ZodType>(value: T) =>
	z.discriminatedUnion("status", [
		z.strictObject({ status: z.literal("known"), value }),
		z.strictObject({ status: z.literal("unknown") }),
	]);
/** Growth over the previous meeting: unavailable when the previous meeting had no attendees, unknown with none. */
export const growth = z.discriminatedUnion("status", [
	z.strictObject({ status: z.literal("known"), difference: z.int(), percent: z.number() }),
	z.strictObject({ status: z.literal("unavailable"), difference: z.int() }),
	z.strictObject({ status: z.literal("unknown") }),
]);
export const evaluationComparison = z.strictObject({
	meetingId,
	current: known(z.number()),
	/** The mean of up to the 50 most recent evaluations of earlier meetings, rounded to one decimal. */
	baseline: z.discriminatedUnion("status", [
		z.strictObject({ status: z.literal("known"), value: z.number(), count: z.int().min(1).max(50) }),
		z.strictObject({ status: z.literal("unknown") }),
	]),
	delta: known(z.number()),
	/** The current evaluation includes a correction. */
	corrected: z.boolean(),
});
const window = z.strictObject({
	types: z.array(meetingType),
	from: localDate.nullable(),
	to: localDate.nullable(),
});
const occurrence = { meetingId, type: meetingType, displayTitle: z.string(), occurredAt: instant, localDate };
export const evaluationTrend = z.strictObject({
	window,
	points: z.array(z.strictObject({ ...occurrence, average: z.number(), corrected: z.boolean() })).max(100),
});
export const attendancePoint = z.strictObject({
	...occurrence,
	attended: z.int().min(0),
	classifications: counts,
	growth,
});
export const attendanceTrend = z.strictObject({ window, points: z.array(attendancePoint).max(100) });
export const summaryStats = z.strictObject({
	window,
	/** Meetings held in the window: occurred, not cancelled or voided. */
	held: z.int().min(0),
	finalized: z.int().min(0),
	attendances: z.int().min(0),
	uniqueAttendees: z.int().min(0),
	averageAttendance: known(z.number()),
	firstTime: z.int().min(0),
	returning: z.int().min(0),
	averageEvaluation: known(z.number()),
});
export const taskProgress = z.strictObject({
	meetingId,
	followUps: z.strictObject({
		total: z.int().min(0),
		open: z.int().min(0),
		complete: z.int().min(0),
		closed: z.int().min(0),
		needsOwner: z.int().min(0),
	}),
	evaluation: z.strictObject({ taskId: recordId.nullable(), status: z.string(), needsOwner: z.boolean() }).nullable(),
});
export const meetingAnalytics = z.strictObject({
	meetingId,
	type: meetingType,
	/** Unknown until attendance is finalized. */
	attended: known(z.int().min(0)),
	classifications: counts.nullable(),
	growth,
	evaluation: evaluationComparison.nullable(),
	tasks: taskProgress,
});

export const attendeeNoteResult = z.strictObject({
	...receipt,
	noteId: recordId,
	personId,
	meetingId,
	meetingType,
	text: z.string(),
	authorId: accountId,
	recordedAt: instant,
});
