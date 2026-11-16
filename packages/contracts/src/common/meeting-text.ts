const DAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
export const MEETING_TYPE_TITLE = {
	vision_meeting: "Vision Meeting",
	orientation: "Orientation",
	team_meeting: "Team Meeting",
	prelaunch_practice: "Pre-launch Practice",
} as const;

export const defaultTitle = (m: { type: keyof typeof MEETING_TYPE_TITLE; visionNumber: number | null }) =>
	MEETING_TYPE_TITLE[m.type] + (m.visionNumber ? ` #${m.visionNumber}` : "");
export const meetingTitle = (m: Parameters<typeof defaultTitle>[0] & { title: string | null }) =>
	m.title?.trim() || defaultTitle(m);

export function timeText(localTime: string): string {
	const [h, min] = localTime.split(":").map(Number) as [number, number];
	const suffix = h < 12 ? "am" : "pm";
	const hour = h % 12 === 0 ? 12 : h % 12;
	return `${hour}:${String(min).padStart(2, "0")} ${suffix}`;
}

export function dateText(localDate: string, thisYear?: number): string {
	const [y, m, d] = localDate.split("-").map(Number) as [number, number, number];
	const weekday = new Date(Date.UTC(y, m - 1, d)).getUTCDay();
	return `${DAYS[weekday]} ${MONTHS[m - 1]} ${d}${thisYear !== undefined && y !== thisYear ? `, ${y}` : ""}`;
}

export function addMinutes(localTime: string, minutes: number): string {
	const [h, m] = localTime.split(":").map(Number) as [number, number];
	const total = (((h * 60 + m + minutes) % 1440) + 1440) % 1440;
	return `${String(Math.floor(total / 60)).padStart(2, "0")}:${String(total % 60).padStart(2, "0")}`;
}

export function durationText(minutes: number): string {
	if (minutes < 60) return `${minutes} min`;
	const h = Math.floor(minutes / 60);
	const rest = minutes % 60;
	return rest ? `${h} h ${rest} min` : `${h} h`;
}

export function sectionStarts(localTime: string, sections: readonly { minutes: number }[]): string[] {
	return sections.reduce<string[]>(
		(all, _, i) => [...all, i === 0 ? localTime : addMinutes(all[i - 1]!, sections[i - 1]!.minutes)],
		[],
	);
}
