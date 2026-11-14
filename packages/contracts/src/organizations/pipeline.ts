import { z } from "zod";
import { accountId, personId, recordId, revision } from "../common/values.ts";
import { instant, localDate } from "../common/time.ts";
import { normalizedEmail } from "../identity/requests.ts";

// The organization pipeline (REQ-MUL-001, -002, -008, -009): the people a sending church or network develops toward
// planting, their stages, moves, outside assessments and private notes. The organization, actor and clock come from the
// server; a body names only records and values. Nothing here scores, rates or judges a person.

/** The fixed kinds a stage maps to (REQ-MUL-008). Counts use kinds, never the editable labels. */
export const pipelineStageKind = z.enum([
	"potential_leader",
	"apprentice",
	"resident",
	"commissioned",
	"not_continuing",
	"other",
]);
/** The starter stages, in order. */
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
/** A move's reason is required and is never sent to a model or central audit (REQ-MUL-002). */
const reason = z.string().trim().min(1).max(1000);

/** The board's URL filters (D67): which list, the six-month inactivity filter, a search and a page number. */
export const pipelineBoardQuery = z.strictObject({
	view: z.enum(["board", "retired"]).default("board"),
	stale: z.boolean().default(false),
	q: z.string().trim().max(100).default(""),
	page: z.int().min(1).max(10_000).default(1),
});

/** A new pipeline person. The browser names the person's ID, so a repeated request adds no second person. */
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
/** Only that an outside assessment happened, when and who ran it: no result, score or rating (REQ-MUL-008). */
export const recordAssessmentRequest = z.strictObject({
	personId,
	expectedRevision: revision,
	assessedOn: localDate,
	assessor: z.string().trim().min(1).max(200),
});
export const pipelinePersonLifecycleRequest = z.strictObject({ personId, expectedRevision: revision });

/**
 * The whole stage list as the editor left it, in order. A listed stage with a revision is an existing one (its kind is
 * fixed); one without is new, with the ID the browser gave it. `removed` names existing stages to delete.
 */
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

/** A count target on a sending goal: never negative (REQ-MUL-007). */
const goalTarget = z.int().min(0).max(10_000);
/**
 * A count a goal chooses (D-1264): people who reached a stage of one fixed kind since the goal's counting-from day,
 * under the organization's own name for it, such as "Leaders sent" for Commissioned.
 */
export const goalCount = z.strictObject({ kind: pipelineStageKind, label: z.string().trim().min(1).max(60) });
/** At most 4 counts per goal, each a different kind. A repeated kind is refused at that count's `kind`. */
const goalCounts = z
	.array(goalCount)
	.max(4)
	.superRefine((counts, ctx) =>
		counts.forEach((c, i) => {
			if (counts.findIndex((o) => o.kind === c.kind) !== i)
				ctx.addIssue({ code: "custom", path: [i, "kind"], message: "This goal already counts that kind." });
		}),
	);
/**
 * A new sending goal (no revision, with the ID the browser gave it) or a change to one. Saving a goal never moves a
 * person, changes a stage or creates a plant (REQ-MUL-007).
 */
export const saveGoalRequest = z.strictObject({
	goalId: recordId,
	expectedRevision: revision.nullable(),
	leaderTarget: goalTarget,
	plantTarget: goalTarget,
	targetYear: z.int().min(2000).max(2200),
	rationale: z.string().trim().min(1).max(1000),
	/**
	 * The first day the goal's counts include, never after today in the organization's time zone (D-1263). Null counts
	 * a new goal from today and keeps a saved goal's day.
	 */
	countingFrom: localDate.nullable(),
	counts: goalCounts,
});
/** A conversation's optional short note: readable only by the Owner, Admins and the current responsible staff. */
const conversationNote = z.string().trim().min(1).max(1000).nullable();
/** A leadership (ICNU) conversation a staff member had with a pipeline person, on its actual day (REQ-MUL-009). */
export const logConversationRequest = z.strictObject({
	conversationId: recordId,
	personId,
	occurredOn: localDate,
	note: conversationNote,
});
/** A correction to a conversation's day or note. History keeps the old and new day, who changed it and when. */
export const correctConversationRequest = z.strictObject({
	conversationId: recordId,
	expectedRevision: revision,
	occurredOn: localDate,
	note: conversationNote,
});

/** What the viewer may see: everyone (Owner, Admin), the people they are responsible for, or counts only. */
export const pipelineAudience = z.enum(["administrator", "responsible", "counts"]);

const staff = z.strictObject({ seatId: recordId, name: z.string() });
export const pipelineCard = z.strictObject({
	personId,
	name: z.string(),
	email: z.string().nullable(),
	responsible: staff.nullable(),
	revision,
	/** The day of the last placement or move, in the organization's time zone. */
	lastMovedOn: localDate.nullable(),
});
export const pipelineStage = z.strictObject({
	id: recordId,
	label: z.string(),
	kind: pipelineStageKind,
	/** A starter stage nobody has saved yet reads as revision 1, the revision the first write gives it. */
	revision,
	/** Every live person in the stage, whatever the filters. */
	count: z.int().min(0),
	/** Live people at this stage who are in the viewer's audience, or in the retired list, and match the filters. */
	matching: z.int().min(0),
	/** This page of those people; always empty for a counts-only audience. */
	people: z.array(pipelineCard).max(24),
});
export const pipelineBoard = z.strictObject({
	audience: pipelineAudience,
	organizationName: z.string(),
	/** Today in the organization's time zone: the as-of date of the inactivity filter. */
	asOf: localDate,
	query: pipelineBoardQuery,
	stages: z.array(pipelineStage),
	/** Pages of 24 people per stage (D67); 1 when everything fits. */
	pages: z.int().min(1),
	/** Current eligible seats for the responsible-staff picker; empty for anyone who cannot edit. */
	staff: z.array(staff.extend({ role: z.enum(["owner", "admin", "member"]) })),
	retiredCount: z.int().min(0),
});

