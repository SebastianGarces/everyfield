import * as c from "@everyfield/contracts/meetings";
import { sql, type SQL } from "@everyfield/db/query";
import { randomUUID } from "node:crypto";
import "server-only";
import { z } from "zod";
import type { RequestActor } from "../access/session.ts";
import { command, deny, next, one, parse, read, reply, type MeetingsContext, type Reader, type Tx } from "./core.ts";
import { guest, guestColumns, guestRow, type GuestRow } from "./guests.ts";
import { meetingColumns, meetingRow, plantMeeting } from "./rows.ts";

// A team meeting's guest list is a copy of its ministry's people, taken when the meeting is made (REQ-MTG-007). It
// follows later joins and leaves only through a reviewed update: the preview names who would be added, removed and
// kept, and the update applies exactly that review.

/**
 * The live people who serve in the ministry now: an open tenure in a current role of a ministry not archived. Its own
 * aliases (s*) never shadow the caller's, so `teamId` may name a column of the enclosing query.
 */
export const servingPeople = (teamId: SQL, plantId: SQL) =>
	sql`SELECT DISTINCT sp.id, sp.display_name, sp.state FROM team_tenure stn
		JOIN team_role sr ON sr.id = stn.role_id AND sr.plant_id = stn.plant_id AND sr.retired_at IS NULL
		JOIN team st ON st.id = sr.team_id AND st.plant_id = sr.plant_id AND st.archived_at IS NULL
		JOIN person sp ON sp.id = stn.person_id AND sp.tenant_id = stn.plant_id AND sp.state = 'live'
		WHERE st.id = ${teamId} AND st.plant_id = ${plantId} AND stn.ended_on IS NULL`;

const personRef = z.object({
	personId: z.uuid(),
	displayName: z.string(),
	state: z.enum(["live", "retired", "merged"]),
});
const rosterFacts = z.object({
	team: z.object({ id: z.uuid(), name: z.string(), archived: z.boolean() }).nullable(),
	serving: z.array(personRef),
	guests: z.array(guestRow.extend({ roster_member: z.boolean() })),
});
/** The meeting's ministry, who serves in it now and every guest row, removed ones too, in one statement. */
const rosterColumns = sql`(SELECT json_build_object('id', t.id, 'name', t.name, 'archived', t.archived_at IS NOT NULL)
		FROM team t WHERE t.id = m.team_id AND t.plant_id = m.plant_id) AS team,
	(SELECT coalesce(json_agg(json_build_object('personId', s.id, 'displayName', s.display_name, 'state', s.state)
		ORDER BY s.display_name, s.id), '[]') FROM (${servingPeople(sql`m.team_id`, sql`m.plant_id`)}) s) AS serving,
	(SELECT coalesce(json_agg(x ORDER BY x.person_name, x.id), '[]') FROM (SELECT g.roster_member, ${guestColumns}
		WHERE g.meeting_id = m.id) x) AS guests`;

const ref = (g: GuestRow) => ({ personId: g.person_id, displayName: g.person_name, state: g.person_state });
/**
 * The difference between the guest list and the ministry now. Only guests the ministry copy added can leave; one marked
 * present stays and is named as kept. A person removed earlier comes back as the same guest row.
 */
function plan(row: Record<string, unknown>) {
	const f = rosterFacts.parse(row);
	if (!f.team) deny("wrong_meeting_type");
	if (f.team.archived) deny("team_unavailable");
	const current = f.guests.filter((g) => !g.removed_at);
	const listed = new Set(current.map((g) => g.person_id));
	const serving = new Set(f.serving.map((p) => p.personId));
	const leaving = current.filter((g) => g.roster_member && !serving.has(g.person_id));
	return {
		team: { id: f.team.id, name: f.team.name },
		add: f.serving.filter((p) => !listed.has(p.personId)),
		remove: leaving.filter((g) => g.presence !== "attended").map(ref),
		kept: leaving.filter((g) => g.presence === "attended").map(ref),
		removedBefore: new Map(f.guests.filter((g) => g.removed_at).map((g) => [g.person_id, g])),
	};
}
const sameSet = (a: readonly string[], b: readonly string[]) =>
	a.length === b.length && [...a].sort().join() === [...b].sort().join();

export const rosterReader = {
	/** What an update from the ministry would change now; Owner or Admin. Nothing is written. */
	async previewRosterImport(db: Reader, authority: RequestActor, raw: unknown) {
		return read(authority, async (v) => {
			const i = parse(c.meetingRequest, raw);
			const { row, admin } = await one(
				db,
				v,
				sql`SELECT ${rosterColumns} FROM meeting m WHERE ${plantMeeting(v.plantId, i.meetingId)} AND m.retired_at IS NULL`,
				true,
			);
			if (!row || !admin) deny();
			const p = plan(row);
			return c.rosterPreview.parse({ meetingId: i.meetingId, team: p.team, add: p.add, remove: p.remove, kept: p.kept });
		});
	},
};

