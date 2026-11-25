import { sql, type SQL } from "@everyfield/db/query";
import { withSettingsWrite } from "@everyfield/domain/settings";
import { owner, timeZone as timeZoneValue } from "@everyfield/contracts/common";
import { digestSchedule as digestScheduleValue, plantProfile, settingsName } from "@everyfield/contracts/settings";
import { z } from "zod";
import { EvryRefusal } from "../../../context/errors.ts";
import { regionLabel } from "@everyfield/contracts/oversight";
import {
	anySeat,
	change,
	committed,
	nativeWrite,
	ownContext,
	patchChanges,
	plantAdmin,
	reviewed,
	rowId,
	scheduleText,
	settled,
} from "../../native.ts";
import { placeText, regionCandidates, statedLocality } from "../reads/index.ts";
import { ZONE_NAME } from "../../../catalog/labels.ts";

const PROFILE_COLUMN = {
	name: "name",
	street: "street",
	city: "city",
	stateProvince: "state_province",
	country: "country",
	description: "description",
} as const;
const profilePatch = plantProfile.partial().refine((p) => Object.keys(p).length > 0, "empty patch");

export const updateProfile = nativeWrite({
	operation: "plant.updateProfile",
	description:
		"Propose a change to this church's profile: its name, street, city, state or province, country or description. Nothing changes until the user approves the exact review.",
	input: z.strictObject({ patch: profilePatch }),
	allowed: plantAdmin,
	review(actor, value) {
		return sql`SELECT jsonb_build_object('target',jsonb_build_object('kind','church','id',pl.id,'label',pl.name),
				'changes',${patchChanges(value.patch, PROFILE_COLUMN, sql`pl`)}) AS review,
			jsonb_build_object('expectedRevision',pl.revision::text,'input',jsonb_build_object('plant',jsonb_build_object('kind','plant','id',pl.id),
				'patch',${JSON.stringify(value.patch)}::jsonb)) AS args
			FROM plant pl WHERE pl.id=${actor.owner.id}::uuid`;
	},
	async run(tx, context, request, { ports }) {
		settled(await ports.settings.updatePlantProfile(tx, context, request));
	},
});

const SHOWN = 8;
const zoneName = (zone: string) => ZONE_NAME[zone] ?? zone;
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
		const saved = settled(await ports.settings.setPlantTimezone(tx, context, request));
		return { revision: saved.revision };
	},
});

type DigestSchedule = z.infer<typeof digestScheduleValue>;

export const setDigestSchedule = nativeWrite({
	operation: "church.digestSchedule.set",
	description:
		"Propose when the church-wide planter digest goes out for everyone in this church who gets it, as Settings > Church sets it: off, daily at a whole hour, or weekly on one day (weekday 0 is Sunday, 6 is Saturday) at a whole hour (0-23), in the church's time zone. There are no other choices: no minutes, no several days a week. Use this when the user names the church digest's day or hour or turns the church digest off; how often the user's own digest comes (daily or weekly) is notifications.digestCadence.set. Owner or Admin. Nothing changes until the user approves the exact review.",
	input: z.strictObject({ schedule: digestScheduleValue }),
	allowed: plantAdmin,
	async review(actor, value, { db }) {
		const [pl] = (
			await db.execute(
				sql`SELECT name,timezone,revision::text AS revision,digest_cadence,digest_weekday,digest_hour FROM plant WHERE id=${actor.owner.id}::uuid`,
			)
		).rows as {
			name: string;
			timezone: string;
			revision: string;
			digest_cadence: string;
			digest_weekday: number;
			digest_hour: number;
		}[];
		if (!pl) return null;
		const before = scheduleText({
			cadence: pl.digest_cadence,
			weekday: pl.digest_weekday,
			hour: pl.digest_hour,
		} as DigestSchedule);
		const after = scheduleText(value.schedule);
		const review: Record<string, unknown> = {
			target: { kind: "church", id: actor.owner.id, label: pl.name },
			changes: [{ field: "digestSchedule", before, after }],
			notes: [
				`Times are in ${zoneName(pl.timezone)} time (${pl.timezone}), the church's time zone.`,
				"This changes the church digest for everyone who gets it.",
			],
		};
		if (before === after)
			review.refusal = "The church digest already goes out on this schedule, so nothing would change.";
		const args = {
			expectedRevision: pl.revision,
			input: { plant: { kind: "plant", id: actor.owner.id }, schedule: value.schedule },
		};
		return sql`SELECT ${JSON.stringify(review)}::jsonb AS review, ${JSON.stringify(args)}::jsonb AS args`;
	},
	async run(tx, context, request, { ports }) {
		settled(await ports.settings.setDigestSchedule(tx, context, request));
	},
});

