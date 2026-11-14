import { localDate } from "@everyfield/contracts/common";
import { countdown, GUEST_NAME_MAX, type History, type Milestone, type Plan } from "@everyfield/contracts/launch";
import type { Transaction } from "@everyfield/db/client";
import { createLaunchReader } from "@everyfield/domain/launch";
import { z } from "zod";
import type { ReadAdapter, SourceResult, SourceRow } from "../../../catalog/types.ts";
import type { EvryActor } from "../../../context/actor.ts";
import { EvryRefusal } from "../../../context/errors.ts";
import { plantAdmin, plantSeat } from "../../native.ts";

// The Launch plan as Evry reads it (WP-075): the same domain reads the Launch plan page makes (WP-045, WP-046), under
// the asker's live seat. The countdown is the plan's own, from the church-local date the read returns; Evry never
// computes one from a date it guessed. A milestone's progress and overdue tasks come from its own linked prep tasks
// only (INH-LAUNCH-02). History says what changed, who changed it and when, never how readiness stood at a time
// (INH-LAUNCH-03). Nothing here completes a milestone, names a guest or changes anything: only an approved card or the
// Launch plan does. A guest name's matches are only offered (LCH-007). Debrief answers and the outcome note are the
// planter's own words: they stay on the Launch plan.

const reader = createLaunchReader();
const dayFormat = new Intl.DateTimeFormat("en-US", {
	weekday: "short",
	month: "short",
	day: "numeric",
	year: "numeric",
	timeZone: "UTC",
});
/** A church-local date (YYYY-MM-DD) as the Launch plan says it: "Tue, Nov 10, 2026". */
export const launchDay = (day: string) => dayFormat.format(new Date(`${day}T12:00:00Z`));

/** The plan could not be read: the answer says so, never that the church has no launch. */
const UNLOADED = "the Launch plan, which couldn't be loaded";
function unloaded(operation: string): SourceResult {
	return {
		operation,
		status: "not_found",
		rows: [],
		total: null,
		page: 1,
		next: null,
		completeness: "partial",
		exclusions: [UNLOADED],
		facts: { loaded: false },
	};
}

/**
 * One Launch read in its own savepoint, so a failed statement leaves the read's transaction usable and the answer says
 * the plan couldn't be loaded. A native refusal reads as no tenant data: the seat no longer reads this plan.
 */
async function loaded<T>(
	tx: Transaction,
	read: (t: Transaction) => Promise<{ status: "ok"; value: T } | { status: "refused" }>,
): Promise<T | null> {
	let reply: Awaited<ReturnType<typeof read>>;
	try {
		reply = await tx.transaction(read);
	} catch {
		return null;
	}
	if (reply.status !== "ok") throw new EvryRefusal("access_denied");
	return reply.value;
}
const planOf = (tx: Transaction, actor: EvryActor) =>
	loaded(tx, async (t) => {
		const r = await reader.readPlan(t, actor.authority);
		return r.status === "ok" ? { status: "ok" as const, value: r.value.plan } : r;
	});

const STATUS_TEXT = { planning: "No date set", scheduled: "Scheduled", postponed: "Postponed", completed: "Launched" };
/** The plan's date facts: the church-local date today, the planned date and the Launch plan's own countdown. */
function dateFacts(plan: Plan) {
	const c = countdown(plan.launch, plan.today);
	return {
		loaded: true,
		timeZone: plan.timeZone,
		today: plan.today,
		status: STATUS_TEXT[plan.launch?.status ?? "planning"],
		plannedDate: plan.launch?.targetDate ? launchDay(plan.launch.targetDate) : null,
		countdown: c.kind,
		daysLeft: c.kind === "ahead" ? c.days : c.kind === "today" ? 0 : null,
		daysOverdue: c.kind === "overdue" ? c.days : null,
		inLaunchWindow: c.kind === "ahead" || c.kind === "today" ? c.window : null,
	};
}
const result = (operation: string, rows: SourceRow[], facts: SourceResult["facts"], exclusions: string[] = []) =>
	({
		operation,
		status: "available",
		rows,
		total: rows.length,
		page: 1,
		next: null,
		completeness: "complete",
		exclusions,
		facts,
	}) satisfies SourceResult;

