import { captured, present } from "../runtime/captured.ts";

const pad = (n: number) => String(n).padStart(2, "0");
const offsetText = (minutes: number) =>
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
function offsetAt(zone: string, at: Date) {
	const p = parts(zone, at);
	const wall = Date.UTC(
		+present(p.year),
		+present(p.month) - 1,
		+present(p.day),
		+present(p.hour),
		+present(p.minute),
		+present(p.second),
	);
	return Math.round((wall - Math.floor(at.getTime() / 1000) * 1000) / 60_000);
}
const shortZone = (zone: string, at: Date) =>
	present(
		new Intl.DateTimeFormat("en-US", { timeZone: zone, timeZoneName: "short" })
			.formatToParts(at)
			.find((p) => p.type === "timeZoneName"),
	).value;
const localLabel = (zone: string, at: Date) =>
	`${new Intl.DateTimeFormat("en-US", {
		timeZone: zone,
		weekday: "short",
		month: "short",
		day: "numeric",
		year: "numeric",
		hour: "numeric",
		minute: "2-digit",
	})
		.format(at)
		.replace(/\u202f/g, " ")} ${shortZone(zone, at)}`;

export type Moment = { instant: string; offset: string; label: string };
export type Resolved =
	| { status: "exact"; local: string; zone: string; at: Moment }
	| { status: "ambiguous"; local: string; zone: string; options: [Moment, Moment] }
	| { status: "nonexistent"; local: string; zone: string; skippedMinutes: number }
	| { status: "invalid_date"; local: string; zone: string };

const LOCAL_DATE = /^(\d{4})-(\d{2})-(\d{2})$/;
const LOCAL_TIME = /^(\d{2}):(\d{2})$/;

export function resolveLocal(zone: string, date: string, time: string, offset?: string): Resolved {
	const local = `${date}T${time}`;
	const d = LOCAL_DATE.exec(date);
	const t = LOCAL_TIME.exec(time);
	if (!d || !t) return { status: "invalid_date", local, zone };
	const [y, mo, da, h, mi] = [+captured(d, 1), +captured(d, 2), +captured(d, 3), +captured(t, 1), +captured(t, 2)];
	const wall = Date.UTC(y, mo - 1, da, h, mi);
	const check = new Date(wall);
	if (check.getUTCMonth() !== mo - 1 || check.getUTCDate() !== da || h > 23 || mi > 59)
		return { status: "invalid_date", local, zone };
	const offsets = [...new Set([-1, 0, 1].map((day) => offsetAt(zone, new Date(wall + day * 86_400_000))))];
	const moments = offsets
		.map((o) => new Date(wall - o * 60_000))
		.filter((at) => offsetAt(zone, at) * 60_000 + at.getTime() === wall)
		.sort((a, b) => a.getTime() - b.getTime())
		.map((at) => ({ instant: at.toISOString(), offset: offsetText(offsetAt(zone, at)), label: localLabel(zone, at) }));
	if (!moments.length)
		return {
			status: "nonexistent",
			local,
			zone,
			skippedMinutes: Math.abs(present(offsets[offsets.length - 1]) - present(offsets[0])),
		};
	const chosen = moments.length > 1 ? moments.find((m) => m.offset === offset) : moments[0];
	if (chosen) return { status: "exact", local, zone, at: chosen };
	return { status: "ambiguous", local, zone, options: [present(moments[0]), present(moments[1])] };
}

export function calendarContext(zone: string, now: Date) {
	const p = parts(zone, now);
	return {
		zone,
		today: `${p.year}-${p.month}-${p.day}`,
		weekday: new Intl.DateTimeFormat("en-US", { timeZone: zone, weekday: "long" }).format(now),
		offset: offsetText(offsetAt(zone, now)),
		zoneName: shortZone(zone, now),
	};
}
