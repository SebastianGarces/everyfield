import {
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
import { RequestActor, deny, jsonValue, parse, readReply } from "./core.ts";

const oversightRow = z.object({
	allowed: z.boolean(),
	timezone: z.string().nullable(),
	lines: z.array(z.object({ plant: z.uuid(), date: z.string(), count: z.number().int().positive() })),
});
const planterRow = z.object({
	timezone: z.string().nullable(),
	in_app: z.boolean().nullable(),
	allowed: z.boolean(),
});
const actions =
	"'tasks.changed','tasks.completed','meetings.changed','meetings.finalized','people.updated','people.created','plant.profile_changed'";

/** The next Sunday-or-daily 16:00 slot in the plant zone. Not a producer method: it sends no statement. */
export function nextDigestInstant(zone: TimeZone, cadence: "daily" | "weekly", now: Date): Instant {
	const start = new Date(now);
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
		if (cadence === "weekly" && part("weekday") !== "Sun") continue;
		const resolved = resolveCalendar(localDateTime.parse(`${date}T16:00:00`), zone, "automatic");
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
					AND EXISTS (
						SELECT FROM live_session(${authority.session}::uuid) i
						WHERE i.registration_state = 'active' AND i.account_id = ${authority.actor.accountId}::uuid
							AND EXISTS (
								SELECT FROM seat s WHERE s.account_id = i.account_id AND s.organization_id = o.id
									AND s.role IN ('owner','admin') AND s.ended_at IS NULL AND s.accepted_at <= clock_timestamp()
							)
					)
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
			mailIntents: 0,
		});
	});
}

export async function readPlanterDigest(db: Database, authority: RequestActor, raw: unknown) {
	return readReply(async () => {
		const input = parse(readPlanterDigestRequest, raw);
		const result = await db.execute(sql`SELECT p.timezone,
				COALESCE((SELECT enabled FROM notification_preference
					WHERE account_id = ${authority.actor.accountId}::uuid AND category = 'planter_digest' AND channel = 'in_app'), false) AS in_app,
				EXISTS (
					SELECT FROM live_session(${authority.session}::uuid) i
					WHERE i.registration_state = 'active' AND i.account_id = ${authority.actor.accountId}::uuid
						AND EXISTS (
							SELECT FROM seat s WHERE s.account_id = i.account_id AND s.plant_id = p.id
								AND s.role IN ('owner','admin') AND s.ended_at IS NULL AND s.accepted_at <= clock_timestamp()
						)
				) AS allowed
			FROM plant p WHERE p.id = ${input.plantId}::uuid`);
		const row = planterRow.parse(result.rows[0] ?? { timezone: null, in_app: null, allowed: false });
		if (!row.allowed || !row.timezone || row.in_app === null) deny("access_denied");
		const zone = input.zone ?? timeZone.parse(row.timezone);
		let sendAt: Instant;
		if (input.wall) {
			const resolved = resolveCalendar(input.wall, zone, "automatic");
			if (resolved.kind !== "resolved") deny("invalid_input");
			sendAt = resolved.occurrence.instant;
		} else sendAt = nextDigestInstant(zone, "weekly", new Date());
		return planterDigestResult.parse({ sendAt, logicalIntents: 1, inAppDigest: row.in_app, mailIntents: 0 });
	});
}
