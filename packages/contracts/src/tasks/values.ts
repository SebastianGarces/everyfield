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
import { recordId } from "../common/values.ts";

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
