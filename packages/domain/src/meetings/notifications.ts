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
import type { Reader } from "./core.ts";
import { displayTitle, meetingColumns, meetingRow, plantMeeting, type MeetingRow } from "./rows.ts";

/**
 * Reminder slots for one meeting (REQ-MTG-018, REQ-TSK-018): 7, 3 and 1 civil days before, at the same church wall
 * clock, through the shared automatic resolver. The announcement goes out when the meeting is scheduled.
 */
export function reminderTimes(m: Pick<MeetingRow, "local_date" | "local_time" | "timezone">) {
	const zone = timeZone.parse(m.timezone);
	return ([7, 3, 1] as const).map((days) => {
		const wall = localDateTime.parse(`${addCivilDays(localDate.parse(m.local_date), -days)}T${m.local_time}:00`);
		const resolved = resolveCalendar(wall, zone, "automatic");
		if (resolved.kind !== "resolved") throw Error("calendar_unresolved");
		return { slot: `day_${days}` as const, at: resolved.occurrence.instant };
	});
}
/** Whether the meeting still wants messages: scheduled, current and not yet started. */
export const live = (m: Pick<MeetingRow, "status" | "retired_at" | "starts_at">, asOf: Date) =>
	["planning", "ready"].includes(m.status) && m.retired_at === null && m.starts_at > asOf;

/** A slot's job key: the announcement has one per meeting; a reminder's names the start it counts back from. */
export const slotKey = (m: Pick<MeetingRow, "starts_at">, slot: z.infer<typeof c.reminderSlot>) =>
	slot === "announcement" ? "meeting/announcement" : `meeting/${slot}/${m.starts_at.toISOString()}`;

/**
 * The meeting's notification jobs after a change, as statements for the command's one write (D70, NTF-006). Every write
 * that moves the meeting's revision runs it. One job per logical slot; a moved meeting gets new slot keys and the old
 * ones are superseded before they send. A slot already sent (or given up) is never queued again; a waiting one takes
 * the new revision, which the worker checks, so a job is stale only when a later write has not reached it. The audience
 * is read when the job runs, so a removed guest or a CRM-only contact never receives a queued message.
 */
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
		writes.push(sql`INSERT INTO job (tenant_id, kind, subject_record_id, producer_key, source_revision, state, eligible_at,
			attempt_count, max_attempts, claim_generation)
			SELECT ${sql.param(m.plant_id)}::uuid, 'notification', ${sql.param(m.id)}::uuid, w.key, ${sql.param(m.revision)}::bigint,
				'ready', w.at, 0, 4, 0
			FROM jsonb_to_recordset(${JSON.stringify(wanted)}::jsonb) w(key text, at timestamptz)
			ON CONFLICT (kind, subject_record_id, producer_key) DO UPDATE SET state = 'ready', eligible_at = excluded.eligible_at,
				source_revision = excluded.source_revision,
				attempt_count = CASE WHEN job.state IN ('superseded', 'cancelled') THEN 0 ELSE job.attempt_count END,
				finished_at = NULL, error_code = NULL, next_attempt_at = NULL, lease_owner = NULL, lease_until = NULL,
				claim_generation = job.claim_generation + 1, revision = job.revision + 1
			WHERE job.state IN ('ready', 'retry_wait', 'claimed', 'superseded', 'cancelled')`);
	return writes;
}

const planRow = meetingRow.extend({
	reminder_recipients: z.array(z.uuid()),
	announcement_recipients: z.array(z.uuid()),
});
/**
 * The meeting's notification plan as the job worker sees it (meetings.planNotifications): each slot's time, whether it
 * is still planned, already passed or suppressed, and its current audience. A reminder slot stays planned through its
 * own time and passes once the next slot (for the last one, the meeting) is due, so a late run sends only the latest
 * owed reminder (D-763); a meeting that stopped, moved to history or started suppresses every slot. Reminders go to the creator and to guests
 * whose live Person links an account with a seat here; the announcement goes to the linked Core Group. Contact
 * addresses never make a recipient. One statement; the caller is the trusted worker for the job's own tenant.
 */
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
/** The meeting's local date and time as a reader sees it, for example "Tuesday, March 10 at 9:00 AM". */
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
/**
 * What a planned slot's notice says, from the meeting's current facts: its name, local date and time and place, never
 * a guest or a contact. Null when the meeting is gone. One statement; the caller is the trusted worker for the tenant.
 */
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

/**
 * Which meeting notice mail may go out (NTF-006): the notice is the recipient's own meeting announcement or reminder,
 * its meeting is still at the revision it was written for, still scheduled and not started, and the recipient still
 * holds an accepted seat in the church. One statement, locking the notice, the meeting and the seat.
 */
export async function authorizeMeetingNotices(
	tx: Reader,
	mail: readonly { id: string; recipient: string | null; notice: string | null }[],
): Promise<ReadonlySet<string>> {
	const input = mail.map((m) => ({ id: m.id, recipient: m.recipient, notice: m.notice }));
	const r =
		await tx.execute(sql`SELECT i.id FROM jsonb_to_recordset(${JSON.stringify(input)}::jsonb) i(id uuid,recipient uuid,notice uuid)
		JOIN notice n ON n.id=i.notice AND n.recipient_id=i.recipient AND n.purpose IN ('meeting_invitation','meeting_reminder')
		JOIN meeting m ON m.id=n.source_record_id AND m.plant_id=n.tenant_id AND m.revision=n.source_revision
		JOIN seat s ON s.account_id=i.recipient AND s.plant_id=m.plant_id AND ${seatHeld("s")}
		WHERE m.status IN ('planning','ready') AND m.retired_at IS NULL AND m.starts_at>clock_timestamp()
		FOR SHARE OF n, m, s`);
	return new Set(
		z
			.array(z.object({ id: z.uuid() }))
			.parse(r.rows)
			.map((row) => row.id),
	);
}
