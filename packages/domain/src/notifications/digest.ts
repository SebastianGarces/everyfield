import {
	MEETING_TYPE_TITLE,
	localDate,
	localDateTime,
	resolveCalendar,
	timeZone,
	type Instant,
	type TimeZone,
} from "@everyfield/contracts/common";
import {
	oversightDigestResult,
	planterDigestResult,
	readOversightDigestRequest,
	readPlanterDigestRequest,
} from "@everyfield/contracts/notifications";
import type { Database } from "@everyfield/db/client";
import { sql } from "@everyfield/db/query";
import { z } from "zod";
import { RequestActor, deny, jsonValue, parse, readReply, seatAccess } from "./core.ts";

const oversightRow = z.object({
	allowed: z.boolean(),
	timezone: z.string().nullable(),
	lines: z.array(z.object({ plant: z.uuid(), date: z.string(), count: z.number().int().positive() })),
});
const planterRow = z.object({
	timezone: z.string().nullable(),
	in_app: z.boolean().nullable(),
	cadence: z.enum(["daily", "weekly"]).nullable(),
	weekday: z.number().int().nullable(),
	hour: z.number().int().nullable(),
	allowed: z.boolean(),
});
const actions =
	"'tasks.changed','tasks.completed','meetings.changed','meetings.finalized','people.updated','people.created','plant.profile_changed'";

const weekdays = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"] as const;

/** The next stored slot in the plant zone. Not a producer method: it sends no statement. */
export function nextDigestInstant(
	zone: TimeZone,
	cadence: "daily" | "weekly",
	now: Date,
	slot: { weekday: number; hour: number } = { weekday: 0, hour: 16 },
): Instant {
	const start = new Date(now);
	const hour = String(slot.hour).padStart(2, "0");
	const weekday = weekdays[slot.weekday] ?? "Sun";
	for (let day = 0; day < 14; day++) {
		const probe = new Date(start.getTime() + day * 86_400_000);
		const parts = new Intl.DateTimeFormat("en-CA", {
			timeZone: zone,
			year: "numeric",
			month: "2-digit",
			day: "2-digit",
			weekday: "short",
			hourCycle: "h23",
		}).formatToParts(probe);
		const part = (type: string) => parts.find((item) => item.type === type)?.value ?? "";
		const date = localDate.parse(`${part("year")}-${part("month")}-${part("day")}`);
		if (cadence === "weekly" && part("weekday") !== weekday) continue;
		const resolved = resolveCalendar(localDateTime.parse(`${date}T${hour}:00:00`), zone, "automatic");
		if (resolved.kind !== "resolved") continue;
		if (Date.parse(resolved.occurrence.instant) > now.getTime()) return resolved.occurrence.instant;
	}
	throw new RangeError("digest slot");
}

export async function readOversightDigest(db: Database, authority: RequestActor, raw: unknown) {
	return readReply(async () => {
		const input = parse(readOversightDigestRequest, raw);
		const result = await db.execute(sql`WITH allowed AS (
				SELECT o.timezone FROM organization o
				WHERE o.id = ${input.organizationId}::uuid AND o.kind = ${input.organizationKind}
					AND ${seatAccess({ session: authority.session, account: authority.actor.accountId, tenant: input.organizationId, admin: true })}
			),
			bounds AS (
				SELECT timezone,
					(date_trunc('day', clock_timestamp() AT TIME ZONE timezone) AT TIME ZONE timezone) AS start_at,
					((date_trunc('day', clock_timestamp() AT TIME ZONE timezone) + interval '1 day') AT TIME ZONE timezone) AS end_at
				FROM allowed
			)
			SELECT EXISTS(SELECT FROM allowed) AS allowed, (SELECT timezone FROM allowed) AS timezone,
				COALESCE((SELECT json_agg(json_build_object('plant', plant_id, 'date', day, 'count', n) ORDER BY plant_id, day)
					FROM (
						SELECT a.plant_id, (e.occurred_at AT TIME ZONE b.timezone)::date AS day, count(*)::int AS n
						FROM bounds b
						JOIN affiliation a ON a.organization_id = ${input.organizationId}::uuid
							AND a.plant_id IS NOT NULL AND a.ended_at IS NULL AND a.share_activity
							AND NOT EXISTS (SELECT FROM lifecycle_witness w WHERE w.kind = 'plant' AND w.opaque_subject_id = a.plant_id
								AND w.state NOT IN ('active','cancelled'))
						JOIN audit_event e ON e.tenant_id = a.plant_id
							AND e.action IN (${sql.raw(actions)})
							AND e.occurred_at >= CASE WHEN ${input.period} = 'owed_catchup' THEN b.start_at - interval '7 days' ELSE b.start_at END
							AND e.occurred_at < b.end_at
						GROUP BY a.plant_id, day
					) counted), '[]'::json) AS lines`);
		const row = oversightRow.parse({ ...result.rows[0], lines: jsonValue(result.rows[0]?.lines) });
		if (!row.allowed || !row.timezone) deny("access_denied");
		const zone = timeZone.parse(row.timezone);
		const plants = [...new Set(row.lines.map((line) => line.plant))];
		return oversightDigestResult.parse({
			timezone: zone,
			period: input.period,
			lines: row.lines.map((line) => ({ date: line.date, count: line.count })),
			plants,
		});
	});
}

