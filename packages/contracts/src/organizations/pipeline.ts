import { z } from "zod";
import { accountId, personId, recordId, revision } from "../common/values.ts";
import { localDate } from "../common/time.ts";
import { normalizedEmail } from "../identity/requests.ts";
import { avatarReference } from "../settings/results.ts";
import { noteReview } from "./reviews.ts";

export const pipelineStageKind = z.enum([
	"potential_leader",
	"apprentice",
	"resident",
	"commissioned",
	"not_continuing",
	"other",
]);
export const STARTER_STAGES = [
	["potential_leader", "Potential leader"],
	["apprentice", "Apprentice"],
	["resident", "Resident"],
	["commissioned", "Commissioned"],
	["not_continuing", "Not continuing"],
] as const satisfies readonly (readonly [z.infer<typeof pipelineStageKind>, string])[];

const stageLabel = z.string().trim().min(1).max(80);
const displayName = z.string().trim().min(1).max(255);
const email = normalizedEmail.pipe(z.string().max(320)).nullable();
const noteBody = z.string().trim().min(1).max(5000);
const reason = z.string().trim().min(1).max(1000);

export const pipelineBoardQuery = z.strictObject({
	view: z.enum(["board", "retired"]).default("board"),
	stale: z.boolean().default(false),
	q: z.string().trim().max(100).default(""),
	page: z.int().min(1).max(10_000).default(1),
});

export const addPipelinePersonRequest = z.strictObject({
	personId,
	displayName,
	email,
	responsibleSeatId: recordId.nullable(),
	stageId: recordId,
});
export const editPipelinePersonRequest = z.strictObject({
	personId,
	expectedRevision: revision,
	displayName,
	email,
	responsibleSeatId: recordId.nullable(),
});
export const movePipelinePersonRequest = z.strictObject({
	personId,
	expectedRevision: revision,
	stageId: recordId,
	reason,
});
export const recordAssessmentRequest = z.strictObject({
	personId,
	expectedRevision: revision,
	assessedOn: localDate,
	assessor: z.string().trim().min(1).max(200),
});
export const pipelinePersonLifecycleRequest = z.strictObject({ personId, expectedRevision: revision });

export const saveStagesRequest = z.strictObject({
	stages: z
		.array(
			z.strictObject({
				id: recordId,
				label: stageLabel,
				kind: pipelineStageKind,
				expectedRevision: revision.nullable(),
			}),
		)
		.min(1)
		.max(30),
	removed: z.array(z.strictObject({ id: recordId, expectedRevision: revision })).max(30),
});

export const addPipelineNoteRequest = z.strictObject({ personId, noteId: recordId, body: noteBody });
export const editPipelineNoteRequest = z.strictObject({ noteId: recordId, expectedRevision: revision, body: noteBody });
export const removePipelineNoteRequest = z.strictObject({ noteId: recordId, expectedRevision: revision });

const goalTarget = z.int().min(0).max(10_000);
export const goalCount = z.strictObject({ kind: pipelineStageKind, label: z.string().trim().min(1).max(60) });
const goalCounts = z
	.array(goalCount)
	.max(4)
	.superRefine((counts, ctx) =>
		counts.forEach((c, i) => {
			if (counts.findIndex((o) => o.kind === c.kind) !== i)
				ctx.addIssue({ code: "custom", path: [i, "kind"], message: "This goal already counts that kind." });
		}),
	);
export const saveGoalRequest = z.strictObject({
	goalId: recordId,
	expectedRevision: revision.nullable(),
	leaderTarget: goalTarget,
	plantTarget: goalTarget,
	targetYear: z.int().min(2000).max(2200),
	rationale: z.string().trim().min(1).max(1000),
	countingFrom: localDate.nullable(),
	counts: goalCounts,
});
const conversationNote = z.string().trim().min(1).max(1000).nullable();
export const logConversationRequest = z.strictObject({
	conversationId: recordId,
	personId,
	occurredOn: localDate,
	note: conversationNote,
});
export const correctConversationRequest = z.strictObject({
	conversationId: recordId,
	expectedRevision: revision,
	occurredOn: localDate,
	note: conversationNote,
});

export const pipelineAudience = z.enum(["administrator", "responsible", "counts"]);

const staff = z.strictObject({ seatId: recordId, name: z.string() });
export const pipelineCard = z.strictObject({
	personId,
	name: z.string(),
	email: z.string().nullable(),
	responsible: staff.nullable(),
	revision,
	lastMovedOn: localDate.nullable(),
});
export const pipelineStage = z.strictObject({
	id: recordId,
	label: z.string(),
	kind: pipelineStageKind,
	revision,
	count: z.int().min(0),
	matching: z.int().min(0),
	people: z.array(pipelineCard).max(24),
});
export const pipelineBoard = z.strictObject({
	audience: pipelineAudience,
	organizationName: z.string(),
	asOf: localDate,
	query: pipelineBoardQuery,
	stages: z.array(pipelineStage),
	pages: z.int().min(1),
	staff: z.array(staff.extend({ role: z.enum(["owner", "admin", "member"]) })),
	retiredCount: z.int().min(0),
});

