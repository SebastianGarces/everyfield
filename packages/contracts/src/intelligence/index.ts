import { z } from "zod";
import { defineSafeError, recordId, requestKey, revision, type Reply } from "../common/values.ts";
import { instant, localDate } from "../common/time.ts";

export const CARE_AREAS = ["spiritual", "family", "financial", "pace"] as const;
export type CareArea = (typeof CARE_AREAS)[number];
export const careLevel = z.enum(["steady", "strained", "struggling"]);
export type CareLevel = z.infer<typeof careLevel>;
export const NOTE_MAX = 2000;
export const HISTORY_PAGE = 12;

export const careAnswers = z.strictObject({
	spiritual: careLevel,
	family: careLevel,
	financial: careLevel,
	pace: careLevel,
});
export type CareAnswers = z.infer<typeof careAnswers>;
const noteInput = z.string().max(NOTE_MAX);

export const readCurrentRequest = z.strictObject({});
export const readTrendsRequest = z.strictObject({});
export const readHistoryRequest = z.strictObject({ page: z.int().min(1).max(10_000) });
export const saveRequest = z.strictObject({
	requestKey,
	expectedRevision: revision,
	input: z.strictObject({ answers: careAnswers, note: noteInput }),
});
export const correctRequest = z.strictObject({
	requestKey,
	expectedRevision: revision,
	input: z.strictObject({ weekId: recordId, answers: careAnswers, note: noteInput }),
});

export const careRevision = z.strictObject({
	revision: z.int().min(1),
	kind: z.enum(["save", "correction"]),
	answers: careAnswers,
	note: z.string().nullable(),
	recordedAt: instant,
});
export const careWeek = z.strictObject({
	id: recordId.nullable(),
	ordinal: z.int().min(1),
	zone: z.string().min(1),
	startsOn: localDate,
	endsOn: localDate,
	current: z.boolean(),
	answer: z
		.strictObject({
			answers: careAnswers,
			note: z.string().nullable(),
			revision: z.int().min(1),
			answeredAt: instant,
		})
		.nullable(),
	revisions: z.array(careRevision),
});
export type CareWeek = z.infer<typeof careWeek>;

export const carePage = z.strictObject({
	zone: z.string().min(1),
	revision,
	page: z.int().min(1),
	pageCount: z.int().min(1),
	weeks: z.array(careWeek),
});
export type CarePage = z.infer<typeof carePage>;
export const careCurrent = z.strictObject({ zone: z.string().min(1), revision, week: careWeek });
export const careWriteResult = z.strictObject({
	outcome: z.enum(["saved", "unchanged"]),
	revision,
	week: careWeek,
});
export type CareWriteResult = z.infer<typeof careWriteResult>;

export const careError = z.discriminatedUnion("code", [
	defineSafeError("invalid_input", {}, "never"),
	defineSafeError("access_denied", {}, "never"),
	defineSafeError("not_found", {}, "never"),
	defineSafeError("idempotency_conflict", {}, "never"),
	defineSafeError("personal_timezone_confirmation_required", {}, "never"),
	defineSafeError("revision_conflict", {}, "refresh"),
]);
export type CareError = z.infer<typeof careError>;
export type CareReply<T> = Reply<T, CareError>;

export const noteOf = (raw: string) => raw.trim() || null;
export * from "./signals.ts";
export * from "./facts.ts";
export * from "./assessment.ts";
export * from "./views.ts";
