import { createDatabase, closeDatabase } from "../../../packages/db/src/client.ts";
import { sql } from "../../../packages/db/node_modules/drizzle-orm/index.js";
import test, { before, after } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { randomUUID, randomBytes } from "node:crypto";

import { migrate } from "../../../packages/db/src/schema/migrate.ts";
import { executeWrites } from "../../../packages/domain/src/operations/writes.ts";
import { RequestActor } from "../../../packages/domain/src/access/session.ts";
import { peopleWriter } from "../../../packages/domain/src/people/index.ts";
import {
	answerRsvpToken,
	createRsvpToken,
	describeRsvpToken,
	guestsWriter as guests,
	meetingsReader as reads,
	meetingsWriter as meetings,
	planNotifications,
	venuesReader,
	venuesWriter as venues,
	withMeetingsWrite,
} from "../../../packages/domain/src/meetings/index.ts";

const source = new URL(process.env.DATABASE_URL_UNPOOLED ?? process.env.DATABASE_URL ?? "about:blank");
const localCi =
	process.env.CI === "true" &&
	process.env.EARLY_ACCESS_TEST_DATABASE === "1" &&
	["localhost", "127.0.0.1"].includes(source.hostname) &&
	source.pathname === "/everyfield_ci";
if (
	(!localCi && source.hostname !== "ep-autumn-dew-b8ltidky.c-14.us-east-1.aws.neon.tech") ||
	process.env.NODE_ENV === "production"
)
	throw Error("Only approved shared development or disposable CI endpoint allowed");
if (!localCi) source.searchParams.set("sslmode", "verify-full");
const schema = "wp020_" + randomUUID().replaceAll("-", ""),
	role = "wp020_" + randomBytes(8).toString("hex");
const admin = createDatabase({
	connectionString: source.href,
	max: 4,
	options: `-c search_path=${schema},pg_catalog,pg_temp`,
});
let db;
let queries = [];

// Plant P (Chicago): 0 Owner, 1 Member with an own linked Person, 2 Admin. Plant Q: 3 Admin.
const P = randomUUID(),
	Q = randomUUID();
const actors = Array.from({ length: 4 }, () => ({ id: randomUUID(), user: randomUUID(), session: randomUUID() }));
const ctx = (who = 0) => ({ session: actors[who].session, selected: { kind: "plant", id: who === 3 ? Q : P } });
const ok = (result) => {
	assert.equal(result.status, "ok", JSON.stringify(result));
	return result.value;
};
const refused = (result, code = "unavailable") => {
	assert.equal(result.status, "refused", JSON.stringify(result));
	assert.equal(result.error.code, code, JSON.stringify(result.error));
	return result.error;
};
const tx = (body) => db.transaction(body);
const run = (op, input, who = 0) => tx((t) => op(t, ctx(who), input));
const key = () => randomUUID();
const viewer = async (who = 0) => RequestActor.resolve(db, actors[who].session);
const count = async (query) => (await admin.execute(query)).rows[0].n;
/** A local date `days` from today, far enough ahead that reminders are still in the future. */
const day = (days) => new Date(Date.now() + days * 86_400_000).toISOString().slice(0, 10);

async function person(name, fields = {}) {
	const id = randomUUID();
	await admin.execute(sql`INSERT INTO person(id,tenant_id,plant_id,display_name,source,stage,adult_classification,commitment_state,
		pipeline_position,state,created_at,linked_account_id) VALUES(${id},${fields.plant ?? P},${fields.plant ?? P},${name},'other',
		${fields.stage ?? "prospect"},'unknown','unknown',0,'live',clock_timestamp(),${fields.account ?? null})`);
	return id;
}
async function schedule(fields = {}, who = 0) {
	return ok(
		await run(
			meetings.schedule,
			{ requestKey: key(), input: { type: "vision_meeting", date: day(30), time: "18:30", ...fields } },
			who,
		),
	).meeting;
}
async function retire(personId) {
	const p = (await admin.execute(sql`SELECT revision::text AS r FROM person WHERE id=${personId}`)).rows[0].r;
	const review = (await admin.execute(sql`SELECT material_revision::text AS r FROM plant WHERE id=${P}`)).rows[0].r;
	ok(
		await run(peopleWriter.retirePerson, {
			requestKey: key(),
			expectedRevision: p,
			input: { personId, reason: "Moved away", reviewRevision: review, handoffs: [] },
		}),
	);
}
const guestOf = async (meetingId, personId, who = 0) =>
	ok(await reads.listGuests(db, await viewer(who), { meetingId })).guests.find((g) => g.person.personId === personId);

before(async () => {
	await admin.execute(sql.raw(`CREATE SCHEMA ${schema}`));
	await migrate(admin, schema);
	const password = randomBytes(32).toString("hex");
	await admin.execute(
		sql.raw(`CREATE ROLE ${role} LOGIN INHERIT PASSWORD '${password}' NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS`),
	);
	await admin.execute(sql.raw(`GRANT everyfield_runtime TO ${role}`));
	const url = new URL(source);
	url.username = role;
	url.password = password;
	db = createDatabase({ connectionString: url.href, max: 6, options: `-c search_path=${schema},pg_catalog,pg_temp` });
	db.$client.on("connect", (client) => {
		const query = client.query;
		client.query = function (...args) {
			queries.push(typeof args[0] === "string" ? args[0] : args[0].text);
			return Reflect.apply(query, this, args);
		};
	});
	for (const a of actors) {
		await admin.execute(
			sql`INSERT INTO auth_user(id,email,email_verified,name) VALUES(${a.user},${a.id + "@example.test"},true,'Synthetic')`,
		);
		await admin.execute(
			sql`INSERT INTO account(id,auth_user_id,registration_state,registration_kind) VALUES(${a.id},${a.user},'active','planter')`,
		);
		await admin.execute(
			sql`INSERT INTO auth_session(id,user_id,token,expires_at) VALUES(${a.session},${a.user},${randomUUID()},clock_timestamp()+interval '1 day')`,
		);
	}
	for (const [id, zone] of [
		[P, "America/Chicago"],
		[Q, "America/New_York"],
	])
		await admin.execute(
			sql`INSERT INTO plant(id,name,timezone,warning_days,alert_days,digest_weekday,digest_hour,phase,material_revision) VALUES(${id},'Synthetic',${zone},7,14,1,8,1,1)`,
		);
	for (const [i, plant, seatRole] of [
		[0, P, "owner"],
		[1, P, "member"],
		[2, P, "admin"],
		[3, Q, "admin"],
	])
		await admin.execute(
			sql`INSERT INTO seat(account_id,plant_id,role,accepted_at) VALUES(${actors[i].id},${plant},${seatRole},clock_timestamp())`,
		);
});
after(async () => {
	if (db) await closeDatabase(db);
	try {
		await admin.execute(sql.raw(`DROP SCHEMA IF EXISTS ${schema} CASCADE`));
		await admin.execute(sql.raw(`DROP ROLE IF EXISTS ${role}`));
	} finally {
		await closeDatabase(admin);
	}
});