export const rosterWriter = {
	/**
	 * Applies a reviewed update from the ministry as one write. A removal follows the hand removal's rules: the guest
	 * leaves the current list, their open RSVP link closes and their card clears, and the row and its history stay;
	 * reminders read the current list when they run. A replay of the same request key returns the first answer.
	 */
	async copyTeamRoster(tx: Tx, ctx: MeetingsContext, raw: unknown) {
		return reply(tx, async () => {
			const input = parse(c.copyTeamRosterRequest, raw);
			return command(tx, ctx, "meetings.copyTeamRoster", input, async (w, audit) => {
				const { meetingId } = input.input;
				const r = await tx.execute(sql`SELECT ${meetingColumns}, ${rosterColumns},
						m.finalized_at IS NOT NULL AS finalized, clock_timestamp() AS now
					FROM meeting m WHERE ${plantMeeting(w.plant.id, meetingId)} AND m.retired_at IS NULL FOR UPDATE OF m`);
				const row = r.rows[0] as Record<string, unknown> | undefined;
				if (!row) deny();
				const m = meetingRow.parse(row);
				const now = z.coerce.date().parse(row.now);
				const p = plan(row);
				const removeIds = p.remove.map((g) => g.personId);
				// The list changed since the review: nothing is applied that the person did not see.
				const addIds = p.add.map((a) => a.personId);
				if (!sameSet(input.input.add, addIds) || !sameSet(input.input.remove, removeIds)) deny("conflict");
				const added: GuestRow[] = p.add.map((a) => {
					const was = p.removedBefore.get(a.personId);
					return {
						id: was?.id ?? randomUUID(),
						revision: was ? next(was.revision) : "1",
						rsvp: "pending",
						rsvp_source: null,
						rsvp_at: null,
						presence: was?.presence ?? "absent",
						card_response: null,
						card_notes: null,
						card_occurred_at: null,
						card_recorded_at: null,
						removed_at: null,
						rsvp_token_open: false,
						inviter_person_id: was?.inviter_person_id ?? null,
						person_id: a.personId,
						person_name: a.displayName,
						person_state: "live",
						inviter_name: was?.inviter_name ?? null,
						inviter_state: was?.inviter_state ?? null,
					};
				});
				const changed = added.length > 0 || removeIds.length > 0;
				// A guest who comes back already marked present changes who attended (REQ-MTG-012).
				if (added.some((g) => g.presence === "attended")) {
					if (row.finalized === true) deny("status_transition");
					audit.writes.push(
						sql`UPDATE meeting SET attendance_revision = attendance_revision + 1 WHERE id = ${m.id}::uuid`,
					);
				}
				if (removeIds.length)
					audit.writes.push(sql`UPDATE participation SET removed_at = ${now.toISOString()}::timestamptz,
						rsvp_token_open = false, card_response = NULL, card_notes = NULL, card_occurred_at = NULL,
						card_recorded_at = NULL, card_author_id = NULL, revision = revision + 1
						WHERE meeting_id = ${m.id}::uuid AND plant_id = ${w.plant.id}::uuid
							AND person_id = ANY(${sql.param(removeIds)}::uuid[]) AND removed_at IS NULL`);
				if (added.length)
					audit.writes
						.push(sql`INSERT INTO participation (id, plant_id, meeting_id, person_id, roster_member, rsvp, presence)
						SELECT v.id, ${w.plant.id}::uuid, ${m.id}::uuid, v.person_id, true, 'pending', 'absent'
						FROM unnest(${sql.param(added.map((g) => g.id))}::uuid[], ${sql.param(added.map((g) => g.person_id))}::uuid[])
							AS v(id, person_id)
						ON CONFLICT (meeting_id, person_id) DO UPDATE SET removed_at = NULL, roster_member = true,
							rsvp = 'pending', rsvp_source = NULL, rsvp_at = NULL, revision = participation.revision + 1
							WHERE participation.removed_at IS NOT NULL`);
				return {
					value: c.rosterUpdateResult.parse({
						receiptId: audit.id,
						outcome: changed ? "changed" : "noop",
						meetingId: m.id,
						added: added.map(guest),
						removedPersonIds: removeIds,
					}),
					subject: m.id,
					subjectType: "meeting",
					meetingId: m.id,
					action: "meetings.changed",
					kind: "edit",
					outcome: changed ? "changed" : "noop",
					before: { rosterAdded: [], rosterRemoved: [] },
					after: { rosterAdded: addIds, rosterRemoved: removeIds },
					metadata: { teamId: p.team.id },
				};
			});
		});
	},
};
