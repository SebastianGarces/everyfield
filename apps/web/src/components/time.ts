const zoneCache = new Map<string, string>();

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
export function allZones(): string[] {
	if (!zones) {
		const listed = typeof Intl.supportedValuesOf === "function" ? Intl.supportedValuesOf("timeZone") : [];
		zones = ["UTC", ...listed.filter((z) => z !== "UTC")];
	}
	return zones;
}

export function formatInstant(instant: string, zone: string, withZone = false): string {
	return new Intl.DateTimeFormat("en-US", {
		timeZone: zone,
		weekday: "short",
		month: "short",
		day: "numeric",
		hour: "numeric",
		minute: "2-digit",
		...(withZone ? { timeZoneName: "short" as const } : {}),
	}).format(new Date(instant));
}

export function formatMoment(instant: string, zone: string): string {
	const d = new Date(instant);
	const date = new Intl.DateTimeFormat("en-US", {
		timeZone: zone,
		month: "long",
		day: "numeric",
		year: "numeric",
	}).format(d);
	const time = new Intl.DateTimeFormat("en-US", {
		timeZone: zone,
		hour: "numeric",
		minute: "2-digit",
		timeZoneName: "short",
	}).format(d);
	return `${date} at ${time}`;
}

export function formatLocalDate(date: string): string {
	const [y, m, d] = date.split("-").map(Number);
	return new Intl.DateTimeFormat("en-US", { timeZone: "UTC", month: "short", day: "numeric" }).format(
		new Date(Date.UTC(y!, m! - 1, d!)),
	);
}

export const WEEKDAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"] as const;

export function hourLabel(hour: number): string {
	const h = hour % 12 === 0 ? 12 : hour % 12;
	return `${h}:00 ${hour < 12 ? "AM" : "PM"}`;
}

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