test("AC:TARGET-MTG-002 AC:GAP-MTG-003 AC:TARGET-MTG-005 AC:TARGET-MTG-006 schedule saves venue copy, agenda, kit and guests together with distinct Vision numbers", async (t) => {
	const hall = ok(
		await run(venues.create, { requestKey: key(), input: { name: "Hall", address: "100 Main St", capacity: 80 } }),
	).venue;
	const alex = await person("Alex");
	const [first, second] = await Promise.all([
		schedule({ venue: { kind: "existing", venueId: hall.id }, guests: [alex] }),
		schedule({ venue: { kind: "existing", venueId: hall.id } }),
	]);
	assert.notEqual(first.visionNumber, second.visionNumber, "concurrent creates take distinct Vision numbers");
	assert.deepEqual(new Set([first.visionNumber, second.visionNumber]), new Set([1, 2]));
	assert.equal(first.displayTitle, `Vision Meeting #${first.visionNumber}`);
	assert.deepEqual(first.venue, { id: hall.id, name: "Hall", address: "100 Main St" });
	assert.deepEqual(
		first.agenda.sections.map((s) => [s.title, s.minutes]),
		[
			["Welcome", 10],
			["Worship", 15],
			["Vision", 25],
			["Q&A", 15],
			["Response", 10],
			["Fellowship", 15],
		],
	);
	assert.equal(first.agenda.totalMinutes, 90);
	assert.equal(first.agenda.defaultVersion, 1);
	assert.notDeepEqual(
		first.agenda.sections.map((s) => s.id),
		second.agenda.sections.map((s) => s.id),
		"each meeting gets fresh section IDs",
	);
	assert.deepEqual(first.kit, { version: 1, checked: 0, total: 23 });
	assert.equal(first.guestCount, 1);
	const kit = ok(await reads.listKit(db, await viewer(), { meetingId: first.id }));
	assert.equal(kit.items.length, 23);
	assert.deepEqual(
		[...new Set(kit.items.map((i) => i.category))],
		["essential", "materials", "av", "setup", "organization"],
	);
	const guest = await guestOf(first.id, alex);
	assert.deepEqual([guest.rsvp, guest.presence, guest.inviter], ["pending", "absent", null]);

	// A picker venue and a foreign guest in one create: nothing is saved, not even the new venue.
	const foreign = await person("Foreign", { plant: Q });
	const venuesBefore = await count(sql`SELECT count(*)::int AS n FROM venue`),
		meetingsBefore = await count(sql`SELECT count(*)::int AS n FROM meeting`);
	refused(
		await run(meetings.schedule, {
			requestKey: key(),
			input: {
				type: "orientation",
				date: day(20),
				time: "10:00",
				venue: { kind: "new", venue: { name: "Ghost", address: "1 Nowhere" } },
				guests: [foreign],
			},
		}),
		"invalid_subject",
	);
	assert.equal(await count(sql`SELECT count(*)::int AS n FROM venue`), venuesBefore);
	assert.equal(await count(sql`SELECT count(*)::int AS n FROM meeting`), meetingsBefore);
	// The picker venue joins the meeting's unit of work when the create succeeds.
	const created = await schedule({
		type: "orientation",
		venue: { kind: "new", venue: { name: "Annex", address: "2 Side St" } },
	});
	assert.equal(created.venue.name, "Annex");
	assert.equal(created.visionNumber, null);
	assert.equal(created.kit, null);
	assert.deepEqual(created.agenda.sections, [], "only Vision starts from the default agenda");

	// D69: a create with venue, agenda, kit, guests and reminders is a fixed handful of statements.
	queries = [];
	const viewerP = await viewer();
	queries = [];
	ok(
		await withMeetingsWrite(db, viewerP, (t, c) =>
			meetings.schedule(t, c, {
				requestKey: key(),
				input: { type: "vision_meeting", date: day(40), time: "19:00", guests: [alex] },
			}),
		),
	);
	t.diagnostic(JSON.stringify({ schedule: queries.length }));
	assert.ok(queries.length <= 6, `schedule statements: ${queries.length}`);
});

test("AC:B03-008 AC:B03-009 AC:TARGET-TSK-018 an entered spring-gap time refuses and a fall-fold time needs its offset", async () => {
	const gap = await run(meetings.schedule, {
		requestKey: key(),
		input: { type: "orientation", date: "2026-03-08", time: "02:30" },
	});
	refused(gap, "nonexistent_local_time");
	const fold = refused(
		await run(meetings.schedule, {
			requestKey: key(),
			input: { type: "orientation", date: "2026-11-01", time: "01:30" },
		}),
		"ambiguous_local_time",
	);
	assert.deepEqual(
		fold.details.choices.map((c) => c.instant),
		["2026-11-01T06:30:00.000Z", "2026-11-01T07:30:00.000Z"],
	);
	for (const [offsetSeconds, expected] of [
		[-18_000, "2026-11-01T06:30:00.000Z"],
		[-21_600, "2026-11-01T07:30:00.000Z"],
	]) {
		const m = await schedule({ type: "orientation", date: "2026-11-01", time: "01:30", offsetSeconds });
		assert.equal(m.startsAt, expected);
		const again = ok(await reads.get(db, await viewer(), { meetingId: m.id })).meeting;
		assert.deepEqual(
			[again.startsAt, again.localDate, again.localTime, again.zone],
			[expected, "2026-11-01", "01:30", "America/Chicago"],
		);
	}
});

