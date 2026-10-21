import * as c from "@everyfield/contracts/meetings";
import { sql, type SQL } from "@everyfield/db/query";
import "server-only";
import { z } from "zod";

const date = z.coerce.date();
/** One meeting with the counts its summary shows. Every meeting read and every write's fact read uses these columns. */
export const meetingColumns = sql`m.id, m.plant_id, m.revision::text AS revision, m.type, m.subtype, m.status, m.title,
	m.notes, m.local_date::text AS local_date, to_char(m.local_time, 'HH24:MI') AS local_time, m.timezone, m.starts_at,
	m.vision_number, m.venue_id, m.venue_name, m.venue_address, m.agenda, m.agenda_version, m.kit_version,
	m.actual_occurrence_at, m.occurrence_voided_at, m.retired_at, m.creator_id,
	(SELECT count(*) FROM participation g WHERE g.meeting_id = m.id AND g.removed_at IS NULL)::int AS guest_count,
	(SELECT count(*) FROM participation g WHERE g.meeting_id = m.id AND g.removed_at IS NULL AND g.rsvp = 'confirmed')::int AS confirmed_count,
	(SELECT count(*) FROM meeting_kit_item k WHERE k.meeting_id = m.id)::int AS kit_total,
	(SELECT count(*) FROM meeting_kit_item k WHERE k.meeting_id = m.id AND k.checked)::int AS kit_checked`;
export const meetingRow = z.object({
	id: z.uuid(),
	plant_id: z.uuid(),
	revision: z.string(),
	type: c.meetingType,
	subtype: z.string().nullable(),
	status: c.meetingStatus,
	title: z.string().nullable(),
	notes: z.string().nullable(),
	local_date: z.string(),
	local_time: z.string(),
	timezone: z.string(),
	starts_at: date,
	vision_number: z.number().int().nullable(),
	venue_id: z.uuid().nullable(),
	venue_name: z.string().nullable(),
	venue_address: z.string().nullable(),
	agenda: z.array(c.agendaSection),
	agenda_version: z.number().int().nullable(),
	kit_version: z.number().int().nullable(),
	actual_occurrence_at: date.nullable(),
	occurrence_voided_at: date.nullable(),
	retired_at: date.nullable(),
	creator_id: z.uuid().nullable(),
	guest_count: z.number().int(),
	confirmed_count: z.number().int(),
	kit_total: z.number().int(),
	kit_checked: z.number().int(),
});
export type MeetingRow = z.infer<typeof meetingRow>;

const labels: Record<z.infer<typeof c.meetingType>, string> = {
	vision_meeting: "Vision Meeting",
	orientation: "Orientation",
	team_meeting: "Team Meeting",
	prelaunch_practice: "Pre-launch Practice",
};
export function displayTitle(m: Pick<MeetingRow, "title" | "type" | "vision_number">) {
	return m.title?.trim() || labels[m.type] + (m.vision_number ? ` #${m.vision_number}` : "");
}
export function summary(m: MeetingRow): z.infer<typeof c.meetingSummary> {
	return c.meetingSummary.parse({
		id: m.id,
		revision: m.revision,
		type: m.type,
		status: m.status,
		displayTitle: displayTitle(m),
		title: m.title,
		startsAt: m.starts_at.toISOString(),
		localDate: m.local_date,
		localTime: m.local_time,
		zone: m.timezone,
		visionNumber: m.vision_number,
		venue: m.venue_name === null ? null : { id: m.venue_id, name: m.venue_name, address: m.venue_address ?? "" },
		guestCount: m.guest_count,
		confirmedCount: m.confirmed_count,
		preparation:
			m.type !== "vision_meeting"
				? "not_applicable"
				: m.kit_version !== null && m.kit_checked === m.kit_total
					? "complete"
					: "incomplete",
	});
}
export function agendaOf(m: MeetingRow): z.infer<typeof c.agendaResult> {
	return {
		meetingId: c.meetingId.parse(m.id),
		revision: c.meetingDetail.shape.revision.parse(m.revision),
		sections: m.agenda,
		totalMinutes: m.agenda.reduce((sum, s) => sum + s.minutes, 0),
		defaultVersion: m.agenda_version,
	};
}
export function detail(m: MeetingRow): z.infer<typeof c.meetingDetail> {
	return c.meetingDetail.parse({
		...summary(m),
		notes: m.notes,
		agenda: agendaOf(m),
		kit: m.kit_version === null ? null : { version: m.kit_version, checked: m.kit_checked, total: m.kit_total },
		occurrence: {
			heldAt: m.actual_occurrence_at?.toISOString() ?? null,
			voidedAt: m.occurrence_voided_at?.toISOString() ?? null,
		},
		retiredAt: m.retired_at?.toISOString() ?? null,
	});
}
/** The audited facts of a meeting: what a change records as before and after. */
export const facts = (m: MeetingRow) => ({
	title: m.title,
	notes: m.notes,
	status: m.status,
	startsAt: m.starts_at.toISOString(),
	localDate: m.local_date,
	localTime: m.local_time,
	venueId: m.venue_id,
	venueName: m.venue_name,
	venueAddress: m.venue_address,
	heldAt: m.actual_occurrence_at?.toISOString() ?? null,
	voidedAt: m.occurrence_voided_at?.toISOString() ?? null,
	retiredAt: m.retired_at?.toISOString() ?? null,
});
export const plantMeeting = (plantId: string, meetingId: string): SQL =>
	sql`m.plant_id = ${sql.param(plantId)}::uuid AND m.id = ${sql.param(meetingId)}::uuid`;
