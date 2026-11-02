import { z } from "zod";
import { correlationId, recordId, requestKey, revision } from "../common/values.ts";
import { instant, localDate } from "../common/time.ts";

// The private weekly check-in contract (WP-039, REQ-PI-038 to REQ-PI-041). Only the original author reads or writes a
// check-in. Requests name no author: the server takes it from the session, so a request can never point at another
// author's weeks. Requests are strict.

/** The four areas, in the order the page asks them. */
export const CARE_AREAS = ["spiritual", "family", "financial", "pace"] as const;
export const careArea = z.enum(CARE_AREAS);
export type CareArea = z.infer<typeof careArea>;
export const careLevel = z.enum(["steady", "strained", "struggling"]);
export type CareLevel = z.infer<typeof careLevel>;
export const NOTE_MAX = 2000;
/** Weeks on one history page; the first page is the twelve-week strip. */
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
/** Save this week: the four answers and an optional note (blank means none), from the calendar revision read. */
export const saveRequest = z.strictObject({
	requestKey,
	expectedRevision: revision,
	input: z.strictObject({ answers: careAnswers, note: noteInput }),
});
/** Correct one answered week of the author's own calendar. */
export const correctRequest = z.strictObject({
	requestKey,
	expectedRevision: revision,
	input: z.strictObject({ weekId: recordId, answers: careAnswers, note: noteInput }),
});
export type SaveRequest = z.infer<typeof saveRequest>;
export type CorrectRequest = z.infer<typeof correctRequest>;

/** One earlier or current answer of a week, oldest first. */
export const careRevision = z.strictObject({
	revision: z.int().min(1),
	kind: z.enum(["save", "correction"]),
	answers: careAnswers,
	note: z.string().nullable(),
	recordedAt: instant,
});
export type CareRevision = z.infer<typeof careRevision>;
/**
 * One Monday week of the author's calendar, in the zone it began in. A week that is due but has no row yet has no id;
 * it has no answer either. A week keeps its id, ordinal, zone and dates for good.
 */
export const careWeek = z.strictObject({
	id: recordId.nullable(),
	ordinal: z.int().min(1),
	zone: z.string().min(1),
	startsOn: localDate,
	endsOn: localDate,
	/** The open week: the latest one. A save changes it; earlier weeks change only by correction. */
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

/** The calendar as the author reads it: the personal zone, the revision a write names, and weeks newest first. */
export const carePage = z.strictObject({
	zone: z.string().min(1),
	revision,
	page: z.int().min(1),
	pageCount: z.int().min(1),
	weeks: z.array(careWeek),
});
export type CarePage = z.infer<typeof carePage>;
export const careCurrent = z.strictObject({ zone: z.string().min(1), revision, week: careWeek });
export type CareCurrent = z.infer<typeof careCurrent>;
/** A save or correction: the week as it now stands and the calendar revision after it. */
export const careWriteResult = z.strictObject({
	outcome: z.enum(["saved", "unchanged"]),
	revision,
	week: careWeek,
});
export type CareWriteResult = z.infer<typeof careWriteResult>;

const error = <C extends string>(code: C, retry: "never" | "refresh") =>
	z.strictObject({ code: z.literal(code), details: z.strictObject({}), correlationId, retry: z.literal(retry) });
/**
 * Every refusal. `not_found` is the one answer for a week that does not exist and for another author's week: it has no
 * body, week, count or calendar. A refusal never carries details.
 */
export const careError = z.discriminatedUnion("code", [
	error("invalid_input", "never"),
	error("access_denied", "never"),
	error("not_found", "never"),
	error("idempotency_conflict", "never"),
	error("personal_timezone_confirmation_required", "never"),
	error("revision_conflict", "refresh"),
]);
export type CareError = z.infer<typeof careError>;
export type CareReply<T> = { status: "ok"; value: T } | { status: "refused"; error: CareError };

/** The trimmed note, or null when it is blank. */
export const noteOf = (raw: string) => raw.trim() || null;
