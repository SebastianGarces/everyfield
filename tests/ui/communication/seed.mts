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
	// A saved follow-up: a Reviewed message. History opens it on Review with the subject and body locked.
	const reviewed = randomUUID();
	await admin.execute(sql`INSERT INTO communication (id, plant_id, revision, state, subject, body_html, body_text, audience)
		VALUES (${reviewed}::uuid, ${people.plant}::uuid, 1, 'reviewed', 'Reviewed follow-up seed',
		'<p>Hello {{name}}, we missed you.</p>', 'Hello {{name}}, we missed you.',
		${JSON.stringify({ groups: [], teamIds: [], personIds: [people.people["Sara Nunez"]] })}::jsonb)`);
	// A message with a plain-text body and no stored HTML, the shape of a message written before the HTML editor. History
	// opens it by id (?message=<id>) and shows the plain-text line (criterion 4). It has no mail rows, because the app
	// cannot make a record without HTML that also has sent mail.
	const legacy = randomUUID();
	await admin.execute(sql`INSERT INTO communication (id, plant_id, revision, state, subject, body_text, audience)
		VALUES (${legacy}::uuid, ${people.plant}::uuid, 1, 'draft', 'Legacy thank you seed',
		'Thank you for coming on Sunday.' || chr(10) || 'We hope to see you again.',
		${JSON.stringify({ groups: [], teamIds: [], personIds: [people.people["Sara Nunez"]] })}::jsonb)`);
	const fixture = writeFixture("communication", env.schema, { orientation, practice, team, retired, reviewed, legacy });
	await env.close();
	console.log(JSON.stringify({ schema: env.schema, fixture }));
}

const [action] = process.argv.slice(2);
if (action === "up") await up();
else if (action === "down") console.log(JSON.stringify(await dropSeed("communication")));
else throw Error("Usage: seed.mts up | down");
