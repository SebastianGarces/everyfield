import {
	countdown,
	type Countdown,
	type DebriefProblem,
	type EvidenceStatus,
	type HistoryEntry,
	type LaunchError,
	type Milestone,
	type NoteProblem,
	type OutcomeField,
	type OutcomeProblem,
	type Plan,
	type SummaryProblem,
} from "@everyfield/contracts/launch";

// The Launch plan's pure model: words, dates and progress. No React and no server code.

/** A server action's answer: the operation's reply, or "lost" when no database answer came back. */
export type Outcome<T> = { status: "ok"; value: T } | { status: "refused"; error: LaunchError } | { status: "lost" };

export async function sent<T>(call: () => Promise<Outcome<T>>): Promise<Outcome<T>> {
	try {
		return await call();
	} catch {
		return { status: "lost" };
	}
}

const at = (date: string) => new Date(`${date}T12:00:00Z`);
/** "Tue, Nov 10, 2026": a church-local date, never shifted by the browser's time zone. */
export const longDate = (date: string) =>
	new Intl.DateTimeFormat("en-US", {
		timeZone: "UTC",
		weekday: "short",
		month: "short",
		day: "numeric",
		year: "numeric",
	}).format(at(date));
/** "Nov 1", or "Nov 1, 2027" in another year than `today`. */
export const shortDate = (date: string, today: string) =>
	new Intl.DateTimeFormat("en-US", {
		timeZone: "UTC",
		month: "short",
		day: "numeric",
		...(date.slice(0, 4) === today.slice(0, 4) ? {} : { year: "numeric" }),
	}).format(at(date));
/** A completion instant as the church's date. */
export const instantDate = (instant: string, timeZone: string) =>
	new Intl.DateTimeFormat("en-US", { timeZone, month: "short", day: "numeric", year: "numeric" }).format(
		new Date(instant),
	);

export type Shown = { kind: Countdown["kind"]; badge: string; tone: "positive" | "attention" | "risk" | "unknown" };
/** The plan's state as the header badge says it. */
export function shownOf(plan: Plan): Shown {
	const c = countdown(plan.launch, plan.today);
	switch (c.kind) {
		case "none":
			return { kind: c.kind, badge: "No date", tone: "unknown" };
		case "postponed":
			return { kind: c.kind, badge: "Postponed", tone: "attention" };
		case "overdue":
			return { kind: c.kind, badge: "Overdue", tone: "risk" };
		case "completed":
			return { kind: c.kind, badge: "Launched", tone: "positive" };
		default:
			return { kind: c.kind, badge: "Scheduled", tone: "positive" };
	}
}

export const isOpen = (status: Milestone["tasks"][number]["status"]) =>
	status !== "complete" && status !== "no_longer_needed";
/** Done tasks of a milestone, from its live tasks: nothing is cached. */
export const progressOf = (m: Pick<Milestone, "tasks">) => ({
	done: m.tasks.filter((t) => t.status === "complete").length,
	total: m.tasks.length,
});
export const tasksText = ({ done, total }: { done: number; total: number }) =>
	`${done} of ${total} ${total === 1 ? "task" : "tasks"}`;

export const NOTE_MESSAGE: Record<NoteProblem, string> = {
	empty: "Write a short reason. It stays in the Launch history.",
	too_long: "Keep the reason to 2,000 characters or fewer.",
};

export const OUTCOME_MESSAGE: Record<OutcomeProblem, string> = {
	date_in_future: "Launch Sunday can't be recorded for a date after today.",
	count_out_of_range: "Counts are whole numbers from 0 to 1,000,000. Leave one empty if you didn't count.",
	note_too_long: "Keep the note to 10,000 characters or fewer.",
};
export const DEBRIEF_MESSAGE: Record<DebriefProblem, string> = {
	guest_answer_needed: "Answer the guest question to submit. Everything else can stay as short as you like.",
	guest_count_needed: "Say how many guests aren't entered by name yet.",
	count_out_of_range: "Use a whole number from 1 to 1,000,000.",
	too_long: "Keep each answer to 10,000 characters or fewer.",
};
export const SUMMARY_MESSAGE: Record<SummaryProblem, string> = {
	empty: "Write the summary before you publish it.",
	too_long: "Keep the summary to 4,000 characters or fewer.",
};

/** A count typed in a form: empty is Not recorded (null); anything else must be a whole number. */
export function parseCount(raw: string): { ok: true; value: number | null } | { ok: false } {
	const t = raw.trim();
	if (!t) return { ok: true, value: null };
	if (!/^\d+$/.test(t)) return { ok: false };
	return { ok: true, value: Number(t) };
}
/** A recorded count as the page says it: an empty one is Not recorded, and 0 is 0. */
export const countText = (n: number | null) => (n === null ? "Not recorded" : n.toLocaleString("en-US"));