test("AC:TARGET-MTG-001 AC:B02-007 windows, closed type filter, equal-start paging, empty filter with history and foreign detail", async () => {
	const at = day(50);
	const ids = [];
	for (const type of ["orientation", "orientation", "orientation"])
		ids.push((await schedule({ type, date: at, time: "07:00" })).id);
	const cancelled = await schedule({ type: "orientation", date: at, time: "07:00" });
	ok(
		await run(meetings.changeStatus, {
			requestKey: key(),
			expectedRevision: cancelled.revision,
			input: { meetingId: cancelled.id, to: "cancelled" },
		}),
	);
	const practice = await schedule({ type: "prelaunch_practice", date: at, time: "07:00" });
	const v = await viewer(1);
	const seen = [];
	let total = 0;
	for (let page = 1; ; page++) {
		const p = ok(await reads.list(db, v, { window: "upcoming", types: ["orientation"], page, limit: 2 }));
		total = p.total;
		seen.push(...p.items.map((m) => m.id));
		if (!p.next) break;
	}
	assert.equal(new Set(seen).size, total, "no duplicates across pages");
	assert.equal(seen.length, total, "no skips across pages");
	assert.ok(
		[...ids, cancelled.id].every((id) => seen.includes(id)),
		"every meeting of the equal start time is listed once",
	);
	const listed = ok(await reads.list(db, v, { window: "upcoming", types: ["orientation"], limit: 100 })).items;
	assert.equal(
		listed.find((m) => m.id === cancelled.id).status,
		"cancelled",
		"a cancelled future meeting stays distinguishable",
	);
	const practices = ok(
		await reads.list(db, v, { types: ["prelaunch_practice", "prelaunch_practice"], limit: 100 }),
	).items;
	assert.ok(practices.every((m) => m.type === "prelaunch_practice"));
	assert.ok(practices.some((m) => m.id === practice.id));
	assert.equal(ok(await reads.get(db, v, { meetingId: practice.id })).meeting.displayTitle, "Pre-launch Practice");
	// Past window empty for team meetings, but the workspace has history: an empty filter is not "no meetings".
	assert.equal(ok(await reads.list(db, v, { window: "past", types: ["team_meeting"] })).total, 0);
	assert.equal(ok(await reads.hasHistory(db, v, {})).hasHistory, true);
	assert.equal(ok(await reads.hasHistory(db, v, { types: ["team_meeting"] })).hasHistory, false);
	const far = ok(await reads.list(db, v, { window: "upcoming", types: ["orientation"], page: 99, limit: 2 }));
	assert.deepEqual([far.items, far.total], [[], total], "a page past the end is empty, not an error");
	// Another church's Admin cannot read or change the meeting.
	assert.deepEqual(ok(await reads.get(db, await viewer(3), { meetingId: practice.id })), { status: "unavailable" });
	refused(
		await run(
			meetings.delete,
			{ requestKey: key(), expectedRevision: practice.revision, input: { meetingId: practice.id, reason: "x" } },
			3,
		),
	);
	refused(
		await run(meetings.schedule, { requestKey: key(), input: { type: "team_meeting", date: at, time: "07:00" } }),
		"invalid_input",
	);
});

test("AC:B02-008 AC:B02-009 AC:B02-011 AC:B02-012 AC:B02-013 AC:B02-015 AC:B02-032 AC:TARGET-MTG-002 held practices count once and only when actually held", async () => {
	const base = ok(await reads.listCompletedPreLaunchPractices(db, await viewer())).count;
	const hours = (n) => new Date(Date.now() - n * 3_600_000).toISOString();
	const practices = [];
	for (let i = 0; i < 6; i++)
		practices.push(await schedule({ type: "prelaunch_practice", date: day(-10 + i), time: "09:00" }));
	const complete = (m, occurredAt, who = 0) =>
		run(
			meetings.completePractice,
			{ requestKey: key(), expectedRevision: m.revision, input: { meetingId: m.id, occurredAt } },
			who,
		);
	// Roles: Owner and Admin may complete a practice; a Member and another church's Admin may not.
	refused(await complete(practices[0], hours(48), 1));
	refused(await complete(practices[0], hours(48), 3));
	const done = [];
	done.push(ok(await complete(practices[0], hours(48))).meeting);
	done.push(ok(await complete(practices[1], hours(36), 2)).meeting);
	const thirdInput = {
		requestKey: key(),
		expectedRevision: practices[2].revision,
		input: { meetingId: practices[2].id, occurredAt: hours(24) },
	};
	done.push(ok(await run(meetings.completePractice, thirdInput)).meeting);
	const replay = ok(await run(meetings.completePractice, thirdInput));
	assert.equal(
		replay.receiptId,
		ok(await run(meetings.completePractice, thirdInput)).receiptId,
		"a repeated request replays its receipt",
	);
	refused(await complete(practices[3], new Date(Date.now() + 3_600_000).toISOString()), "invalid_input");
	const cancelled = ok(
		await run(meetings.changeStatus, {
			requestKey: key(),
			expectedRevision: practices[4].revision,
			input: { meetingId: practices[4].id, to: "cancelled" },
		}),
	).meeting;
	refused(await complete(cancelled, hours(1)), "status_transition");
	refused(
		await run(meetings.changeStatus, {
			requestKey: key(),
			expectedRevision: practices[5].revision,
			input: { meetingId: practices[5].id, to: "completed" },
		}),
		"status_transition",
	);
	let counted = ok(await reads.listCompletedPreLaunchPractices(db, await viewer(1)));
	assert.equal(counted.count - base, 3);
	assert.equal(counted.criterion, "met");
	const fourth = ok(await complete(practices[5], hours(2))).meeting;
	assert.equal(ok(await reads.listCompletedPreLaunchPractices(db, await viewer())).count - base, 4, "four still meet");
	// Archive a genuine one (delete): still counted. Void an invalid one: no longer counted.
	ok(
		await run(meetings.delete, {
			requestKey: key(),
			expectedRevision: fourth.revision,
			input: { meetingId: fourth.id, reason: "Tidy list" },
		}),
	);
	const voided = ok(
		await run(meetings.correctOccurrence, {
			requestKey: key(),
			expectedRevision: done[2].revision,
			input: { meetingId: done[2].id, voided: true, reason: "Duplicate entry" },
		}),
	).meeting;
	assert.ok(voided.occurrence.voidedAt);
	// Correct an occurrence as not held: reopened with history, not counted.
	ok(
		await run(meetings.correctPracticeOccurrence, {
			requestKey: key(),
			expectedRevision: done[1].revision,
			input: { meetingId: done[1].id, state: "not_completed", reason: "Did not happen" },
		}),
	);
	counted = ok(await reads.listCompletedPreLaunchPractices(db, await viewer()));
	assert.equal(counted.count - base, 2);
	assert.ok(counted.meetingIds.includes(fourth.id) && counted.meetingIds.includes(done[0].id));
	assert.equal(counted.criterion, base + 2 >= 3 ? "met" : "not_met");
	const history = (
		await admin.execute(
			sql`SELECT kind, before_value->>'heldAt' AS before FROM audit_event WHERE subject_id=${done[1].id} ORDER BY occurred_at`,
		)
	).rows;
	assert.deepEqual(
		history.map((h) => h.kind),
		["create", "complete", "correct"],
	);
	assert.ok(history[2].before, "the correction keeps the earlier held time");
	// A practice is an ordinary meeting: no Vision number, kit or card.
	const alex = await person("Practice guest");
	const practice = await schedule({ type: "prelaunch_practice", guests: [alex] });
	assert.deepEqual([practice.visionNumber, practice.kit], [null, null]);
	ok(
		await run(meetings.replaceAgenda, {
			requestKey: key(),
			expectedRevision: practice.revision,
			input: {
				meetingId: practice.id,
				sections: [
					{ id: "a", title: "Welcome", minutes: 5 },
					{ id: "b", title: "Practice service", minutes: 60 },
				],
			},
		}),
	);
	refused(
		await run(meetings.populateKit, {
			requestKey: key(),
			expectedRevision: practice.revision,
			input: { meetingId: practice.id },
		}),
		"wrong_meeting_type",
	);
	const g = await guestOf(practice.id, alex);
	refused(
		await run(guests.recordCard, {
			requestKey: key(),
			expectedRevision: g.revision,
			input: { meetingId: practice.id, personId: alex, response: "interested" },
		}),
		"wrong_meeting_type",
	);
	// The generated operation catalog names the native practice completion command (REQ-KNOW-065).
	const catalog = JSON.parse(await readFile(new URL("../../../docs/catalog/operations.json", import.meta.url), "utf8"));
	const operations = (catalog.operations ?? catalog).map((o) => o.id);
	assert.ok(operations.includes("meetings.completePractice"));
});

