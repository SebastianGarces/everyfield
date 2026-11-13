import test, { after, before } from "node:test";
import assert from "node:assert/strict";
import { invokeRead, readCatalog, READ_DOMAINS, type EvryActor } from "../../../../../packages/evry/src/index.ts";
import type { ReadAdapter } from "../../../../../packages/evry/src/catalog/types.ts";
import { actor, db, setup, teardown } from "../../../runtime/support.mts";
import { localDate, seedMeetings, type Seeded } from "../support.mts";

// The Meetings read tools against real records the native commands wrote, read the way a turn reads them (invokeRead)
// under each actor's live authority.

let owner: EvryActor, member: EvryActor, seeded: Seeded;
before(async () => {
	await setup();
	owner = await actor("owner");
	member = await actor("member");
	seeded = await seedMeetings(owner);
});
after(teardown);

const adapter = (operation: string) =>
	READ_DOMAINS.meetings.find((a) => a.operation === operation) as ReadAdapter<unknown>;
const read = (who: EvryActor, operation: string, input: unknown) => invokeRead(db, who, adapter(operation), input);
const zoneShort = (date: string, time: string) =>
	new Intl.DateTimeFormat("en-US", { timeZone: "America/Chicago", timeZoneName: "short" })
		.formatToParts(new Date(`${date}T${time}:00-06:00`))
		.find((p) => p.type === "timeZoneName")!.value;

test("upcoming meetings list church-local date, time and venue, soonest first, with the cancelled one marked cancelled", async () => {
	const r = await read(owner, "meetings.list", { window: "upcoming" });
	assert.equal(r.status, "available");
	assert.deepEqual(
		r.rows.map((m) => [m.label, m.fields.status, m.fields.date, m.fields.time, m.fields.venue]),
		[
			["Newcomer lunch", "cancelled", localDate(1), "12:00", null],
			["Vision night", "planning", localDate(2), "19:00", "Coffee shop"],
			["Team training", "planning", localDate(7), "18:30", "Coffee shop"],
		],
	);
	const vision = r.rows[1]!;
	assert.equal(vision.fields.zone, "America/Chicago");
	assert.match(String(vision.fields.when), new RegExp(`7:00 PM ${zoneShort(localDate(2), "19:00")}$`));
	assert.equal(r.total, 3);
});

test("a church with no upcoming meetings gets an answer with no rows, not a missing source", async () => {
	const r = await read(owner, "meetings.list", { window: "upcoming", types: ["prelaunch_practice"] });
	assert.deepEqual([r.status, r.rows, r.total], ["available", [], 0]);
});

test("guests come grouped by RSVP yes, no and no answer, and say nothing about attendance", async () => {
	const r = await read(owner, "meetings.listGuests", { meetingId: seeded.vision.id });
	assert.deepEqual(
		r.rows.map((g) => [g.label, g.fields.rsvp]),
		[
			["Gloria Yes", "yes"],
			["Nolan No", "no"],
			["Penny Pending", "no answer"],
		],
	);
	for (const g of r.rows) assert.equal("presence" in g.fields || "attended" in g.fields, false);
	assert.ok(r.exclusions.some((e) => /attendance/.test(e)));
});

test("the agenda is the saved one in order, with each section's start and the app's print link", async () => {
	const r = await read(member, "meetings.readAgenda", { meetingId: seeded.vision.id });
	const [meeting, ...sections] = r.rows;
	assert.equal(meeting!.fields.print, `/meetings/${seeded.vision.id}/agenda`);
	assert.deepEqual(
		sections.map((s) => [s.fields.order, s.label, s.fields.starts]),
		[
			["1", "Welcome", "19:00"],
			["2", "Worship", "19:10"],
			["3", "Vision", "19:25"],
			["4", "Q&A", "19:50"],
			["5", "Response", "20:05"],
			["6", "Fellowship", "20:15"],
		],
	);
	assert.equal(r.total, 6);
});

test("what is still needed from the kit is exactly the two unchecked items", async () => {
	const r = await read(owner, "meetings.listKit", { meetingId: seeded.vision.id, only: "unchecked" });
	assert.deepEqual(
		r.rows.map((k) => [k.label, k.fields.checked]),
		seeded.kitItems.slice(0, 2).map((k) => [k.text, false]),
	);
	assert.equal(r.total, 2);
	const all = await read(owner, "meetings.listKit", { meetingId: seeded.vision.id });
	assert.equal(all.total, seeded.kitItems.length);
});

test("the last three Vision nights read 18, not recorded and 24: a night with no attendance is never 0", async () => {
	const r = await read(owner, "meetings.attendanceTrend", { limit: 3 });
	assert.deepEqual(
		r.rows.map((p) => [p.id, p.fields.date, p.fields.attended]),
		[
			[seeded.first.id, localDate(-21), "18"],
			[seeded.middle.id, localDate(-14), "not recorded"],
			[seeded.last.id, localDate(-7), "24"],
		],
	);
});

test("venues.list finds the one saved venue by name and keeps its contact details out", async () => {
	const r = await read(owner, "venues.list", { search: "coffee" });
	assert.deepEqual(
		r.rows.map((v) => [v.kind, v.label, v.fields.address]),
		[["venue", "Coffee shop", "12 Main St, Oak Park, IL"]],
	);
	assert.deepEqual((await read(owner, "venues.list", { search: "library" })).rows, []);
});

test("reports stay with Owners and Admins; a Member is refused and is never offered them", async () => {
	await assert.rejects(read(member, "meetings.attendanceTrend", { limit: 3 }), { code: "access_denied" });
	const offered = readCatalog(member).domains.find((d) => d.domain === "meetings")!.operations.map((o) => o.operation);
	assert.equal(offered.includes("meetings.attendanceTrend"), false);
	assert.ok(offered.includes("meetings.listGuests"));
});

test("a meeting of another church, or one that never existed, reads as not found", async () => {
	const r = await read(owner, "meetings.get", { meetingId: "00000000-0000-4000-8000-000000000000" });
	assert.deepEqual([r.status, r.rows], ["not_found", []]);
	const foreign = await actor("foreign");
	const g = await read(foreign, "meetings.listGuests", { meetingId: seeded.vision.id });
	assert.deepEqual([g.status, g.rows], ["not_found", []]);
});

test("an organization seat and an account context have no meetings tools", async () => {
	const org = await actor("orgOwner");
	assert.equal(org.contextKind, "sending_church");
	assert.equal(readCatalog(org).domains.some((d) => d.domain === "meetings"), false);
	await assert.rejects(invokeRead(db, org, adapter("meetings.list"), {}), { code: "access_denied" });
});
