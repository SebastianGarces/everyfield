import type { Transaction } from "@everyfield/db/client";
import { sql } from "@everyfield/db/query";
import { liveRead } from "@everyfield/domain/access";
import { z } from "zod";
import type { EvryActor } from "../../../context/actor.ts";
import type { ReadAdapter, SourceResult } from "../../../catalog/types.ts";
import { calendarContext, resolveLocal } from "../../../calendar/resolve.ts";

// The calendar helpers (WP-085): the church's own calendar, so everyday date words become one exact local date, time and
// zone before any review card names them. Each reads the church's time zone in one statement with the lock-free live
// access check (C13, C27); the date math itself is pure (calendar/resolve.ts). Any seat in the church may use them.

const inPlant = (actor: EvryActor) => actor.owner.kind === "plant" && actor.role !== null;

/** The church's IANA time zone, or null when the actor's access ended. */
async function churchZone(tx: Transaction, actor: EvryActor) {
	const r = await tx.execute(sql`SELECT pl.timezone FROM plant pl WHERE pl.id=${actor.owner.id}::uuid
		AND ${liveRead({ session: actor.session, owner: actor.owner, seatId: actor.seatId ?? undefined })}`);
	return z
		.string()
		.nullable()
		.parse(r.rows[0]?.timezone ?? null);
}
const answer = (operation: string, id: string, label: string, fields: SourceResult["rows"][number]["fields"]) =>
	({
		operation,
		status: "available",
		rows: [{ kind: "date", id, label, fields }],
		total: 1,
		page: 1,
		next: null,
		completeness: "complete",
		exclusions: [],
	}) satisfies SourceResult;
const unavailable = (operation: string): SourceResult => ({
	operation,
	status: "not_found",
	rows: [],
	total: 0,
	page: 1,
	next: null,
	completeness: "complete",
	exclusions: [],
});

export const getContext: ReadAdapter<Record<string, never>> = {
	operation: "calendar.getContext",
	description:
		"Today's date, weekday, local time and time zone in this church, to read words like today, Friday, next week or the 5th against.",
	input: z.strictObject({}),
	allowed: inPlant,
	async invoke(tx, actor) {
		const zone = await churchZone(tx, actor);
		if (!zone) return unavailable("calendar.getContext");
		// The host clock: the turn's trusted server clock, the same one the system prompt names.
		const today = calendarContext(zone, new Date());
		return answer("calendar.getContext", today.today, `Today in ${zone}`, today);
	},
};

const resolveInput = z.strictObject({
	date: z
		.string()
		.regex(/^\d{4}-\d{2}-\d{2}$/)
		.describe("The church's local date, like 2026-11-01"),
	time: z
		.string()
		.regex(/^\d{2}:\d{2}$/)
		.describe("The church's local time on a 24-hour clock, like 01:30"),
	offset: z
		.string()
		.regex(/^[+-]\d{2}:\d{2}$/)
		.optional()
		.describe("Only after the user chose one of the two times of an ambiguous answer: that option's offset"),
});
export const resolve: ReadAdapter<z.infer<typeof resolveInput>> = {
	operation: "calendar.resolve",
	description:
		"Check one local date and time in this church's time zone before using it: exact (with its zone), ambiguous (the time happens twice that day as the clocks fall back: ask which one), nonexistent (the clocks skip it that day: ask for another time) or invalid_date.",
	input: resolveInput,
	allowed: inPlant,
	async invoke(tx, actor, input) {
		const zone = await churchZone(tx, actor);
		if (!zone) return unavailable("calendar.resolve");
		const r = resolveLocal(zone, input.date, input.time, input.offset);
		const fields: Record<string, string | null> = { status: r.status, local: r.local, zone: r.zone };
		if (r.status === "exact") Object.assign(fields, { instant: r.at.instant, offset: r.at.offset, shows: r.at.label });
		if (r.status === "ambiguous")
			r.options.forEach((o, n) =>
				Object.assign(fields, { [`option${n + 1}`]: o.label, [`option${n + 1}Offset`]: o.offset }),
			);
		if (r.status === "nonexistent") fields.clocksSkipMinutes = String(r.skippedMinutes);
		return answer("calendar.resolve", r.local, r.local, fields);
	},
};

/** The installed calendar read tools, in catalog order. */
export const CALENDAR_READS = [getContext, resolve] as const;
