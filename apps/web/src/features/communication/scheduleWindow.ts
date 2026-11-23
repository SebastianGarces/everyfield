import { SCHEDULE_WINDOW_MS } from "@everyfield/contracts/communication";
import { localInputAt } from "../../components/time.ts";

export const windowBounds = (now: number, zone: string) => ({
	min: localInputAt(now, zone),
	max: localInputAt(now + SCHEDULE_WINDOW_MS, zone),
});

export const insideWindow = (at: Date, now = Date.now()) =>
	!Number.isNaN(at.getTime()) && at.getTime() >= now - 60_000 && at.getTime() <= now + SCHEDULE_WINDOW_MS;
