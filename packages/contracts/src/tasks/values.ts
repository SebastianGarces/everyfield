import { z } from "zod";
import {
	addCivilDays,
	instant,
	localDate,
	localDateTime,
	localDayBounds,
	type Instant,
	type TimeZone,
} from "../common/time.ts";
import { accountId, recordId } from "../common/values.ts";

export const taskStatus = z.enum(["not_started", "in_progress", "blocked", "complete", "no_longer_needed"]);
export const settledStatus = ["complete", "no_longer_needed"] as const;
export const priority = z.enum(["low", "medium", "high", "urgent"]);
export const category = z.enum([
	"vision_meeting",
	"follow_up",
	"training",
	"facilities",
	"promotion",
	"administrative",
	"ministry_team",
	"launch_prep",
	"recurring",
	"general",
]);
/** Why an assignee cannot own a follow-up now (REQ-TSK-012): no current seat, no linked Person, or a Person outside the committed stages. */
export const ownerReason = z.enum(["no_seat", "no_person", "not_committed"]);
/** A task has at most ten assignees (D-b). */
export const MAX_ASSIGNEES = 10;
/** The accounts a task is assigned to. A repeated ID collapses to one before the limit applies. */
export const assigneeIds = z
	.array(accountId)
	.max(100)
	.transform((ids) => [...new Set(ids)])
	.refine((ids) => ids.length <= MAX_ASSIGNEES, "too_many_assignees");
/** A follow-up's owner view: one of the task's assignees and whether they may own it. The one value every screen shows. */
export const followUpOwner = z.strictObject({
	accountId,
	displayName: z.string(),
	eligible: z.boolean(),
	reason: ownerReason.nullable(),
});
export type FollowUpOwner = z.infer<typeof followUpOwner>;
/** Where a follow-up came from: a meeting's generated duty or a person who added it. Tells two for one person apart. */
export const followUpOrigin = z.discriminatedUnion("kind", [
	z.strictObject({ kind: z.literal("meeting"), meeting: z.strictObject({ id: recordId, label: z.string() }) }),
	z.strictObject({ kind: z.literal("added"), by: z.string().nullable() }),
]);
export type FollowUpOrigin = z.infer<typeof followUpOrigin>;
export const obligationKind = z.enum(["first_vision_follow_up", "meeting_evaluation"]);
// A bounded title. Whitespace-only titles are refused rather than saved empty.
export const title = z.string().trim().min(1).max(500);
// Plain bounded text: trimmed, LF line endings, at most 10,000 characters (tasks.normalizeDescription).
export const description = z
	.string()
	.transform((v) => v.replaceAll("\r\n", "\n").replaceAll("\r", "\n").trim())
	.pipe(z.string().max(10_000));

// A due date is one of three kinds. A deadline is entered as church-local wall time: the server resolves it in the
// church zone and never takes an instant from the client. A fold needs the chosen offset (REQ-TSK-018).
export const dueInput = z.discriminatedUnion("kind", [
	z.strictObject({ kind: z.literal("undated") }),
	z.strictObject({ kind: z.literal("local_date"), date: localDate }),
	z.strictObject({
		kind: z.literal("resolved_instant"),
		local: localDateTime,
		offsetSeconds: z.int().min(-86_400).max(86_400).optional(),
	}),
]);
export const due = z.discriminatedUnion("kind", [
	z.strictObject({ kind: z.literal("undated") }),
	z.strictObject({ kind: z.literal("local_date"), date: localDate }),
	z.strictObject({
		kind: z.literal("resolved_instant"),
		local: localDateTime,
		zone: z.string(),
		instant,
		offsetSeconds: z.int(),
	}),
]);
export type Due = z.infer<typeof due>;
// Person, meeting or team. There is no facility relation; the strict union refuses one.
export const relation = z.discriminatedUnion("kind", [
	z.strictObject({ kind: z.literal("person"), id: recordId }),
	z.strictObject({ kind: z.literal("meeting"), id: recordId }),
	z.strictObject({ kind: z.literal("team"), id: recordId }),
]);

// A recurring rule (REQ-TSK-007): the interval, an inclusive end date that is required but may be null for no end, and
// an optional church-local time for successors. There is no occurrence count; the strict object refuses one.
export const recurrenceFrequency = z.enum(["daily", "weekly", "biweekly", "monthly", "quarterly", "yearly"]);
export const recurrenceRule = z.strictObject({
	frequency: recurrenceFrequency,
	until: localDate.nullable(),
	localTime: z
		.string()
		.regex(/^([01]\d|2[0-3]):[0-5]\d$/)
		.nullable()
		.default(null),
});
export type RecurrenceRule = z.infer<typeof recurrenceRule>;
const months = { monthly: 1, quarterly: 3, yearly: 12 } as const;
const days = { daily: 1, weekly: 7, biweekly: 14 } as const;
/** One interval after `from`. A month or year step clamps to the last day of a shorter month: Jan 31 + 1 month = Feb 28. */
export function nextOccurrenceDate(from: z.infer<typeof localDate>, frequency: z.infer<typeof recurrenceFrequency>) {
	if (frequency in days) return addCivilDays(from, days[frequency as keyof typeof days]);
	const [y, m, d] = from.split("-").map(Number) as [number, number, number];
	const index = y * 12 + (m - 1) + months[frequency as keyof typeof months];
	const year = Math.floor(index / 12),
		month = (index % 12) + 1;
	const last = new Date(Date.UTC(year, month, 0)).getUTCDate();
	return localDate.parse(
		`${String(year).padStart(4, "0")}-${String(month).padStart(2, "0")}-${String(Math.min(d, last)).padStart(2, "0")}`,
	);
}

/**
 * Whether a task is overdue at asOf. A date-only task is due all through its church-local day and overdue from the
 * next local midnight, also on 23 and 25 hour days. A deadline is overdue once asOf is after it. Undated is unknown.
 */
export function overdueAt(value: Due, zone: TimeZone, asOf: Instant): boolean | null {
	if (value.kind === "undated") return null;
	if (value.kind === "resolved_instant") return asOf > value.instant;
	return asOf >= localDayBounds(value.date, zone).end;
}
/** A first-Vision follow-up is due two church-local calendar days after the meeting's local date. */
export const followUpDueDate = (meetingDate: z.infer<typeof localDate>) => addCivilDays(meetingDate, 2);
