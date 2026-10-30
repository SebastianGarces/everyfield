// Seeds a meetings preview on the shared development database (WP-020/ui), after the People seed. It schedules one
// Vision meeting with guests through the WP-020 producer and writes one open RSVP link per browser engine, as the
// invitation send (WP-028) will. The link is a random token whose SHA-256 is stored on the guest row. For WP-022 it
// also schedules one Vision meeting per engine that started two hours ago, for check-in, finalize and evaluation.
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
	// WP-022: one Vision meeting per engine that started two hours ago, for door check-in, finalize and evaluation.
	const past: Record<string, { meetingId: string; guests: string[] }> = {};
	for (const [engine, guestNames] of [
		["chromium", ["Guest 11", "Guest 12"]],
		["webkit", ["Guest 13", "Guest 14"]],
	] as const) {
		const r = await runtime.transaction((tx) =>
			meetingsWriter.schedule(tx as never, ctx, {
				requestKey: randomUUID(),
				input: { type: "vision_meeting", date, time: "18:30", guests: guestNames.map((n) => people.people[n]) },
			}),
		);
		if (r.status !== "ok") throw Error("schedule past: " + JSON.stringify(r));
		// Scheduling refuses a past start, so the seed moves the start back as the meeting's own clock would.
		await admin.execute(sql`UPDATE meeting SET starts_at = clock_timestamp() - interval '2 hours',
			local_date = ((clock_timestamp() - interval '2 hours') AT TIME ZONE timezone)::date WHERE id = ${r.value.meeting.id}::uuid`);
		past[engine] = { meetingId: r.value.meeting.id, guests: [...guestNames] };
	}
	// WP-020/ui page flow: per engine one Vision meeting with no guests (the page's own flow runs on it) and one
	// Orientation with guests, which has no Kit tab.
	const flow: Record<string, string> = {};
	for (const engine of ["chromium", "webkit"]) {
		const r = await runtime.transaction((tx) =>
			meetingsWriter.schedule(tx as never, ctx, {
				requestKey: randomUUID(),
				input: { type: "vision_meeting", date, time: "18:30", guests: [] },
			}),
		);
		if (r.status !== "ok") throw Error("schedule flow: " + JSON.stringify(r));
		flow[engine] = r.value.meeting.id;
	}
	// WP-020/ui Kit tab fill height: per engine one Vision meeting with the reviewed kit, and one more that is cancelled.
	const kit: Record<string, { open: string; cancelled: string }> = {};
	for (const engine of ["chromium", "webkit"]) {
		const made: string[] = [];
		for (const cancel of [false, true]) {
			const s = await runtime.transaction((tx) =>
				meetingsWriter.schedule(tx as never, ctx, {
					requestKey: randomUUID(),
					input: { type: "vision_meeting", date, time: "18:30", guests: [] },
				}),
			);
			if (s.status !== "ok") throw Error("schedule kit: " + JSON.stringify(s));
			const k = await runtime.transaction((tx) =>
				meetingsWriter.populateKit(tx as never, ctx, {
					requestKey: randomUUID(),
					expectedRevision: s.value.meeting.revision,
					input: { meetingId: s.value.meeting.id },
				}),
			);
			if (k.status !== "ok") throw Error("populate kit: " + JSON.stringify(k));
			if (cancel) {
				const c = await runtime.transaction((tx) =>
					meetingsWriter.changeStatus(tx as never, ctx, {
						requestKey: randomUUID(),
						expectedRevision: k.value.meeting.revision,
						input: { meetingId: s.value.meeting.id, to: "cancelled" },
					}),
				);
				if (c.status !== "ok") throw Error("cancel kit: " + JSON.stringify(c));
			}
			made.push(s.value.meeting.id);
		}
		kit[engine] = { open: made[0]!, cancelled: made[1]! };
	}
	// The owner's own Person, so the state meetings show the viewer's invitation banner.
	const ownerRow = await admin.execute(
		sql`SELECT id FROM person WHERE linked_account_id = ${people.owner.accountId}::uuid AND state = 'live' LIMIT 1`,
	);
	const ownerPerson = ownerRow.rows[0]!.id as string;
	// WP-020/ui default tab and check-in state: per engine one ready Vision meeting with guests, and one completed.
	const state: Record<string, { ready: string; completed: string }> = {};
	for (const engine of ["chromium", "webkit"]) {
		const made: string[] = [];
		for (const path of [["ready"], ["in_progress", "completed"]] as const) {
			const s = await runtime.transaction((tx) =>
				meetingsWriter.schedule(tx as never, ctx, {
					requestKey: randomUUID(),
					input: { type: "vision_meeting", date, time: "18:30", guests: [...guests, ownerPerson] },
				}),
			);
			if (s.status !== "ok") throw Error("schedule state: " + JSON.stringify(s));
			let revision = s.value.meeting.revision;
			for (const to of path) {
				const c = await runtime.transaction((tx) =>
					meetingsWriter.changeStatus(tx as never, ctx, {
						requestKey: randomUUID(),
						expectedRevision: revision,
						input: { meetingId: s.value.meeting.id, to },
					}),
				);
				if (c.status !== "ok") throw Error(`status ${to}: ` + JSON.stringify(c));
				revision = c.value.meeting.revision;
			}
			made.push(s.value.meeting.id);
		}
		state[engine] = { ready: made[0]!, completed: made[1]! };
	}
	// S2 F06: per engine two Vision meetings dated after today in their timezone, to finalize and evaluate (the server
	// defaults the evaluation date; the modal never sends one). One takes a blank note, the other a whitespace-only note.
	const future: Record<string, string[]> = {};
	for (const engine of ["chromium", "webkit"]) {
		future[engine] = [];
		for (let i = 0; i < 2; i++) {
			const r = await runtime.transaction((tx) =>
				meetingsWriter.schedule(tx as never, ctx, {
					requestKey: randomUUID(),
					input: { type: "vision_meeting", date, time: "18:30", guests: [] },
				}),
			);
			if (r.status !== "ok") throw Error("schedule future: " + JSON.stringify(r));
			future[engine]!.push(r.value.meeting.id);
		}
	}
	const o = await runtime.transaction((tx) =>
		meetingsWriter.schedule(tx as never, ctx, {
			requestKey: randomUUID(),
			input: { type: "orientation", date, time: "18:30", guests },
		}),
	);
	if (o.status !== "ok") throw Error("schedule orientation: " + JSON.stringify(o));
	const fixture = writeFixture("meetings", env.schema, {
		meetingId,
		links,
		past,
		flow,
		future,
		kit,
		state,
		orientationId: o.value.meeting.id,
	});
	await env.close();
	console.log(JSON.stringify({ schema: env.schema, fixture }));
}

const [action] = process.argv.slice(2);
if (action === "up") await up();
else if (action === "down") console.log(JSON.stringify(await dropSeed("meetings")));
else throw Error("Usage: seed.mts up | down");
