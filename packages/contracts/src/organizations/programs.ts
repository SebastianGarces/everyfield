import { z } from "zod";
import { personId, recordId, revision } from "../common/values.ts";
import { localDate, localDateTime } from "../common/time.ts";

export const programKind = z.enum(["apprenticeship", "residency"]);
export const programRhythm = z.enum(["weekly", "every_two_weeks", "monthly"]);
export type ProgramKind = z.infer<typeof programKind>;
export type ProgramRhythm = z.infer<typeof programRhythm>;

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
		lineage: z.uuid(),
		title: z.string().trim().min(1).max(200),
		description: z.string().trim().min(1).max(2000).nullable(),
		handsOn: z.boolean(),
	})
	.refine((m) => !m.handsOn || m.description !== null, { path: ["description"] });
const readingInput = z.strictObject({ revisionId: recordId });

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

export const createProgramRequest = z.strictObject({
	programId: recordId,
	kind: programKind,
	name: z.string().trim().min(1).max(120),
	directorSeatId: recordId,
	plan: programPlan,
});
export const saveProgramPlanRequest = z.strictObject({
	programId: recordId,
	expectedRevision: revision,
	plan: programPlan,
});
export const publishProgramRequest = z.strictObject({ programId: recordId, expectedRevision: revision });

export const enrollRequest = z
	.strictObject({
		enrollmentId: recordId,
		programId: recordId,
		personId,
		cohort: z.string().trim().min(1).max(80),
		startedOn: localDate,
		expectedEndOn: localDate,
		stageId: recordId,
		nextMeetingAt: localDateTime.nullable(),
	})
	.refine((e) => e.expectedEndOn >= e.startedOn, { path: ["expectedEndOn"] });

export const recordMilestoneRequest = z.strictObject({
	enrollmentId: recordId,
	milestoneId: recordId,
	completedOn: localDate,
});
export const confirmMilestoneRequest = z.strictObject({ enrollmentId: recordId, milestoneId: recordId });
export const addFeedbackRequest = z.strictObject({
	feedbackId: recordId,
	enrollmentId: recordId,
	milestoneId: recordId,
	body: z.string().trim().min(1).max(5000),
});
export const applyVersionRequest = z.strictObject({
	enrollmentId: recordId,
	versionId: recordId,
	stageId: recordId,
	basis: z.string().regex(/^[0-9a-f]{32}$/),
});
export const APPLY_VERSION_LIMIT = 50;
const enrollmentIds = z
	.array(recordId)
	.min(1)
	.max(APPLY_VERSION_LIMIT)
	.refine((ids) => new Set(ids).size === ids.length);
export const versionReviewsRequest = z.strictObject({ programId: recordId, enrollmentIds });
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
export const readingSearchRequest = z.strictObject({ q: z.string().trim().max(100) });

const person = z.strictObject({ seatId: recordId, name: z.string() });
export const readingItem = z.strictObject({
	id: recordId,
	revisionId: recordId,
	title: z.string(),
	source: z.enum(["global", "organization"]),
	slug: z.string().nullable(),
});
export const programVersion = z.strictObject({
	id: recordId,
	number: z.int().min(1),
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
	publishedNumber: z.int().min(1).nullable(),
	publishedOn: localDate.nullable(),
	draft: z.boolean(),
	activeEnrollments: z.int().min(0),
});
export const programList = z.strictObject({
	organizationName: z.string(),
	administrator: z.boolean(),
	activeResidents: z.int().min(0),
	programs: z.array(programSummary),
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
			stage: z.string(),
			versionNumber: z.int().min(1),
		}),
	),
	people: z.array(z.strictObject({ personId, name: z.string() })),
});
export type ProgramDetail = z.infer<typeof programDetail>;

export const completionSource = z.enum(["program_leader", "resident"]);

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
			confirmedOn: localDate.nullable(),
			recorder: z.string().nullable(),
			confirmer: z.string().nullable(),
			source: completionSource,
		})
		.nullable(),
	feedback: z
		.array(z.strictObject({ id: recordId, writtenOn: localDate, writer: z.string().nullable(), body: z.string() }))
		.nullable(),
});
export const earlierMilestone = enrollmentMilestone.extend({ versionNumber: z.int().min(1) });
export const enrollmentDetail = z.strictObject({
	id: recordId,
	person: z.strictObject({ personId, name: z.string() }),
	program: z.strictObject({ id: recordId, name: z.string(), kind: programKind, director: person }),
	versionNumber: z.int().min(1),
	cohort: z.string(),
	startedOn: localDate,
	expectedEndOn: localDate,
	status: z.literal("active"),
	stage: z.strictObject({ id: recordId, label: z.string() }),
	nextMeeting: z.strictObject({ at: localDateTime, timezone: z.string() }).nullable(),
	milestones: z.array(enrollmentMilestone),
	resident: residentView,
	earlier: z.array(earlierMilestone),
	newerVersion: z.strictObject({ id: recordId, number: z.int().min(1) }).nullable(),
	viewer,
	today: localDate,
});
export type EnrollmentDetail = z.infer<typeof enrollmentDetail>;

const reviewedMilestone = z.strictObject({
	title: z.string(),
	description: z.string().nullable(),
	handsOn: z.boolean(),
	finished: z.boolean(),
});
export const versionReview = z.strictObject({
	enrollmentId: recordId,
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

export const programRefusal = z.discriminatedUnion("code", [
	z.strictObject({ code: z.literal("unavailable") }),
	z.strictObject({ code: z.literal("invalid_input"), field: z.string().optional() }),
	z.strictObject({ code: z.literal("conflict") }),
	z.strictObject({ code: z.literal("not_published") }),
	z.strictObject({ code: z.literal("already_enrolled") }),
	z.strictObject({ code: z.literal("no_stages") }),
	z.strictObject({ code: z.literal("linked_resident") }),
	z.strictObject({
		code: z.literal("stale_review"),
		enrollmentIds: z.array(recordId).optional(),
	}),
]);
export type ProgramRefusal = z.infer<typeof programRefusal>;
export type ProgramReply<T> = { status: "ok"; value: T } | { status: "refused"; refusal: ProgramRefusal };