test("AC:TARGET-MTG-003 AC:TARGET-MTG-004 AC:GAP-MTG-004 venues keep meeting copies through edit, archive, restore and stale corrections", async () => {
	const v = ok(
		await run(venues.create, { requestKey: key(), input: { name: "Old Hall", address: "1 First St", capacity: 50 } }),
	).venue;
	refused(
		await run(venues.create, { requestKey: key(), input: { name: "Zero", address: "0 St", capacity: 0 } }),
		"invalid_input",
	);
	refused(
		await run(venues.create, { requestKey: key(), input: { name: "Bad", address: "1 St", email: "not-an-email" } }),
		"invalid_input",
	);
	const m = await schedule({ type: "orientation", venue: { kind: "existing", venueId: v.id } });
	const renamed = ok(
		await run(venues.edit, {
			requestKey: key(),
			expectedRevision: v.revision,
			input: { venueId: v.id, patch: { name: "New Hall", address: "9 Ninth St" } },
		}),
	).venue;
	assert.deepEqual(ok(await reads.get(db, await viewer(), { meetingId: m.id })).meeting.venue, {
		id: v.id,
		name: "Old Hall",
		address: "1 First St",
	});
	// Stale second tab: no row change and no history.
	const historyBefore = await count(sql`SELECT count(*)::int AS n FROM audit_event WHERE subject_id=${v.id}`);
	refused(
		await run(venues.correct, {
			requestKey: key(),
			expectedRevision: v.revision,
			input: { venueId: v.id, patch: { capacity: 60 }, reason: "Typo" },
		}),
		"conflict",
	);
	assert.equal(await count(sql`SELECT count(*)::int AS n FROM audit_event WHERE subject_id=${v.id}`), historyBefore);
	const corrected = ok(
		await run(venues.correct, {
			requestKey: key(),
			expectedRevision: renamed.revision,
			input: { venueId: v.id, patch: { capacity: 60 }, reason: "Typo" },
		}),
	).venue;
	const archive = { requestKey: key(), expectedRevision: corrected.revision, input: { venueId: v.id } };
	const archived = ok(await run(venues.archive, archive)).venue;
	assert.equal(archived.active, false);
	assert.equal(
		ok(await run(venues.archive, { ...archive, requestKey: key(), expectedRevision: archived.revision })).outcome,
		"noop",
		"archiving twice converges",
	);
	const vr = await viewer(1);
	assert.ok(
		!ok(await venuesReader.list(db, vr, {})).items.some((x) => x.id === v.id),
		"archived venues are hidden by default",
	);
	assert.ok(ok(await venuesReader.list(db, vr, { archived: "only" })).items.some((x) => x.id === v.id));
	// The existing meeting keeps its unchanged archived selection; a new or changed selection is refused.
	const current = ok(await reads.get(db, await viewer(), { meetingId: m.id })).meeting;
	const kept = ok(
		await run(meetings.edit, {
			requestKey: key(),
			expectedRevision: current.revision,
			input: { meetingId: m.id, patch: { title: "Kept", venue: { kind: "existing", venueId: v.id } } },
		}),
	).meeting;
	assert.deepEqual(kept.venue, { id: v.id, name: "Old Hall", address: "1 First St" });
	refused(
		await run(meetings.schedule, {
			requestKey: key(),
			input: { type: "orientation", date: day(9), time: "10:00", venue: { kind: "existing", venueId: v.id } },
		}),
		"venue_archived",
	);
	const other = await schedule({ type: "orientation" });
	refused(
		await run(meetings.edit, {
			requestKey: key(),
			expectedRevision: other.revision,
			input: { meetingId: other.id, patch: { venue: { kind: "existing", venueId: v.id } } },
		}),
		"venue_archived",
	);
	const restored = ok(
		await run(venues.restore, { requestKey: key(), expectedRevision: archived.revision, input: { venueId: v.id } }),
	).venue;
	assert.equal(restored.active, true);
	assert.deepEqual(
		ok(await reads.get(db, await viewer(), { meetingId: m.id })).meeting.venue.name,
		"Old Hall",
		"restore never rewrites copies",
	);
	const detail = ok(await venuesReader.get(db, vr, { venueId: v.id }));
	assert.deepEqual(
		detail.history.map((h) => h.kind),
		["restore", "noop", "archive", "correct", "edit", "create"],
	);
	assert.deepEqual(detail.history[3].before, { capacity: 50 });
	assert.equal(detail.history[3].reason, "Typo");
	assert.deepEqual(ok(await venuesReader.get(db, await viewer(3), { venueId: v.id })), { status: "unavailable" });
	const big = ok(await venuesReader.list(db, vr, { minCapacity: 55, search: "hall" })).items.map((x) => x.id);
	assert.ok(big.includes(v.id));
});

