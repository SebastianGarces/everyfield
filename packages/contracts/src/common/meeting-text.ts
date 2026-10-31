// The words a meeting shows for its date, time, duration and default title. One copy: the meeting screen, the Agenda
// card and the agenda PDF all import it, so the printed sheet says what the screen says.

const DAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const DEFAULT_TITLE = {
	vision_meeting: "Vision Meeting",
	orientation: "Orientation",
	team_meeting: "Team Meeting",
	prelaunch_practice: "Pre-launch Practice",
} as const;

/** The title a meeting shows without its own title, as the producer builds it ("Vision Meeting #12"). */
export const defaultTitle = (m: { type: keyof typeof DEFAULT_TITLE; visionNumber: number | null }) =>
	DEFAULT_TITLE[m.type] + (m.visionNumber ? ` #${m.visionNumber}` : "");

/** "6:30 pm" from "18:30". */
export function timeText(localTime: string): string {
	const [h, min] = localTime.split(":").map(Number) as [number, number];
	const suffix = h < 12 ? "am" : "pm";
	const hour = h % 12 === 0 ? 12 : h % 12;
	return `${hour}:${String(min).padStart(2, "0")} ${suffix}`;
}

/** "Sun Oct 12" (with the year when it differs from `thisYear`). */
export function dateText(localDate: string, thisYear?: number): string {
	const [y, m, d] = localDate.split("-").map(Number) as [number, number, number];
	const weekday = new Date(Date.UTC(y, m - 1, d)).getUTCDay();
	return `${DAYS[weekday]} ${MONTHS[m - 1]} ${d}${thisYear !== undefined && y !== thisYear ? `, ${y}` : ""}`;
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

/** Each section's start time: the first at the meeting's start, each next when the one before it ends. */
export function sectionStarts(localTime: string, sections: readonly { minutes: number }[]): string[] {
	return sections.reduce<string[]>(
		(all, _, i) => [...all, i === 0 ? localTime : addMinutes(all[i - 1]!, sections[i - 1]!.minutes)],
		[],
	);
}
