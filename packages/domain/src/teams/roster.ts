import * as c from "@everyfield/contracts/teams";
import { sql, type SQL } from "@everyfield/db/query";
import { randomUUID } from "node:crypto";
import "server-only";
import { z } from "zod";
import { command, deny, parse, reply, type TeamsContext, type Tx } from "./core.ts";

const id = z.string().uuid();
async function oneRow(tx: Tx, query: SQL) {
	const found = await tx.execute(query);
	return found.rows[0] as Record<string, unknown> | undefined;
}

/** Copies the team's live roster onto a team meeting. Later joins do not change rows already copied. */
export const rosterWriter = {
	async copyTeamRoster(tx: Tx, ctx: TeamsContext, raw: unknown) {
		return reply(tx, async () => {
			const input = parse(c.copyTeamRosterRequest, raw);
			return command(
				tx,
				ctx,
				"meetings.copyTeamRoster",
				input,
				async (w, audit) => {
					const found = await oneRow(
						tx,
						sql`SELECT m.team_id AS "teamId",
							coalesce((SELECT json_agg(DISTINCT p.id) FROM team_tenure tn
								JOIN team_role r ON r.id = tn.role_id
								JOIN team t ON t.id = r.team_id
								JOIN person p ON p.id = tn.person_id AND p.state = 'live'
								WHERE t.id = ${input.input.teamId}::uuid AND t.plant_id = m.plant_id
									AND t.archived_at IS NULL AND r.retired_at IS NULL AND tn.ended_on IS NULL), '[]'::json) AS live,
							coalesce((SELECT json_agg(person_id) FROM participation
								WHERE meeting_id = m.id AND plant_id = m.plant_id), '[]'::json) AS present
							FROM meeting m
							WHERE m.id = ${input.input.meetingId}::uuid AND m.plant_id = ${w.plant.id}::uuid
							FOR UPDATE OF m`,
					);
					if (!found) {
						const other = await oneRow(tx, sql`SELECT 1 AS n FROM meeting WHERE id = ${input.input.meetingId}::uuid`);
						if (other) deny("access_denied");
						deny();
					}
					if (found.teamId !== input.input.teamId) deny("invalid_subject");
					const live = z.array(id).parse(found.live);
					const present = new Set(z.array(id).parse(found.present));
					const added = live.filter((personId) => !present.has(personId));
					const skipped = live.filter((personId) => present.has(personId));
					const first = added[0] ? randomUUID() : null;
					if (added.length)
						audit.writes.push(sql`INSERT INTO participation
							(id, plant_id, meeting_id, person_id, roster_member, presence, rsvp)
							SELECT v.id, ${w.plant.id}::uuid, ${input.input.meetingId}::uuid, v.person_id, true, 'absent', 'pending'
							FROM (VALUES ${sql.join(
								added.map((personId, index) => sql`(${index === 0 ? first : randomUUID()}::uuid, ${personId}::uuid)`),
								sql`, `,
							)}) AS v(id, person_id)
							ON CONFLICT (meeting_id, person_id) DO NOTHING`);
					return {
						value: c.rosterCopyResult.parse({
							receiptId: audit.id,
							outcome: added.length ? "changed" : "noop",
							meetingId: input.input.meetingId,
							teamId: input.input.teamId,
							addedPersonIds: added,
							skippedPersonIds: skipped,
						}),
						subject: first ?? input.input.meetingId,
						subjectType: first ? "participation" : "record",
						kind: added.length ? "assign" : "noop",
						outcome: added.length ? "changed" : "noop",
						before: { present: skipped.length },
						after: { added: added.length },
					};
				},
				input.input.teamId,
			);
		});
	},
};
