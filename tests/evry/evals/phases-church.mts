import { randomUUID } from "node:crypto";
import { sql } from "../../../packages/db/node_modules/drizzle-orm/index.js";
import type { Database } from "../../../packages/db/src/client.ts";
import { MINISTRY_RESPONSIBILITIES } from "../../../packages/contracts/src/intelligence/index.ts";
import { live, PLANT } from "./golden-church.mts";
import { authorityOf, day, planOf, writer } from "./launch-church.mts";

export const COMMITTED = 18;
export const COMMITTED_PEOPLE = live()
	.map((p) => p.name)
	.toSorted()
	.slice(0, COMMITTED);

export async function seedCommitted(admin: Database) {
	for (const [n, name] of COMMITTED_PEOPLE.entries()) {
		const person = live().find((p) => p.name === name)!.id;
		const signed = sql`((now() AT TIME ZONE 'America/Chicago')::date - ${2 + n * 3}::int)`;
		await admin.execute(sql`INSERT INTO commitment(id,plant_id,person_id,kind,signed_on,recorded_at,notes)
			SELECT ${randomUUID()},${PLANT},${person},'core_group',${signed},now(),'Core group card'
			WHERE NOT EXISTS(SELECT FROM commitment WHERE person_id=${person} AND voided_at IS NULL)`);
		await admin.execute(sql`UPDATE person SET adult_classification='adult',commitment_state='active',
			commitment_effective_on=coalesce(commitment_effective_on,${signed}) WHERE id=${person}`);
	}
}

export async function seedAllMet(admin: Database, db: Database) {
	const keys = MINISTRY_RESPONSIBILITIES.map((r) => r.key);
	const { rows } = await admin.execute(sql`SELECT DISTINCT r.id FROM team_role r
		JOIN team t ON t.id=r.team_id AND t.archived_at IS NULL
		JOIN team_tenure n ON n.role_id=r.id AND n.ended_on IS NULL
		WHERE r.plant_id=${PLANT} AND r.retired_at IS NULL ORDER BY r.id LIMIT ${keys.length}`);
	if (rows.length < keys.length) throw Error(`only ${rows.length} staffed roles for ${keys.length} responsibilities`);
	for (const [n, row] of rows.entries())
		await admin.execute(sql`UPDATE team_role SET responsibility_key=${keys[n]!} WHERE id=${String(row.id)}`);
	const plan = await planOf(db);
	const reply = await writer.schedule(db, await authorityOf(db, "owner"), {
		requestKey: randomUUID(),
		expectedRevision: plan.revision,
		input: { date: day(60), reason: null },
	});
	if (reply.status !== "ok") throw Error(`launch fixture refused: ${JSON.stringify(reply.error)}`);
}
