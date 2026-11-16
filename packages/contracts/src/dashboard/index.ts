import { z } from "zod";
import { accountId, recordId, role, type Reply } from "../common/values.ts";
import { instant, localDate } from "../common/time.ts";
import { meetingType } from "../meetings/values.ts";
import { phaseNumber } from "../phases/index.ts";

export const SETUP_STEPS = ["add_people", "plan_vision_meeting", "invite_team", "set_launch_date"] as const;
export const setupStep = z.enum(SETUP_STEPS);
export type SetupStep = z.infer<typeof setupStep>;
export const setupGaps = z.strictObject({
	setupComplete: z.boolean(),
	gaps: z.array(setupStep),
});
export type SetupGaps = z.infer<typeof setupGaps>;

export const PROMPTS = ["import_people", "invite_team"] as const;
export const promptKey = z.enum(PROMPTS);
export type PromptKey = z.infer<typeof promptKey>;
export const PROMPT_STEP: Record<PromptKey, SetupStep> = { import_people: "add_people", invite_team: "invite_team" };
export const promptState = z.strictObject({ dismissed: z.array(promptKey) });
export type PromptState = z.infer<typeof promptState>;
export const dismissPromptRequest = z.strictObject({ prompt: promptKey });
export const dismissPromptResult = z.strictObject({ outcome: z.enum(["changed", "noop"]), prompt: promptKey });

export const QUICK_ACTIONS = ["add_person", "import_people", "plan_meeting"] as const;
export const quickAction = z.enum(QUICK_ACTIONS);
export type QuickAction = z.infer<typeof quickAction>;

export const overviewFrame = z.strictObject({
	plantName: z.string(),
	phase: phaseNumber,
	timeZone: z.string(),
	today: localDate,
	firstWeek: z.boolean(),
	role,
	actions: z.array(quickAction),
	setup: setupGaps,
	prompts: z.array(promptKey),
});
export type OverviewFrame = z.infer<typeof overviewFrame>;

export const metrics = z.strictObject({
	recruited: z.int().min(0),
	people: z.int().min(0),
	myOverdueTasks: z.int().min(0),
	visionMeetings: z.int().min(0),
});
export type Metrics = z.infer<typeof metrics>;

const person = z.strictObject({ accountId, displayName: z.string() });
export const launchDateEvent = z.enum(["scheduled", "moved", "postponed", "rescheduled"]);
const meeting = { meetingId: recordId, title: z.string().nullable(), meetingType };
export const change = z.discriminatedUnion("kind", [
	z.strictObject({ kind: z.literal("person_added"), personId: recordId, name: z.string() }),
	z.strictObject({ kind: z.literal("meeting_held"), ...meeting }),
	z.strictObject({ kind: z.literal("attendance_corrected"), ...meeting }),
	z.strictObject({ kind: z.literal("task_completed"), taskId: recordId, title: z.string() }),
	z.strictObject({ kind: z.literal("launch_date"), event: launchDateEvent, date: localDate.nullable() }),
	z.strictObject({ kind: z.literal("launch_recorded"), date: localDate.nullable() }),
	z.strictObject({ kind: z.literal("phase_changed"), phase: phaseNumber }),
]);
export type Change = z.infer<typeof change>;
export const activityEntry = z.strictObject({
	id: recordId,
	at: instant,
	actor: person.nullable(),
	change,
});
export type ActivityEntry = z.infer<typeof activityEntry>;
export const ACTIVITY_LIMIT = 20;
export const activity = z.strictObject({
	timeZone: z.string(),
	entries: z.array(activityEntry).max(ACTIVITY_LIMIT),
	more: z.boolean(),
});
export type Activity = z.infer<typeof activity>;

export const dashboardError = z.strictObject({ code: z.enum(["access_denied", "invalid_input"]) });
export type DashboardError = z.infer<typeof dashboardError>;
export type DashboardReply<T> = Reply<T, DashboardError>;
