import {
	PROMPT_STEP,
	PROMPTS,
	SETUP_STEPS,
	type ActivityEntry,
	type DashboardReply,
	type OverviewFrame,
	type PromptKey,
	type SetupStep,
} from "@everyfield/contracts/dashboard";
import { dashboardReader } from "@everyfield/domain/dashboard";
import { z } from "zod";
import type { ReadAdapter, SourceResult, SourceRow } from "../../../catalog/types.ts";
import { localWhen, phaseText, TYPE_LABEL } from "../../../catalog/labels.ts";
import { plantSeat } from "../../native.ts";

const STEP: Record<SetupStep, { title: string; action: string; href: string }> = {
	add_people: { title: "Add the people you already know", action: "Import", href: "/people/import" },
	plan_vision_meeting: { title: "Plan your first Vision Meeting", action: "Plan", href: "/meetings" },
	invite_team: { title: "Invite your spouse or co-leader", action: "Invite", href: "/settings/seats" },
	set_launch_date: { title: "Set Launch Sunday", action: "Set date", href: "/launch" },
};
const PROMPT_TITLE: Record<PromptKey, string> = {
	import_people: "Import your people",
	invite_team: "Invite your team",
};
const PROMPT_OF = Object.fromEntries(PROMPTS.map((p) => [PROMPT_STEP[p], p])) as Partial<Record<SetupStep, PromptKey>>;
const METRIC = {
	recruited: { label: "Recruited", href: "/people?stage=core_group&stage=launch_team&stage=leader" },
	people: { label: "People", href: "/people" },
	myOverdueTasks: { label: "My overdue tasks", href: "/tasks?view=my" },
	visionMeetings: { label: "Vision Meetings", href: "/meetings?type=vision_meeting&status=completed" },
} as const;

const result = (operation: string, rows: SourceRow[], facts: SourceResult["facts"], partial = false): SourceResult => ({
	operation,
	status: "available",
	rows,
	total: rows.length,
	page: 1,
	next: null,
	completeness: partial ? "partial" : "complete",
	exclusions: [],
	facts,
});
const denied = (operation: string): SourceResult => ({
	operation,
	status: "not_found",
	rows: [],
	total: 0,
	page: 1,
	next: null,
	completeness: "complete",
	exclusions: ["You no longer have access to this church's Overview."],
});
const valueOf = <T>(reply: DashboardReply<T>) => (reply.status === "ok" ? reply.value : null);

function nextSteps(frame: OverviewFrame, plantId: string): SourceRow[] {
	if (frame.role === "member") return [];
	const shown = SETUP_STEPS.filter((s) => {
		const p = PROMPT_OF[s];
		if (!frame.firstWeek) return p !== undefined && frame.prompts.includes(p);
		return frame.setup.gaps.includes(s) && (p === undefined || frame.prompts.includes(p));
	});
	return shown.map((s) => ({
		kind: "step",
		id: `${plantId}:${s}`,
		label: !frame.firstWeek && PROMPT_OF[s] ? PROMPT_TITLE[PROMPT_OF[s]] : STEP[s].title,
		fields: { status: "open", source: "Overview", action: STEP[s].action, href: STEP[s].href },
	}));
}

function entryRow(e: ActivityEntry, zone: string, self: string | null): SourceRow {
	const c = e.change;
	const meeting = (m: { title: string | null; meetingType: string }) => m.title || TYPE_LABEL[m.meetingType];
	const day = (d: string | null) =>
		d
			? new Intl.DateTimeFormat("en-US", { timeZone: "UTC", month: "short", day: "numeric" }).format(
					new Date(`${d}T12:00:00Z`),
				)
			: null;
	const [label, href, personId] = ((): [string, string, string | null] => {
		switch (c.kind) {
			case "person_added":
				return [`${c.name} added to People`, `/people/${c.personId}`, c.personId];
			case "meeting_held":
				return [`${meeting(c)} held`, `/meetings/${c.meetingId}`, null];
			case "attendance_corrected":
				return [`Attendance corrected for ${meeting(c)}`, `/meetings/${c.meetingId}`, null];
			case "task_completed":
				return [`${c.title} completed`, `/tasks?task=${c.taskId}`, null];
			case "launch_date": {
				const on = day(c.date);
				const text = {
					scheduled: on ? `Launch Sunday set for ${on}` : "Launch Sunday set",
					moved: on ? `Launch Sunday moved to ${on}` : "Launch Sunday moved",
					rescheduled: on ? `Launch Sunday set again for ${on}` : "Launch Sunday set again",
					postponed: "Launch Sunday postponed",
				}[c.event];
				return [text, "/launch", null];
			}
			case "launch_recorded":
				return [c.date ? `Launch Sunday recorded as held ${day(c.date)}` : "Launch Sunday recorded", "/launch", null];
			case "phase_changed":
				return [`Phase saved as ${phaseText(c.phase)}`, "/intelligence", null];
		}
	})();
	return {
		kind: "activity",
		id: e.id,
		label,
		fields: {
			change: c.kind,
			date: new Intl.DateTimeFormat("en-CA", { timeZone: zone }).format(new Date(e.at)),
			when: localWhen(e.at, zone),
			by: e.actor?.displayName ?? "Everyfield",
			personId,
			href,
			...(personId !== null && personId === self ? { you: true } : {}),
		},
	};
}