export async function readPlanterDigest(db: Database, authority: RequestActor, raw: unknown, now: () => Date) {
	return readReply(async () => {
		const input = parse(readPlanterDigestRequest, raw);
		const result = await db.execute(sql`SELECT p.timezone,
				COALESCE((SELECT enabled FROM notification_preference
					WHERE account_id = ${authority.actor.accountId}::uuid AND category = 'planter_digest' AND channel = 'in_app'), false) AS in_app,
				(SELECT cadence FROM notification_preference
					WHERE account_id = ${authority.actor.accountId}::uuid AND category = 'planter_digest' AND cadence IS NOT NULL
					LIMIT 1) AS cadence,
				COALESCE((SELECT hour FROM notification_preference
					WHERE account_id = ${authority.actor.accountId}::uuid AND category = 'planter_digest' AND hour IS NOT NULL
					LIMIT 1), p.digest_hour)::int AS hour,
				COALESCE((SELECT weekday FROM notification_preference
					WHERE account_id = ${authority.actor.accountId}::uuid AND category = 'planter_digest' AND weekday IS NOT NULL
					LIMIT 1), p.digest_weekday)::int AS weekday,
				${seatAccess({ session: authority.session, account: authority.actor.accountId, tenant: input.plantId, admin: true })} AS allowed
			FROM plant p WHERE p.id = ${input.plantId}::uuid`);
		const row = planterRow.parse(
			result.rows[0] ?? { timezone: null, in_app: null, cadence: null, weekday: null, hour: null, allowed: false },
		);
		if (!row.allowed || !row.timezone || row.in_app === null || row.weekday === null || row.hour === null)
			deny("access_denied");
		const zone = input.zone ?? timeZone.parse(row.timezone);
		let sendAt: Instant;
		if (input.wall) {
			const resolved = resolveCalendar(input.wall, zone, "automatic");
			if (resolved.kind !== "resolved") deny("invalid_input");
			sendAt = resolved.occurrence.instant;
		} else sendAt = nextDigestInstant(zone, row.cadence ?? "weekly", now(), { weekday: row.weekday, hour: row.hour });
		return planterDigestResult.parse({ sendAt, inAppDigest: row.in_app });
	});
}

// The delivered digests (NTF-007, NTF-008). The scheduled runner compiles each one inside its job transaction. Every
// statement repeats the recipient's live access check (C13), and the oversight read locks the sharing links it counts,
// so a plant that turns sharing off waits for the digest to commit or is left out of it.

type Execute = { execute: Database["execute"] };
/** At most this many lines in one digest; the total still counts every item (REQ-NTF-008: ≤100 lines). */
const DIGEST_LINES = 100;

/** The recipient holds a current Owner or Admin seat in the tenant, and no lifecycle witness hides the account, seat or tenant. */
const liveRecipient = (tenant: string, recipient: string) => seatAccess({ account: recipient, tenant, admin: true });

