import { z } from "zod";
import { recordId } from "../common/values.ts";
import { localDate, localDateTime } from "../common/time.ts";
import { completionSource, programKind } from "./programs.ts";

export const residentReading = z.strictObject({
	id: recordId,
	title: z.string(),
	source: z.enum(["global", "organization"]),
	available: z.boolean(),
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
			confirmedOn: localDate.nullable(),
			source: completionSource,
		})
		.nullable(),
	feedback: z.array(
		z.strictObject({ id: recordId, writtenOn: localDate, writer: z.string().nullable(), body: z.string() }),
	),
});

export const residentEnrollment = z.strictObject({
	id: recordId,
	program: z.strictObject({ name: z.string(), kind: programKind, director: z.string() }),
	cohort: z.string(),
	startedOn: localDate,
	expectedEndOn: localDate,
	stage: z.string(),
	nextMeeting: z
		.strictObject({
			at: localDateTime,
			churchAt: localDateTime,
			churchTimezone: z.string(),
		})
		.nullable(),
	milestones: z.array(residentMilestone),
	readings: z.array(residentReading),
});

export const myResidency = z.discriminatedUnion("status", [
	z.strictObject({ status: z.literal("not_linked") }),
	z.strictObject({ status: z.literal("ended") }),
	z.strictObject({
		status: z.literal("linked"),
		organizationName: z.string(),
		timezone: z.string(),
		today: localDate,
		sharing: z.strictObject({ shareMilestones: z.boolean(), shareFoundations: z.boolean() }),
		enrollments: z.array(residentEnrollment),
	}),
]);
export type MyResidency = z.infer<typeof myResidency>;

export const markMilestoneRequest = z.strictObject({ enrollmentId: recordId, milestoneId: recordId });

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
