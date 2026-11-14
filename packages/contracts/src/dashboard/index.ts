import { z } from "zod";
import { accountId, recordId, role, type Reply } from "../common/values.ts";
import { instant, localDate } from "../common/time.ts";
import { meetingType } from "../meetings/values.ts";
import { phaseNumber } from "../phases/index.ts";

// The Overview contract (WP-048: ADM-004 and ADM-005). Overview reads what the church recorded and never certifies a
// threshold: a number here is a count, never "met" or a target (REQ-ADM-005).

/**
 * The first-week steps a new church works through. Each is decided from what the church recorded, never from a
 * dismissal. `invite_team` counts the church's seats and open invitations.
 */
export const SETUP_STEPS = ["add_people", "plan_vision_meeting", "invite_team", "set_launch_date"] as const;
export const setupStep = z.enum(SETUP_STEPS);
export type SetupStep = z.infer<typeof setupStep>;
export const setupGaps = z.strictObject({
	/** plant.onboarding_completed_at is set. */
	setupComplete: z.boolean(),
	/** The steps still open, in SETUP_STEPS order. */
	gaps: z.array(setupStep),
});
export type SetupGaps = z.infer<typeof setupGaps>;

/**
 * The optional prompts Overview may show. A person may dismiss one for themselves in this church; that hides the
 * prompt and changes nothing else (REQ-ADM-005).
 */
export const PROMPTS = ["import_people", "invite_team"] as const;
export const promptKey = z.enum(PROMPTS);
export type PromptKey = z.infer<typeof promptKey>;
export const promptState = z.strictObject({ dismissed: z.array(promptKey) });
export type PromptState = z.infer<typeof promptState>;
export const dismissPromptRequest = z.strictObject({ prompt: promptKey });
export const dismissPromptResult = z.strictObject({ outcome: z.enum(["changed", "noop"]), prompt: promptKey });

/**
 * The quick actions a seat can use now: Owner and Admin write capability, read from the live seat. Setting Launch Sunday
 * is the launch card's own link.
 */
export const QUICK_ACTIONS = ["add_person", "import_people", "plan_meeting"] as const;
export const quickAction = z.enum(QUICK_ACTIONS);
export type QuickAction = z.infer<typeof quickAction>;

/**
 * dashboard.availableActions (ADM-005): the church as this seat sees it now. The phase is the saved one. `firstWeek` is
 * true through the church's first seven church-local days. `prompts` are the optional prompts this seat may act on that
 * still apply and that this person has not dismissed.
 */
export const overviewFrame = z.strictObject({
	plantName: z.string(),
	phase: phaseNumber,
	timeZone: z.string(),
	today: localDate,
	/** The church-local day the church was created; null when no creation is recorded. */
	createdOn: localDate.nullable(),
	firstWeek: z.boolean(),
	role,
	actions: z.array(quickAction),
	setup: setupGaps,
	prompts: z.array(promptKey),
});
export type OverviewFrame = z.infer<typeof overviewFrame>;

/**
 * dashboard.metrics (ADM-005): four independent counts. Recruited is live People in core group, launch team or leader,
 * except People linked to an account with a current seat in this church. People is every live Person. My overdue tasks
 * are the viewer's own open, overdue top-level tasks. Vision Meetings are the ones held and not voided.
 */
export const metrics = z.strictObject({
	recruited: z.int().min(0),
	people: z.int().min(0),
	myOverdueTasks: z.int().min(0),
	visionMeetings: z.int().min(0),
});
export type Metrics = z.infer<typeof metrics>;

const person = z.strictObject({ accountId, displayName: z.string() });
/** How Launch Sunday's date changed: set, moved, cleared (postponed) or set again after a postponement. */
export const launchDateEvent = z.enum(["scheduled", "moved", "postponed", "rescheduled"]);
const meeting = { meetingId: recordId, title: z.string().nullable(), meetingType };
/** What one activity entry says happened, and the item it opens. */
export const change = z.discriminatedUnion("kind", [
	z.strictObject({ kind: z.literal("person_added"), personId: recordId, name: z.string() }),
	z.strictObject({ kind: z.literal("meeting_held"), ...meeting }),
	/** Attendance on a held meeting was corrected: the same meeting, never a new one. */
	z.strictObject({ kind: z.literal("attendance_corrected"), ...meeting }),
	z.strictObject({ kind: z.literal("task_completed"), taskId: recordId, title: z.string() }),
	z.strictObject({ kind: z.literal("launch_date"), event: launchDateEvent, date: localDate.nullable() }),
	z.strictObject({ kind: z.literal("launch_recorded"), date: localDate.nullable() }),
	/** Owners and Admins only: the phase journey is theirs to open. */
	z.strictObject({ kind: z.literal("phase_changed"), phase: phaseNumber }),
]);
export type Change = z.infer<typeof change>;
export const activityEntry = z.strictObject({
	id: recordId,
	at: instant,
	/** Who did it; null for a change the system made or an account that no longer exists. */
	actor: person.nullable(),
	change,
});
export type ActivityEntry = z.infer<typeof activityEntry>;
export const ACTIVITY_LIMIT = 20;
/** dashboard.activity (ADM-005): the latest changes the viewer can open, newest first. `more` says older ones exist. */
export const activity = z.strictObject({
	timeZone: z.string(),
	entries: z.array(activityEntry).max(ACTIVITY_LIMIT),
	more: z.boolean(),
});
export type Activity = z.infer<typeof activity>;

export const dashboardError = z.strictObject({ code: z.enum(["access_denied", "invalid_input"]) });
export type DashboardError = z.infer<typeof dashboardError>;
export type DashboardReply<T> = Reply<T, DashboardError>;