test("AC:TARGET-MTG-005 an agenda saves whole: reorder and retime round trip, invalid payloads are refused by name", async () => {
	const m = await schedule();
	const reversed = [...m.agenda.sections].reverse().map((s, i) => (i === 0 ? { ...s, minutes: s.minutes + 5 } : s));
	const saved = ok(
		await run(meetings.replaceAgenda, {
			requestKey: key(),
			expectedRevision: m.revision,
			input: { meetingId: m.id, sections: reversed },
		}),
	).agenda;
	assert.deepEqual(saved.sections, reversed);
	assert.equal(saved.totalMinutes, 95);
	assert.equal(saved.defaultVersion, 1, "the copied default version stays with the edited agenda");
	assert.deepEqual(ok(await reads.readAgenda(db, await viewer(1), { meetingId: m.id })), saved);
	const bad = [
		[Array.from({ length: 41 }, (_, i) => ({ id: "s" + i, title: "S", minutes: 1 })), "sections"],
		[[{ id: "a", title: "x".repeat(121), minutes: 1 }], "sections.0.title"],
		[[{ id: "a", title: "Ok", minutes: -1 }], "sections.0.minutes"],
		[[{ id: "a", title: "Ok", minutes: 1.5 }], "sections.0.minutes"],
		[[{ id: "a", title: "  ", minutes: 1 }], "sections.0.title"],
	];
	for (const [sections, path] of bad) {
		const e = refused(
			await run(meetings.replaceAgenda, {
				requestKey: key(),
				expectedRevision: saved.revision,
				input: { meetingId: m.id, sections },
			}),
			"invalid_input",
		);
		assert.ok(
			e.details.issues.some((i) => i.path === "input." + path),
			JSON.stringify(e.details.issues),
		);
	}
	const empty = ok(
		await run(meetings.replaceAgenda, {
			requestKey: key(),
			expectedRevision: saved.revision,
			input: { meetingId: m.id, sections: [] },
		}),
	).agenda;
	assert.deepEqual([empty.sections, empty.totalMinutes], [[], 0]);
});

test("AC:TARGET-MTG-006 AC:PERSONREF-MEETING-CHECKLIST-PERSON-RETIRE one kit, owned live assignees, true counts and no kit for other types", async () => {
	const m = await schedule();
	const populate = { requestKey: key(), expectedRevision: m.revision, input: { meetingId: m.id } };
	assert.equal(ok(await run(meetings.populateKit, populate)).outcome, "noop", "the kit seeded with the meeting");
	assert.equal(ok(await run(meetings.populateKit, { ...populate, requestKey: key() })).outcome, "noop");
	assert.equal(await count(sql`SELECT count(*)::int AS n FROM meeting_kit_item WHERE meeting_id=${m.id}`), 23);
	const kit = ok(await reads.listKit(db, await viewer(), { meetingId: m.id }));
	const [first, second] = kit.items;
	const update = (item, patch, who = 0) =>
		run(
			meetings.updateKitItem,
			{ requestKey: key(), expectedRevision: item.revision, input: { meetingId: m.id, itemId: item.id, patch } },
			who,
		);
	const foreign = await person("Foreign", { plant: Q }),
		gone = await person("Retired helper");
	await retire(gone);
	refused(await update(first, { assigneePersonId: foreign }), "invalid_subject");
	refused(await update(first, { assigneePersonId: gone }), "invalid_subject");
	refused(await update(first, { checked: true }, 1));
	const p2 = await person("Alex Chen");
	let r = ok(await update(first, { checked: true, assigneePersonId: p2, notes: "Bring two" }));
	assert.deepEqual([r.checked, r.total], [1, 23]);
	const checkedFirst = r.items[0];
	assert.deepEqual([checkedFirst.checked, checkedFirst.assignee.personId, checkedFirst.notes], [true, p2, "Bring two"]);
	r = ok(await update(second, { checked: true }));
	r = ok(await update(r.items[1], { checked: false }));
	assert.equal(r.checked, 1, "uncheck reverses check");
	assert.equal(ok(await reads.listKit(db, await viewer(1), { meetingId: m.id })).checked, 1);
	refused(await update(first, { checked: false }), "conflict");
	// Retiring the assignee keeps the historical reference and takes them out of new assignment.
	await retire(p2);
	const after = ok(await reads.listKit(db, await viewer(), { meetingId: m.id })).items[0];
	assert.deepEqual(after.assignee, { personId: p2, displayName: "Alex Chen", state: "retired" });
	refused(
		await update(ok(await reads.listKit(db, await viewer(), { meetingId: m.id })).items[2], { assigneePersonId: p2 }),
		"invalid_subject",
	);
	const orientation = await schedule({ type: "orientation" });
	refused(
		await run(meetings.populateKit, {
			requestKey: key(),
			expectedRevision: orientation.revision,
			input: { meetingId: orientation.id },
		}),
		"wrong_meeting_type",
	);
	assert.deepEqual(
		ok(await reads.listKit(db, await viewer(), { meetingId: orientation.id })).items,
		[],
		"a read never seeds a kit",
	);
});

