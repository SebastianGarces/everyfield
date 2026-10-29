// Seeds one meeting of each type for the Messages handoff test (WP-027/ui), after the People seed. Orientation and the
// practice meeting go through the meetings producer. A team meeting and a retired meeting start as scheduled Vision
// meetings and are changed by the admin connection, because no producer schedules them in this seed.
//
//   up:   node --env-file=<home apps/web/.env.local> --conditions=react-server --import tsx tests/ui/communication/seed.mts up
//   down: node --env-file=<home apps/web/.env.local> --conditions=react-server --import tsx tests/ui/communication/seed.mts down
//
// `up` reads the People fixture and writes the meeting ids to $COMMUNICATION_UI_FIXTURE (default
// /tmp/everyfield-communication-ui.json).
import { sql } from "../../../packages/db/node_modules/drizzle-orm/index.js";
import { meetingsWriter } from "../../../packages/domain/src/meetings/index.ts";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { fixturePath } from "../setup.mjs";
import { dropSeed, openSeedEnvironment, writeFixture } from "../seed-env.mts";

async function up() {
	const people = JSON.parse(readFileSync(fixturePath("people"), "utf8"));
	const env = await openSeedEnvironment(people.origin);
	const { admin, runtime } = env;
	const session = await admin.execute(sql`SELECT s.id FROM auth_session s JOIN auth_user u ON u.id = s.user_id
		WHERE u.email = 'owner@people-preview.example.test' ORDER BY s.created_at DESC LIMIT 1`);
	const ctx = { session: session.rows[0]!.id, selected: { kind: "plant", id: people.plant } } as never;
	const guests = ["Sara Nunez", "Leo Pratt"].map((n) => people.people[n] as string);
	const date = new Date(Date.now() + 6 * 86_400_000).toISOString().slice(0, 10);
	const schedule = async (type: "vision_meeting" | "orientation" | "prelaunch_practice") => {
		const r = await runtime.transaction((tx) =>
			meetingsWriter.schedule(tx as never, ctx, {
				requestKey: randomUUID(),
				input: { type, date, time: "19:00", guests },
			}),
		);
		if (r.status !== "ok") throw Error(`schedule ${type}: ${JSON.stringify(r)}`);
		return r.value.meeting.id as string;
	};
	const orientation = await schedule("orientation");
	const practice = await schedule("prelaunch_practice");
	const team = await schedule("vision_meeting");
	const teamId = randomUUID();
	await admin.execute(sql`INSERT INTO team (id, plant_id, name, state, sort_order)
		VALUES (${teamId}::uuid, ${people.plant}::uuid, 'Handoff team', 'active', 99)`);
	await admin.execute(
		sql`UPDATE meeting SET type = 'team_meeting', vision_number = NULL, kit_version = NULL, team_id = ${teamId}::uuid WHERE id = ${team}::uuid`,
	);
	const retired = await schedule("vision_meeting");
	await admin.execute(sql`UPDATE meeting SET retired_at = clock_timestamp() WHERE id = ${retired}::uuid`);
	const fixture = writeFixture("communication", env.schema, { orientation, practice, team, retired });
	await env.close();
	console.log(JSON.stringify({ schema: env.schema, fixture }));
}

const [action] = process.argv.slice(2);
if (action === "up") await up();
else if (action === "down") console.log(JSON.stringify(await dropSeed("communication")));
else throw Error("Usage: seed.mts up | down");
