import { dateText, meetingTitle, sectionStarts, timeText } from "@everyfield/contracts/common";
import type { MeetingRead } from "./meeting-read.ts";

export const ATTENDEE_CAP = 150;
export type AgendaKind = "vision" | "board";
export const AGENDA_TEMPLATE: Record<AgendaKind, string> = {
	vision: "vision-meeting-agenda",
	board: "board-meeting-agenda",
};

export type AgendaMeeting = {
	title: string;
	date: string;
	time: string;
	place: string | null;
	sections: { title: string; minutes: number; start: string }[];
	totalMinutes: number;
	attendees: { name: string; role: string | null }[];
	hiddenAttendees: number;
};

export function agendaKindOf(m: Pick<MeetingRead, "type" | "leadership">): AgendaKind | null {
	if (m.type === "vision_meeting") return "vision";
	if (m.type === "team_meeting" && m.leadership) return "board";
	return null;
}

export function agendaMeetingOf(m: MeetingRead, thisYear: number): AgendaMeeting {
	const starts = sectionStarts(m.localTime, m.agenda);
	return {
		title: meetingTitle(m),
		date: dateText(m.localDate, thisYear),
		time: timeText(m.localTime),
		place: m.venueName === null ? null : `${m.venueName}, ${m.venueAddress ?? ""}`,
		sections: m.agenda.map((s, i) => ({ title: s.title, minutes: s.minutes, start: timeText(starts[i]!) })),
		totalMinutes: m.agenda.reduce((n, s) => n + s.minutes, 0),
		attendees: m.attendees,
		hiddenAttendees: m.attendeeTotal - m.attendees.length,
	};
}
