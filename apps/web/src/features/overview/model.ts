import type { ActivityEntry, PromptKey, SetupStep } from "@everyfield/contracts/dashboard";
import { countdown, type Plan } from "@everyfield/contracts/launch";
import { TYPE_LABEL } from "../meetings/model.ts";
import { SHORT_NAME } from "../phases/model.ts";

// Overview's pure model: words, links and dates. No React and no server code.

/** A card's read: its value, a refusal (the seat lost access) or lost (no answer came back). Never a made-up zero. */
export type Loaded<T> = { status: "ok"; value: T } | { status: "denied" } | { status: "lost" };

export const phaseText = (phase: number) => `Phase ${phase} · ${SHORT_NAME[phase] ?? ""}`;

/** Each count's card: what it counts and the list it opens. */
export const METRICS = [
	{
		key: "recruited",
		label: "Recruited",
		detail: "Core group, launch team and leaders, not counting your team's own logins",
		href: "/people?stage=core_group&stage=launch_team&stage=leader",
	},
	{ key: "people", label: "People", detail: "Everyone in People", href: "/people" },
	{ key: "myOverdueTasks", label: "My overdue tasks", detail: "Assigned to you and past due", href: "/tasks?view=my" },
	{
		key: "visionMeetings",
		label: "Vision Meetings",
		detail: "Held so far",
		href: "/meetings?type=vision_meeting&status=completed",
	},
] as const;

/** The first-week steps as the checklist says them. `action` is what an Owner or Admin can do about an open step. */
export const STEP_TEXT: Record<SetupStep, { title: string; detail: string; action: { label: string; href: string } }> =
	{
		add_people: {
			title: "Add the people you already know",
			detail: "Import a spreadsheet or add them one by one.",
			action: { label: "Import", href: "/people/import" },
		},
		plan_vision_meeting: {
			title: "Plan your first Vision Meeting",
			detail: "Pick a date, a place and who to invite.",
			action: { label: "Plan", href: "/meetings" },
		},
		invite_team: {
			title: "Invite your spouse or co-leader",
			detail: "Seats are free for your planting team.",
			action: { label: "Invite", href: "/settings/seats" },
		},
		set_launch_date: {
			title: "Set Launch Sunday",
			detail: "It starts the countdown and the readiness milestones.",
			action: { label: "Set date", href: "/launch" },
		},
	};
/** The optional prompt each step may show outside the first week. */
export const PROMPT_TEXT: Record<PromptKey, { title: string }> = {
	import_people: { title: "Import your people" },
	invite_team: { title: "Invite your team" },
};

const at = (date: string) => new Date(`${date}T12:00:00Z`);
const shortDate = (date: string) =>
	new Intl.DateTimeFormat("en-US", { timeZone: "UTC", month: "short", day: "numeric" }).format(at(date));
/** "Oct 12, 4:05 PM" in the church's time zone. */
export const churchTime = (instant: string, timeZone: string) =>
	new Intl.DateTimeFormat("en-US", {
		timeZone,
		month: "short",
		day: "numeric",
		hour: "numeric",
		minute: "2-digit",
	}).format(new Date(instant));

/** What the launch card shows: a held launch, a countdown, or the state that stands in for one. */
export type LaunchShown =
	| { kind: "held"; date: string; attendance: number | null }
	| { kind: "ahead"; days: number; date: string }
	| { kind: "today"; date: string }
	| { kind: "overdue"; date: string }
	| { kind: "postponed" }
	| { kind: "none" };
export function launchShown(plan: Plan): LaunchShown {
	if (plan.outcome) return { kind: "held", date: plan.outcome.actualDate, attendance: plan.outcome.attendance };
	const c = countdown(plan.launch, plan.today);
	const date = plan.launch?.targetDate ?? "";
	if (c.kind === "ahead") return { kind: "ahead", days: c.days, date };
	if (c.kind === "today" || c.kind === "overdue") return { kind: c.kind, date };
	return { kind: c.kind === "postponed" ? "postponed" : "none" };
}
export const daysText = (days: number) => `${days} ${days === 1 ? "day" : "days"}`;

/** One activity entry in words, with the item it opens. */
export function entryText(e: ActivityEntry): { title: string; href: string } {
	const c = e.change;
	switch (c.kind) {
		case "person_added":
			return { title: `${c.name} added to People`, href: `/people/${c.personId}` };
		case "meeting_held":
			return { title: `${c.title || TYPE_LABEL[c.meetingType]} held`, href: `/meetings/${c.meetingId}` };
		case "attendance_corrected":
			return {
				title: `Attendance corrected for ${c.title || TYPE_LABEL[c.meetingType]}`,
				href: `/meetings/${c.meetingId}`,
			};
		case "task_completed":
			return { title: `${c.title} completed`, href: `/tasks?task=${c.taskId}` };
		case "launch_date": {
			const day = c.date ? shortDate(c.date) : null;
			const title = {
				scheduled: day ? `Launch Sunday set for ${day}` : "Launch Sunday set",
				moved: day ? `Launch Sunday moved to ${day}` : "Launch Sunday moved",
				rescheduled: day ? `Launch Sunday set again for ${day}` : "Launch Sunday set again",
				postponed: "Launch Sunday postponed",
			}[c.event];
			return { title, href: "/launch" };
		}
		case "launch_recorded":
			return {
				title: c.date ? `Launch Sunday recorded as held ${shortDate(c.date)}` : "Launch Sunday recorded",
				href: "/launch",
			};
		case "phase_changed":
			return { title: `Phase saved as ${phaseText(c.phase)}`, href: "/intelligence" };
	}
}
/** Who made the change and when, in church-local time. */
export const entryByline = (e: ActivityEntry, timeZone: string) =>
	`${e.actor?.displayName ?? "Everyfield"} · ${churchTime(e.at, timeZone)}`;
