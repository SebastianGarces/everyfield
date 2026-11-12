import {
	addCivilDays,
	instant,
	localDate,
	localDateTime,
	resolveCalendar,
	timeZone,
	type Instant,
} from "@everyfield/contracts/common";
import * as c from "@everyfield/contracts/meetings";
import { sql } from "@everyfield/db/query";
import "server-only";
import { z } from "zod";
import type { Reader } from "./core.ts";
import { meetingColumns, meetingRow, plantMeeting, type MeetingRow } from "./rows.ts";

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

const planRow = meetingRow.extend({
	reminder_recipients: z.array(z.uuid()),
	announcement_recipients: z.array(z.uuid()),
});
/**
 * The meeting's notification plan as the job worker sees it (meetings.planNotifications): each slot's time, whether it
 * is still planned, already passed or suppressed, and its current audience. Reminders go to the creator and to guests
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
	const state = (at: Instant) => (!current ? "suppressed" : Date.parse(at) <= asOf.getTime() ? "passed" : "planned");
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
			...reminderTimes(m).map((t) => ({
				slot: t.slot,
				eligibleAt: t.at,
				state: state(t.at),
				recipients: state(t.at) === "planned" ? m.reminder_recipients : [],
			})),
		],
	});
}
