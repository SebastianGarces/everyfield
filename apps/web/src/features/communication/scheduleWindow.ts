import { SCHEDULE_WINDOW_MS } from "@everyfield/contracts/communication";

const pad = (n: number) => String(n).padStart(2, "0");
const localStamp = (d: Date) =>
	`${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;

export const windowBounds = (now = new Date()) => ({
	min: localStamp(now),
	max: localStamp(new Date(now.getTime() + SCHEDULE_WINDOW_MS)),
});

export const insideWindow = (at: Date, now = Date.now()) =>
	!Number.isNaN(at.getTime()) && at.getTime() >= now - 60_000 && at.getTime() <= now + SCHEDULE_WINDOW_MS;
