import { instant } from "@everyfield/contracts/common";
import {
	CARE_AREAS,
	noteOf,
	type CareAnswers,
	type CareArea,
	type CareError,
	type CareLevel,
	type CarePage,
	type CareWeek,
	type CareWriteResult,
} from "@everyfield/contracts/intelligence";

// The check-in screen's pure model: labels, dates, messages and the optimistic strip. No React and no server code, so
// the UI tests call it directly.

/** A server action's answer: the operation's reply, or "lost" when no database answer came back. */
export type Outcome<T> = { status: "ok"; value: T } | { status: "refused"; error: CareError } | { status: "lost" };

export const AREA: Record<CareArea, { title: string; question: string; short: string }> = {
	spiritual: { title: "Spiritually", question: "How is your own walk with God?", short: "Spiritual" },
	family: { title: "Marriage and family", question: "How are things at home?", short: "Family" },
	financial: { title: "Financially", question: "How are your personal finances?", short: "Finances" },
	pace: { title: "Pace", question: "Is your pace of life sustainable?", short: "Pace" },
};
export const LEVEL_LABEL: Record<CareLevel, string> = {
	steady: "Steady",
	strained: "Strained",
	struggling: "Struggling",
};

/** The form's answers: an area stays unset until the author picks a level. */
export type Draft = { answers: Partial<CareAnswers>; note: string };
export const draftOf = (week: CareWeek | null): Draft =>
	week?.answer ? { answers: { ...week.answer.answers }, note: week.answer.note ?? "" } : { answers: {}, note: "" };
export const missingAreas = (draft: Draft) => CARE_AREAS.filter((a) => !draft.answers[a]);
export const complete = (draft: Draft): draft is { answers: CareAnswers; note: string } =>
	missingAreas(draft).length === 0;

/**
 * The form's primary button. A past week is corrected; this week is saved once, then changed. A week counts as saved
 * only once the server has its row, so the optimistic strip during a first save still reads "Save check-in".
 */
export function submitLabel(week: CareWeek, correcting: boolean) {
	if (correcting) return "Save correction";
	return week.id !== null && week.answer !== null ? "Save changes" : "Save check-in";
}

const LONG_MONTH = [
	"January",
	"February",
	"March",
	"April",
	"May",
	"June",
	"July",
	"August",
	"September",
	"October",
	"November",
	"December",
];
/** "Oct 5" for a LocalDate. */
export function shortDate(day: string) {
	const [, m, d] = day.split("-").map(Number);
	return `${LONG_MONTH[m! - 1]!.slice(0, 3)} ${d}`;
}
/** "Monday, October 5" for a LocalDate that is a Monday. */
export function mondayDate(day: string) {
	const [, m, d] = day.split("-").map(Number);
	return `Monday, ${LONG_MONTH[m! - 1]} ${d}`;
}
/** "Oct 6, 9:12 pm" for an instant, in the author's zone. */
export function savedAt(instant: string, zone: string) {
	const parts = new Intl.DateTimeFormat("en-US", {
		timeZone: zone,
		month: "short",
		day: "numeric",
		hour: "numeric",
		minute: "2-digit",
		hour12: true,
	}).formatToParts(new Date(instant));
	const get = (type: string) => parts.find((p) => p.type === type)?.value ?? "";
	return `${get("month")} ${get("day")}, ${get("hour")}:${get("minute")} ${get("dayPeriod").toLowerCase()}`;
}
const dayIn = (instant: string, zone: string) => {
	const parts = new Intl.DateTimeFormat("en-US", { timeZone: zone, month: "short", day: "numeric" }).formatToParts(
		new Date(instant),
	);
	return `${parts.find((p) => p.type === "month")?.value} ${parts.find((p) => p.type === "day")?.value}`;
};

/** The line under a week in the strip: this week, skipped, or what its last correction changed. */
export function weekNote(week: CareWeek, zone: string): { text: string; tone: "plain" | "amber" } | null {
	if (week.current) return { text: "this week", tone: "plain" };
	if (!week.answer) return { text: "Skipped", tone: "plain" };
	const last = week.revisions.at(-1),
		before = week.revisions.at(-2);
	if (last?.kind !== "correction" || !before) return null;
	const changed = CARE_AREAS.filter((a) => before.answers[a] !== last.answers[a]).map(
		(a) => `${AREA[a].short} was ${LEVEL_LABEL[before.answers[a]]}`,
	);
	const what = changed.length
		? changed.slice(0, 2).join(", ") + (changed.length > 2 ? " and more" : "")
		: "Note changed";
	return { text: `Corrected ${dayIn(last.recordedAt, zone)} · ${what}`, tone: "amber" };
}

/** The strip with one week shown as the author just answered it, before the server confirms. */
export function withAnswer(page: CarePage, week: CareWeek, answers: CareAnswers, note: string): CarePage {
	const answeredAt = instant.parse(new Date().toISOString());
	const answer = { answers, note: noteOf(note), revision: (week.answer?.revision ?? 0) + 1, answeredAt };
	return { ...page, weeks: page.weeks.map((w) => (w.ordinal === week.ordinal ? { ...w, answer } : w)) };
}
/** The strip after a confirmed save or correction: the server's week and the calendar revision. */
export function withResult(page: CarePage, result: CareWriteResult): CarePage {
	return {
		...page,
		revision: result.revision,
		weeks: page.weeks.map((w) => (w.ordinal === result.week.ordinal ? result.week : w)),
	};
}

/** What a refusal means for the author, in words. */
export function refusalText(error: CareError | null): string {
	switch (error?.code) {
		case "revision_conflict":
			return "Your check-in changed in another window or in Settings. Load the latest version, then save again.";
		case "personal_timezone_confirmation_required":
			return "Choose your time zone in Settings first, so your week starts on your own Monday.";
		case "invalid_input":
			return "Choose an answer for each of the four areas. A note can have up to 2,000 characters.";
		case "not_found":
			return "That week is not in your check-ins.";
		case "access_denied":
			return "Your seat no longer includes a check-in. Only an Owner or Admin of a church plant has one.";
		case "idempotency_conflict":
			return "This save was sent twice with different answers. Save again.";
		default:
			return "Everyfield could not be reached, so this may not have saved. Your answers are still here. Save again.";
	}
}