export const readCountdown = {
	operation: "launch.readCountdown",
	description:
		"Launch Sunday as the Launch plan shows it: its status (No date set, Scheduled, Postponed or Launched), the planned date, the church-local date today and the Launch plan's own countdown (daysLeft). Use daysLeft as it is; never count days from a date yourself. A postponed or undated plan has no countdown",
	input: z.strictObject({}),
	allowed: plantSeat,
	async invoke(tx, actor): Promise<SourceResult> {
		const plan = await planOf(tx, actor);
		if (!plan) return unloaded("launch.readCountdown");
		const facts = dateFacts(plan);
		// One row: Launch Sunday as the Launch plan's header shows it.
		const row: SourceRow = {
			kind: "item",
			id: actor.owner.id,
			label: "Launch Sunday",
			fields: { status: facts.status, plannedDate: facts.plannedDate, daysLeft: facts.daysLeft },
		};
		return result("launch.readCountdown", [row], facts);
	},
} satisfies ReadAdapter<Record<string, never>>;

const isOpen = (status: string) => status !== "complete" && status !== "no_longer_needed";
/** A milestone the Launch plan counts done: a person marked it complete and no reopened task waits for review. */
const done = (m: Milestone) => m.completion !== null && !m.needsReview;
/** An open linked prep task whose due date is before the church-local date today. */
const overdue = (t: Milestone["tasks"][number], today: string) =>
	isOpen(t.status) && t.dueDate !== null && t.dueDate < today;

const workspaceInput = z.strictObject({
	/**
	 * open (the default): milestones not yet done. blocked: open milestones with an overdue linked prep task. all: all nine.
	 */
	filter: z.enum(["open", "blocked", "all"]).optional(),
});
export const readWorkspace = {
	operation: "launch.readWorkspace",
	description:
		'The Launch plan\'s nine readiness milestones (milestone rows) with progress from their own linked prep tasks (done of total), and each listed milestone\'s open prep tasks (item rows: status, due date, assignees, overdue). filter "open" (default) lists milestones not yet done; "blocked" lists only open milestones with an overdue linked prep task; "all" lists all nine. A task is linked to a milestone only when the plan lists it there, never by similar wording. This read never completes a milestone: only a person does, on a review card they approve (launch.completeMilestone) or on the Launch plan',
	input: workspaceInput,
	allowed: plantSeat,
	async invoke(tx, actor, input): Promise<SourceResult> {
		const plan = await planOf(tx, actor);
		if (!plan) return unloaded("launch.readWorkspace");
		const filter = input.filter ?? "open";
		const listed = plan.milestones.filter((m) =>
			filter === "all" ? true : filter === "open" ? !done(m) : !done(m) && m.tasks.some((t) => overdue(t, plan.today)),
		);
		const rows: SourceRow[] = listed.flatMap((m) => {
			const open = m.tasks.filter((t) => isOpen(t.status));
			const milestone: SourceRow = {
				kind: "milestone",
				id: m.id,
				label: m.title,
				fields: {
					area: m.area,
					done: m.tasks.filter((t) => t.status === "complete").length,
					total: m.tasks.length,
					completed: done(m),
					needsReview: m.needsReview,
					openTasks: open.length,
					overdueTasks: open.filter((t) => overdue(t, plan.today)).length,
					...(m.practices && { practicesHeld: m.practices.held, practicesRequired: m.practices.required }),
				},
			};
			const tasks: SourceRow[] = open.map((t) => ({
				kind: "item",
				id: t.id,
				label: t.title,
				fields: {
					milestone: m.title,
					milestoneId: m.id,
					status: t.status,
					dueDate: t.dueDate ? launchDay(t.dueDate) : null,
					overdue: overdue(t, plan.today),
					assignees: t.assignees.map((a) => a.displayName).join(", ") || null,
				},
			}));
			return [milestone, ...tasks];
		});
		return {
			...result("launch.readWorkspace", rows, {
				...dateFacts(plan),
				filter,
				milestonesDone: plan.milestones.filter(done).length,
				milestonesTotal: plan.milestones.length,
			}),
			total: listed.length,
		};
	},
} satisfies ReadAdapter<z.infer<typeof workspaceInput>>;

