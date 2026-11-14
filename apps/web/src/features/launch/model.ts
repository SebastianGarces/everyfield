import {
	countdown,
	type Countdown,
	type LaunchError,
	type Milestone,
	type NoteProblem,
	type Plan,
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
