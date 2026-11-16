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
import { MAX_DESCRIPTION, normalizeDescription } from "./description.ts";

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
export const ownerReason = z.enum(["no_seat", "no_person", "not_committed"]);
export const MAX_ASSIGNEES = 10;
export const assigneeIds = z
	.array(accountId)
	.max(100)
	.transform((ids) => [...new Set(ids)])
	.refine((ids) => ids.length <= MAX_ASSIGNEES, "too_many_assignees");
export const followUpOwner = z.strictObject({
	accountId,
	displayName: z.string(),
	eligible: z.boolean(),
	reason: ownerReason.nullable(),
});
export type FollowUpOwner = z.infer<typeof followUpOwner>;
export const followUpOrigin = z.discriminatedUnion("kind", [
	z.strictObject({ kind: z.literal("meeting"), meeting: z.strictObject({ id: recordId, label: z.string() }) }),
	z.strictObject({ kind: z.literal("added"), by: z.string().nullable() }),
]);
export type FollowUpOrigin = z.infer<typeof followUpOrigin>;
export const obligationKind = z.enum(["first_vision_follow_up", "meeting_evaluation"]);
export const title = z.string().trim().min(1).max(500);
export const description = z
	.string()
	.max(4 * MAX_DESCRIPTION)
	.transform(normalizeDescription)
	.pipe(z.string().max(MAX_DESCRIPTION));

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
export const relation = z.discriminatedUnion("kind", [
	z.strictObject({ kind: z.literal("person"), id: recordId }),
	z.strictObject({ kind: z.literal("meeting"), id: recordId }),
	z.strictObject({ kind: z.literal("team"), id: recordId }),
]);

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

export function overdueAt(value: Due, zone: TimeZone, asOf: Instant): boolean | null {
	if (value.kind === "undated") return null;
	if (value.kind === "resolved_instant") return asOf > value.instant;
	return asOf >= localDayBounds(value.date, zone).end;
}
export const followUpDueDate = (meetingDate: z.infer<typeof localDate>) => addCivilDays(meetingDate, 2);
