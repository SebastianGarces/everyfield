import { z } from "zod";
import { personId, recordId, revision } from "../common/values.ts";
import { localDate, localDateTime } from "../common/time.ts";

// Development programs (REQ-MUL-010, -011, -012): an organization's apprenticeships and residencies, each a numbered
// series of published plans, the people enrolled on one of them, the milestones the director recorded for each, and
// the director's feedback on hands-on assignments. The organization, actor and clock come from the server. Nothing
// here grades, scores or judges a person or their calling.

export const programKind = z.enum(["apprenticeship", "residency"]);
export const programRhythm = z.enum(["weekly", "every_two_weeks", "monthly"]);
export type ProgramKind = z.infer<typeof programKind>;
export type ProgramRhythm = z.infer<typeof programRhythm>;

/** The residency template (REQ-MUL-010): four stages with month ranges, and three starter milestones. */
export const RESIDENCY_TEMPLATE = {
	stages: [
		{ label: "Assimilating", minMonths: 2, maxMonths: 3 },
		{ label: "Training and planning", minMonths: 6, maxMonths: 9 },
		{ label: "Gathering", minMonths: 2, maxMonths: 3 },
		{ label: "Sending and planting", minMonths: 2, maxMonths: 3 },
	],
	milestones: [
		"Start a small group and raise a replacement",
		"Present your vision to the sending church leadership",
		"Write a church planting prospectus",
	],
} as const;

const months = z.int().min(0).max(120);
const stageInput = z
	.strictObject({ label: z.string().trim().min(1).max(80), minMonths: months, maxMonths: months })
	.refine((s) => s.maxMonths >= s.minMonths, { path: ["maxMonths"] });
const milestoneInput = z
	.strictObject({
		/** Carries a milestone from one version to the next; the browser names it once, when the milestone is new. */
		lineage: z.uuid(),
		title: z.string().trim().min(1).max(200),
		description: z.string().trim().min(1).max(2000).nullable(),
		handsOn: z.boolean(),
	})
	.refine((m) => !m.handsOn || m.description !== null, { path: ["description"] });
/** A Wiki article on the reading list, by the revision chosen: global, or the organization's own version. */
const readingInput = z.strictObject({ revisionId: recordId });

/** The whole plan as the editor left it, in order. A save replaces the draft's plan. */
export const programPlan = z
	.strictObject({
		rhythm: programRhythm,
		expectedMonths: z.int().min(1).max(120),
		stages: z.array(stageInput).max(20),
		milestones: z.array(milestoneInput).max(100),
		readings: z.array(readingInput).max(50),
	})
	.refine((p) => new Set(p.milestones.map((m) => m.lineage)).size === p.milestones.length, { path: ["milestones"] })
	.refine((p) => new Set(p.readings.map((r) => r.revisionId)).size === p.readings.length, { path: ["readings"] })
	.refine((p) => new Set(p.stages.map((s) => s.label.toLowerCase())).size === p.stages.length, { path: ["stages"] });
export type ProgramPlan = z.infer<typeof programPlan>;

/** A new program and its first draft. Owner or Admin. The browser names the program's ID once per form. */
export const createProgramRequest = z.strictObject({
	programId: recordId,
	kind: programKind,
	name: z.string().trim().min(1).max(120),
	directorSeatId: recordId,
	plan: programPlan,
});
/** Saves the draft, starting the next version's draft when the program has none. The current director only. */
export const saveProgramPlanRequest = z.strictObject({
	programId: recordId,
	expectedRevision: revision,
	plan: programPlan,
});
/** Publishes the draft as the next version. The current director only. */
export const publishProgramRequest = z.strictObject({ programId: recordId, expectedRevision: revision });

/** Enrolls a live pipeline person in the program's current published version. Owner or Admin. */
export const enrollRequest = z
	.strictObject({
		enrollmentId: recordId,
		programId: recordId,
		personId,
		cohort: z.string().trim().min(1).max(80),
		startedOn: localDate,
		expectedEndOn: localDate,
		stageId: recordId,
		/** In the organization's time zone, which the enrollment keeps as its meeting time zone. */
		nextMeetingAt: localDateTime.nullable(),
	})
	.refine((e) => e.expectedEndOn >= e.startedOn, { path: ["expectedEndOn"] });

/**
 * The director records that an enrollee without a linked account finished a milestone on a day, and confirms it in
 * the same step (REQ-MUL-012). The director is recorder and confirmer; nothing is commissioned or created.
 */
export const recordMilestoneRequest = z.strictObject({
	enrollmentId: recordId,
	milestoneId: recordId,
	completedOn: localDate,
});
/** The director confirms a milestone a linked resident marked done (REQ-MUL-012). The current director only. */
export const confirmMilestoneRequest = z.strictObject({ enrollmentId: recordId, milestoneId: recordId });
/** Dated feedback on a hands-on assignment. The current director only; the browser names the feedback's ID. */
export const addFeedbackRequest = z.strictObject({
	feedbackId: recordId,
	enrollmentId: recordId,
	milestoneId: recordId,
	body: z.string().trim().min(1).max(5000),
});
/**
 * Moves an active enrollment to the program's current published version, at a stage of that version. The current
 * director only, after a review: `basis` names the state the review showed, and a change since refuses the apply.
 */