const EVENT_TEXT: Record<string, string> = {
	scheduled: "Launch Sunday set",
	moved: "Launch Sunday moved",
	postponed: "Launch postponed",
	rescheduled: "Launch Sunday set again",
};
/** One history entry as a row: what changed, from what to what, the reason as written, who and when. */
function entryRow(e: History["entries"][number], timeZone: string): SourceRow {
	const at = new Intl.DateTimeFormat("en-US", { timeZone, month: "short", day: "numeric", year: "numeric" }).format(
		new Date(e.at),
	);
	const base = { by: e.actor?.displayName ?? "A former account", on: at, at: e.at };
	const ch = e.change;
	switch (ch.kind) {
		case "date":
			return {
				kind: "activity",
				id: e.id,
				label: EVENT_TEXT[ch.event] ?? "Launch Sunday changed",
				fields: {
					...base,
					change: "date",
					from: ch.from ? launchDay(ch.from) : null,
					to: ch.to ? launchDay(ch.to) : null,
					reason: ch.reason,
				},
			};
		case "milestone":
			return {
				kind: "activity",
				id: e.id,
				label: `${ch.title} ${ch.event === "completed" ? "marked complete" : "reopened"}`,
				fields: { ...base, change: "milestone" },
			};
		case "outcome":
			return {
				kind: "activity",
				id: e.id,
				label: ch.event === "recorded" ? "Launch Sunday recorded" : "Launch Sunday corrected",
				fields: {
					...base,
					change: "outcome",
					fields: ch.changes.map((c) => c.field).join(", "),
					reason: ch.reason,
				},
			};
		case "guest":
			return {
				kind: "activity",
				id: e.id,
				label: `Guest named${ch.name ? `: ${ch.name}` : ""}`,
				fields: { ...base, change: "guest" },
			};
		case "debrief":
			return {
				kind: "activity",
				id: e.id,
				label:
					ch.event === "submitted"
						? `Debrief submitted (version ${ch.version})`
						: `Debrief corrected (version ${ch.version})`,
				fields: { ...base, change: "debrief" },
			};
		case "summary":
			return {
				kind: "activity",
				id: e.id,
				label: `Summary published (version ${ch.version})`,
				fields: { ...base, change: "summary" },
			};
		case "path":
			return {
				kind: "activity",
				id: e.id,
				label:
					ch.to === "milestone"
						? `Milestone chosen instead of Launch Sunday${ch.milestone ? `: ${ch.milestone}` : ""}`
						: "Launch Sunday chosen again",
				fields: { ...base, change: "path", milestone: ch.milestone, organization: ch.organization },
			};
		case "gathering":
			return {
				kind: "activity",
				id: e.id,
				label: `${ch.name} ${ch.event === "recorded" ? "reached" : ch.event === "corrected" ? "corrected" : "record cleared"}`,
				fields: {
					...base,
					change: "gathering",
					from: ch.from ? launchDay(ch.from) : null,
					to: ch.to ? launchDay(ch.to) : null,
					reason: ch.reason,
				},
			};
	}
}
/** The church-local date of an instant. */
const localDayOf = (at: string, timeZone: string) =>
	new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" }).format(
		new Date(at),
	);

const journalInput = z.strictObject({
	/** Only changes on or after this church-local date (YYYY-MM-DD), such as a week before today. */
	since: localDate.optional(),
});
export const readJournal = {
	operation: "launch.readJournal",
	description:
		"Launch history, newest first, as the Launch plan's History shows it: each change to Launch Sunday (from, to and the reason as written), milestone completions, the recorded outcome, named guests, the debrief and the published summary, with who made it and when. since (a church-local date) keeps only later changes. History records changes, not how readiness stood at an earlier time: say nothing about past readiness beyond these entries. Owners and Admins read it",
	input: journalInput,
	allowed: plantAdmin,
	async invoke(tx, actor, input): Promise<SourceResult> {
		const history = await loaded(tx, (t) => reader.readJournal(t, actor.authority));
		if (!history) return unloaded("launch.readJournal");
		const since = input.since;
		const entries = history.entries.filter((e) => !since || localDayOf(e.at, history.timeZone) >= since);
		return result(
			"launch.readJournal",
			entries.map((e) => entryRow(e, history.timeZone)),
			{ loaded: true, timeZone: history.timeZone, since: since ?? null },
			["how readiness stood at an earlier time, which history does not record"],
		);
	},
} satisfies ReadAdapter<z.infer<typeof journalInput>>;

