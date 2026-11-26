import * as q from "@everyfield/contracts/settings";
import type { SettingsProducer } from "@everyfield/contracts/settings/server";
import { sql } from "@everyfield/db/query";
import "server-only";
import { z } from "zod";
import { liveAccess, liveRead, liveRows, type RequestActor } from "../access/session.ts";
import type { Reader } from "../organizations/core.ts";
import { actor, appendEvent, begin, deny, finish, parse, reply, revision, sameOwner, type Tx } from "./core.ts";

const leadRole = (plant: string) =>
	sql`SELECT r.id, r.team_id FROM onboarding_setup s
	JOIN team_role r ON r.id=(s.lead->'assignment'->>'roleId')::uuid AND r.plant_id=s.plant_id AND r.retired_at IS NULL
	JOIN team tm ON tm.id=r.team_id AND tm.plant_id=r.plant_id AND tm.archived_at IS NULL
	WHERE s.plant_id=${plant}::uuid AND s.lead->>'answer'='yes'`;
const readRow = z.object({
	revision: z.string(),
	owner: z.boolean(),
	role_id: z.uuid().nullable(),
	holder: z.object({ personId: z.uuid(), name: z.string() }).nullable(),
	people: z.array(z.object({ personId: z.uuid(), name: z.string() })),
});

export async function readLeadPlanter(db: Reader, authority: RequestActor): Promise<q.LeadPlanterRead | null> {
	const context = authority.actor.context;
	if (context.kind !== "seat" || context.owner.kind !== "plant") return null;
	const plant = context.owner.id;
	const owner = context.role === "owner";
	const rows = await liveRows(
		db,
		liveRead(liveAccess(authority)),
		sql`WITH r AS (${leadRole(plant)}),
		h AS (SELECT pe.id, pe.display_name FROM team_tenure tn
			JOIN person pe ON pe.id=tn.person_id AND pe.plant_id=tn.plant_id AND pe.state='live'
			WHERE tn.role_id=(SELECT id FROM r) AND tn.plant_id=${plant}::uuid AND tn.ended_on IS NULL)
		SELECT pl.revision::text AS revision, ${owner}::boolean AS owner, (SELECT id FROM r) AS role_id,
			CASE WHEN (SELECT count(*) FROM h)=1 THEN (SELECT json_build_object('personId',id,'name',display_name) FROM h) END
				AS holder,
			CASE WHEN ${owner}::boolean AND EXISTS(SELECT FROM r) THEN (SELECT coalesce(json_agg(json_build_object(
				'personId',id,'name',display_name) ORDER BY display_name, id),'[]') FROM person
				WHERE plant_id=${plant}::uuid AND state='live') ELSE '[]' END AS people
		FROM plant pl WHERE pl.id=${plant}::uuid`,
	);
	if (!rows?.[0]) return null;
	const r = readRow.parse(rows[0]);
	return q.leadPlanterRead.parse({
		revision: r.revision,
		canEdit: r.owner && r.role_id !== null,
		lead: r.role_id ? { roleId: r.role_id, holder: r.holder } : null,
		people: r.people,
	});
}

const lockedRow = z.object({
	role: z.object({ id: z.uuid(), team_id: z.uuid() }).nullable(),
	live: z.boolean(),
	holders: z.array(z.uuid()),
});

export const leadOperations: Pick<SettingsProducer<Tx>, "setLeadPlanter"> = {
	setLeadPlanter: (tx, ctx, raw) =>
		reply(tx, async () => {
			const v = parse(q.setLeadPlanterRequest, raw);
			const a = await actor(tx, ctx, "command");
			if (
				!sameOwner(ctx.selected, v.input.plant) ||
				a.identity.context.kind !== "seat" ||
				a.identity.context.role !== "owner" ||
				!a.plant
			)
				deny("unavailable");
			const c = await begin(tx, ctx, a.account.id, "settings.setLeadPlanter", v);
			if (c.kind === "replay") return q.leadPlanterResult.parse(c.value);
			revision(v.expectedRevision, a.plant.revision);
			const plant = a.plant.id,
				person = v.input.personId;
			const locked = lockedRow.parse(
				(
					await tx.execute(sql`WITH r AS MATERIALIZED (${leadRole(plant)} FOR UPDATE OF r, tm),
					pe AS MATERIALIZED (SELECT id FROM person WHERE id=${person}::uuid AND plant_id=${plant}::uuid
						AND state='live' FOR SHARE),
					h AS MATERIALIZED (SELECT person_id FROM team_tenure WHERE role_id=(SELECT id FROM r)
						AND plant_id=${plant}::uuid AND ended_on IS NULL FOR UPDATE)
					SELECT (SELECT row_to_json(r) FROM r) AS role, EXISTS(SELECT FROM pe) AS live,
						(SELECT coalesce(json_agg(person_id),'[]') FROM h) AS holders`)
				).rows[0],
			);
			const role = locked.role;
			if (!role) deny("unavailable");
			if (!locked.live) deny("invalid_subject");
			const holders = locked.holders;
			const changed = holders.length !== 1 || holders[0] !== person;
			const after = changed ? String(BigInt(a.plant.revision) + 1n) : a.plant.revision;
			if (changed) {
				const today = sql`(clock_timestamp() AT TIME ZONE (SELECT timezone FROM plant WHERE id=${plant}::uuid))::date`;
				await tx.execute(sql`UPDATE team_tenure SET ended_on=${today}, revision=revision+1 WHERE role_id=${role.id}::uuid
					AND plant_id=${plant}::uuid AND ended_on IS NULL AND person_id<>${person}::uuid`);
				if (!holders.includes(person))
					c.writes.push(sql`INSERT INTO team_tenure(plant_id,role_id,person_id,started_on)
					VALUES (${plant}::uuid,${role.id}::uuid,${person}::uuid,${today})`);
				c.writes.push(
					sql`UPDATE team SET leader_person_id=${person}::uuid, leader_source='role_derived',
					leader_role_id=${role.id}::uuid, revision=revision+1 WHERE id=${role.team_id}::uuid AND plant_id=${plant}::uuid
					AND leader_person_id IS DISTINCT FROM ${person}::uuid
					AND (leader_person_id IS NULL OR (leader_source='role_derived' AND leader_role_id=${role.id}::uuid))`,
					sql`UPDATE plant SET revision=revision+1 WHERE id=${plant}::uuid`,
				);
				await appendEvent(tx, c, role.id, "assign", "roles.changed", a.plant.revision, after);
			}
			return finish(tx, c, q.leadPlanterResult, () => ({ plant: v.input.plant, revision: after, personId: person }));
		}),
};
