import { z } from "zod";
import { accountId, defineSafeError, recordId, requestKey, revision, type Reply } from "../common/values.ts";
import { instant, localDate, type LocalDate } from "../common/time.ts";
import {
	debrief,
	debriefProblem,
	derivedMilestone,
	evidence,
	guests,
	outcome,
	outcomeProblem,
	summary,
	summaryProblem,
} from "./outcome.ts";
import { preparation } from "../oversight/health.ts";
import { gatheringPath, gatheringProblem } from "./gathering.ts";

export * from "./gathering.ts";
export * from "./outcome.ts";

export const NOTE_MAX = 2000;
export const LAUNCH_WINDOW_DAYS = 28;
export const PRACTICES_REQUIRED = 3;
export const PRACTICE_MILESTONE = "launch_team.pre_launch_services";

export const launchStatus = z.enum(["planning", "scheduled", "postponed", "completed"]);
export type LaunchStatus = z.infer<typeof launchStatus>;
export const area = z.enum(["operations", "launch_team", "promotion"]);
export type Area = z.infer<typeof area>;
export const AREA_LABEL: Record<Area, string> = {
	operations: "Operations",
	launch_team: "Launch team",
	promotion: "Promotion",
};

export const noteProblem = z.enum(["empty", "too_long"]);
export type NoteProblem = z.infer<typeof noteProblem>;
export function checkNote(
	raw: string | null,
	required: boolean,
): { ok: true; note: string | null } | { ok: false; problem: NoteProblem } {
	const note = (raw ?? "").trim();
	if (!note) return required ? { ok: false, problem: "empty" } : { ok: true, note: null };
	if (note.length > NOTE_MAX) return { ok: false, problem: "too_long" };
	return { ok: true, note };
}

function civilDaysBetween(from: LocalDate, to: LocalDate): number {
	return Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000);
}

export type Countdown =
	| { kind: "none" }
	| { kind: "postponed" }
	| { kind: "completed" }
	| { kind: "today"; window: true }
	| { kind: "ahead"; days: number; window: boolean }
	| { kind: "overdue"; days: number };
export function countdown(launch: { status: LaunchStatus; targetDate: LocalDate | null } | null, today: LocalDate) {
	if (!launch) return { kind: "none" } satisfies Countdown;
	if (launch.status === "completed") return { kind: "completed" } satisfies Countdown;
	if (launch.status === "postponed") return { kind: "postponed" } satisfies Countdown;
	if (!launch.targetDate) return { kind: "none" } satisfies Countdown;
	const days = civilDaysBetween(today, launch.targetDate);
	if (days === 0) return { kind: "today", window: true } satisfies Countdown;
	if (days < 0) return { kind: "overdue", days: -days } satisfies Countdown;
	return { kind: "ahead", days, window: days <= LAUNCH_WINDOW_DAYS } satisfies Countdown;
}
export function launchSundayArrived(
	launch: { status: LaunchStatus; targetDate: LocalDate | null } | null,
	today: LocalDate,
): boolean {
	const kind = countdown(launch, today).kind;
	return launch?.status === "scheduled" && (kind === "today" || kind === "overdue");
}

export const reviewedOf = (tasks: readonly { id: string; revision: string }[]) =>
	tasks
		.map((t) => `${t.id}@${t.revision}`)
		.sort()
		.join(",");

const envelope = { requestKey, expectedRevision: revision };
export const scheduleRequest = z.strictObject({
	...envelope,
	input: z.strictObject({ date: localDate, reason: z.string().nullable() }),
});
export const postponeRequest = z.strictObject({ ...envelope, input: z.strictObject({ reason: z.string() }) });
const milestoneRef = z.union([recordId, derivedMilestone]);
export const completeMilestoneRequest = z.strictObject({
	...envelope,
	input: z.strictObject({ milestoneId: milestoneRef, reviewed: z.string().max(2000) }),
});
export const reopenMilestoneRequest = z.strictObject({
	...envelope,
	input: z.strictObject({ milestoneId: milestoneRef }),
});

const person = z.strictObject({ accountId, displayName: z.string() });
export const prepTask = z.strictObject({
	id: recordId,
	title: z.string(),
	status: z.enum(["not_started", "in_progress", "blocked", "complete", "no_longer_needed"]),
	revision,
	dueDate: localDate.nullable(),
	assignees: z.array(person),
});
export type PrepTask = z.infer<typeof prepTask>;
export const milestone = z.strictObject({
	id: recordId,
	templateKey: z.string(),
	area,
	title: z.string(),
	description: z.string().nullable(),
	revision,
	completion: z.strictObject({ at: instant, by: person.nullable() }).nullable(),
	needsReview: z.boolean(),
	tasks: z.array(prepTask),
	practices: z.strictObject({ held: z.int().min(0), required: z.literal(PRACTICES_REQUIRED) }).nullable(),
});
export type Milestone = z.infer<typeof milestone>;
export const plan = z.strictObject({
	today: localDate,
	timeZone: z.string(),
	launch: z.strictObject({ status: launchStatus, targetDate: localDate.nullable(), revision }).nullable(),
	path: gatheringPath,
	revision,
	milestones: z.array(milestone),
	outcome: outcome.nullable(),
	guests,
	evidence,
	debrief: debrief.nullable(),
	summary: summary.nullable(),
	preparation,
});
export type Plan = z.infer<typeof plan>;

export const scheduleResult = z.strictObject({ outcome: z.enum(["changed", "noop"]), plan });
export const planResult = scheduleResult;
export type PlanResult = z.infer<typeof planResult>;
export const milestoneResult = z.strictObject({ outcome: z.enum(["changed", "noop"]), milestone });

export const launchError = z.discriminatedUnion("code", [
	defineSafeError("invalid_input", {}, "never"),
	defineSafeError("invalid_reason", { problem: noteProblem }, "never"),
	defineSafeError("access_denied", {}, "never"),
	defineSafeError("idempotency_conflict", {}, "never"),
	defineSafeError("conflict", {}, "refresh"),
	defineSafeError("stale_review", { milestone }, "refresh"),
	defineSafeError("invalid_outcome", { problem: outcomeProblem }, "never"),
	defineSafeError("invalid_debrief", { problem: debriefProblem }, "never"),
	defineSafeError("invalid_summary", { problem: summaryProblem }, "never"),
	defineSafeError("not_ready", { needs: z.enum(["launch_sunday", "outcome", "debrief"]) }, "refresh"),
	defineSafeError("derived_evidence_only", {}, "never"),
	defineSafeError("invalid_gathering", { problem: gatheringProblem }, "never"),
	defineSafeError("gathering_unavailable", {}, "refresh"),
	defineSafeError("gathering_reached", {}, "refresh"),
]);
export type LaunchError = z.infer<typeof launchError>;
export type LaunchReply<T> = Reply<T, LaunchError>;
