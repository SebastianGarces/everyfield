// Seeds a meetings preview on the shared development database (WP-020/ui), after the People seed. It schedules one
// Vision meeting with guests through the WP-020 producer and writes one open RSVP link per browser engine, as the
// invitation send (WP-028) will. The link is a random token whose SHA-256 is stored on the guest row.
//
//   up:   node --env-file=<home apps/web/.env.local> --conditions=react-server --import tsx tests/ui/meetings/seed.mts up
//   down: node --env-file=<home apps/web/.env.local> --conditions=react-server --import tsx tests/ui/meetings/seed.mts down
//
// `up` reads the People fixture and writes the meeting and links to $MEETINGS_UI_FIXTURE (default
// /tmp/everyfield-meetings-ui.json).
import { sql } from "../../../packages/db/node_modules/drizzle-orm/index.js";
import { meetingsWriter } from "../../../packages/domain/src/meetings/index.ts";
import { createHash, randomBytes, randomUUID } from "node:crypto";
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
	const guests = ["Sara Nunez", "Leo Pratt", "Ana Lee"].map((n) => people.people[n] as string);
	const date = new Date(Date.now() + 5 * 86_400_000).toISOString().slice(0, 10);
	const created = await runtime.transaction((tx) =>
		meetingsWriter.schedule(tx as never, ctx, {
			requestKey: randomUUID(),
			input: { type: "vision_meeting", date, time: "18:30", guests },
		}),
	);
	if (created.status !== "ok") throw Error("schedule: " + JSON.stringify(created));
	const meetingId = created.value.meeting.id;
	const links: Record<string, { token: string; first: string }> = {};
	for (const [engine, name] of [
		["chromium", "Sara Nunez"],
		["webkit", "Leo Pratt"],
	] as const) {
		const token = randomBytes(32).toString("base64url");
		await admin.execute(sql`UPDATE participation SET rsvp_token_hash = ${createHash("sha256").update(token).digest("hex")},
			rsvp_token_expires_at = clock_timestamp() + interval '7 days', rsvp_token_open = true, revision = revision + 1
			WHERE meeting_id = ${meetingId}::uuid AND person_id = ${people.people[name]}::uuid`);
		links[engine] = { token, first: name.split(" ")[0]! };
	}
	const fixture = writeFixture("meetings", env.schema, { meetingId, links });
	await env.close();
	console.log(JSON.stringify({ schema: env.schema, fixture }));
}

const [action] = process.argv.slice(2);
if (action === "up") await up();
else if (action === "down") console.log(JSON.stringify(await dropSeed("meetings")));
else throw Error("Usage: seed.mts up | down");