export const applyVersionRequest = z.strictObject({
	enrollmentId: recordId,
	versionId: recordId,
	stageId: recordId,
	basis: z.string().regex(/^[0-9a-f]{32}$/),
});
/** The most enrollments one review or apply covers (D-1329). */
export const APPLY_VERSION_LIMIT = 50;
const enrollmentIds = z
	.array(recordId)
	.min(1)
	.max(APPLY_VERSION_LIMIT)
	.refine((ids) => new Set(ids).size === ids.length);
/** The reviews the director reads before applying the program's current version to several of its enrollments. */
export const versionReviewsRequest = z.strictObject({ programId: recordId, enrollmentIds });
/**
 * Moves several active enrollments of one program to its current published version, each at its own stage, all or
 * none (D-1328). Each names the `basis` of its review; a change to any of them since refuses the whole apply.
 */
export const applyVersionsRequest = z
	.strictObject({
		programId: recordId,
		versionId: recordId,
		enrollments: z
			.array(z.strictObject({ enrollmentId: recordId, stageId: recordId, basis: applyVersionRequest.shape.basis }))
			.min(1)
			.max(APPLY_VERSION_LIMIT),
	})
	.refine((r) => new Set(r.enrollments.map((e) => e.enrollmentId)).size === r.enrollments.length, {
		path: ["enrollments"],
	});
/** Wiki articles the organization may put on a reading list, by title. */
export const readingSearchRequest = z.strictObject({ q: z.string().trim().max(100) });

const person = z.strictObject({ seatId: recordId, name: z.string() });
export const readingItem = z.strictObject({
	id: recordId,
	revisionId: recordId,
	title: z.string(),
	source: z.enum(["global", "organization"]),
	/** The article's address segment while its source still publishes it; null shows the item as unavailable. */
	slug: z.string().nullable(),
});
export const programVersion = z.strictObject({
	id: recordId,
	number: z.int().min(1),
	/** The day it was published, in the organization's time zone; null for the draft. */
	publishedOn: localDate.nullable(),
	rhythm: programRhythm,
	expectedMonths: z.int().min(1),
	stages: z.array(z.strictObject({ id: recordId, label: z.string(), minMonths: z.int(), maxMonths: z.int() })),
	milestones: z.array(
		z.strictObject({
			id: recordId,
			lineage: z.uuid(),
			title: z.string(),
			description: z.string().nullable(),
			handsOn: z.boolean(),
		}),
	),
	readings: z.array(readingItem),
});
export type ProgramVersion = z.infer<typeof programVersion>;

const viewer = z.strictObject({ administrator: z.boolean(), director: z.boolean() });

export const programSummary = z.strictObject({
	id: recordId,
	name: z.string(),
	kind: programKind,
	director: person,
	/** The current published version's number; null while only a draft exists. */
	publishedNumber: z.int().min(1).nullable(),
	publishedOn: localDate.nullable(),
	draft: z.boolean(),
	activeEnrollments: z.int().min(0),
});
export const programList = z.strictObject({
	organizationName: z.string(),
	administrator: z.boolean(),
	/** Distinct live people with an active enrollment in a residency-kind program (REQ-MUL-007). */
	activeResidents: z.int().min(0),
	programs: z.array(programSummary),
	/** Current seats for the director picker; empty for anyone who cannot create a program. */
	staff: z.array(person),
});
export type ProgramList = z.infer<typeof programList>;

export const programDetail = z.strictObject({
	id: recordId,
	name: z.string(),
	kind: programKind,
	revision,
	director: person,
	viewer,
	timezone: z.string(),
	today: localDate,
	published: programVersion.nullable(),
	draft: programVersion.nullable(),
	enrollments: z.array(
		z.strictObject({
			id: recordId,
			personId,
			name: z.string(),
			cohort: z.string(),
			status: z.enum(["active", "completed", "withdrawn"]),
			stage: z.string(),
			versionNumber: z.int().min(1),
		}),
	),
	/** Live pipeline people for the enroll picker; empty for anyone who cannot enroll. */
	people: z.array(z.strictObject({ personId, name: z.string() })),
});
export type ProgramDetail = z.infer<typeof programDetail>;

/** Who recorded a milestone: the director in one step for an unlinked enrollee, or the linked resident (WP-100). */
export const completionSource = z.enum(["program_leader", "resident"]);

/**
 * What the organization may see from the enrollee's own account (REQ-MUL-003, REQ-MUL-014): nothing without a live
 * residency link; with one, the resident's own milestone marks only while they share milestone progress, and only a
 * count of the six Discovery foundations while they share foundations. Never reading rows, reflections or documents.
 */
