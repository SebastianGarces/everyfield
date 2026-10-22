import type * as c from "@everyfield/contracts/meetings";
import type { Status } from "@everyfield/ui/display";
import type { z } from "zod";

// Words, filters and dates for the meetings screens. Pure functions only: the server and the browser both import this.

export type MeetingType = z.infer<typeof c.meetingType>;
export type MeetingStatus = z.infer<typeof c.meetingStatus>;
export type Summary = z.infer<typeof c.meetingSummary>;
export type Detail = z.infer<typeof c.meetingDetail>;
export type Guest = z.infer<typeof c.guest>;
export type KitItem = z.infer<typeof c.kitItem>;
export type Venue = z.infer<typeof c.venue>;
export type AgendaSection = z.infer<typeof c.agendaSection>;
export type Rsvp = z.infer<typeof c.rsvp>;
export type CardResponse = z.infer<typeof c.cardResponse>;
export type Presence = z.infer<typeof c.presence>;
export type Attendee = z.infer<typeof c.attendee>;
export type Attendance = z.infer<typeof c.attendanceList>;
export type Analytics = z.infer<typeof c.meetingAnalytics>;
export type Evaluation = z.infer<typeof c.evaluation>;
export type Scores = z.infer<typeof c.scores>;
export type Factor = keyof Scores;
export type Classification = z.infer<typeof c.classification>;
export type Finalization = z.infer<typeof c.finalizationResult>;

/** A server action's answer. "lost" means no answer arrived: the same request key may be sent again. */
export type Outcome<T> =
	| { status: "ok"; value: T }
	| { status: "refused"; code: string; choices?: { instant: string; offsetSeconds: number }[] }
	| { status: "lost" };

export const TYPES = ["vision_meeting", "orientation", "team_meeting", "prelaunch_practice"] as const;
/** The types a new meeting can be. Team meetings arrive with teams (WP-017). */
export const NEW_TYPES = ["vision_meeting", "orientation", "prelaunch_practice"] as const;
export const TYPE_LABEL: Record<MeetingType, string> = {
	vision_meeting: "Vision meeting",
	orientation: "Orientation",
	team_meeting: "Team meeting",
	prelaunch_practice: "Pre-launch practice",
};
/** The title a meeting shows without its own title, as the producer builds it ("Vision Meeting #12"). */
const DEFAULT_TITLE: Record<MeetingType, string> = {
	vision_meeting: "Vision Meeting",
	orientation: "Orientation",
	team_meeting: "Team Meeting",
	prelaunch_practice: "Pre-launch Practice",
};
export const defaultTitle = (m: { type: MeetingType; visionNumber: number | null }) =>
	DEFAULT_TITLE[m.type] + (m.visionNumber ? ` #${m.visionNumber}` : "");

/** Short labels for filters. */
export const TYPE_SHORT: Record<MeetingType, string> = {
	vision_meeting: "Vision",
	orientation: "Orientation",
	team_meeting: "Team",
	prelaunch_practice: "Practice",
};
export const TYPE_TONE: Record<MeetingType, "green" | "blue" | "violet" | "amber"> = {
	vision_meeting: "green",
	orientation: "blue",
	team_meeting: "violet",
	prelaunch_practice: "amber",
};

export const STATUSES = ["planning", "ready", "in_progress", "completed", "cancelled"] as const;
export const STATUS_LABEL: Record<MeetingStatus, string> = {
	planning: "Planning",
	ready: "Ready",
	in_progress: "In progress",
	completed: "Completed",
	cancelled: "Cancelled",
};
export const STATUS_TONE: Record<MeetingStatus, Status> = {
	planning: "measured",
	ready: "positive",
	in_progress: "attention",
	completed: "unknown",
	cancelled: "risk",
};
/** The menu words for moving to each status. */
export const STATUS_ACTION: Record<MeetingStatus, string> = {
	planning: "Back to planning",
	ready: "Mark as ready",
	in_progress: "Start the meeting",
	completed: "Mark as completed",
	cancelled: "Cancel the meeting",
};

export const RSVP_LABEL: Record<Rsvp, string> = { confirmed: "Yes", declined: "No", pending: "Pending" };
export const RSVP_TONE: Record<Rsvp, Status> = { confirmed: "positive", declined: "risk", pending: "attention" };
export const RSVP_SOURCE_LABEL = {
	invitation: "from the invitation",
	token: "from their link",
	own: "answered in Everyfield",
	admin: "set by an Admin",
} as const;

export const CARD_RESPONSES = [
	"ready_commit",
	"interested",
	"prayer_request",
	"stay_informed",
	"not_interested",
] as const satisfies readonly CardResponse[];
export const CARD_LABEL: Record<CardResponse, string> = {
	ready_commit: "Ready to commit",
	interested: "Interested",
	prayer_request: "Prayer request",
	stay_informed: "Stay informed",
	not_interested: "Not interested",
};