/** Whether the recipient still holds a current Owner or Admin seat in the tenant. One statement. */
export async function digestRecipientLive(db: Execute, tenant: string, recipient: string) {
	const r = await db.execute(sql`SELECT ${liveRecipient(tenant, recipient)} AS ok`);
	return z.object({ ok: z.boolean() }).parse(r.rows[0]).ok;
}

const planterItem = z.object({ kind: z.enum(["task", "meeting"]), date: localDate, title: z.string().min(1) });
const oversightLine = z.object({ plant: z.string().min(1), date: localDate, count: z.number().int().positive() });
type PlanterDigestItem = z.infer<typeof planterItem>;
type OversightDigestLine = z.infer<typeof oversightLine>;
const compiled = <T extends z.ZodType>(line: T) =>
	z.object({ live: z.boolean(), total: z.number().int().nonnegative(), lines: z.array(line).max(DIGEST_LINES) });

/** The title the app shows for meeting m (meetingTitle in contracts), built in SQL from the same type names. */
const meetingTitleSql = sql`coalesce(nullif(btrim(m.title), ''),
	(${JSON.stringify(MEETING_TYPE_TITLE)}::jsonb ->> m.type) || coalesce(' #' || nullif(m.vision_number, 0), ''))`;

/**
 * The church digest's open items for one recipient (REQ-NTF-007): their open dated tasks due on or before `through`
 * (overdue ones included) and the church's meetings still ahead that fall on or before `through`. One statement.
 */
export async function compilePlanterDigest(
	db: Execute,
	input: { plant: string; recipient: string; asOf: string; through: string },
) {
	const r = await db.execute(sql`WITH items AS (
			SELECT 'task' AS kind, coalesce(t.due_date, (t.due_at AT TIME ZONE p.timezone)::date) AS date, t.title
			FROM task t JOIN plant p ON p.id = t.plant_id
			WHERE t.plant_id = ${input.plant}::uuid AND t.deleted_at IS NULL AND t.due_kind <> 'undated'
				AND t.status NOT IN ('complete','no_longer_needed')
				AND EXISTS (SELECT FROM task_assignee ta WHERE ta.task_id = t.id AND ta.account_id = ${input.recipient}::uuid)
				AND coalesce(t.due_date, (t.due_at AT TIME ZONE p.timezone)::date) <= ${input.through}::date
			UNION ALL
			SELECT 'meeting', m.local_date, ${meetingTitleSql}
			FROM meeting m
			WHERE m.plant_id = ${input.plant}::uuid AND m.retired_at IS NULL AND m.status NOT IN ('cancelled','completed')
				AND m.starts_at > ${input.asOf}::timestamptz AND m.local_date <= ${input.through}::date
		), live AS (SELECT ${liveRecipient(input.plant, input.recipient)} AS ok)
		SELECT (SELECT ok FROM live) AS live,
			CASE WHEN (SELECT ok FROM live) THEN (SELECT count(*) FROM items) ELSE 0 END::int AS total,
			CASE WHEN (SELECT ok FROM live) THEN coalesce((SELECT json_agg(json_build_object('kind', kind, 'date', date, 'title', title))
				FROM (SELECT * FROM items ORDER BY date, kind DESC, title LIMIT ${DIGEST_LINES}) shown), '[]'::json) ELSE '[]'::json END AS lines`);
	return compiled(planterItem).parse({ ...r.rows[0], lines: jsonValue(r.rows[0]?.lines) });
}

/**
 * The oversight digest's activity counts (REQ-NTF-008): for each linked plant whose relationship is current and shares
 * activity, the number of audited changes on each local date from `start` to `end` in the organization's zone. It
 * returns plant names, dates and counts only: never a person, note, message or gift. The sharing links it counts stay
 * locked until the caller commits. Given a delivered notice instead of a zone, it counts in the notice's zone and also
 * returns the text that notice holds, so dispatch rechecks a queued email in one statement. One statement.
 */
