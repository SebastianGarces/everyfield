/** The scheduling window: now through the next 30 days. Shared by Review and the history detail. */
export const WINDOW_MS = 30 * 24 * 60 * 60 * 1000;

const pad = (n: number) => String(n).padStart(2, "0");
/** A local `datetime-local` value. */
export const localStamp = (d: Date) =>
	`${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;

export const windowBounds = (now = new Date()) => ({
	min: localStamp(now),
	max: localStamp(new Date(now.getTime() + WINDOW_MS)),
});

/** True when the instant is not in the past (one minute of slack) and not beyond the window. */
export const insideWindow = (at: Date, now = Date.now()) =>
	!Number.isNaN(at.getTime()) && at.getTime() >= now - 60_000 && at.getTime() <= now + WINDOW_MS;