test("AC:TARGET-MTG-007 AC:TARGET-MTG-019 AC:PERSONREF-MEETING-INVITATION-RSVP-ATTENDANCE-CARD-RETIRE one guest row per Person, valid inviters, removal keeps history", async () => {
	const m = await schedule();
	const [alex, casey, jamie] = [await person("Alex"), await person("Casey"), await person("Jamie")];
	const invite = (personId, inviterPersonId = null, requestKey = key()) =>
		run(guests.inviteGuest, { requestKey, input: { meetingId: m.id, personId, inviterPersonId } });
	const first = ok(await invite(alex, casey));
	assert.equal(ok(await invite(alex)).outcome, "noop", "inviting a current guest again adds nothing");
	assert.equal(
		await count(sql`SELECT count(*)::int AS n FROM participation WHERE meeting_id=${m.id} AND person_id=${alex}`),
		1,
	);
	refused(await invite(casey, casey), "invalid_input");
	refused(await invite(casey, await person("Elsewhere", { plant: Q })), "invalid_subject");
	ok(await invite(casey));
	// Casey was invited by nobody; Alex by Casey. Casey invited by Alex would be a referral cycle.
	const caseyGuest = await guestOf(m.id, casey);
	refused(
		await run(guests.setInviter, {
			requestKey: key(),
			expectedRevision: caseyGuest.revision,
			input: { meetingId: m.id, personId: casey, inviterPersonId: alex },
		}),
		"invalid_subject",
	);
	ok(
		await run(guests.setInviter, {
			requestKey: key(),
			expectedRevision: caseyGuest.revision,
			input: { meetingId: m.id, personId: casey, inviterPersonId: jamie },
		}),
	);
	const attribution = ok(await reads.invitationAttribution(db, await viewer(1), { meetingId: m.id }));
	assert.deepEqual(
		attribution.guests.map((g) => [g.person.displayName, g.inviter?.displayName ?? null, g.rsvp]).sort(),
		[
			["Alex", "Casey", "pending"],
			["Casey", "Jamie", "pending"],
		],
	);
	// Remove Alex after a card, a note and an open token: the card goes, the note and the history stay.
	let g = await guestOf(m.id, alex);
	g = ok(
		await run(guests.recordCard, {
			requestKey: key(),
			expectedRevision: g.revision,
			input: { meetingId: m.id, personId: alex, response: "interested" },
		}),
	);
	const note = ok(
		await run(peopleWriter.addNote, {
			requestKey: key(),
			expectedRevision: (await admin.execute(sql`SELECT revision::text AS r FROM person WHERE id=${alex}`)).rows[0].r,
			input: { personId: alex, body: "Followed up", meetingId: m.id },
		}),
	);
	const token = await tx(async (t) => {
		const writes = [];
		const issued = await createRsvpToken(t, ctx(), { meetingId: m.id, personId: alex }, writes);
		await executeWrites(t, writes);
		return issued;
	});
	g = await guestOf(m.id, alex);
	const removed = ok(
		await run(guests.removeGuest, {
			requestKey: key(),
			expectedRevision: g.revision,
			input: { meetingId: m.id, personId: alex },
		}),
	);
	assert.equal(removed.guest.hasCard, false);
	assert.equal(await guestOf(m.id, alex), undefined);
	assert.equal(
		await count(sql`SELECT count(*)::int AS n FROM person_note WHERE id=${note.noteId} AND removed_at IS NULL`),
		1,
	);
	assert.deepEqual(await describeRsvpToken(db, { token: token.token }), { state: "unavailable" });
	refused(await answerRsvpToken(db, { token: token.token, rsvp: "confirmed" }), "token_closed");
	assert.deepEqual(
		(
			await admin.execute(sql`SELECT kind FROM audit_event WHERE subject_id=${first.guest.id} ORDER BY occurred_at`)
		).rows.map((r) => r.kind),
		["create", "noop", "create", "remove"],
	);
	// Retiring a guest keeps the guest row with the historical Person; reminders and links leave them out.
	const casey2 = await guestOf(m.id, casey);
	await retire(casey);
	const retired = await guestOf(m.id, casey);
	assert.deepEqual([retired.id, retired.person.state], [casey2.id, "retired"]);
	await assert.rejects(
		tx(async (t) => createRsvpToken(t, ctx(), { meetingId: m.id, personId: casey }, [])),
		(e) => e.code === "unavailable",
	);
	ok(await invite(alex, null));
	assert.equal((await guestOf(m.id, alex)).id, first.guest.id, "a removed guest invited again reuses their row");
});

test("AC:TARGET-MTG-011 AC:GAP-MTG-011 AC:B02-023 AC:B02-024 quick-add contacts create one real Person and one guest, or nothing", async () => {
	const m = await schedule();
	const input = { requestKey: key(), input: { meetingId: m.id, displayName: "Mara" } };
	const people = () => count(sql`SELECT count(*)::int AS n FROM person WHERE plant_id=${P}`);
	const before = await people();
	const created = ok(await run(guests.createGuestContact, input));
	assert.deepEqual(ok(await run(guests.createGuestContact, input)), created, "a double submit replays");
	assert.equal(await people(), before + 1);
	const mara = (await admin.execute(sql`SELECT * FROM person WHERE id=${created.guest.person.personId}`)).rows[0];
	assert.deepEqual(
		[
			mara.display_name,
			mara.last_name,
			mara.email,
			mara.phone,
			mara.linked_account_id,
			mara.stage,
			mara.source,
			mara.adult_classification,
			mara.commitment_state,
		],
		["Mara", null, null, null, null, "prospect", "meeting_guest_list", "unknown", "unknown"],
	);
	assert.deepEqual([created.guest.presence, created.guest.rsvp], ["absent", "pending"]);
	const walkIn = { requestKey: key(), input: { meetingId: m.id, displayName: "Jamie" } };
	const jamie = ok(await run(guests.createWalkInContact, walkIn));
	ok(await run(guests.createWalkInContact, walkIn));
	assert.equal(jamie.guest.presence, "attended");
	assert.equal(await people(), before + 2, "a replayed walk-in adds no Person");
	// Same name as an existing Person: a new Person, never a silent merge; the existing one joins by explicit ID.
	const existingAlex = await person("Alex");
	const sameName = ok(
		await run(guests.createGuestContact, { requestKey: key(), input: { meetingId: m.id, displayName: "Alex" } }),
	);
	assert.notEqual(sameName.guest.person.personId, existingAlex);
	assert.equal(
		ok(await run(guests.inviteGuest, { requestKey: key(), input: { meetingId: m.id, personId: existingAlex } })).guest
			.person.personId,
		existingAlex,
	);
	// A foreign or deleted meeting leaves no orphan contact.
	const foreignMeeting = await schedule({ type: "orientation" }, 3);
	const count1 = await people();
	refused(
		await run(guests.createGuestContact, {
			requestKey: key(),
			input: { meetingId: foreignMeeting.id, displayName: "Orphan" },
		}),
	);
	assert.equal(await people(), count1);
	assert.equal(
		await count(
			sql`SELECT count(*)::int AS n FROM seat s JOIN person p ON p.linked_account_id=s.account_id WHERE p.id=${jamie.guest.person.personId}`,
		),
		0,
		"no login or seat",
	);
});