export async function compileOversightDigest(
	db: Execute,
	input: { organization: string; recipient: string; start: string; end: string } & (
		{ zone: TimeZone } | { notice: { id: string; logicalKey: string } }
	),
) {
	const stored =
		"notice" in input
			? sql`SELECT timezone, safe_body FROM notice WHERE id = ${input.notice.id}::uuid
				AND tenant_id = ${input.organization}::uuid AND logical_key = ${input.notice.logicalKey} AND cancelled_at IS NULL`
			: sql`SELECT ${input.zone}::text AS timezone, NULL::text AS safe_body`;
	const zone = sql`(SELECT timezone FROM stored)`;
	const r = await db.execute(sql`WITH stored AS (${stored}),
		live AS (SELECT ${liveRecipient(input.organization, input.recipient)} AS ok),
		links AS MATERIALIZED (
			SELECT a.plant_id FROM affiliation a
			WHERE a.organization_id = ${input.organization}::uuid AND a.plant_id IS NOT NULL AND a.ended_at IS NULL
				AND a.share_activity AND (SELECT ok FROM live)
				AND NOT EXISTS (SELECT FROM lifecycle_witness w WHERE w.kind = 'plant' AND w.opaque_subject_id = a.plant_id
					AND w.state NOT IN ('active','cancelled'))
			ORDER BY a.id FOR SHARE OF a
		), counted AS (
			SELECT p.name AS plant, p.id, (e.occurred_at AT TIME ZONE ${zone})::date AS date, count(*)::int AS count
			FROM links l JOIN plant p ON p.id = l.plant_id
			JOIN audit_event e ON e.tenant_id = l.plant_id AND e.action IN (${sql.raw(actions)})
				AND e.occurred_at >= (${input.start}::date::timestamp AT TIME ZONE ${zone})
				AND e.occurred_at < ((${input.end}::date + 1)::timestamp AT TIME ZONE ${zone})
			GROUP BY p.name, p.id, 3
		)
		SELECT (SELECT ok FROM live) AS live, coalesce((SELECT sum(count) FROM counted), 0)::int AS total,
			coalesce((SELECT json_agg(json_build_object('plant', plant, 'date', date, 'count', count))
				FROM (SELECT * FROM counted ORDER BY plant, id, date LIMIT ${DIGEST_LINES}) shown), '[]'::json) AS lines,
			(SELECT safe_body FROM stored) AS stored`);
	return compiled(oversightLine)
		.extend({ stored: z.string().nullable() })
		.parse({ ...r.rows[0], lines: jsonValue(r.rows[0]?.lines) });
}

const day = new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric", year: "numeric", timeZone: "UTC" });
const shortDay = (date: string) => day.format(new Date(`${date}T00:00:00Z`));
const range = (start: string, end: string) =>
	start === end ? shortDay(start) : `${shortDay(start)} to ${shortDay(end)}`;
const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/** The text a delivered digest shows: a title and one sentence per line. Pure. */
export function renderPlanterDigest(input: {
	start: string;
	end: string;
	today: string;
	total: number;
	lines: readonly PlanterDigestItem[];
}) {
	return {
		title: `Church digest: ${plural(input.total, "open item")}, ${range(input.start, input.end)}`,
		lines: [
			...input.lines.map((l) =>
				l.kind === "meeting"
					? `Meeting on ${shortDay(l.date)}: ${l.title}.`
					: l.date < input.today
						? `Overdue task, due ${shortDay(l.date)}: ${l.title}.`
						: `Task due ${shortDay(l.date)}: ${l.title}.`,
			),
			...(input.total > input.lines.length ? [`${input.total - input.lines.length} more in Everyfield.`] : []),
		],
	};
}

/** The oversight digest's text: plant names, dates and counts only (REQ-NTF-008). Pure. */
export function renderOversightDigest(input: {
	start: string;
	end: string;
	total: number;
	lines: readonly OversightDigestLine[];
}) {
	const shown = input.lines.reduce((sum, l) => sum + l.count, 0);
	return {
		title: `Oversight digest: ${plural(input.total, "activity", "activities")}, ${range(input.start, input.end)}`,
		lines: [
			...input.lines.map((l) => `${l.plant}: ${plural(l.count, "activity", "activities")} on ${shortDay(l.date)}.`),
			...(input.total > shown
				? [`${plural(input.total - shown, "more activity", "more activities")} in Everyfield.`]
				: []),
		],
	};
}
