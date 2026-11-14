import {
	addCivilDays,
	instant,
	localDate,
	localDateTime,
	resolveCalendar,
	timeZone,
	type Instant,
} from "@everyfield/contracts/common";

function automatic(wall: string, zone: string): Instant {
	const resolved = resolveCalendar(localDateTime.parse(wall), timeZone.parse(zone), "automatic");
	if (resolved.kind !== "resolved") throw Error("calendar_unresolved");
	return resolved.occurrence.instant;
}
export function taskReminderTimes(
	due: { kind: "undated" } | { kind: "date_only"; date: string; zone: string } | { kind: "timed"; at: string },
) {
	if (due.kind === "undated") return [];
	if (due.kind === "timed") {
		const at = instant.parse(due.at);
		return [
			{ slot: "due" as const, at },
			{ slot: "overdue" as const, at: instant.parse(new Date(Date.parse(at) + 86_400_000).toISOString()) },
		];
	}
	const date = localDate.parse(due.date);
	return [
		{ slot: "due" as const, at: automatic(`${date}T09:00:00`, due.zone) },
		{ slot: "overdue" as const, at: automatic(`${addCivilDays(date, 1)}T09:00:00`, due.zone) },
	];
}
