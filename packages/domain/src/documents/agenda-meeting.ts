// What an agenda print reads from one meeting (WP-036/api, REQ-DOC-007). Plain data and pure text rules: no database and
// no engine, so a test can check every string. The date and time words match the meeting screen (features/meetings/model.ts).

/** People printed on an attendee list. A longer list prints this many and one line with the rest. */
export const ATTENDEE_CAP = 150;
/** The agenda kinds a meeting can print: a Vision meeting, or a meeting of the church's leadership team. */
export type AgendaKind = "vision" | "board";
export const AGENDA_TEMPLATE: Record<AgendaKind, string> = {
	vision: "vision-meeting-agenda",
	board: "board-meeting-agenda",
};

export type AgendaMeeting = {
	/** The title the meeting screen shows. */
	title: string;
	date: string;
	time: string;
	/** "Name, Address" as the screen shows it; null when the meeting has no venue. */
	place: string | null;
	sections: { title: string; minutes: number; start: string }[];
	totalMinutes: number;
	attendees: { name: string; role: string | null }[];
	/** People on the list beyond the cap. They do not print. */
	hiddenAttendees: number;
};

/** The columns the meeting read returns. Agenda and people arrive as JSON. */
export type MeetingRead = {
	type: "vision_meeting" | "orientation" | "team_meeting" | "prelaunch_practice";
	title: string | null;
	visionNumber: number | null;
	localDate: string;
	localTime: string;
	venueName: string | null;
	venueAddress: string | null;
	agenda: { title: string; minutes: number }[];
	leadership: boolean;
	attendees: { name: string; role: string | null }[];
	attendeeTotal: number;
};

export function agendaKindOf(m: Pick<MeetingRead, "type" | "leadership">): AgendaKind | null {
	if (m.type === "vision_meeting") return "vision";
	if (m.type === "team_meeting" && m.leadership) return "board";
	return null;
}

const DAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const LABEL = {
	vision_meeting: "Vision Meeting",
	orientation: "Orientation",
	team_meeting: "Team Meeting",
	prelaunch_practice: "Pre-launch Practice",
} as const;

/** "6:30 pm" from "18:30". */
export function timeText(localTime: string): string {
	const [h, min] = localTime.split(":").map(Number) as [number, number];
	return `${h % 12 === 0 ? 12 : h % 12}:${String(min).padStart(2, "0")} ${h < 12 ? "am" : "pm"}`;
}
/** "Sun Oct 12", with the year when it differs from `thisYear`. */
export function dateText(localDate: string, thisYear: number): string {
	const [y, m, d] = localDate.split("-").map(Number) as [number, number, number];
	const weekday = new Date(Date.UTC(y, m - 1, d)).getUTCDay();
	return `${DAYS[weekday]} ${MONTHS[m - 1]} ${d}${y !== thisYear ? `, ${y}` : ""}`;
}
/** Minutes after a wall-clock time: "18:30" + 25 is "18:55". Wraps past midnight. */
export function addMinutes(localTime: string, minutes: number): string {
	const [h, m] = localTime.split(":").map(Number) as [number, number];
	const total = (((h * 60 + m + minutes) % 1440) + 1440) % 1440;
	return `${String(Math.floor(total / 60)).padStart(2, "0")}:${String(total % 60).padStart(2, "0")}`;
}
/** "1 h 30 min", "45 min": the words the Agenda card shows for its total. */
export function durationText(minutes: number): string {
	if (minutes < 60) return `${minutes} min`;
	const rest = minutes % 60;
	return rest ? `${Math.floor(minutes / 60)} h ${rest} min` : `${minutes / 60} h`;
}

export function displayTitle(m: Pick<MeetingRead, "title" | "type" | "visionNumber">) {
	return m.title?.trim() || LABEL[m.type] + (m.visionNumber ? ` #${m.visionNumber}` : "");
}

export function agendaMeetingOf(m: MeetingRead, thisYear: number): AgendaMeeting {
	// Each section starts when the one before it ends, counted from the meeting's start (the Agenda card's rule).
	const starts: string[] = [];
	m.agenda.forEach((_, i) => starts.push(i === 0 ? m.localTime : addMinutes(starts[i - 1]!, m.agenda[i - 1]!.minutes)));
	return {
		title: displayTitle(m),
		date: dateText(m.localDate, thisYear),
		time: timeText(m.localTime),
		place: m.venueName === null ? null : `${m.venueName}, ${m.venueAddress ?? ""}`,
		sections: m.agenda.map((s, i) => ({ title: s.title, minutes: s.minutes, start: timeText(starts[i]!) })),
		totalMinutes: m.agenda.reduce((n, s) => n + s.minutes, 0),
		attendees: m.attendees.slice(0, ATTENDEE_CAP),
		hiddenAttendees: Math.max(0, m.attendeeTotal - Math.min(m.attendees.length, ATTENDEE_CAP)),
	};
}