const none = z.strictObject({});
type None = z.infer<typeof none>;

export const DASHBOARD_READS = [
	{
		operation: "dashboard.availableActions",
		description:
			"This church's Overview as the user's seat sees it now: the next steps Overview offers them (each with its link), the church's phase and church-local today. A Member is offered no next step: Owners and Admins take them",
		input: none,
		allowed: plantSeat,
		async invoke(tx, actor): Promise<SourceResult> {
			const frame = valueOf(await dashboardReader.readAvailableActions(tx, actor.authority));
			if (!frame) return denied("dashboard.availableActions");
			return result("dashboard.availableActions", nextSteps(frame, actor.owner.id), {
				church: frame.plantName,
				phase: phaseText(frame.phase),
				today: frame.today,
				firstWeek: frame.firstWeek,
				role: frame.role,
				setupDone: `${SETUP_STEPS.length - frame.setup.gaps.length} of ${SETUP_STEPS.length}`,
			});
		},
	} satisfies ReadAdapter<None>,
	{
		operation: "dashboard.metrics",
		description:
			"Overview's four counts: Recruited, People, the user's own overdue tasks and Vision Meetings held, each with the list it opens. Counts only, never a target",
		input: none,
		allowed: plantSeat,
		async invoke(tx, actor): Promise<SourceResult> {
			const metrics = valueOf(await dashboardReader.readMetrics(tx, actor.authority));
			if (!metrics) return denied("dashboard.metrics");
			const rows = (Object.keys(METRIC) as (keyof typeof METRIC)[]).map((key): SourceRow => ({
				kind: "item",
				id: key,
				label: METRIC[key].label,
				fields: { count: metrics[key], href: METRIC[key].href },
			}));
			return result("dashboard.metrics", rows, { ...metrics });
		},
	} satisfies ReadAdapter<None>,
	{
		operation: "dashboard.activity",
		description:
			"Overview's Recent changes: the 20 latest changes the user can open, newest first, each with its church-local date and who made it (a person added to People, a meeting held, a task completed, Launch Sunday changes). more: true says older changes exist that this read does not return",
		input: none,
		allowed: plantSeat,
		async invoke(tx, actor): Promise<SourceResult> {
			const activity = valueOf(await dashboardReader.readActivity(tx, actor.authority));
			if (!activity) return denied("dashboard.activity");
			const rows = activity.entries.map((e) => entryRow(e, activity.timeZone, actor.selfPersonId));
			return result("dashboard.activity", rows, { timeZone: activity.timeZone, more: activity.more }, activity.more);
		},
	} satisfies ReadAdapter<None>,
	{
		operation: "dashboard.readSetupGaps",
		description:
			"The first-week setup steps this church still has open, as Overview lists them, each with its link for an Owner or Admin, and whether setup is saved complete",
		input: none,
		allowed: plantSeat,
		async invoke(tx, actor): Promise<SourceResult> {
			const setup = valueOf(await dashboardReader.readSetupGaps(tx, actor.authority));
			if (!setup) return denied("dashboard.readSetupGaps");
			const admin = actor.role === "owner" || actor.role === "admin";
			const rows = setup.gaps.map((s): SourceRow => ({
				kind: "step",
				id: `${actor.owner.id}:${s}`,
				label: STEP[s].title,
				fields: { status: "open", source: "Overview", href: admin ? STEP[s].href : null },
			}));
			return result("dashboard.readSetupGaps", rows, { setupComplete: setup.setupComplete });
		},
	} satisfies ReadAdapter<None>,
] as const;
