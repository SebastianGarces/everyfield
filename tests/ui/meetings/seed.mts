import { sql } from "../../../packages/db/node_modules/drizzle-orm/index.js";
import { meetingsWriter } from "../../../packages/domain/src/meetings/index.ts";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { fixturePath } from "../setup.mjs";
import { dropSeed, openSeedEnvironment, writeFixture } from "../seed-env.mts";
import { gatedTransaction } from "../../../packages/domain/src/operations/writes.ts";

async function up() {
	const people = JSON.parse(readFileSync(fixturePath("people"), "utf8"));
	const env = await openSeedEnvironment(people.origin);
	const { admin, runtime } = env;
	const session = await admin.execute(sql`SELECT s.id FROM auth_session s JOIN auth_user u ON u.id = s.user_id
		WHERE u.email = 'owner@people-preview.example.test' ORDER BY s.created_at DESC LIMIT 1`);
	const ctx = { session: session.rows[0]!.id, selected: { kind: "plant", id: people.plant } } as never;
	const date = new Date(Date.now() + 5 * 86_400_000).toISOString().slice(0, 10);
	const past: Record<string, { meetingId: string; guests: string[] }> = {};
	for (const [engine, guestNames] of [
		["chromium", ["Guest 11", "Guest 12"]],
		["webkit", ["Guest 13", "Guest 14"]],
	] as const) {
		const r = await gatedTransaction(runtime, (tx) =>
			meetingsWriter.schedule(tx as never, ctx, {
				requestKey: randomUUID(),
				input: { type: "vision_meeting", date, time: "18:30", guests: guestNames.map((n) => people.people[n]) },
			}),
		);
		if (r.status !== "ok") throw Error("schedule past: " + JSON.stringify(r));
		await admin.execute(sql`UPDATE meeting SET starts_at = clock_timestamp() - interval '2 hours',
			local_date = ((clock_timestamp() - interval '2 hours') AT TIME ZONE timezone)::date WHERE id = ${r.value.meeting.id}::uuid`);
		past[engine] = { meetingId: r.value.meeting.id, guests: [...guestNames] };
	}
	const revisions: Record<string, { card: { meetingId: string; guest: string }; walkIn: string }> = {};
	for (const [engine, guest] of [
		["chromium", "Guest 15"],
		["webkit", "Guest 16"],
	] as const) {
		const ids: string[] = [];
		for (const guestNames of [[guest], []]) {
			const r = await gatedTransaction(runtime, (tx) =>
				meetingsWriter.schedule(tx as never, ctx, {
					requestKey: randomUUID(),
					input: { type: "vision_meeting", date, time: "18:30", guests: guestNames.map((n) => people.people[n]) },
				}),
			);
			if (r.status !== "ok") throw Error("schedule revisions: " + JSON.stringify(r));
			const id = r.value.meeting.id;
			await admin.execute(sql`UPDATE meeting SET starts_at = clock_timestamp() - interval '2 hours',
				local_date = ((clock_timestamp() - interval '2 hours') AT TIME ZONE timezone)::date WHERE id = ${id}::uuid`);
			if (guestNames.length) {
				await admin.execute(sql`UPDATE participation SET presence = 'attended', revision = revision + 1
					WHERE meeting_id = ${id}::uuid`);
				await admin.execute(
					sql`UPDATE meeting SET attendance_revision = attendance_revision + 1 WHERE id = ${id}::uuid`,
				);
			}
			ids.push(id);
		}
		revisions[engine] = { card: { meetingId: ids[0]!, guest }, walkIn: ids[1]! };
	}
	const fixture = writeFixture("meetings", env.schema, { past, revisions });
	await env.close();
	console.log(JSON.stringify({ schema: env.schema, fixture }));
}

const [action] = process.argv.slice(2);
if (action === "up") await up();
else if (action === "down") console.log(JSON.stringify(await dropSeed("meetings")));
else throw Error("Usage: seed.mts up | down");