export const correctReportingLocation = nativeWrite({
	operation: "organizations.correctReportingLocation",
	description:
		"Propose correcting this church's reporting place and Region, as Settings > Church saves them: the Region (regionItemId, a candidate row of geography.listReportingRegionCandidates) and the same city, state or province and country it was listed for (leave them out for the saved place). The history keeps the earlier place. Owner or Admin. Nothing changes until the user approves the exact review.",
	input: statedLocality.extend({ regionItemId: rowId }),
	allowed: plantAdmin,
	async review(actor, { regionItemId, ...stated }, { db }) {
		const { saved, locality, candidates } = await regionCandidates(db, actor, stated);
		const region = candidates.find((x) => x.regionItemId === regionItemId);
		if (!region) throw new EvryRefusal("invalid_input");
		if (!saved.referenceVersionId) throw new EvryRefusal("source_unavailable");
		const before = { place: placeText(saved.locality), region: saved.region ? regionLabel(saved.region) : null };
		const after = { place: placeText(locality), region: regionLabel(region.area) };
		const same = before.place === after.place && before.region === after.region;
		return reviewed(
			{
				target: { kind: "church", id: actor.owner.id, label: "Reporting Region" },
				changes: [
					{ field: "reportingPlace", before: before.place, after: after.place },
					{ field: "reportingRegion", before: before.region, after: after.region },
				],
				notes: [
					"It takes effect when you approve. The earlier place and Region stay in the history, and earlier Network Intelligence runs keep them.",
				],
				...(same && { refusal: "The reporting place and Region are already this, so nothing would change." }),
			},
			{
				expectedRevision: saved.revision,
				input: {
					plant: { kind: "plant", id: actor.owner.id },
					locality,
					referenceVersionId: saved.referenceVersionId,
					regionItemId,
				},
			},
		);
	},
	async run(tx, context, request, { ports }) {
		committed(
			await ports.organizations["organizations.correctReportingLocation"](
				tx,
				context.session,
				context.selected,
				request,
			),
		);
	},
});

const days = z.int().min(1).max(365);
const sectionInput = z.discriminatedUnion("section", [
	z.strictObject({ section: z.literal("account"), name: settingsName.describe("The user's own new account name") }),
	z.strictObject({
		section: z.literal("church"),
		warningDays: days.optional().describe("Days without activity before a warning; leave out to keep it"),
		alertDays: days.optional().describe("Days without activity before an alert; leave out to keep it"),
	}),
]);
export const saveSection = nativeWrite({
	operation: "settings.saveSection",
	description:
		"Propose changing the user's own account name (section account, any user), or the church's inactivity days (section church, Owner or Admin): the warning days must be fewer than the alert days. The church's profile is plant.updateProfile, its digest church.digestSchedule.set, an organization's profile organizations.updateProfile: never prepare this one for those. Nothing changes until the user approves the exact review.",
	input: sectionInput,
	allowed: anySeat,
	review(actor, value) {
		if (value.section === "account")
			return sql`SELECT jsonb_build_object('target',jsonb_build_object('kind','account','id',a.id,'label',n.display_name),
					'changes',jsonb_build_array(${change("accountName", sql`to_jsonb(n.display_name)`, value.name)}))
					||CASE WHEN n.display_name=${value.name}::text THEN jsonb_build_object('refusal','That is already your account name, so nothing would change.') ELSE '{}'::jsonb END AS review,
				jsonb_build_object('expectedRevision',a.revision::text,'input',jsonb_build_object('section','account','name',${value.name}::text)) AS args
				FROM account a CROSS JOIN LATERAL seat_identity(a.id) n WHERE a.id=${actor.accountId}::uuid`;
		if (!plantAdmin(actor)) throw new EvryRefusal("access_denied");
		const warning = sql`coalesce(${value.warningDays ?? null}::int,pl.warning_days)`;
		const alert = sql`coalesce(${value.alertDays ?? null}::int,pl.alert_days)`;
		const row = (field: string, before: SQL, after: SQL) =>
			sql`jsonb_build_object('field',${field}::text,'before',${before},'after',${after})`;
		return sql`SELECT jsonb_build_object('target',jsonb_build_object('kind','church','id',pl.id,'label',pl.name),
				'changes',jsonb_build_array(${row("warningDays", sql`pl.warning_days`, warning)},${row("alertDays", sql`pl.alert_days`, alert)}))
				||CASE WHEN ${warning}>=${alert} THEN jsonb_build_object('refusal','The warning has to come before the alert: choose fewer warning days than alert days.')
					WHEN ${warning}=pl.warning_days AND ${alert}=pl.alert_days THEN jsonb_build_object('refusal','Those are already the inactivity days, so nothing would change.')
					ELSE '{}'::jsonb END AS review,
			jsonb_build_object('expectedRevision',pl.revision::text,'input',jsonb_build_object('section','plant','plant',jsonb_build_object('kind','plant','id',pl.id),
				'change',jsonb_build_object('kind','inactivity','value',jsonb_build_object('warningDays',${warning},'alertDays',${alert})))) AS args
			FROM plant pl WHERE pl.id=${actor.owner.id}::uuid`;
	},
	async run(tx, context, request, { authority, ports }) {
		const own = (request.input as { section?: unknown }).section === "account";
		const saved = settled(
			await ports.settings.saveSection(tx, own ? ownContext(context, authority.actor.accountId) : context, request),
		);
		return "revision" in saved.current ? { revision: saved.current.revision } : undefined;
	},
});

export const CHURCH_COMMANDS = {
	"settings.saveSection": saveSection,
	"plant.updateProfile": updateProfile,
	"plant.setTimezone": setTimezone,
	"church.digestSchedule.set": setDigestSchedule,
	"organizations.correctReportingLocation": correctReportingLocation,
} as const;
