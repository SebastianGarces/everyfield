import { dateText, defaultTitle, sectionStarts, timeText } from "@everyfield/contracts/common";
import type { MeetingRead } from "./meeting-read.ts";

// What an agenda print reads from one meeting (WP-036/api, REQ-DOC-007). Plain data and pure text rules: no database and
// no engine, so a test can check every string. The date and time words come from @everyfield/contracts/common, as on the meeting screen.

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

export function agendaKindOf(m: Pick<MeetingRead, "type" | "leadership">): AgendaKind | null {
	if (m.type === "vision_meeting") return "vision";
	if (m.type === "team_meeting" && m.leadership) return "board";
	return null;
}

export function displayTitle(m: Pick<MeetingRead, "title" | "type" | "visionNumber">) {
	return m.title?.trim() || defaultTitle(m);
}

export function agendaMeetingOf(m: MeetingRead, thisYear: number): AgendaMeeting {
	// Each section starts when the one before it ends, counted from the meeting's start (the Agenda card's rule).
	const starts = sectionStarts(m.localTime, m.agenda);
	return {
		title: displayTitle(m),
		date: dateText(m.localDate, thisYear),
		time: timeText(m.localTime),
		place: m.venueName === null ? null : `${m.venueName}, ${m.venueAddress ?? ""}`,
		sections: m.agenda.map((s, i) => ({ title: s.title, minutes: s.minutes, start: timeText(starts[i]!) })),
		totalMinutes: m.agenda.reduce((n, s) => n + s.minutes, 0),
		attendees: m.attendees,
		hiddenAttendees: m.attendeeTotal - m.attendees.length,
	};
}
