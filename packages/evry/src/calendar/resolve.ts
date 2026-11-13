// calendar.resolve and calendar.getContext as pure functions: a church's local date and time to the exact instant, with
// the two DST cases named instead of guessed. A local time in the spring-forward gap does not exist; a local time in
// the fall-back fold happens twice, once at each offset. Intl's zone data is the only source, so the answer follows
// the same rules the review cards format with.

const pad = (n: number) => String(n).padStart(2, "0");
/** "+05:30", "-04:00": an offset in minutes east of UTC. */
export const offsetText = (minutes: number) =>
	`${minutes < 0 ? "-" : "+"}${pad(Math.floor(Math.abs(minutes) / 60))}:${pad(Math.abs(minutes) % 60)}`;

const parts = (zone: string, at: Date) =>
	Object.fromEntries(
		new Intl.DateTimeFormat("en-US", {
			timeZone: zone,
			hourCycle: "h23",
			year: "numeric",
			month: "2-digit",
			day: "2-digit",
			hour: "2-digit",
			minute: "2-digit",
			second: "2-digit",
		})
			.formatToParts(at)
			.map((p) => [p.type, p.value]),
	) as Record<string, string>;
/** The zone's offset from UTC at an instant, in minutes. */
function offsetAt(zone: string, at: Date) {
	const p = parts(zone, at);
	const wall = Date.UTC(+p.year!, +p.month! - 1, +p.day!, +p.hour!, +p.minute!, +p.second!);
	return Math.round((wall - Math.floor(at.getTime() / 1000) * 1000) / 60_000);
}
const shortZone = (zone: string, at: Date) =>
	new Intl.DateTimeFormat("en-US", { timeZone: zone, timeZoneName: "short" })
		.formatToParts(at)
		.find((p) => p.type === "timeZoneName")!.value;
/** "Sun, Nov 1, 2026, 1:30 AM EDT": the date, the time and the zone, as a review card shows it. */
export const localLabel = (zone: string, at: Date) =>
	`${new Intl.DateTimeFormat("en-US", { timeZone: zone, weekday: "short", month: "short", day: "numeric", year: "numeric", hour: "numeric", minute: "2-digit" }).format(at)} ${shortZone(zone, at)}`;

export type Moment = { instant: string; offset: string; label: string };
export type Resolved =
	| { status: "exact"; local: string; zone: string; at: Moment }
	/** The time happens twice that day: once at each offset, the earlier first. */
	| { status: "ambiguous"; local: string; zone: string; options: [Moment, Moment] }
	/** The clocks skip this time that day; `skippedMinutes` is how far they jump. */
	| { status: "nonexistent"; local: string; zone: string; skippedMinutes: number }
	| { status: "invalid_date"; local: string; zone: string };

const LOCAL_DATE = /^(\d{4})-(\d{2})-(\d{2})$/;
const LOCAL_TIME = /^(\d{2}):(\d{2})$/;

/**
 * The instant(s) a church's local date and time names in its zone. `offset` chooses one of the two in a fold, as the
 * user picked it; an offset the time never has is ignored, so the answer stays ambiguous.
 */
export function resolveLocal(zone: string, date: string, time: string, offset?: string): Resolved {
	const local = `${date}T${time}`;
	const d = LOCAL_DATE.exec(date);
	const t = LOCAL_TIME.exec(time);
	if (!d || !t) return { status: "invalid_date", local, zone };
	const [y, mo, da, h, mi] = [+d[1]!, +d[2]!, +d[3]!, +t[1]!, +t[2]!];
	const wall = Date.UTC(y, mo - 1, da, h, mi);
	const check = new Date(wall);
	if (check.getUTCMonth() !== mo - 1 || check.getUTCDate() !== da || h > 23 || mi > 59)
		return { status: "invalid_date", local, zone };
	// Every offset the zone uses within a day either side; each one that maps back to the same wall time is a match.
	const offsets = [...new Set([-1, 0, 1].map((day) => offsetAt(zone, new Date(wall + day * 86_400_000))))];
	const moments = offsets
		.map((o) => new Date(wall - o * 60_000))
		.filter((at) => offsetAt(zone, at) * 60_000 + at.getTime() === wall)
		.sort((a, b) => a.getTime() - b.getTime())
		.map((at) => ({ instant: at.toISOString(), offset: offsetText(offsetAt(zone, at)), label: localLabel(zone, at) }));
	if (!moments.length)
		return { status: "nonexistent", local, zone, skippedMinutes: Math.abs(offsets[offsets.length - 1]! - offsets[0]!) };
	const chosen = moments.length > 1 ? moments.find((m) => m.offset === offset) : moments[0];
	if (chosen) return { status: "exact", local, zone, at: chosen };
	return { status: "ambiguous", local, zone, options: [moments[0]!, moments[1]!] };
}

/** calendar.getContext: today in the church's zone, so "Friday" or "the 5th" are read against the church's own calendar. */
export function calendarContext(zone: string, now: Date) {
	const p = parts(zone, now);
	return {
		zone,
		today: `${p.year}-${p.month}-${p.day}`,
		weekday: new Intl.DateTimeFormat("en-US", { timeZone: zone, weekday: "long" }).format(now),
		localTime: `${p.hour}:${p.minute}`,
		offset: offsetText(offsetAt(zone, now)),
		zoneName: shortZone(zone, now),
	};
}