export const KIT_CATEGORY_LABEL = {
	essential: "Essentials",
	materials: "Materials",
	setup: "Setup",
	av: "Audio and video",
	organization: "Organization",
} as const;

// -------------------------------------------------------------------------------------------------------------
// Attendance and evaluation (WP-022).

export const PRESENCE_LABEL: Record<Presence, string> = { attended: "Attended", excused: "Excused", absent: "Absent" };
export const PRESENCE_TONE: Record<Presence, Status> = { attended: "positive", excused: "measured", absent: "unknown" };
export const CLASSIFICATION_LABEL: Record<Classification, string> = {
	first_time: "First visit",
	returning: "Returning",
	core_group: "Core group",
};

/** The eight Vision factors (REQ-MTG-014) in their stored order, with the question each one asks. */
export const FACTORS: { key: Factor; label: string; hint: string }[] = [
	{ key: "attendanceScore", label: "Attendance", hint: "The core group invited people actively" },
	{ key: "locationScore", label: "Location", hint: "Easy to find, welcoming and free of distractions" },
	{ key: "logisticsScore", label: "Logistics", hint: "Room, audio, video and materials were ready" },
	{ key: "agendaScore", label: "Agenda", hint: "Detailed, and it ran on time" },
	{ key: "vibeScore", label: "Vibe", hint: "Warm, inviting and enthusiastic" },
	{ key: "messageScore", label: "Message", hint: "The vision was clear and compelling" },
	{ key: "closeScore", label: "Close", hint: "A strong call that did not pressure anyone" },
	{ key: "nextStepsScore", label: "Next steps", hint: "Clear dates and details" },
];
/** One decimal, always: "4.0", never "4". */
export const scoreText = (n: number) => n.toFixed(1);
/** "+0.4", "−0.3", "0.0". */
export const deltaText = (n: number) => (n > 0 ? "+" : n < 0 ? "−" : "") + Math.abs(n).toFixed(1);

/** People in a count: "1 person", "3 people". */
export const peopleText = (n: number) => `${n} ${n === 1 ? "person" : "people"}`;

// -------------------------------------------------------------------------------------------------------------
// The list address. Filters live in the URL; a filter change returns to page one. Unknown or repeated values fall back
// to the documented default (REQ-MTG-001), so an old or hand-made link never errors.

export const WINDOWS = ["all", "upcoming", "past"] as const;
export type Window = (typeof WINDOWS)[number];
export const WINDOW_LABEL: Record<Window, string> = { all: "All", upcoming: "Upcoming", past: "Past" };
export const PAGE_SIZE = 24;

export type MeetingsQuery = { window: Window; type: MeetingType | null; status: MeetingStatus | null; page: number };
export const DEFAULT_QUERY: MeetingsQuery = { window: "all", type: null, status: null, page: 1 };

const pick = <T extends string>(all: readonly T[], raw: string[]): T | null =>
	raw.length === 1 && (all as readonly string[]).includes(raw[0]!) ? (raw[0] as T) : null;

export function parseQuery(params: URLSearchParams): MeetingsQuery {
	const page = Number(params.get("page"));
	return {
		window: pick(WINDOWS, params.getAll("when")) ?? "all",
		type: pick(TYPES, params.getAll("type")),
		status: pick(STATUSES, params.getAll("status")),
		page: Number.isInteger(page) && page >= 1 && page <= 100_000 ? page : 1,
	};
}

export function querySearch(q: MeetingsQuery): string {
	const p = new URLSearchParams();
	if (q.window !== "all") p.set("when", q.window);
	if (q.type) p.set("type", q.type);
	if (q.status) p.set("status", q.status);
	if (q.page > 1) p.set("page", String(q.page));
	const s = p.toString();
	return s ? `?${s}` : "";
}

export function listRequest(q: MeetingsQuery) {
	return {
		window: q.window,
		types: q.type ? [q.type] : [],
		statuses: q.status ? [q.status] : [],
		page: q.page,
		limit: PAGE_SIZE,
	};
}

export const isFiltered = (q: MeetingsQuery) => q.window !== "all" || q.type !== null || q.status !== null;
export const pageCount = (total: number) => Math.max(1, Math.ceil(total / PAGE_SIZE));

// -------------------------------------------------------------------------------------------------------------
// Dates. A meeting's date and time are the church's wall clock (localDate, localTime in its zone). They are formatted
// from those strings, never through the browser's zone, so the server and the browser print the same words.

const DAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const LONG_DAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

