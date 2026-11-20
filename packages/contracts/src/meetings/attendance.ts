import { z } from "zod";
import { instant, localDate } from "../common/time.ts";
import { accountId, operationId, personId, recordId, requestKey, revision } from "../common/values.ts";
import { stage } from "../people/values.ts";
import { assigneeIds, followUpOwner, MAX_ASSIGNEES } from "../tasks/values.ts";
import { meetingId, meetingType, presence, rsvp } from "./values.ts";

export const classification = z.enum(["first_time", "returning", "core_group"]);

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
export const averageOf = (s: z.infer<typeof scores>) =>
	Math.round((evaluationFactors.reduce((sum, f) => sum + s[f], 0) / evaluationFactors.length) * 10) / 10;

const unique = <T extends z.ZodType>(item: T, max: number) =>
	z
		.array(item)
		.max(max)
		.refine((ids) => new Set(ids).size === ids.length, "duplicate_entry");
const create = <T extends z.ZodType>(input: T) => z.strictObject({ requestKey, input });
const target = { meetingId, personId };
const assignees = assigneeIds.default([]);

export const setAttendanceRequest = create(z.strictObject({ ...target, presence }));
export const checkInRequest = create(z.strictObject(target));
export const clearAttendanceRequest = create(z.strictObject(target));
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
export const finalizeAttendanceRequest = z.strictObject({
	requestKey,
	expectedRevision: revision,
	input: z.strictObject({
		meetingId,
		attendeeIds: unique(personId, 500),
		followUpAssigneeIds: assignees,
		evaluationAssigneeIds: assignees,
	}),
});
export const reconcileAttendanceRequest = z.strictObject({
	requestKey,
	expectedRevision: revision,
	input: z.strictObject({
		meetingId,
		attendeeIds: unique(personId, 500),
		followUpAssigneeIds: assignees,
		reason: z.string().trim().min(1).max(500),
	}),
});
export const recordEvaluationRequest = z.strictObject({
	requestKey,
	input: z.strictObject({
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
	classification: classification.nullable(),
	classificationStage: stage.nullable(),
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
	viewerCanMarkAttendance: z.boolean(),
});
const counts = z.strictObject({ first_time: z.int().min(0), returning: z.int().min(0), core_group: z.int().min(0) });
export const attendanceSummary = z.strictObject({
	meetingId,
	attendanceRevision: revision,
	finalized,
	guests: z.int().min(0),
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
	meetingId,
	kind: z.enum(["first_vision_follow_up", "meeting_evaluation"]),
	personId: personId.nullable(),
	obligationId: recordId,
	taskId: recordId.nullable(),
	outcome: z.enum(["created", "existing", "closed"]),
	assigneeIds: z.array(accountId).max(MAX_ASSIGNEES),
	needsOwner: z.boolean(),
	owners: z.array(followUpOwner).max(MAX_ASSIGNEES),
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
	attendees: z.array(attendee).max(1000),
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

const known = <T extends z.ZodType>(value: T) =>
	z.discriminatedUnion("status", [
		z.strictObject({ status: z.literal("known"), value }),
		z.strictObject({ status: z.literal("unknown") }),
	]);
export const growth = z.discriminatedUnion("status", [
	z.strictObject({ status: z.literal("known"), difference: z.int(), percent: z.number() }),
	z.strictObject({ status: z.literal("unavailable"), difference: z.int() }),
	z.strictObject({ status: z.literal("unknown") }),
]);
export const evaluationComparison = z.strictObject({
	meetingId,
	current: known(z.number()),
	baseline: z.discriminatedUnion("status", [
		z.strictObject({ status: z.literal("known"), value: z.number(), count: z.int().min(1).max(50) }),
		z.strictObject({ status: z.literal("unknown") }),
	]),
	delta: known(z.number()),
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
