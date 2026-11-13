import { recordId } from "@everyfield/contracts/common";
import { meetingType } from "@everyfield/contracts/meetings";
import type { FollowUpOrigin } from "@everyfield/contracts/tasks";
import { sql, type SQL } from "@everyfield/db/query";
import "server-only";
import { z } from "zod";
import { displayTitle } from "../meetings/rows.ts";

/**
 * Where task `t` came from, as JSON: the meeting whose duty generated it, else who added it. Two follow-ups for one
 * person read differently on every screen.
 */
export const originJson = (
	t: SQL,
) => sql`(SELECT jsonb_build_object('meeting_id', m.id, 'title', m.title, 'type', m.type,
	'vision_number', m.vision_number, 'by', (SELECT display_name FROM seat_identity(${t}.creator_id)))
	FROM (SELECT 1) one LEFT JOIN obligation ob ON ob.id=${t}.obligation_id AND ob.plant_id=${t}.plant_id
	LEFT JOIN meeting m ON m.id=ob.meeting_id AND m.plant_id=ob.plant_id)`;
const originRow = z.object({
	meeting_id: z.uuid().nullable(),
	title: z.string().nullable(),
	type: meetingType.nullable(),
	vision_number: z.int().nullable(),
	by: z.string().nullable(),
});
export function originOf(raw: unknown): FollowUpOrigin {
	const o = originRow.parse(raw);
	return o.meeting_id && o.type
		? {
				kind: "meeting",
				meeting: {
					id: recordId.parse(o.meeting_id),
					label: displayTitle({ title: o.title, type: o.type, vision_number: o.vision_number }),
				},
			}
		: { kind: "added", by: o.by };
}
