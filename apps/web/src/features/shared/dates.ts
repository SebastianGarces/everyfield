// Date words the features share, so a date reads the same on every screen. Pure and relative-import only, so node
// tests can import it by path.

/** Short English month names, January first, for building "Oct 12" style labels by month index. */
export const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** "Oct 3, 2026" for an instant, on the calendar of `zone`. Used where the day matters and the hour adds nothing. */
export function formatDay(instant: string, zone: string): string {
	return new Intl.DateTimeFormat("en-US", { timeZone: zone, month: "short", day: "numeric", year: "numeric" }).format(
		new Date(instant),
	);
}

/** "UTC−5" or "UTC+5:30" for a UTC offset in seconds. A fold choice names its offset: zone abbreviations vary. */
export function offsetText(seconds: number): string {
	const sign = seconds < 0 ? "−" : "+";
	const abs = Math.abs(seconds),
		h = Math.floor(abs / 3600),
		m = Math.round((abs % 3600) / 60);
	return `UTC${sign}${h}${m ? `:${String(m).padStart(2, "0")}` : ""}`;
}
