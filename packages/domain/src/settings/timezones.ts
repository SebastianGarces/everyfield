import type { Clock } from "@everyfield/contracts/common";
import {
	addCivilDays,
	calendarContext,
	frozenClock,
	instant,
	localDate,
	localDateTime,
	resolveCalendar,
	timeZone,
} from "@everyfield/contracts/common";
import * as q from "@everyfield/contracts/settings";
import * as n from "@everyfield/contracts/settings/native";
import type {
	NativeAccountProducer,
	NativeSettingsContext,
	SettingsProducer,
} from "@everyfield/contracts/settings/server";
import { and, asc, eq, isNull, sql } from "@everyfield/db/query";
import { canonicalTimeZone } from "@everyfield/db/schema";
import * as t from "@everyfield/db/tables";
import { randomUUID } from "node:crypto";
import "server-only";
import { z } from "zod";
import {
	appendEvent,
	auditChange,
	begin,
	calendarEligible,
	deny,
	finish,
	hash,
	now,
	parse,
	plantAdmin,
	preference,
	reply,
	revision,
	self,
	type Tx,
} from "./core.ts";
import type { SettingsEffects } from "./sections.ts";
const personalRecord = z.object({ preference: n.personalTimezoneResult.shape.preference });
export interface PersonalCalendar {
	// WP-039 owns private plan storage. These handles must never contain a body,
	// calendar revision, author-existence flag or telemetry payload.
	preview(
		tx: Tx,
		ctx: NativeSettingsContext,
		input: { previewId: string; zone: string; expiresAt: string },
	): Promise<void>;
	apply(tx: Tx, ctx: NativeSettingsContext, input: { previewId: string; zone: string }): Promise<void>;
}
function automatic(date: string, hour: number, zone: string) {
	const resolved = resolveCalendar(
		localDateTime.parse(`${date}T${String(hour).padStart(2, "0")}:00:00`),
		timeZone.parse(zone),
		"automatic",
	);
	if (resolved.kind !== "resolved") throw Error("automatic_calendar_unresolved");
	return resolved;
}
async function schedule(tx: Tx, plant: typeof t.plant.$inferSelect, zone: string, asOf: string) {
	const tasks = await tx
		.select({ id: t.task.id, date: t.task.due_date, revision: t.task.revision })
		.from(t.task)
		.where(
			and(
				eq(t.task.plant_id, plant.id),
				eq(t.task.due_kind, "date_only"),
				isNull(t.task.deleted_at),
				sql`${t.task.status} NOT IN ('complete','no_longer_needed')`,
			),
		)
		.orderBy(asc(t.task.id))
		.for("share");
	const reminders = [];
	const preservedTaskDates = [];
	const warnings = new Set<"dst_fold_earlier" | "dst_gap_shifted" | "more_results">();
	const disclose = (r: ReturnType<typeof automatic>) => {
		if (r.adjustmentSeconds > 0) warnings.add("dst_gap_shifted");
		if (resolveCalendar(r.entered, r.zone, "entered").kind === "fold") warnings.add("dst_fold_earlier");
	};
	for (const row of tasks) {
		if (row.date === null) throw Error("date_only_task_missing_date");
		if (preservedTaskDates.length < 100) preservedTaskDates.push({ id: row.id, date: row.date });
		for (const day of [row.date, addCivilDays(localDate.parse(row.date), 1)]) {
			const before = automatic(day, 9, plant.timezone),
				after = automatic(day, 9, zone);
			if (before.occurrence.instant <= asOf) continue;
			disclose(after);
			if (before.occurrence.instant !== after.occurrence.instant && reminders.length < 100)
				reminders.push({ id: row.id, before: before.occurrence.instant, after: after.occurrence.instant });
		}
	}
	const digests = [];
	if (plant.digest_cadence !== "off") {
		const today = calendarContext(timeZone.parse(plant.timezone), frozenClock(instant.parse(asOf))).localDate;
		for (let i = 0; i < 14; i++) {
			const day = addCivilDays(today, i);
			if (plant.digest_cadence === "weekly" && new Date(day + "T00:00:00Z").getUTCDay() !== plant.digest_weekday)
				continue;
			const before = automatic(day, plant.digest_hour, plant.timezone),
				after = automatic(day, plant.digest_hour, zone);
			if (before.occurrence.instant > asOf && before.occurrence.instant !== after.occurrence.instant) {
				disclose(after);
				digests.push({ id: plant.id, before: before.occurrence.instant, after: after.occurrence.instant });
			}
		}
	}
	const bounded = (tasks.length > 50 || plant.digest_cadence !== "off") && zone !== plant.timezone;
	if (bounded) warnings.add("more_results");
	return {
		sources: hash({
			tasks,
			plant: {
				revision: plant.revision,
				timeZone: plant.timezone,
				digest: plant.digest_cadence,
				weekday: plant.digest_weekday,
				hour: plant.digest_hour,
			},
		}),
		meetings: [],
		reminders,
		digests,
		preservedTaskDates,
		completeness: bounded ? ("bounded" as const) : ("complete" as const),
		warnings: [...warnings],
	};
}
async function readClock(tx: Tx, id: string, clock?: Clock) {
	if (clock) return { at: new Date(clock.now()) };
	const [row] = await tx.select({ at: now }).from(t.account).where(eq(t.account.id, id));
	return row!;
}
export function timezoneOperations(
	effects: SettingsEffects,
	calendar?: PersonalCalendar,
	injectedClock?: Clock,
): Pick<SettingsProducer<Tx>, "previewPlantTimezone" | "setPlantTimezone"> &
	Pick<NativeAccountProducer<Tx>, "previewPersonalTimezone" | "setPersonalTimezone"> {
	return {
		previewPlantTimezone: (tx, ctx, raw) =>
			reply(tx, async (s) => {
				const v = parse(q.previewPlantTimezoneRequest, raw);
				const a = await plantAdmin(s, ctx, v.plant, "preview");
				const newZone = canonicalTimeZone(v.timeZone);
				const clock = await readClock(s, a.account.id, injectedClock);
				const asOf = clock.at.toISOString(),
					expiresAt = new Date(clock.at.getTime() + 15 * 60_000).toISOString(),
					previewId = randomUUID();
				const plan = await schedule(s, a.plant, newZone, asOf);
				const value = q.plantTimezonePreview.parse({
					previewId,
					plant: v.plant,
					expectedRevision: a.plant.revision,
					asOf,
					expiresAt,
					oldZone: a.plant.timezone,
					newZone,
					meetings: plan.meetings,
					reminders: plan.reminders,
					digests: plan.digests,
					preservedTaskDates: plan.preservedTaskDates,
					completeness: plan.completeness,
					warnings: plan.warnings,
				});
				await s.insert(t.settings_preview).values({
					id: previewId,
					account_id: a.account.id,
					tenant_id: v.plant.id,
					kind: "plant_timezone",
					expected_revision: a.plant.revision,
					value: { preview: value, sources: plan.sources },
					expires_at: new Date(expiresAt),
				});
				return value;
			}),
		setPlantTimezone: (tx, ctx, raw) =>
			reply(tx, async (s) => {
				const v = parse(q.setPlantTimezoneRequest, raw);
				const a = await plantAdmin(s, ctx, v.input.plant, "command");
				const zone = canonicalTimeZone(v.input.timeZone);
				const c = await begin(s, ctx, a.account.id, "plant.setTimezone", v);
				if (c.kind === "replay") return q.plantTimezoneResult.parse(c.value);
				revision(v.expectedRevision, a.plant.revision);
				// The preview row and the database clock in one statement.
				const [found] = await s
					.select({ saved: t.settings_preview, at: now })
					.from(t.settings_preview)
					.where(
						and(
							eq(t.settings_preview.id, v.input.previewId),
							eq(t.settings_preview.account_id, a.account.id),
							eq(t.settings_preview.tenant_id, a.plant.id),
							eq(t.settings_preview.kind, "plant_timezone"),
						),
					)
					.for("update");
				const at = injectedClock ? new Date(injectedClock.now()) : found?.at;
				if (!found || !at || found.saved.expires_at <= at) deny("stale_preview");
				const saved = found.saved;
				const plan = parse(z.object({ preview: q.plantTimezonePreview, sources: z.string() }), saved.value);
				if (plan.preview.newZone !== zone || saved.expected_revision !== a.plant.revision) deny("stale_preview");
				const current = await schedule(s, a.plant, zone, plan.preview.asOf);
				if (current.sources !== plan.sources) deny("stale_preview");
				const changed = a.plant.timezone !== zone;
				const next = changed ? String(BigInt(a.plant.revision) + 1n) : a.plant.revision;
				const events: string[] = [];
				let replanIntentId: string | undefined;
				if (changed) {
					c.writes.push(
						s
							.update(t.plant)
							.set({ timezone: zone, revision: next, material_revision: sql`${t.plant.material_revision}+1` })
							.where(eq(t.plant.id, a.plant.id)),
					);
					replanIntentId = await effects.replan(s, {
						owner: v.input.plant,
						revision: next,
						operationId: c.id,
						kind: "plant_timezone",
					});
					await effects.invalidate(s, { owner: v.input.plant, revision: next, operationId: c.id });
					const event = await appendEvent(
						s,
						c,
						a.plant.id,
						"preference",
						"plant.profile_changed",
						a.plant.revision,
						next,
					);
					auditChange(c, event, "plant", { timeZone: a.plant.timezone }, { timeZone: zone });
					events.push(event);
				}
				return finish(s, c, q.plantTimezoneResult, () =>
					changed
						? { status: "changed", plant: v.input.plant, timeZone: zone, revision: next, replanIntentId }
						: { status: "noop", plant: v.input.plant, timeZone: zone, revision: next },
				);
			}),
		previewPersonalTimezone: (tx, ctx, raw) =>
			reply(tx, async (s) => {
				const v = parse(n.previewPersonalTimezoneRequest, raw);
				const a = await self(s, ctx, "preview");
				const zone = canonicalTimeZone(v.timeZone);
				const clock = await readClock(s, a.account.id, injectedClock);
				const previewId = randomUUID(),
					expiresAt = new Date(clock.at.getTime() + 15 * 60_000).toISOString();
				if (calendar && (await calendarEligible(s, a.account.id)))
					await calendar.preview(s, ctx, { previewId, zone, expiresAt });
				const value = n.personalTimezonePreview.parse({
					previewId,
					preference: preference(a.account),
					expectedRevision: a.account.personal_timezone_revision,
					newZone: zone,
					asOf: clock.at.toISOString(),
					expiresAt,
				});
				await s.insert(t.settings_preview).values({
					id: previewId,
					account_id: a.account.id,
					tenant_id: a.account.id,
					kind: "personal_timezone",
					expected_revision: a.account.personal_timezone_revision,
					value,
					expires_at: new Date(expiresAt),
				});
				return value;
			}),
		setPersonalTimezone: (tx, ctx, raw) =>
			reply(tx, async (s) => {
				const v = parse(n.setPersonalTimezoneRequest, raw);
				const a = await self(s, ctx);
				const zone = canonicalTimeZone(v.input.timeZone);
				const c = await begin(s, { ...ctx }, a.account.id, "account.setPersonalTimezone", v);
				if (c.kind === "replay")
					return n.personalTimezoneResult.parse({ preference: personalRecord.parse(c.value).preference });
				revision(v.expectedRevision, a.account.personal_timezone_revision);
				// The preview row and the database clock in one statement.
				const [found] = await s
					.select({ saved: t.settings_preview, at: now })
					.from(t.settings_preview)
					.where(
						and(
							eq(t.settings_preview.id, v.input.previewId),
							eq(t.settings_preview.account_id, a.account.id),
							eq(t.settings_preview.tenant_id, a.account.id),
							eq(t.settings_preview.kind, "personal_timezone"),
						),
					)
					.for("update");
				const at = injectedClock ? new Date(injectedClock.now()) : found?.at;
				if (!found || !at || found.saved.expires_at <= at) deny("stale_preview");
				const saved = found.saved;
				const plan = parse(n.personalTimezonePreview, saved.value);
				if (plan.newZone !== zone || plan.expectedRevision !== a.account.personal_timezone_revision)
					deny("stale_preview");
				if (a.account.personal_timezone !== zone) {
					if (calendar && (await calendarEligible(s, a.account.id)))
						await calendar.apply(s, ctx, { previewId: saved.id, zone });
					const next = String(BigInt(a.account.personal_timezone_revision) + 1n);
					await s
						.update(t.account)
						.set({ personal_timezone: zone, personal_timezone_revision: next, revision: sql`${t.account.revision}+1` })
						.where(eq(t.account.id, a.account.id));
					// Preference-only operation/intent. No private author existence or calendar metadata.
					await effects.replan(s, {
						owner: ctx.selected,
						revision: next,
						operationId: c.id,
						kind: "personal_timezone",
					});
					const result = await finish(s, c, personalRecord, () => ({
						preference: { status: "confirmed", timeZone: zone, revision: next },
					}));
					return n.personalTimezoneResult.parse({ preference: result.preference });
				}
				const result = await finish(s, c, personalRecord, () => ({ preference: preference(a.account) }));
				return n.personalTimezoneResult.parse({ preference: result.preference });
			}),
	};
}
