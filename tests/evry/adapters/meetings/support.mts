import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import {
	createAttendanceWriter,
	guestsWriter,
	meetingsWriter,
	venuesWriter,
	withMeetingsWrite,
} from "../../../../packages/domain/src/meetings/index.ts";
import type { EvryActor } from "../../../../packages/evry/src/index.ts";
import { admin, db, plant, sql } from "../../runtime/support.mts";

// A church's meetings for the meetings adapter suites, made through the native Meetings commands the screens use, so
// every row is one the app could have written. Dates are church-local (America/Chicago) and placed from the real clock:
// an upcoming Vision night two days out at the saved venue "Coffee shop", last week's Vision night, the two Vision
// nights before it (18 attended, then none recorded, then 24 last week), a meeting cancelled today and a team training
// next week. The native reads compare with the database clock, so the dates must be the real ones.

const ZONE = "America/Chicago";
/** The church-local date `days` from today. */
export function localDate(days: number) {
	const at = new Date(Date.now() + days * 86_400_000);
	return new Intl.DateTimeFormat("en-CA", { timeZone: ZONE, year: "numeric", month: "2-digit", day: "2-digit" }).format(
		at,
	);
}
const noReminders = async () => undefined;
const attendance = createAttendanceWriter({ reminders: noReminders });

/** One native meetings command as `who`, expected to succeed. */
export async function native<T>(
	who: EvryActor,
	run: (tx: never, ctx: never, request: unknown) => Promise<{ status: string; value?: T; error?: unknown }>,
	request: Record<string, unknown>,
): Promise<T> {
	const reply = await withMeetingsWrite(db, who.authority, (tx, ctx) =>
		run(tx as never, ctx as never, { requestKey: randomUUID(), ...request }) as never,
	);
	assert.equal(reply.status, "ok", JSON.stringify(reply));
	return (reply as { value: T }).value;
}

type Meeting = { meeting: { id: string; revision: string } };
async function schedule(who: EvryActor, input: Record<string, unknown>) {
	return (await native<Meeting>(who, meetingsWriter.schedule as never, { input })).meeting;
}
async function person(name: string) {
	const id = randomUUID();
	await admin.execute(sql`INSERT INTO person(id,tenant_id,plant_id,display_name,source,created_at,stage,adult_classification,commitment_state,pipeline_position,state)
		VALUES(${id},${plant},${plant},${name},'other',clock_timestamp(),'prospect','unknown','unknown',500,'live')`);
	return id;
}
/** `n` new prospects, for a finalized attendance count. */
async function crowd(prefix: string, n: number) {
	const ids: string[] = [];
	for (let i = 1; i <= n; i++) ids.push(await person(`${prefix} ${String(i).padStart(2, "0")}`));
	return ids;
}

export async function seedMeetings(owner: EvryActor) {
	const venue = (
		await native<{ venue: { id: string } }>(owner, venuesWriter.create as never, {
			input: { name: "Coffee shop", address: "12 Main St, Oak Park, IL" },
		})
	).venue.id;
	const guests = {
		yes: await person("Gloria Yes"),
		no: await person("Nolan No"),
		pending: await person("Penny Pending"),
		maria: await person("Maria Santos"),
		alex: await person("Alex Kim"),
		casey: await person("Casey Lee"),
	};
	const vision = await schedule(owner, {
		type: "vision_meeting",
		title: "Vision night",
		date: localDate(2),
		time: "19:00",
		venue: { kind: "existing", venueId: venue },
		guests: [guests.yes, guests.no, guests.pending],
	});
	await native(owner, guestsWriter.correctRsvp as never, await guestRevision(vision.id, guests.yes, "confirmed"));
	await native(owner, guestsWriter.correctRsvp as never, await guestRevision(vision.id, guests.no, "declined"));
	// The kit: every item checked but two.
	const kit = await admin.execute(
		sql`SELECT id,revision::text AS revision,text FROM meeting_kit_item WHERE meeting_id=${vision.id} ORDER BY position`,
	);
	const items = kit.rows as { id: string; revision: string; text: string }[];
	for (const k of items.slice(2))
		await native(owner, meetingsWriter.updateKitItem as never, {
			expectedRevision: k.revision,
			input: { meetingId: vision.id, itemId: k.id, patch: { checked: true } },
		});
	// The three Vision nights before it: 18 attended, none recorded, 24 attended.
	const past = async (days: number, title: string) =>
		schedule(owner, { type: "vision_meeting", title, date: localDate(days), time: "19:00" });
	const first = await past(-21, "Vision night");
	const middle = await past(-14, "Vision night");
	const last = await past(-7, "Vision night");
	await finalize(owner, first.id, await crowd("Guest A", 18));
	await finalize(owner, last.id, await crowd("Guest B", 24));
	// Last week's guests, invited before the night and not yet marked.
	for (const p of [guests.maria, guests.alex, guests.casey])
		await native(owner, guestsWriter.inviteGuest as never, { input: { meetingId: middle.id, personId: p } });
	const cancelled = await schedule(owner, { type: "orientation", title: "Newcomer lunch", date: localDate(1), time: "12:00" });
	await native(owner, meetingsWriter.changeStatus as never, {
		expectedRevision: cancelled.revision,
		input: { meetingId: cancelled.id, to: "cancelled" },
	});
	const training = await schedule(owner, {
		type: "orientation",
		title: "Team training",
		date: localDate(7),
		time: "18:30",
		venue: { kind: "existing", venueId: venue },
	});
	return { venue, guests, vision, kitItems: items, first, middle, last, cancelled, training };
}
export type Seeded = Awaited<ReturnType<typeof seedMeetings>>;

async function guestRevision(meetingId: string, personId: string, rsvp: string) {
	const r = await admin.execute(
		sql`SELECT revision::text AS revision FROM participation WHERE meeting_id=${meetingId} AND person_id=${personId}`,
	);
	return { expectedRevision: (r.rows[0] as { revision: string }).revision, input: { meetingId, personId, rsvp } };
}
export async function finalize(owner: EvryActor, meetingId: string, attendeeIds: string[]) {
	const r = await admin.execute(sql`SELECT attendance_revision::text AS revision FROM meeting WHERE id=${meetingId}`);
	await native(owner, attendance.finalizeAttendance as never, {
		expectedRevision: (r.rows[0] as { revision: string }).revision,
		input: { meetingId, attendeeIds },
	});
}
export { plant };