const debriefInput = z.strictObject({
	/**
	 * A guest's name as the user typed it: the read also lists the church's live People that name may be (person rows
	 * with match), as the Launch plan's guest picker shows them, for an Owner or Admin. A match is only offered.
	 */
	guestName: z
		.string()
		.max(GUEST_NAME_MAX * 4)
		.optional(),
});
export const readDebrief = {
	operation: "launch.readDebrief",
	description:
		"What happened on Launch Sunday, as the Launch plan records it: the actual date, attendance and decisions as counted (null is Not recorded), the first-time guests named on the plan (person rows; an Owner or Admin sees names, a Member only the count), the debrief's answer on guests not entered by name and how many, whether the debrief is drafted or submitted, and the summary: its saved draft and the latest published text. guestName (a name the user typed) also lists the live People it may be (person rows with match, detail and alreadyGuest), for an Owner or Admin to pick from: a typed name never links to a Person by itself. Guests are named, and the recorded outcome is corrected, only by a person: on a review card they approve (launch.addGuestAttendance, launch.correctOutcome) or on the Launch plan. Launch Sunday guests are only these; never use Vision Meeting or other meeting attendance in their place. Debrief answers and the outcome note stay on the Launch plan",
	input: debriefInput,
	allowed: plantSeat,
	async invoke(tx, actor, input): Promise<SourceResult> {
		const plan = await planOf(tx, actor);
		if (!plan) return unloaded("launch.readDebrief");
		const rows: SourceRow[] = (plan.guests.named ?? []).map((g) => ({
			kind: "person",
			id: g.personId,
			label: g.displayName,
			fields: { guest: "Launch Sunday first-time guest" },
		}));
		// The guest picker's matches, for an Owner or Admin only, through the same read the Launch plan's picker calls.
		const guestName = input.guestName?.trim() || null;
		const picker = guestName !== null && plantAdmin(actor);
		const matches = picker ? await loaded(tx, (t) => reader.suggestGuests(t, actor.authority, guestName)) : null;
		if (picker && !matches) return unloaded("launch.readDebrief");
		for (const m of matches ?? [])
			rows.push({
				kind: "person",
				id: m.personId,
				label: m.displayName,
				fields: { match: guestName, detail: m.detail || null, alreadyGuest: m.alreadyGuest },
			});
		const latest = plan.debrief?.draft ?? plan.debrief?.submitted ?? null;
		const answers = latest?.answers;
		const o = plan.outcome;
		return {
			...result(
				"launch.readDebrief",
				rows,
				{
					...dateFacts(plan),
					recorded: o !== null,
					actualDate: o ? launchDay(o.actualDate) : null,
					attendance: o?.attendance ?? null,
					decisions: o?.decisions ?? null,
					guestsNamed: plan.guests.count,
					namesVisible: plan.guests.named !== null,
					guestsNotNamed: answers
						? answers.missingNames === "yes"
							? answers.missingCount
							: answers.missingNames === "no"
								? 0
								: null
						: null,
					debrief: plan.debrief
						? plan.debrief.draft
							? "draft"
							: plan.debrief.submitted
								? "submitted"
								: "not started"
						: null,
					debriefSubmitted: plan.evidence.submittedAt !== null,
					summaryDraft: plan.summary?.draft?.body ?? null,
					summaryPublished: plan.summary?.published[0]?.body ?? null,
					...(guestName !== null && { guestName, matches: matches?.length ?? null }),
				},
				[
					"debrief answers and the outcome note, which stay on the Launch plan",
					...(plan.guests.named === null ? ["guest names, which only an Owner or Admin sees"] : []),
					...(guestName !== null && !picker ? ["People matching a guest name, which only an Owner or Admin sees"] : []),
				],
			),
			total: plan.guests.count,
		};
	},
} satisfies ReadAdapter<z.infer<typeof debriefInput>>;

/** The installed Launch reads. */
export const LAUNCH_READS = [readCountdown, readWorkspace, readJournal, readDebrief] as const;
