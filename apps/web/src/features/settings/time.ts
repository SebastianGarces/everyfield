// Time zone and clock words for settings. Pure functions; the clock is always passed in, never read here.

const zoneCache = new Map<string, string>();

/** "Chicago · Central Time" from "America/Chicago". Falls back to the IANA name. */
export function zoneLabel(zone: string): string {
	const hit = zoneCache.get(zone);
	if (hit) return hit;
	const city = zone.split("/").pop()!.replaceAll("_", " ");
	let generic = "";
	try {
		generic =
			new Intl.DateTimeFormat("en-US", { timeZone: zone, timeZoneName: "longGeneric" })
				.formatToParts(new Date(Date.UTC(2026, 0, 15)))
				.find((p) => p.type === "timeZoneName")?.value ?? "";
	} catch {
		generic = "";
	}
	const label = generic && !generic.startsWith("GMT") && generic !== city ? `${city} · ${generic}` : city;
	zoneCache.set(zone, label);
	return label;
}

let zones: string[] | null = null;
/** Every IANA zone the browser knows, with UTC first. */
export function allZones(): string[] {
	if (!zones) {
		const listed = typeof Intl.supportedValuesOf === "function" ? Intl.supportedValuesOf("timeZone") : [];
		zones = ["UTC", ...listed.filter((z) => z !== "UTC")];
	}
	return zones;
}

/** "Mon, Oct 19, 9:00 AM" in the given zone. */
export function formatInstant(instant: string, zone: string): string {
	return new Intl.DateTimeFormat("en-US", {
		timeZone: zone,
		weekday: "short",
		month: "short",
		day: "numeric",
		hour: "numeric",
		minute: "2-digit",
	}).format(new Date(instant));
}

/** "October 19, 2026" for a deadline, in the given zone. */
export function formatDate(instant: string, zone: string): string {
	return new Intl.DateTimeFormat("en-US", { timeZone: zone, month: "long", day: "numeric", year: "numeric" }).format(
		new Date(instant),
	);
}

/** "Oct 19" for a LocalDate (YYYY-MM-DD), which has no zone. */
export function formatLocalDate(date: string): string {
	const [y, m, d] = date.split("-").map(Number);
	return new Intl.DateTimeFormat("en-US", { timeZone: "UTC", month: "short", day: "numeric" }).format(
		new Date(Date.UTC(y!, m! - 1, d!)),
	);
}

export const WEEKDAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"] as const;

/** "4:00 PM" for an hour 0..23. */
export function hourLabel(hour: number): string {
	const h = hour % 12 === 0 ? 12 : hour % 12;
	return `${h}:00 ${hour < 12 ? "AM" : "PM"}`;
}

/**
 * The first Monday strictly after `asOf` in `zone`, as a LocalDate. The private check-in week starts there
 * (REQ-IDN-033); the server's exact boundary still decides.
 */
export function nextMonday(asOf: string, zone: string): string {
	const parts = new Intl.DateTimeFormat("en-CA", {
		timeZone: zone,
		year: "numeric",
		month: "2-digit",
		day: "2-digit",
		weekday: "short",
	}).formatToParts(new Date(asOf));
	const get = (type: string) => parts.find((p) => p.type === type)!.value;
	const weekday = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].indexOf(get("weekday"));
	const local = Date.UTC(Number(get("year")), Number(get("month")) - 1, Number(get("day")));
	const ahead = (8 - weekday) % 7 || 7;
	return new Date(local + ahead * 86_400_000).toISOString().slice(0, 10);
}