export const EVIDENCE_TEXT: Record<EvidenceStatus, { label: string; tone: "positive" | "risk" | "unknown" }> = {
	met: { label: "Met", tone: "positive" },
	not_met: { label: "Not met", tone: "risk" },
	unknown: { label: "Unknown", tone: "unknown" },
};

const FIELD_LABEL: Record<OutcomeField, string> = {
	actualDate: "Date held",
	attendance: "Attendance",
	decisions: "Decisions",
	note: "Note",
};
/** One Launch history entry in words: a title and the details under it. */
export function historyText(e: HistoryEntry, today: string): { title: string; lines: string[] } {
	const c = e.change;
	const day = (d: string | null) => (d ? shortDate(d, today) : "no date");
	switch (c.kind) {
		case "date":
			return {
				title: {
					scheduled: "Launch Sunday set",
					moved: "Launch Sunday moved",
					postponed: "Launch Sunday postponed",
					rescheduled: "Launch Sunday set again",
				}[c.event],
				lines: [
					c.event === "postponed"
						? `Was ${day(c.from)}`
						: c.from
							? `${day(c.from)} → ${day(c.to)}`
							: `Set to ${day(c.to)}`,
					...(c.reason ? [`Reason: ${c.reason}`] : []),
				],
			};
		case "milestone":
			return { title: `Milestone ${c.event === "completed" ? "completed" : "reopened"}`, lines: [c.title] };
		case "outcome":
			return {
				title: c.event === "recorded" ? "Launch Sunday recorded" : "Launch Sunday corrected",
				lines: [
					...c.changes.map((x) =>
						x.field === "note"
							? c.event === "recorded"
								? "Note added"
								: "Note changed"
							: c.event === "recorded"
								? `${FIELD_LABEL[x.field]}: ${historyValue(x.field, x.after, today)}`
								: `${FIELD_LABEL[x.field]}: ${historyValue(x.field, x.before, today)} → ${historyValue(x.field, x.after, today)}`,
					),
					...(c.reason ? [`Reason: ${c.reason}`] : []),
				],
			};
		case "guest":
			return { title: "Guest named", lines: [`${c.name ?? "A guest"}${c.added ? " · added to People" : ""}`] };
		case "debrief":
			return {
				title: c.event === "submitted" ? "Debrief submitted" : "Debrief corrected",
				lines: [`Version ${c.version}`],
			};
		case "summary":
			return { title: "Summary published", lines: [`Version ${c.version}`] };
	}
}
function historyValue(field: OutcomeField, v: string | number | null, today: string) {
	if (v === null) return "Not recorded";
	return field === "actualDate" ? shortDate(String(v), today) : String(v);
}
/** Who made a change: their name, or a former account once it is deleted. */
export const actorText = (e: Pick<HistoryEntry, "actor">) => e.actor?.displayName || "A former account";

/** The message a refused or lost change shows. */
export function refusalMessage(outcome: Exclude<Outcome<unknown>, { status: "ok" }>): string {
	if (outcome.status === "lost")
		return "Everyfield's answer did not come back, so this may not have saved. Try again: the same change will not apply twice.";
	const error = outcome.error;
	switch (error.code) {
		case "invalid_reason":
			return NOTE_MESSAGE[error.details.problem];
		case "conflict":
			return "Someone changed the Launch plan while you were looking. Reload the page to see it now.";
		case "stale_review":
			return "The tasks changed since you opened this milestone. Review them and complete it again.";
		case "access_denied":
			return "Only an Owner or Admin can change the Launch plan. Your seat may have changed.";
		case "invalid_outcome":
			return OUTCOME_MESSAGE[error.details.problem];
		case "invalid_debrief":
			return DEBRIEF_MESSAGE[error.details.problem];
		case "invalid_summary":
			return SUMMARY_MESSAGE[error.details.problem];
		case "not_ready":
			return error.details.needs === "outcome"
				? "Record Launch Sunday first. Reload the page to see it now."
				: "Submit the debrief first. Reload the page to see it now.";
		case "derived_evidence_only":
			return "This milestone follows the submitted debrief. It can't be checked off by hand.";
		default:
			return "Nothing changed. Reload the page and try again.";
	}
}

/** One request key per intent, so a retry after a lost answer replays the first write instead of acting twice. */
export function requestKeys(fresh: () => string) {
	const keys = new Map<string, string>();
	return {
		keyFor(intent: readonly unknown[]) {
			const id = JSON.stringify(intent);
			if (!keys.has(id)) keys.set(id, fresh());
			return keys.get(id)!;
		},
		settle(intent: readonly unknown[]) {
			keys.delete(JSON.stringify(intent));
		},
	};
}