function parts(localDate: string) {
	const [y, m, d] = localDate.split("-").map(Number) as [number, number, number];
	return { y, m, d, weekday: new Date(Date.UTC(y, m - 1, d)).getUTCDay() };
}

/** "6:30 pm" from "18:30". */
export function timeText(localTime: string): string {
	const [h, min] = localTime.split(":").map(Number) as [number, number];
	const suffix = h < 12 ? "am" : "pm";
	const hour = h % 12 === 0 ? 12 : h % 12;
	return `${hour}:${String(min).padStart(2, "0")} ${suffix}`;
}

/** "Sun Oct 12" (with the year when it differs from `thisYear`). */
export function dateText(localDate: string, thisYear?: number): string {
	const { y, m, d, weekday } = parts(localDate);
	return `${DAYS[weekday]} ${MONTHS[m - 1]} ${d}${thisYear !== undefined && y !== thisYear ? `, ${y}` : ""}`;
}

/** "Sunday, Oct 12". */
export function longDateText(localDate: string): string {
	const { m, d, weekday } = parts(localDate);
	return `${LONG_DAYS[weekday]}, ${MONTHS[m - 1]} ${d}`;
}

/** "Sun Oct 12 · 6:30 pm". */
export function whenText(m: { localDate: string; localTime: string }, thisYear?: number): string {
	return `${dateText(m.localDate, thisYear)} · ${timeText(m.localTime)}`;
}

/** "today", "tomorrow", "in 4 days", "in 3 weeks", from the meeting's instant and the page's render time. */
export function untilText(startsAt: string, now: string): string {
	const days = Math.round((Date.parse(startsAt) - Date.parse(now)) / 86_400_000);
	if (days <= 0) return "today";
	if (days === 1) return "tomorrow";
	if (days < 14) return `in ${days} days`;
	return `in ${Math.round(days / 7)} weeks`;
}

/** Minutes after a wall-clock time: "18:30" + 25 is "18:55". Wraps past midnight. */
export function addMinutes(localTime: string, minutes: number): string {
	const [h, m] = localTime.split(":").map(Number) as [number, number];
	const total = (((h * 60 + m + minutes) % 1440) + 1440) % 1440;
	return `${String(Math.floor(total / 60)).padStart(2, "0")}:${String(total % 60).padStart(2, "0")}`;
}

/** "1 h 30 min", "45 min". */
export function durationText(minutes: number): string {
	if (minutes < 60) return `${minutes} min`;
	const h = Math.floor(minutes / 60);
	const rest = minutes % 60;
	return rest ? `${h} h ${rest} min` : `${h} h`;
}

/** The offset a fold choice carries, in words: "1:30 am (CDT)" style hints are zone-specific, so show UTC offsets. */
export function offsetText(offsetSeconds: number): string {
	const sign = offsetSeconds < 0 ? "−" : "+";
	const abs = Math.abs(offsetSeconds);
	return `UTC${sign}${Math.floor(abs / 3600)}${abs % 3600 ? `:${String((abs % 3600) / 60).padStart(2, "0")}` : ""}`;
}

/** RSVP counts from the guest list. */
export function rsvpCounts(guests: readonly Pick<Guest, "rsvp">[]) {
	const out = { confirmed: 0, declined: 0, pending: 0 };
	for (const g of guests) out[g.rsvp]++;
	return out;
}

// -------------------------------------------------------------------------------------------------------------
// Problems in words. A refusal never says more than the viewer may know: missing, foreign and deleted read the same.

export function problemText(code: string): string {
	switch (code) {
		case "conflict":
			return "Someone else changed this while you were working. The latest version is shown now. Check it and try again.";
		case "conflict_kept":
			return "Someone else changed this while you were working. The form now shows their version with your changes on top. Check it and save again.";
		case "conflict_unloaded":
			return "Someone else changed this while you were working, and the latest version did not load. Close this and reload the page before you try again.";
		case "invalid_input":
			return "Some details are not valid. Check them and try again.";
		case "invalid_subject":
			return "That person cannot be chosen here. They may have been retired or merged.";
		case "venue_archived":
			return "That place is archived. Restore it in Places, or choose another one.";
		case "wrong_meeting_type":
			return "This kind of meeting does not have that.";
		case "status_transition":
			return "The meeting cannot move to that status from where it is now.";
		case "nonexistent_local_time":
			return "That time does not exist on that day, because the clocks spring forward. Choose another time.";
		case "ambiguous_local_time":
			return "That time happens twice on that day, because the clocks fall back. Choose which one you mean.";
		case "required_write_failed":
			return "The server could not save this. Nothing changed. Try again in a moment.";
		case "unavailable":
			return "This is not available any more. It may have been deleted, or your seat may have changed. Reload the page.";
		default:
			return "You cannot make this change. Your seat may have changed. Reload the page.";
	}
}
