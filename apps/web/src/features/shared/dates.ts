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