test("AC:CASE-COM-010 AC:TARGET-MTG-008 AC:TARGET-MTG-009 AC:GAP-MTG-008 one current RSVP from link, own reply or Admin, never attendance", async () => {
	const memberPerson = await person("Morgan", { account: actors[1].id });
	const alex = await person("Alex Rivera");
	const m = await schedule({ guests: [alex, memberPerson] });
	const issue = (personId) =>
		tx(async (t) => {
			const writes = [];
			const issued = await createRsvpToken(t, ctx(), { meetingId: m.id, personId }, writes);
			await executeWrites(t, writes);
			return issued.token;
		});
	refused(
		await tx((t) => createRsvpToken(t, ctx(1), { meetingId: m.id, personId: alex }, [])).catch((e) => ({
			status: "refused",
			error: { code: e.code },
		})),
	);
	const token = await issue(alex);
	const totalWrites = () =>
		count(
			sql`SELECT (SELECT count(*) FROM audit_event) + (SELECT coalesce(sum(revision),0) FROM participation)::int AS n`,
		);
	const writesBefore = await totalWrites();
	queries = [];
	const view = await describeRsvpToken(db, { token });
	assert.equal(queries.length, 1);
	assert.deepEqual(
		[view.state, view.guestFirstName, view.rsvp, view.meeting.displayTitle],
		["pending", "Alex", "pending", m.displayTitle],
	);
	assert.equal(await totalWrites(), writesBefore, "opening a link writes nothing");
	assert.deepEqual(await describeRsvpToken(db, { token: "x".repeat(43) }), { state: "unavailable" });
	const [a, b] = await Promise.all([
		answerRsvpToken(db, { token, rsvp: "confirmed" }),
		answerRsvpToken(db, { token, rsvp: "declined" }),
	]);
	const winners = [a, b].filter((r) => r.status === "ok");
	assert.equal(winners.length, 1, "two concurrent answers: one current answer");
	refused(
		[a, b].find((r) => r.status === "refused"),
		"token_closed",
	);
	let g = await guestOf(m.id, alex);
	assert.deepEqual([g.rsvp, g.rsvpSource, g.presence], [winners[0].value.rsvp, "token", "absent"]);
	assert.equal((await describeRsvpToken(db, { token })).state, "answered");
	// Admin correction after a fresh pending link: the old link can no longer overwrite it.
	const fresh = await issue(alex);
	g = await guestOf(m.id, alex);
	g = ok(
		await run(guests.correctRsvp, {
			requestKey: key(),
			expectedRevision: g.revision,
			input: { meetingId: m.id, personId: alex, rsvp: "confirmed" },
		}),
	).guest;
	refused(await answerRsvpToken(db, { token: fresh, rsvp: "declined" }), "token_closed");
	assert.deepEqual([g.rsvp, g.rsvpSource, g.presence], ["confirmed", "admin", "absent"]);
	assert.equal(
		(await describeRsvpToken(db, { token: fresh })).rsvp,
		"confirmed",
		"the old link still shows the current answer",
	);
	g = ok(
		await run(guests.correctRsvp, {
			requestKey: key(),
			expectedRevision: g.revision,
			input: { meetingId: m.id, personId: alex, rsvp: null },
		}),
	).guest;
	assert.equal(g.rsvp, "pending", "reset returns to Pending and does not reopen a link");
	refused(await answerRsvpToken(db, { token: fresh, rsvp: "declined" }), "token_closed");
	const renewed = await issue(alex);
	assert.equal(
		ok(await answerRsvpToken(db, { token: renewed, rsvp: "declined" })).rsvp,
		"declined",
		"a new invitation mints a fresh link",
	);
	refused(await answerRsvpToken(db, { token: fresh, rsvp: "confirmed" }), "token_closed");
	// An expired pending link refuses; renewal keeps the answered history.
	const expiring = await issue(alex);
	await admin.execute(
		sql`UPDATE participation SET rsvp_token_expires_at=clock_timestamp()-interval '1 second' WHERE meeting_id=${m.id} AND person_id=${alex}`,
	);
	assert.equal((await describeRsvpToken(db, { token: expiring })).state, "expired");
	refused(await answerRsvpToken(db, { token: expiring, rsvp: "confirmed" }), "token_closed");
	assert.equal((await guestOf(m.id, alex)).rsvp, "declined");
	refused(await answerRsvpToken(db, { token: "bad", rsvp: "confirmed" }), "invalid_input");
	// Own reply: the member answers for their own linked Person only.
	const v1 = await viewer(1);
	assert.deepEqual(ok(await reads.getOwnRsvp(db, v1, { meetingId: m.id })).rsvp, "pending");
	const own = ok(
		await run(guests.saveOwnRsvp, { requestKey: key(), input: { meetingId: m.id, rsvp: "confirmed" } }, 1),
	).guest;
	assert.deepEqual([own.person.personId, own.rsvp, own.rsvpSource], [memberPerson, "confirmed", "own"]);
	refused(
		await run(
			guests.saveOwnRsvp,
			{ requestKey: key(), input: { meetingId: m.id, rsvp: "declined", personId: alex } },
			1,
		),
		"invalid_input",
	);
	refused(await reads.getOwnRsvp(db, await viewer(2), { meetingId: m.id }), "unavailable");
	refused(await run(guests.saveOwnRsvp, { requestKey: key(), input: { meetingId: m.id, rsvp: "declined" } }, 3));
	refused(
		await run(
			guests.correctRsvp,
			{
				requestKey: key(),
				expectedRevision: own.revision,
				input: { meetingId: m.id, personId: memberPerson, rsvp: "declined" },
			},
			1,
		),
	);
	assert.equal(
		await count(sql`SELECT count(*)::int AS n FROM participation WHERE meeting_id=${m.id} AND presence<>'absent'`),
		0,
		"no RSVP path records attendance",
	);
	assert.equal(
		await count(
			sql`SELECT count(*)::int AS n FROM participation WHERE meeting_id=${m.id} AND card_response IS NOT NULL`,
		),
		0,
	);
});

test("AC:TARGET-MTG-013 cards: attended guests are the denominator, no card is unknown and notes stay with Owner/Admin", async () => {
	const m = await schedule();
	const alex = (
		await run(guests.createWalkInContact, { requestKey: key(), input: { meetingId: m.id, displayName: "Alex" } })
	).value.guest;
	const casey = await person("Casey");
	ok(await run(guests.inviteGuest, { requestKey: key(), input: { meetingId: m.id, personId: casey } }));
	const g = await guestOf(m.id, casey);
	const recorded = ok(
		await run(guests.recordCard, {
			requestKey: key(),
			expectedRevision: g.revision,
			input: { meetingId: m.id, personId: casey, response: "not_interested", notes: "PRAYER-CANARY" },
		}),
	);
	assert.equal(recorded.card.notes, "PRAYER-CANARY");
	refused(
		await run(guests.recordCard, {
			requestKey: key(),
			expectedRevision: g.revision,
			input: { meetingId: m.id, personId: casey, response: "maybe" },
		}),
		"invalid_input",
	);
	const breakdown = ok(await reads.cardBreakdown(db, await viewer(1), { meetingId: m.id }));
	assert.deepEqual(
		[
			breakdown.attended.total,
			breakdown.attended.withCard,
			breakdown.attended.unknown,
			breakdown.absentWithCard.total,
			breakdown.absentWithCard.responses.not_interested,
		],
		[1, 0, 1, 1, 1],
	);
	const memberCards = ok(await reads.listCards(db, await viewer(1), { meetingId: m.id })).cards;
	assert.deepEqual(
		memberCards.map((c) => [c.personId, c.response, c.notes]),
		[[casey, "not_interested", null]],
	);
	assert.equal(ok(await reads.listCards(db, await viewer(), { meetingId: m.id })).cards[0].notes, "PRAYER-CANARY");
	const history = await count(
		sql`SELECT count(*)::int AS n FROM audit_event WHERE (before_value::text LIKE '%PRAYER-CANARY%' OR after_value::text LIKE '%PRAYER-CANARY%' OR result::text LIKE '%PRAYER-CANARY%')`,
	);
	assert.equal(history, 1, "only the Admin's own receipt carries the note; history records that a note exists");
	const cleared = ok(
		await run(guests.clearCard, {
			requestKey: key(),
			expectedRevision: (await guestOf(m.id, casey)).revision,
			input: { meetingId: m.id, personId: casey, reason: "Wrong guest" },
		}),
	);
	assert.equal(cleared.card, null);
	assert.equal(ok(await reads.cardBreakdown(db, await viewer(), { meetingId: m.id })).absentWithCard.total, 0);
	assert.equal(alex.presence, "attended");
});