const historyBase = { id: recordId, on: localDate, actor: z.string().nullable() };
export const pipelineHistoryEntry = z.discriminatedUnion("kind", [
	z.strictObject({ ...historyBase, kind: z.literal("placed"), to: z.string() }),
	z.strictObject({ ...historyBase, kind: z.literal("moved"), from: z.string(), to: z.string(), reason: z.string() }),
	z.strictObject({ ...historyBase, kind: z.literal("assessment") }),
	z.strictObject({ ...historyBase, kind: z.literal("edited") }),
	z.strictObject({ ...historyBase, kind: z.literal("retired") }),
	z.strictObject({ ...historyBase, kind: z.literal("restored") }),
]);
export const pipelineNote = z.discriminatedUnion("state", [
	z.strictObject({
		state: z.literal("current"),
		id: recordId,
		revision,
		body: z.string(),
		author: z.string().nullable(),
		writtenOn: localDate,
		editedOn: localDate.nullable(),
		mine: z.boolean(),
	}),
	z.strictObject({
		state: z.literal("removed"),
		id: recordId,
		author: z.string().nullable(),
		removedOn: localDate,
	}),
]);
/** One leadership conversation on a person's record, readable only by the record's audience. */
export const leadershipConversation = z.strictObject({
	id: recordId,
	revision,
	on: localDate,
	/** The staff member who met the person and logged it. */
	metBy: z.string().nullable(),
	note: z.string().nullable(),
	loggedOn: localDate,
	/** Each correction, oldest first: the old and new day when the day changed, who changed it and when. */
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

/**
 * Whether the person's own Everyfield account is linked to this organization's residency (REQ-MUL-004). Owners and
 * Admins also see a pending invitation to link, with what resending or revoking it needs.
 */
export const residencyLinkStatus = z.discriminatedUnion("status", [
	z.strictObject({ status: z.literal("not_linked") }),
	z.strictObject({ status: z.literal("linked") }),
	z.strictObject({
		status: z.literal("pending"),
		invitationId: recordId,
		revision,
		recipientEmail: z.string(),
		/** The day it was last sent, in the organization's time zone. */
		sentOn: localDate,
		resendAvailableAt: instant,
	}),
]);
export type ResidencyLinkStatus = z.infer<typeof residencyLinkStatus>;

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
	/** The organization's revision, which an invitation to link must carry. */
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
	/**
	 * Each chosen count in the goal's order: distinct live people of this organization with a move or first placement
	 * into a stage of its kind dated from `countingFrom` through today. Counts only, no names (D-1265).
	 */
	counts: z.array(goalCount.extend({ count: z.int().min(0) })).max(4),
});
const count = z.int().min(0);
/**
 * The goals area of the Pipeline page, for every seat: the organization's goals, its own pipeline counted by fixed
 * stage kind as of today, and leadership conversations counted by month and quarter. Counts and dates only: no rate,
 * forecast or verdict (ADR-001). Plants sent is unavailable until commissioning arrives (ADR-001 stage 3).
 */
export const pipelineGoals = z.strictObject({
	/** Today in the organization's time zone: the as-of day of every count. */
	asOf: localDate,
	canEdit: z.boolean(),
	goals: z.array(sendingGoal).max(50),
	/** Distinct live people of this organization whose current stage has each kind; one entry per kind in use. */
	kinds: z.array(z.strictObject({ kind: pipelineStageKind, count })),
	/** Distinct live people with an active enrollment in a residency-kind program (REQ-MUL-007); not a stage count. */
	activeResidents: count,
	plantsSent: z.strictObject({ status: z.literal("unavailable"), reason: z.literal("deferred_stage_3") }),
	conversations: z.strictObject({
		/** The last six months, oldest first, ending with this month. */
		months: z.array(z.strictObject({ month: z.string().regex(/^\d{4}-\d{2}$/), count })).length(6),
		/** The last four quarters, oldest first, ending with this quarter. */
		quarters: z.array(z.strictObject({ year: z.int(), quarter: z.int().min(1).max(4), count })).length(4),
	}),
});
/** Why a pipeline request was refused. `stage_occupied` names how many people a stage still holds. */
export const pipelineRefusal = z.discriminatedUnion("code", [
	z.strictObject({ code: z.literal("unavailable") }),
	z.strictObject({ code: z.literal("invalid_input"), field: z.string().optional() }),
	z.strictObject({ code: z.literal("conflict") }),
	z.strictObject({ code: z.literal("stage_occupied"), stageId: recordId, people: z.int().min(1) }),
]);
export type PipelineRefusal = z.infer<typeof pipelineRefusal>;
export type PipelineReply<T> = { status: "ok"; value: T } | { status: "refused"; refusal: PipelineRefusal };
export type PipelineBoard = z.infer<typeof pipelineBoard>;
export type PipelinePersonRecord = z.infer<typeof pipelinePersonRecord>;
export type PipelineBoardQuery = z.infer<typeof pipelineBoardQuery>;
export type PipelineGoals = z.infer<typeof pipelineGoals>;
