// Seeds the launch team for the Evry email tests (WP-028 slice 2), after the People seed: people with an address, one whose
// address bounced and is blocked, one who unsubscribed from the church's email, and one with no address. The People seed already holds
// Rosa Bennett on the launch team.
//
//   up:   node --env-file=<home apps/web/.env.local> --conditions=react-server --import tsx tests/ui/evry/seed.mts up
//   down: node --env-file=<home apps/web/.env.local> --conditions=react-server --import tsx tests/ui/evry/seed.mts down
//
// `up` reads the People fixture and writes the people ids to $EVRY_UI_FIXTURE (default /tmp/everyfield-evry-ui.json).
import { sql } from "../../../packages/db/node_modules/drizzle-orm/index.js";
import { createHmac, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { fixturePath } from "../setup.mjs";
import { dropSeed, openSeedEnvironment, writeFixture } from "../seed-env.mts";

const LAUNCH_TEAM = [
	["Lena Ortiz", "lena.ortiz@example.test"],
	["Marcus Webb", "marcus.webb@example.test"],
	["Priya Nair", "priya.nair@example.test"],
	["Dana Cole", "dana.cole@example.test"],
	["Noah Quinn", null],
] as const;
async function up() {
	const people = JSON.parse(readFileSync(fixturePath("people"), "utf8"));
	const env = await openSeedEnvironment(people.origin);
	const { admin } = env;
	const ids: Record<string, string> = {};
	// A repeated seed starts from its own people again.
	await admin.execute(
		sql`DELETE FROM person_email_opt_out WHERE person_id IN (SELECT id FROM person WHERE plant_id=${people.plant}::uuid AND display_name IN (${sql.join(
			LAUNCH_TEAM.map(([name]) => sql`${name}`),
			sql`, `,
		)}))`,
	);
	await admin.execute(
		sql`DELETE FROM person WHERE plant_id=${people.plant}::uuid AND display_name IN (${sql.join(
			LAUNCH_TEAM.map(([name]) => sql`${name}`),
			sql`, `,
		)})`,
	);
	for (const [name, email] of LAUNCH_TEAM) {
		const id = randomUUID();
		ids[name] = id;
		await admin.execute(sql`INSERT INTO person(id,tenant_id,plant_id,display_name,email,source,created_at,stage,adult_classification,commitment_state,pipeline_position,state)
			VALUES(${id}::uuid,${people.plant}::uuid,${people.plant}::uuid,${name},${email},'other',clock_timestamp(),'launch_team','unknown','unknown',900,'live')`);
	}
	// Priya's address bounced and is blocked.
	const event = randomUUID();
	await admin.execute(sql`INSERT INTO provider_event(id,event_key,message_id,kind,occurred_at,received_at,payload_hash,safe_payload)
		VALUES(${event}::uuid,${"seed-" + event},${"seed-" + event},'bounced',clock_timestamp(),clock_timestamp(),'x','{"hard_bounce":true}'::jsonb)`);
	await admin.execute(sql`INSERT INTO suppression(address_hash,reason,source_event_id,suppressed_at)
		VALUES(${createHmac("sha256", env.addressKey).update("priya.nair@example.test").digest("hex")},'hard_bounce',${event}::uuid,clock_timestamp())
		ON CONFLICT (address_hash) DO NOTHING`);
	// Dana unsubscribed from this church's email (the Messages opt-out the handoff honors).
	await admin.execute(
		sql`INSERT INTO person_email_opt_out(plant_id,person_id) VALUES(${people.plant}::uuid,${ids["Dana Cole"]}::uuid)`,
	);
	const fixture = writeFixture("evry", env.schema, { people: ids });
	await env.close();
	console.log(JSON.stringify({ schema: env.schema, fixture }));
}

const [action] = process.argv.slice(2);
if (action === "up") await up();
else if (action === "down") console.log(JSON.stringify(await dropSeed("evry")));
else throw Error("Usage: seed.mts up | down");