export const residentView = z.discriminatedUnion("status", [
	z.strictObject({ status: z.literal("not_linked") }),
	z.strictObject({
		status: z.literal("linked"),
		milestones: z.enum(["shared", "not_shared"]),
		foundations: z.discriminatedUnion("status", [
			z.strictObject({ status: z.literal("not_shared") }),
			z.strictObject({ status: z.literal("shared"), completed: z.int().min(0).max(6), total: z.literal(6) }),
		]),
	}),
]);

export const enrollmentMilestone = z.strictObject({
	id: recordId,
	title: z.string(),
	description: z.string().nullable(),
	handsOn: z.boolean(),
	completion: z
		.strictObject({
			completedOn: localDate,
			/** Null while a resident's own mark waits for the director's confirmation. */
			confirmedOn: localDate.nullable(),
			recorder: z.string().nullable(),
			confirmer: z.string().nullable(),
			source: completionSource,
		})
		.nullable(),
	/** The director's dated feedback; null for a viewer who may not read it (REQ-MUL-012). */
	feedback: z
		.array(z.strictObject({ id: recordId, writtenOn: localDate, writer: z.string().nullable(), body: z.string() }))
		.nullable(),
});
/** A milestone that is no longer in the enrollment's plan but holds a record from an earlier version, kept as recorded. */
export const earlierMilestone = enrollmentMilestone.extend({ versionNumber: z.int().min(1) });
export const enrollmentDetail = z.strictObject({
	id: recordId,
	person: z.strictObject({ personId, name: z.string() }),
	program: z.strictObject({ id: recordId, name: z.string(), kind: programKind, director: person }),
	versionNumber: z.int().min(1),
	cohort: z.string(),
	startedOn: localDate,
	expectedEndOn: localDate,
	status: z.enum(["active", "completed", "withdrawn"]),
	stage: z.strictObject({ id: recordId, label: z.string() }),
	nextMeeting: z.strictObject({ at: localDateTime, timezone: z.string() }).nullable(),
	milestones: z.array(enrollmentMilestone),
	resident: residentView,
	/** Records on milestones that a later version removed (REQ-MUL-011). */
	earlier: z.array(earlierMilestone),
	/** The program's current published version, when it is newer than the enrollment's. */
	newerVersion: z.strictObject({ id: recordId, number: z.int().min(1) }).nullable(),
	viewer,
	today: localDate,
});
export type EnrollmentDetail = z.infer<typeof enrollmentDetail>;

const reviewedMilestone = z.strictObject({
	title: z.string(),
	description: z.string().nullable(),
	handsOn: z.boolean(),
	/** The enrollee finished it; the finished record is kept whatever the new version does with it. */
	finished: z.boolean(),
});
/**
 * What applying the program's current version changes for one enrollment, matched by milestone lineage: milestones
 * added, removed, and changed in title, description or kind, and the finished ones that carry over. Unchanged
 * milestones are not listed. `stageId` is the preselected stage of the new version.
 */
export const versionReview = z.strictObject({
	enrollmentId: recordId,
	/** The enrolled person's name. */
	name: z.string(),
	versionId: recordId,
	fromNumber: z.int().min(1),
	toNumber: z.int().min(1),
	basis: z.string(),
	added: z.array(reviewedMilestone),
	removed: z.array(reviewedMilestone),
	changed: z.array(z.strictObject({ before: reviewedMilestone, after: reviewedMilestone })),
	carried: z.array(z.string()),
	stage: z.string(),
	stages: z.array(z.strictObject({ id: recordId, label: z.string() })),
	stageId: recordId,
});
export type VersionReview = z.infer<typeof versionReview>;

export const readingCandidates = z.array(
	z.strictObject({ revisionId: recordId, title: z.string(), source: z.enum(["global", "organization"]) }),
);

/** Why a program request was refused. */
export const programRefusal = z.discriminatedUnion("code", [
	z.strictObject({ code: z.literal("unavailable") }),
	z.strictObject({ code: z.literal("invalid_input"), field: z.string().optional() }),
	z.strictObject({ code: z.literal("conflict") }),
	/** Enrollment needs a published version; a draft enrolls nobody (REQ-MUL-010). */
	z.strictObject({ code: z.literal("not_published") }),
	/** The person already has an active enrollment in this program (REQ-MUL-011). */
	z.strictObject({ code: z.literal("already_enrolled") }),
	/** A version needs at least one stage before it is published, since every enrollment is at a stage. */
	z.strictObject({ code: z.literal("no_stages") }),
	/** The enrollee has a linked account, so they mark their own milestones (WP-100). */
	z.strictObject({ code: z.literal("linked_resident") }),
	/** The enrollment, its records or the program's current version changed since the director's review. */
	z.strictObject({
		code: z.literal("stale_review"),
		/** In a batch apply, the enrollments whose review went out of date; all of them when the version did. */
		enrollmentIds: z.array(recordId).optional(),
	}),
]);
export type ProgramRefusal = z.infer<typeof programRefusal>;
export type ProgramReply<T> = { status: "ok"; value: T } | { status: "refused"; refusal: ProgramRefusal };
