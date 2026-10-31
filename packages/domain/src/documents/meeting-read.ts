import { sql, type SQL } from "@everyfield/db/query";
import "server-only";
import { z } from "zod";
import { liveRead } from "../access/session.ts";
import { ATTENDEE_CAP, agendaKindOf, type AgendaKind } from "./agenda-meeting.ts";
import type { PlantViewer, Reader } from "./access.ts";

// The meeting an agenda prints from. The documents domain reads the meeting tables in its own statement, as readPlant
// does for the plant. A meeting counts only when it is live (not retired) in the viewer's plant.

const meetingRead = z.object({
	type: z.enum(["vision_meeting", "orientation", "team_meeting", "prelaunch_practice"]),
	title: z.string().nullable(),
	visionNumber: z.number().int().nullable(),
	localDate: z.string(),
	localTime: z.string(),
	venueName: z.string().nullable(),
	venueAddress: z.string().nullable(),
	agenda: z.array(z.object({ title: z.string(), minutes: z.number().int() })),
	leadership: z.boolean(),
	attendees: z.array(z.object({ name: z.string(), role: z.string().nullable() })),
	attendeeTotal: z.number().int(),
});
/** The columns the meeting read returns. Agenda and people arrive as JSON. */
export type MeetingRead = z.infer<typeof meetingRead>;

/** A live meeting of the plant, with the leadership flag of its team. Shared by the kind check and the full read. */
const liveMeeting = (plantId: string, meetingId: string) =>
	sql`FROM meeting m LEFT JOIN team t ON t.id=m.team_id AND t.plant_id=m.plant_id AND t.archived_at IS NULL
		WHERE m.id=${meetingId}::uuid AND m.plant_id=${plantId}::uuid AND m.retired_at IS NULL`;

/** People on the meeting's current list: not removed, Person live, RSVP not declined. */
const listed = (plantId: string) =>
	sql`FROM participation g JOIN person pe ON pe.id=g.person_id AND pe.tenant_id=${plantId}::uuid AND pe.state='live'
		WHERE g.meeting_id=m.id AND g.plant_id=${plantId}::uuid AND g.removed_at IS NULL AND coalesce(g.rsvp,'pending')<>'declined'`;

/** One JSON object with everything the print needs. Used as a lateral in the plant read. */
export function meetingFactsSql(plantId: string, meetingId: string): SQL {
	return sql`SELECT jsonb_build_object(
		'type', m.type, 'title', m.title, 'visionNumber', m.vision_number,
		'localDate', m.local_date::text, 'localTime', to_char(m.local_time, 'HH24:MI'),
		'venueName', m.venue_name, 'venueAddress', m.venue_address, 'agenda', m.agenda,
		'leadership', coalesce(t.template_key='leadership', false),
		'attendeeTotal', (SELECT count(*) ${listed(plantId)}),
		'attendees', (SELECT coalesce(jsonb_agg(jsonb_build_object('name', x.name, 'role', x.role) ORDER BY x.name, x.id), '[]'::jsonb)
			FROM (SELECT pe.display_name AS name, pe.id,
				CASE WHEN t.template_key='leadership' THEN (SELECT string_agg(tr.name, ', ' ORDER BY tr.sort_order, tr.name)
					FROM team_tenure tt JOIN team_role tr ON tr.id=tt.role_id AND tr.plant_id=${plantId}::uuid
						AND tr.team_id=m.team_id AND tr.retired_at IS NULL
					WHERE tt.person_id=pe.id AND tt.plant_id=${plantId}::uuid AND tt.ended_on IS NULL) END AS role
				${listed(plantId)} ORDER BY pe.display_name, pe.id LIMIT ${ATTENDEE_CAP}::int) x)
	) AS facts ${liveMeeting(plantId, meetingId)}`;
}

export function parseMeeting(value: unknown): MeetingRead | null {
	if (value === null || value === undefined) return null;
	return meetingRead.parse(value);
}

/**
 * One statement. Whether the viewer's session and seat are live, and the agenda kind of a live meeting in the plant. Reads no agenda and no people, and
 * says nothing about a retired meeting, another plant's meeting or a meeting of a type with no agenda.
 */
export async function readAgendaKind(
	db: Reader,
	viewer: PlantViewer,
	meetingId: string,
): Promise<{ open: false } | { open: true; kind: AgendaKind | null }> {
	const found = await db.execute(sql`SELECT a.access_live, k.type, k.leadership
		FROM (SELECT ${liveRead(viewer.access, false)} AND EXISTS(SELECT FROM live_session(${viewer.access.session}::uuid) s
			WHERE s.registration_state='active' AND s.account_id=${viewer.accountId}::uuid) AS access_live) a
		LEFT JOIN LATERAL (SELECT m.type, coalesce(t.template_key='leadership', false) AS leadership
			${liveMeeting(viewer.plantId, meetingId)}) k ON a.access_live`);
	const row = found.rows[0] as { access_live?: unknown; type?: unknown; leadership?: unknown } | undefined;
	if (!row || row.access_live !== true) return { open: false };
	const parsed = meetingRead.pick({ type: true, leadership: true }).safeParse(row);
	return { open: true, kind: parsed.success ? agendaKindOf(parsed.data) : null };
}
