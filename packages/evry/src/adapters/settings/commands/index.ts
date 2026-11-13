import { sql } from "@everyfield/db/query";
import { withSettingsWrite } from "@everyfield/domain/settings";
import { owner, timeZone as timeZoneValue } from "@everyfield/contracts/common";
import { plantProfile } from "@everyfield/contracts/settings";
import { z } from "zod";
import { EvryRefusal } from "../../../context/errors.ts";
import { change, nativeWrite, plantAdmin, settled } from "../../native.ts";

// The church settings reviewed writes: the church profile and its time zone, through the same Settings commands the
// Church section runs. A time zone review first runs the native preview, which saves what the change moves, and shows
// those items with their new times; the save then binds that exact preview.

const PROFILE_COLUMN = {
	name: "name",
	street: "street",
	city: "city",
	stateProvince: "state_province",
	country: "country",
	description: "description",
} as const;
export const profilePatch = plantProfile.partial().refine((p) => Object.keys(p).length > 0, "empty patch");

export const updateProfile = nativeWrite({
	operation: "plant.updateProfile",
	description:
		"Propose a change to this church's profile: its name, street, city, state or province, country or description. Nothing changes until the user approves the exact review.",
	input: z.strictObject({ patch: profilePatch }),
	allowed: plantAdmin,
	review(actor, value) {
		const changes = Object.entries(value.patch).map(([field, after], n) => ({
			n,
			field,
			col: PROFILE_COLUMN[field as keyof typeof PROFILE_COLUMN],
			after: after ?? null,
		}));
		return sql`SELECT jsonb_build_object('target',jsonb_build_object('kind','church','id',pl.id,'label',pl.name),
				'changes',(SELECT jsonb_agg(jsonb_build_object('field',k.field,'before',to_jsonb(pl)->k.col,'after',k.after) ORDER BY k.n)
					FROM jsonb_to_recordset(${JSON.stringify(changes)}::jsonb) k(n int,field text,col text,after jsonb))) AS review,
			jsonb_build_object('expectedRevision',pl.revision::text,'input',jsonb_build_object('plant',jsonb_build_object('kind','plant','id',pl.id),
				'patch',${JSON.stringify(value.patch)}::jsonb)) AS args
			FROM plant pl WHERE pl.id=${actor.owner.id}::uuid`;
	},
	async run(tx, context, request, { ports }) {
		settled(await ports.settings.updatePlantProfile(tx, context, request as never));
	},
});

/** The longest list of moved items a review shows; the rest are counted. */
const SHOWN = 8;
const ZONE_NAME: Record<string, string> = {
	"America/New_York": "Eastern",
	"America/Chicago": "Central",
	"America/Denver": "Mountain",
	"America/Phoenix": "Arizona",
	"America/Los_Angeles": "Pacific",
	"America/Anchorage": "Alaska",
	"Pacific/Honolulu": "Hawaii",
};
export const zoneName = (zone: string) => ZONE_NAME[zone] ?? zone;
const day = (instant: string, zone: string) =>
	new Intl.DateTimeFormat("en-US", { weekday: "short", month: "short", day: "numeric", timeZone: zone }).format(
		new Date(instant),
	);
const time = (instant: string, zone: string) =>
	new Intl.DateTimeFormat("en-US", { hour: "numeric", minute: "2-digit", timeZone: zone }).format(new Date(instant));

export const setTimezone = nativeWrite({
	operation: "plant.setTimezone",
	description:
		"Propose changing this church's time zone (an IANA zone such as America/New_York). The review lists the upcoming times it moves. Nothing changes until the user approves the exact review.",
	input: z.strictObject({ timeZone: timeZoneValue }),
	allowed: plantAdmin,
	async review(actor, value, { db, native }) {
		if (!native) throw new EvryRefusal("source_unavailable");
		const plant = owner.parse({ kind: "plant", id: actor.owner.id }) as { kind: "plant"; id: never };
		const context = { session: actor.authority.session, selected: plant };
		// The native preview saves what this change moves, bound to the church's current revision for 15 minutes.
		const preview = settled(
			await withSettingsWrite(db, actor.authority, context, (tx) =>
				native.settings.previewPlantTimezone(tx, context, { plant, timeZone: value.timeZone }),
			),
		);
		const titles = new Map<string, string>(
			preview.reminders.length
				? (
						await db.execute(
							sql`SELECT id,title FROM task WHERE plant_id=${plant.id}::uuid AND id=ANY(${sql.param(preview.reminders.map((r) => String(r.id)))}::uuid[])`,
						)
					).rows.map((r) => [String(r.id), String(r.title)])
				: [],
		);
		// Every moved time in the new zone, before and after, the way the Church section's preview lists them.
		const zone = preview.newZone;
		const moved = [
			...preview.meetings.map((m) => ({ at: m.after, label: "Meeting", before: m.before, after: m.after })),
			...preview.digests.map((d) => ({ at: d.after, label: "Weekly digest email", before: d.before, after: d.after })),
			...preview.reminders.map((r) => ({
				at: r.after,
				label: `Reminder for "${titles.get(r.id) ?? "a task"}"`,
				before: r.before,
				after: r.after,
			})),
		].sort((a, b) => a.at.localeCompare(b.at));
		const lines = moved
			.slice(0, SHOWN)
			.map(
				(m) =>
					`${m.label}, ${day(m.after, zone)}: ${time(m.before, zone)} → ${time(m.after, zone)} ${zoneName(zone)} time`,
			);
		if (moved.length > SHOWN) lines.push(`And ${moved.length - SHOWN} more.`);
		const intro = moved.length
			? `These upcoming times move, shown in ${zoneName(zone)} time:`
			: "Nothing already planned moves. Dates stay the same.";
		return sql`SELECT jsonb_build_object('target',jsonb_build_object('kind','church','id',pl.id,'label',pl.name),
				'changes',jsonb_build_array(${change("timeZone", sql`to_jsonb(pl.timezone)`, zone)}),
				'notes',${JSON.stringify([intro, ...lines, "Task due dates keep their day."])}::jsonb) AS review,
			jsonb_build_object('expectedRevision',${preview.expectedRevision}::text,'input',jsonb_build_object('plant',jsonb_build_object('kind','plant','id',pl.id),
				'timeZone',${zone}::text,'previewId',${preview.previewId}::uuid)) AS args
			FROM plant pl WHERE pl.id=${plant.id}::uuid`;
	},
	async run(tx, context, request, { ports }) {
		const saved = settled(await ports.settings.setPlantTimezone(tx, context, request as never));
		return { revision: saved.revision };
	},
});

/** The installed church settings reviewed writes, keyed by operation. */
export const CHURCH_COMMANDS = {
	"plant.updateProfile": updateProfile,
	"plant.setTimezone": setTimezone,
} as const;
