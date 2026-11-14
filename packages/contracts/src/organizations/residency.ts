import { z } from "zod";
import { recordId } from "../common/values.ts";
import { localDate, localDateTime } from "../common/time.ts";
import { completionSource, programKind } from "./programs.ts";

// My residency (REQ-MUL-013): a linked resident's own view of the residency their sending church runs for them. It
// holds only what the resident may see: the program, the program stage, the next meeting, their own milestones with
// their confirmation and the director's feedback on them, the reading list and their own sharing choices. Never the
// pipeline stage, stage-move reasons, staff notes, the outside assessment or the inactivity flag.

/** One reading list item as the resident may open it: their church's own version here, a global article in the Wiki. */
export const residentReading = z.strictObject({
	id: recordId,
	title: z.string(),
	source: z.enum(["global", "organization"]),
	/** False once the source no longer publishes the article; the item then opens nothing. */
	available: z.boolean(),
	/** A global article's Wiki address segment while it is available; null for the church's own version. */
	slug: z.string().nullable(),
});

export const residentMilestone = z.strictObject({
	id: recordId,
	title: z.string(),
	description: z.string().nullable(),
	handsOn: z.boolean(),
	completion: z
		.strictObject({
			completedOn: localDate,
			/** Null while the resident's own mark waits for the director. */
			confirmedOn: localDate.nullable(),
			source: completionSource,
		})
		.nullable(),
	/** The director's dated feedback on this resident's assignment. */
	feedback: z.array(z.strictObject({ id: recordId, writtenOn: localDate, writer: z.string().nullable(), body: z.string() })),
});

export const residentEnrollment = z.strictObject({
	id: recordId,
	program: z.strictObject({ name: z.string(), kind: programKind, director: z.string() }),
	cohort: z.string(),
	startedOn: localDate,
	expectedEndOn: localDate,
	/** The program stage (REQ-MUL-011); never the pipeline stage. */
	stage: z.string(),
	nextMeeting: z
		.strictObject({
			/** In the resident's own time zone. */
			at: localDateTime,
			/** The church's wall time and zone, which the enrollment keeps. */
			churchAt: localDateTime,
			churchTimezone: z.string(),
		})
		.nullable(),
	milestones: z.array(residentMilestone),
	readings: z.array(residentReading),
});

export const myResidency = z.discriminatedUnion("status", [
	/** No live residency link: never linked, left, or the church ended it. */
	z.strictObject({ status: z.literal("not_linked") }),
	z.strictObject({
		status: z.literal("linked"),
		organizationName: z.string(),
		/** The resident's own time zone, from their personal settings or else the church's. */
		timezone: z.string(),
		today: localDate,
		sharing: z.strictObject({ shareMilestones: z.boolean(), shareFoundations: z.boolean() }),
		enrollments: z.array(residentEnrollment),
	}),
]);
export type MyResidency = z.infer<typeof myResidency>;

/** The resident marks one of their own milestones done today; it then waits for the director's confirmation. */
export const markMilestoneRequest = z.strictObject({ enrollmentId: recordId, milestoneId: recordId });

/** One church-owned reading list item the resident may open: its current published body. */
export const residentReadingRequest = z.strictObject({ readingId: recordId });
export const residentReadingResult = z.discriminatedUnion("status", [
	z.strictObject({ status: z.literal("unavailable") }),
	z.strictObject({
		status: z.literal("available"),
		title: z.string(),
		organizationName: z.string(),
		contentType: z.enum(["safe_mdx", "safe_nodes"]),
		body: z.string(),
	}),
]);
export type ResidentReadingResult = z.infer<typeof residentReadingResult>;
