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

export * from "./outcome.ts";

// The Launch plan contract (WP-045: LCH-001, 003, 004, 005, 008, 009, IDN-015, NTF-009; WP-046 adds outcome.ts). The planned Launch Sunday is a
// church-local date; the nine Playbook milestones and their 23 prep tasks are fixed content. Requests are strict, so a
// caller never names a plant, an actor or a status.

export const NOTE_MAX = 2000;
/** REQ-KNOW-034: 0 to 28 church-local days away is inside the launch window. */
export const LAUNCH_WINDOW_DAYS = 28;
/** The "Three pre-launch services held" evidence counts this many held practices. */
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

/** Why a note was refused, so the dialog can say it next to the field. */
export const noteProblem = z.enum(["empty", "too_long"]);
export type NoteProblem = z.infer<typeof noteProblem>;
/** The trimmed note (null when blank and optional), or the problem with it. */
export function checkNote(
	raw: string | null,
	required: boolean,
): { ok: true; note: string | null } | { ok: false; problem: NoteProblem } {
	const note = (raw ?? "").trim();
	if (!note) return required ? { ok: false, problem: "empty" } : { ok: true, note: null };
	if (note.length > NOTE_MAX) return { ok: false, problem: "too_long" };
	return { ok: true, note };
}

/** Whole civil days from `from` to `to`; negative when `to` is earlier. */
function civilDaysBetween(from: LocalDate, to: LocalDate): number {
	return Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000);
}

/**
 * LCH-008: the one countdown, from the church-local date today. No date is unknown (none); a postponed plan has no
 * countdown; a past date with no recorded launch is overdue, never launched.
 */
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

/**
 * The linked-task view a milestone completion was reviewed against (LCH-004): which live tasks the milestone has and
 * the revision of each. The page computes it from the tasks it shows; the server from the tasks it locks.
 */
export const reviewedOf = (tasks: readonly { id: string; revision: string }[]) =>
	tasks
		.map((t) => `${t.id}@${t.revision}`)
		.sort()
		.join(",");

const envelope = { requestKey, expectedRevision: revision };
/** Set, move or recommit Launch Sunday. A move away from a scheduled date needs a reason (checkNote). */
export const scheduleRequest = z.strictObject({
	...envelope,
	input: z.strictObject({ date: localDate, reason: z.string().nullable() }),
});
export const postponeRequest = z.strictObject({ ...envelope, input: z.strictObject({ reason: z.string() }) });
/**
 * A milestone a person completes or reopens. The two evidence-governed milestones are named by key so the server can
 * refuse them as derived (LCH-004): only a submitted debrief decides them.
 */
const milestoneRef = z.union([recordId, derivedMilestone]);
/** Complete a milestone as reviewed: `reviewed` is reviewedOf the tasks the page showed (LCH-004). */
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
	/** The person's completion. It stays listed while the milestone needs review. */
	completion: z.strictObject({ at: instant, by: person.nullable() }).nullable(),
	/** A task that was complete at completion has since been reopened. */
	needsReview: z.boolean(),
	tasks: z.array(prepTask),
	/** Held pre-launch practices, for "Three pre-launch services held" only. */
	practices: z.strictObject({ held: z.int().min(0), required: z.literal(PRACTICES_REQUIRED) }).nullable(),
});
export type Milestone = z.infer<typeof milestone>;
export const plan = z.strictObject({
	/** The church-local date today, from the church's time zone. */
	today: localDate,
	timeZone: z.string(),
	launch: z.strictObject({ status: launchStatus, targetDate: localDate.nullable(), revision }).nullable(),
	/** The revision a first schedule expects while the church has no launch row. */
	revision,
	milestones: z.array(milestone),
	/** What actually happened on Launch Sunday; null until someone records it, whatever the planned date says. */
	outcome: outcome.nullable(),
	guests,
	/** guest_data_entered and debrief_done, from the latest submitted debrief. */
	evidence,
	/** The debrief and summary, for Owners and Admins; null for a Member. */
	debrief: debrief.nullable(),
	summary: summary.nullable(),
});
export type Plan = z.infer<typeof plan>;

export const scheduleResult = z.strictObject({ outcome: z.enum(["changed", "noop"]), plan });
/** Every outcome, guest, debrief and summary write answers with the plan as saved. */
export const planResult = scheduleResult;
export type PlanResult = z.infer<typeof planResult>;
export const milestoneResult = z.strictObject({ outcome: z.enum(["changed", "noop"]), milestone });

export const launchError = z.discriminatedUnion("code", [
	defineSafeError("invalid_input", {}, "never"),
	defineSafeError("invalid_reason", { problem: noteProblem }, "never"),
	defineSafeError("access_denied", {}, "never"),
	defineSafeError("idempotency_conflict", {}, "never"),
	defineSafeError("conflict", {}, "refresh"),
	/** The milestone's linked tasks changed since the page was read: the current tasks, to review and confirm again. */
	defineSafeError("stale_review", { milestone }, "refresh"),
	defineSafeError("invalid_outcome", { problem: outcomeProblem }, "never"),
	defineSafeError("invalid_debrief", { problem: debriefProblem }, "never"),
	defineSafeError("invalid_summary", { problem: summaryProblem }, "never"),
	/** Guests and the debrief need a recorded Launch Sunday; the summary needs a submitted debrief. */
	defineSafeError("not_ready", { needs: z.enum(["outcome", "debrief"]) }, "refresh"),
	/** guest_data_entered and debrief_done have no manual checkbox (LCH-004). */
	defineSafeError("derived_evidence_only", {}, "never"),
]);
export type LaunchError = z.infer<typeof launchError>;
export type LaunchReply<T> = Reply<T, LaunchError>;