const historyBase = { id: recordId, on: localDate, actor: z.string().nullable() };
export const pipelineHistoryEntry = z.discriminatedUnion("kind", [
	z.strictObject({ ...historyBase, kind: z.literal("placed"), to: z.string() }),
	z.strictObject({ ...historyBase, kind: z.literal("imported"), to: z.string() }),
	z.strictObject({ ...historyBase, kind: z.literal("moved"), from: z.string(), to: z.string(), reason: z.string() }),
	z.strictObject({ ...historyBase, kind: z.literal("assessment") }),
	z.strictObject({ ...historyBase, kind: z.literal("edited") }),
	z.strictObject({ ...historyBase, kind: z.literal("retired") }),
	z.strictObject({ ...historyBase, kind: z.literal("restored") }),
	z.strictObject({ ...historyBase, kind: z.literal("review_sent"), reviewer: z.string().nullable() }),
	z.strictObject({ ...historyBase, kind: z.literal("review_withdrawn") }),
]);
export const pipelineNote = z.discriminatedUnion("state", [
	z.strictObject({
		state: z.literal("current"),
		id: recordId,
		revision,
		body: z.string(),
		author: z.string().nullable(),
		avatar: avatarReference.nullable(),
		writtenOn: localDate,
		editedOn: localDate.nullable(),
		mine: z.boolean(),
		questions: z.array(z.string()).max(200).nullable(),
		reviews: z.array(noteReview).max(200),
	}),
	z.strictObject({
		state: z.literal("removed"),
		id: recordId,
		author: z.string().nullable(),
		avatar: avatarReference.nullable(),
		removedOn: localDate,
	}),
]);
export const leadershipConversation = z.strictObject({
	id: recordId,
	revision,
	on: localDate,
	metBy: z.string().nullable(),
	note: z.string().nullable(),
	loggedOn: localDate,
	corrections: z
		.array(
			z.strictObject({
				id: recordId,
				on: localDate,
				actor: z.string().nullable(),
				dateFrom: localDate.nullable(),
				dateTo: localDate.nullable(),
				noteChanged: z.boolean(),
			}),
		)
		.max(50),
});

export const residencyLinkStatus = z.discriminatedUnion("status", [
	z.strictObject({ status: z.literal("not_linked") }),
	z.strictObject({ status: z.literal("linked") }),
	z.strictObject({
		status: z.literal("pending"),
		invitationId: recordId,
		revision,
		recipientEmail: z.string(),
		sentOn: localDate,
	}),
]);

export const pipelinePersonRecord = z.strictObject({
	audience: pipelineAudience.exclude(["counts"]),
	personId,
	name: z.string(),
	email: z.string().nullable(),
	retired: z.boolean(),
	revision,
	stage: z.strictObject({ id: recordId, label: z.string(), kind: pipelineStageKind }),
	responsible: staff.nullable(),
	assessment: z.strictObject({ on: localDate, by: z.string() }).nullable(),
	history: z.array(pipelineHistoryEntry).max(200),
	notes: z.array(pipelineNote).max(200),
	conversations: z.array(leadershipConversation).max(200),
	residency: residencyLinkStatus,
	organizationRevision: revision,
	asOf: localDate,
	viewer: accountId,
});

export const sendingGoal = z.strictObject({
	id: recordId,
	revision,
	leaderTarget: goalTarget,
	plantTarget: goalTarget,
	targetYear: z.int(),
	rationale: z.string(),
	countingFrom: localDate,
	counts: z.array(goalCount.extend({ count: z.int().min(0) })).max(4),
});
const count = z.int().min(0);
export const pipelineGoals = z.strictObject({
	asOf: localDate,
	canEdit: z.boolean(),
	goals: z.array(sendingGoal).max(50),
	kinds: z.array(z.strictObject({ kind: pipelineStageKind, count })),
	activeResidents: count,
	plantsSent: z.strictObject({ status: z.literal("unavailable"), reason: z.literal("deferred_stage_3") }),
	conversations: z.strictObject({
		months: z.array(z.strictObject({ month: z.string().regex(/^\d{4}-\d{2}$/), count })).length(6),
		quarters: z.array(z.strictObject({ year: z.int(), quarter: z.int().min(1).max(4), count })).length(4),
	}),
});
export const pipelineRefusal = z.discriminatedUnion("code", [
	z.strictObject({ code: z.literal("unavailable") }),
	z.strictObject({ code: z.literal("invalid_input"), field: z.string().optional() }),
	z.strictObject({ code: z.literal("conflict") }),
	z.strictObject({ code: z.literal("stage_occupied"), stageId: recordId, people: z.int().min(1) }),
]);
export type PipelineRefusal = z.infer<typeof pipelineRefusal>;

export const removePipelinePersonRequest = z.strictObject({ personId, expectedRevision: revision });
export const pipelineRemovalReport = z.strictObject({
	personId,
	removed: z.strictObject({
		stageMoves: count,
		notes: count,
		conversations: count,
		enrollments: count,
		milestoneMarks: count,
		feedback: count,
		residencyLinkEnded: z.boolean(),
		invitationsRevoked: count,
		mergedRecords: count,
	}),
	kept: z.array(
		z.strictObject({
			category: z.enum(["program_completion_count", "activity_record", "removal_record"]),
			count: count.nullable(),
		}),
	),
	attribution: z.literal("Former participant"),
});
export type PipelineRemovalReport = z.infer<typeof pipelineRemovalReport>;
export const pipelineExport = z.strictObject({
	filename: z.string().regex(/^pipeline-\d{4}-\d{2}-\d{2}\.csv$/),
	mediaType: z.literal("text/csv; charset=utf-8"),
	text: z.string(),
	people: count,
});
export type PipelineExport = z.infer<typeof pipelineExport>;
export type PipelineReply<T> = { status: "ok"; value: T } | { status: "refused"; refusal: PipelineRefusal };
export type PipelineBoard = z.infer<typeof pipelineBoard>;
export type PipelinePersonRecord = z.infer<typeof pipelinePersonRecord>;
export type PipelineBoardQuery = z.infer<typeof pipelineBoardQuery>;
export type PipelineGoals = z.infer<typeof pipelineGoals>;
