import {
	addCivilDays,
	instant,
	localDate,
	localDateTime,
	resolveCalendar,
	timeZone,
} from "@everyfield/contracts/common";
import * as c from "@everyfield/contracts/meetings";
import { sql, type SQLWrapper } from "@everyfield/db/query";
import "server-only";
import { z } from "zod";
import { seatHeld } from "../access/session.ts";
import { queueJobsFor } from "../jobs/queue.ts";
import type { Reader } from "./core.ts";
import { displayTitle, meetingColumns, meetingRow, plantMeeting, type MeetingRow } from "./rows.ts";

function reminderTimes(m: Pick<MeetingRow, "local_date" | "local_time" | "timezone">) {
	const zone = timeZone.parse(m.timezone);
	return ([7, 3, 1] as const).map((days) => {
		const wall = localDateTime.parse(`${addCivilDays(localDate.parse(m.local_date), -days)}T${m.local_time}:00`);
		const resolved = resolveCalendar(wall, zone, "automatic");
		if (resolved.kind !== "resolved") throw Error("calendar_unresolved");
		return { slot: `day_${days}` as const, at: resolved.occurrence.instant };
	});
}
const live = (m: Pick<MeetingRow, "status" | "retired_at" | "starts_at">, asOf: Date) =>
	["planning", "ready"].includes(m.status) && m.retired_at === null && m.starts_at > asOf;

const slotKey = (m: Pick<MeetingRow, "starts_at">, slot: z.infer<typeof c.reminderSlot>) =>
	slot === "announcement" ? "meeting/announcement" : `meeting/${slot}/${m.starts_at.toISOString()}`;

export function syncReminderJobs(m: MeetingRow, asOf: Date): SQLWrapper[] {
	const wanted = live(m, asOf)
		? [
				{ key: slotKey(m, "announcement"), at: asOf.toISOString() },
				...reminderTimes(m)
					.filter((t) => Date.parse(t.at) > asOf.getTime())
					.map((t) => ({ key: slotKey(m, t.slot), at: t.at })),
			]
		: [];
	const keys = wanted.map((w) => w.key);
	const writes: SQLWrapper[] = [
		sql`UPDATE job SET state = 'superseded', claim_generation = claim_generation + 1, lease_owner = NULL,
			lease_until = NULL, revision = revision + 1, finished_at = clock_timestamp()
			WHERE kind = 'notification' AND subject_record_id = ${sql.param(m.id)}::uuid AND producer_key LIKE 'meeting/%'
			AND state IN ('ready', 'retry_wait', 'claimed') AND NOT (producer_key = ANY(${sql.param(keys)}::text[]))`,
	];
	if (wanted.length)
		writes.push(
			queueJobsFor(sql`FROM jsonb_to_recordset(${JSON.stringify(wanted)}::jsonb) w(key text, at timestamptz)`, {
				kind: "notification",
				tenant: sql`${sql.param(m.plant_id)}::uuid`,
				subject: sql`${sql.param(m.id)}::uuid`,
				key: sql`w.key`,
				revision: sql`${sql.param(m.revision)}::bigint`,
				eligibleAt: sql`w.at`,
				conflict: "reopen",
			}),
		);
	return writes;
}

const planRow = meetingRow.extend({
	reminder_recipients: z.array(z.uuid()),
	announcement_recipients: z.array(z.uuid()),
});
export async function planNotifications(db: Reader, plantId: string, raw: z.input<typeof c.planNotificationsRequest>) {
	const input = c.planNotificationsRequest.parse(raw);
	const r = await db.execute(sql`WITH seated AS (
			SELECT account_id FROM seat WHERE plant_id = ${sql.param(plantId)}::uuid AND ended_at IS NULL AND accepted_at <= clock_timestamp()
		)
		SELECT ${meetingColumns},
			ARRAY(SELECT DISTINCT a FROM (
				SELECT p.linked_account_id AS a FROM participation g JOIN person p ON p.id = g.person_id
				WHERE g.meeting_id = m.id AND g.removed_at IS NULL AND p.state = 'live'
				UNION SELECT m.creator_id) x WHERE a IN (SELECT account_id FROM seated) ORDER BY a) AS reminder_recipients,
			ARRAY(SELECT DISTINCT p.linked_account_id FROM person p WHERE p.plant_id = m.plant_id AND p.state = 'live'
				AND p.stage IN ('core_group', 'launch_team', 'leader') AND p.linked_account_id IN (SELECT account_id FROM seated)
				ORDER BY 1) AS announcement_recipients
		FROM meeting m WHERE ${plantMeeting(plantId, input.meetingId)}`);
	if (!r.rows[0]) return null;
	const m = planRow.parse(r.rows[0]);
	const asOf = new Date(input.asOf),
		current = live(m, asOf);
	const times = reminderTimes(m);
	const state = (n: number) =>
		!current
			? "suppressed"
			: Date.parse(times[n + 1]?.at ?? m.starts_at.toISOString()) <= asOf.getTime()
				? "passed"
				: "planned";
	return c.notificationPlan.parse({
		meetingId: m.id,
		revision: m.revision,
		slots: [
			{
				slot: "announcement",
				eligibleAt: instant.parse(asOf.toISOString()),
				state: current ? "planned" : "suppressed",
				recipients: current ? m.announcement_recipients : [],
			},
			...times.map((t, n) => ({
				slot: t.slot,
				eligibleAt: t.at,
				state: state(n),
				recipients: state(n) === "planned" ? m.reminder_recipients : [],
			})),
		],
	});
}

const heading = { announcement: "New meeting", day_7: "In 7 days", day_3: "In 3 days", day_1: "Tomorrow" } as const;
function when(m: Pick<MeetingRow, "local_date" | "local_time">) {
	const day = new Date(`${m.local_date}T00:00:00Z`).toLocaleDateString("en-US", {
		timeZone: "UTC",
		weekday: "long",
		month: "long",
		day: "numeric",
		year: "numeric",
	});
	const [h, min] = m.local_time.split(":").map(Number) as [number, number];
	return `${day} at ${((h + 11) % 12) + 1}:${String(min).padStart(2, "0")} ${h < 12 ? "AM" : "PM"}`;
}
export async function meetingNotice(
	db: Reader,
	plantId: string,
	meetingId: string,
	slot: z.infer<typeof c.reminderSlot>,
): Promise<{ title: string; text: string } | null> {
	const r = await db.execute(sql`SELECT ${meetingColumns} FROM meeting m WHERE ${plantMeeting(plantId, meetingId)}`);
	if (!r.rows[0]) return null;
	const m = meetingRow.parse(r.rows[0]);
	const name = displayTitle(m);
	const place = m.venue_name ? ` at ${m.venue_name}` : "";
	return {
		title: `${heading[slot]}: ${name}`.slice(0, 500),
		text: `${name} is on ${when(m)}${place}.`,
	};
}

export function meetingMailGrants(input: SQLWrapper): SQLWrapper {
	return sql`SELECT i.id FROM ${input}
		JOIN notice n ON n.id=i.notice AND n.recipient_id=i.recipient AND n.purpose IN ('meeting_invitation','meeting_reminder')
		JOIN meeting m ON m.id=n.source_record_id AND m.plant_id=n.tenant_id AND m.revision=n.source_revision
		JOIN seat s ON s.account_id=i.recipient AND s.plant_id=m.plant_id AND ${seatHeld("s")}
		WHERE m.status IN ('planning','ready') AND m.retired_at IS NULL AND m.starts_at>clock_timestamp()
		FOR SHARE OF n, m, s`;
}