test("AC:TARGET-MTG-018 AC:CASE-NTF-006 AC:NOTIFY47-007 AC:B03-010 AC:B03-011 AC:B03-012 reminders follow the meeting and its current audience", async () => {
	// B03-012: Chicago, 10 March 2026 at 09:00. Civil-day offsets cross the DST change at the same wall clock.
	const plan = (meetingId, asOf) => planNotifications(db, P, { meetingId, asOf });
	const march = await schedule({ type: "orientation", date: "2026-03-10", time: "09:00" });
	assert.equal(march.startsAt, "2026-03-10T14:00:00.000Z");
	const early = await plan(march.id, "2026-02-01T00:00:00Z");
	assert.deepEqual(
		early.slots.filter((s) => s.slot !== "announcement").map((s) => [s.slot, s.eligibleAt, s.state]),
		[
			["day_7", "2026-03-03T15:00:00.000Z", "planned"],
			["day_3", "2026-03-07T15:00:00.000Z", "planned"],
			["day_1", "2026-03-09T14:00:00.000Z", "planned"],
		],
	);
	assert.deepEqual(
		(await plan(march.id, "2026-03-08T00:00:00Z")).slots.map((s) => s.state),
		["planned", "passed", "passed", "planned"],
	);
	assert.equal(
		await count(sql`SELECT count(*)::int AS n FROM job WHERE subject_record_id=${march.id} AND state='ready'`),
		0,
		"a past meeting queues nothing",
	);

	// A future Vision meeting: creator (Owner), a linked guest (the Member), a CRM-only guest and the Core Group.
	const memberPerson =
		(await admin.execute(sql`SELECT id FROM person WHERE linked_account_id=${actors[1].id}`)).rows[0]?.id ??
		(await person("Morgan", { account: actors[1].id }));
	const ownerPerson = await person("Owner as guest", { account: actors[0].id, stage: "core_group" });
	const crmOnly = await person("CRM only");
	await admin.execute(sql`UPDATE person SET email='crm@example.test' WHERE id=${crmOnly}`);
	const m = await schedule({ date: day(20), time: "18:00", guests: [memberPerson, ownerPerson, crmOnly] });
	const jobs = async () =>
		(
			await admin.execute(
				sql`SELECT producer_key AS key, state, eligible_at FROM job WHERE subject_record_id=${m.id} ORDER BY producer_key`,
			)
		).rows;
	const first = await jobs();
	assert.deepEqual(
		first.map((j) => j.key.split("/").slice(0, 2).join("/")),
		["meeting/announcement", "meeting/day_1", "meeting/day_3", "meeting/day_7"],
	);
	const now = new Date().toISOString();
	let current = await plan(m.id, now);
	const reminder = current.slots.find((s) => s.slot === "day_3");
	assert.deepEqual(
		reminder.recipients,
		[actors[0].id, actors[1].id].sort(),
		"creator once though also a guest; no CRM-only address",
	);
	assert.deepEqual(current.slots[0].recipients, [actors[0].id], "the announcement goes to the linked Core Group");
	// Reschedule after the 7-day job was queued: old slots are superseded before they send, new ones queued once.
	const moved = ok(
		await run(meetings.edit, {
			requestKey: key(),
			expectedRevision: m.revision,
			input: { meetingId: m.id, patch: { date: day(21), time: "18:00" } },
		}),
	).meeting;
	const afterMove = await jobs();
	assert.equal(afterMove.filter((j) => j.state === "ready").length, 4);
	assert.equal(afterMove.filter((j) => j.state === "superseded").length, 3);
	assert.ok(
		afterMove
			.filter((j) => j.state === "ready" && j.key !== "meeting/announcement")
			.every((j) => j.key.endsWith(moved.startsAt)),
	);
	const same = ok(
		await run(meetings.edit, {
			requestKey: key(),
			expectedRevision: moved.revision,
			input: { meetingId: m.id, patch: { date: day(21), time: "18:00" } },
		}),
	);
	assert.equal(same.outcome, "noop");
	assert.equal((await jobs()).length, afterMove.length, "the same time again queues nothing new");
	// The member leaves the guest list: their queued reminder audience drops them when the job runs.
	const g = await guestOf(m.id, memberPerson);
	ok(
		await run(guests.removeGuest, {
			requestKey: key(),
			expectedRevision: g.revision,
			input: { meetingId: m.id, personId: memberPerson },
		}),
	);
	current = await plan(m.id, new Date().toISOString());
	assert.deepEqual(current.slots.find((s) => s.slot === "day_1").recipients, [actors[0].id]);
	// Completing or cancelling stops every pending reminder; nothing obsolete is sent.
	ok(
		await run(meetings.changeStatus, {
			requestKey: key(),
			expectedRevision: moved.revision,
			input: { meetingId: m.id, to: "cancelled" },
		}),
	);
	assert.equal((await jobs()).filter((j) => j.state === "ready").length, 0);
	assert.ok(
		(await plan(m.id, new Date().toISOString())).slots.every(
			(s) => s.state === "suppressed" && s.recipients.length === 0,
		),
	);
});

test("INV-reads: meeting pages and details are one statement whatever their size, without locks", async () => {
	const measure = async (body) => {
		queries = [];
		const value = ok(await body());
		return { value, statements: queries.length, locks: queries.some((q) => /for\s+(update|share)/i.test(q)) };
	};
	const v = await viewer(1);
	const small = await measure(() => reads.list(db, v, { limit: 2 }));
	const large = await measure(() => reads.list(db, v, { limit: 100 }));
	assert.ok(large.value.items.length > small.value.items.length);
	const meetingId = large.value.items[0].id;
	for (const r of [
		small,
		large,
		await measure(() => reads.get(db, v, { meetingId })),
		await measure(() => reads.listGuests(db, v, { meetingId })),
		await measure(() => reads.listKit(db, v, { meetingId })),
		await measure(() => reads.cardBreakdown(db, v, { meetingId })),
		await measure(() => venuesReader.list(db, v, {})),
	])
		assert.deepEqual([r.statements, r.locks], [1, false]);
});
