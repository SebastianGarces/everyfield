import test, { after, before } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { visionAgenda } from "../../../packages/contracts/src/meetings/index.ts";
import { sql } from "../../../packages/db/src/query.ts";
import {
	meetingsReader,
	meetingsWriter,
	venuesReader,
	venuesWriter,
} from "../../../packages/domain/src/meetings/index.ts";
import { parseQuery } from "../../../apps/web/src/features/meetings/model.ts";
import { ok, refused } from "../../support/fixture.mts";
import { effects, key, meetingsWorld, type MeetingsWorld } from "./meetings-world.mts";

let w: MeetingsWorld;
before(async () => {
	w = await meetingsWorld("mtg_cases");
});
after(() => w?.close());

const REMINDERS = Array(3).fill("notification");
const SCHEDULED = { ...effects("meetings.changed"), jobs: REMINDERS };
const AT = { date: "2026-10-20", time: "10:00" };
const hall = async (fields: object = {}) =>
	ok(await w.create(venuesWriter.create, { name: "Hall", address: "100 Main St", capacity: 80, ...fields })).venue;
const existing = (venueId: string) => ({ venue: { kind: "existing", venueId } });
const said = (reply: unknown, code?: string) => {
	const { correlationId, ...error } = refused(reply, code);
	assert.ok(correlationId);
	return error;
};
const venueOf = async (venueId: string) => {
	const found = ok(await w.read(venuesReader.get, { venueId }));
	assert.ok(found.status === "available");
	return found;
};

test("AC:TARGET-MTG-001 three meetings at one instant page once each, past and cancelled ones stay apart, and an unknown or repeated type shows all", async () => {
	const past = await w.schedule({ type: "orientation", date: "2026-10-10" });
	assert.equal(past.startsAt, "2026-10-10T15:00:00.000Z");
	const types = ["vision_meeting", "orientation"];
	const statuses = ["planning", "cancelled", "completed"];
	const same = [await w.schedule(), await w.schedule({ type: "orientation" }), await w.schedule()];
	const [scheduled, cancelled, completed] = same as [(typeof same)[0], (typeof same)[0], (typeof same)[0]];
	await w.status(cancelled.id, "cancelled");
	await w.status(completed.id, "in_progress", "completed");
	assert.deepEqual([...new Set(same.map((m) => m.startsAt))], ["2026-10-20T15:00:00.000Z"]);
	const filter = { types: [...types, ...types], statuses, limit: 2, window: "upcoming" };
	for (const who of ["admin", "member"] as const) {
		const seen: string[] = [];
		const pages: number[] = [];
		await w.unchanged(async () => {
			for (const [page, next] of [
				[1, 2],
				[2, null],
			]) {
				const shown = ok(await w.read(meetingsReader.list, { ...filter, page }, who));
				assert.deepEqual([shown.total, shown.next], [3, next]);
				pages.push(shown.items.length);
				seen.push(...shown.items.map((m) => m.id));
			}
		});
		assert.deepEqual(pages, [2, 1], "each page is full until the last");
		assert.deepEqual([...seen].sort(), same.map((m) => m.id).sort(), "three distinct rows, none twice, none skipped");
	}
	const listed = async (input: object) =>
		ok(await w.read(meetingsReader.list, input)).items.map((m) => [m.id, m.status, m.displayTitle]);
	for (const [wanted, meeting] of [
		["planning", scheduled],
		["cancelled", cancelled],
		["completed", completed],
	] as const) {
		const row = [meeting.id, wanted, meeting.displayTitle];
		assert.ok((await listed({ window: "upcoming" })).some((r) => r.join() === row.join()));
		assert.deepEqual(await listed({ window: "upcoming", statuses: [wanted] }), [row]);
		assert.equal((await w.meetingOf(meeting.id)).displayTitle, meeting.displayTitle, "one title in list and detail");
	}
	const detail = (id: string) => [id, "planning", "Orientation"];
	assert.deepEqual(await listed({ window: "past" }), [detail(past.id)]);
	assert.equal((await listed({})).length, 4, "the default window is every meeting");
	assert.ok((await listed({ window: "all" })).some((r) => r[0] === past.id));
	assert.deepEqual(await listed({ window: "past", types: ["vision_meeting"] }), []);
	assert.deepEqual(ok(await w.read(meetingsReader.hasHistory, {})).hasHistory, true);
	assert.deepEqual(ok(await w.read(meetingsReader.hasHistory, { types: ["team_meeting"] })).hasHistory, false);

	const query = (search: string) => parseQuery(new URLSearchParams(search));
	assert.deepEqual(
		[
			"type=orientation",
			"type=picnic",
			"type=orientation&type=vision_meeting",
			"type=orientation&type=orientation",
			"",
		].map((s) => query(s).type),
		["orientation", null, null, null, null],
	);
	assert.equal(query("").window, "all");
	refused(await w.read(meetingsReader.list, { types: ["picnic"] }), "invalid_input");

	const theirs = await w.schedule({ type: "orientation" }, "foreign");
	const foreignDetail = await w.unchanged(() => w.read(meetingsReader.get, { meetingId: scheduled.id }, "foreign"));
	assert.deepEqual(ok(foreignDetail), { status: "unavailable" });
	assert.deepEqual(ok(await w.read(meetingsReader.get, { meetingId: randomUUID() }, "foreign")), {
		status: "unavailable",
	});
	assert.deepEqual(ok(await w.read(meetingsReader.get, { meetingId: theirs.id })), { status: "unavailable" });
	assert.equal((await w.meetingOf(theirs.id, "foreign")).id, theirs.id);
	assert.deepEqual(
		ok(await w.read(meetingsReader.list, {}, "foreign")).items.map((m) => m.id),
		[theirs.id],
		"a foreign seat lists its own meetings only",
	);
	assert.equal((await listed({})).length, 4);
});

test("AC:TARGET-MTG-002 two Vision meetings created at once take two numbers, and a failed venue, kit or guest write leaves nothing", async () => {
	const first = await w.schedule();
	const { value: raced, added } = await w.recorded(() =>
		w.queued(sql`SELECT FROM plant WHERE id=${w.P.id} FOR UPDATE`, [() => w.schedule(), () => w.schedule()]),
	);
	const numbers = (raced as (typeof first)[]).map((m) => m.visionNumber);
	assert.deepEqual(numbers.sort(), [first.visionNumber! + 1, first.visionNumber! + 2]);
	assert.deepEqual(added, { ...effects("meetings.changed", "meetings.changed"), jobs: [...REMINDERS, ...REMINDERS] });

	const alex = await w.person("Alex");
	const request = {
		requestKey: key(),
		input: {
			type: "vision_meeting",
			...AT,
			venue: { kind: "new", venue: { name: "Annex", address: "2 Side St" } },
			guests: [alex],
		},
	};
	for (const table of ["venue", "meeting_kit_item", "participation", "job"])
		await w.unchanged(() =>
			w.failing(table, "INSERT", async () =>
				refused(await w.write(meetingsWriter.schedule, request), "required_write_failed"),
			),
		);
	const { value: saved, added: once } = await w.recorded(() => w.write(meetingsWriter.schedule, request));
	assert.deepEqual(once, SCHEDULED, "the same request saves once the outage ends");
	const meeting = ok(saved).meeting;
	assert.deepEqual(
		[meeting.visionNumber, meeting.venue?.name, meeting.venue?.address, meeting.kit, meeting.guestCount],
		[first.visionNumber! + 3, "Annex", "2 Side St", { version: 1, checked: 0, total: 23 }, 1],
	);
	assert.deepEqual(await w.unchanged(() => w.write(meetingsWriter.schedule, request)), saved, "a retry adds nothing");
});

test("AC:TARGET-MTG-002 three held practices count three times: a repeat, a future and a cancelled one add nothing, and neither do a phase or training credit", async () => {
	const practices = [];
	for (const date of ["2026-10-01", "2026-10-03", "2026-10-05", "2026-10-20", "2026-10-07"])
		practices.push(await w.schedule({ type: "prelaunch_practice", date, time: "09:00" }));
	const [p1, p2, p3, future, cancelled] = practices as [
		(typeof practices)[0],
		(typeof practices)[0],
		(typeof practices)[0],
		(typeof practices)[0],
		(typeof practices)[0],
	];
	await w.status(cancelled.id, "cancelled");
	const complete = async (m: { id: string }, occurredAt: string) =>
		w.change(meetingsWriter.completePractice, (await w.meetingOf(m.id)).revision, { meetingId: m.id, occurredAt });
	const counted = async () => {
		const { meetingIds, count, criterion } = ok(await w.read(meetingsReader.listCompletedPreLaunchPractices, {}));
		return [meetingIds, count, criterion];
	};
	const plant = () => w.one(sql`SELECT phase FROM plant WHERE id=${w.P.id}`);
	const credits = () => w.count(sql`SELECT count(*)::int AS n FROM training_credit`);
	const start = [await plant(), await credits()];
	for (const [m, held] of [
		[p1, "2026-10-01T14:00:00.000Z"],
		[p2, "2026-10-03T14:00:00.000Z"],
		[p3, "2026-10-05T14:00:00.000Z"],
	] as const) {
		const done = await w.changes(() => complete(m, held));
		assert.deepEqual([ok(done.value).meeting.status, ok(done.value).meeting.occurrence.heldAt], ["completed", held]);
		assert.deepEqual(done.added.audits, ["meetings.finalized"]);
		assert.deepEqual([done.added.jobs, done.added.notices, done.added.mail], [[], 0, 0]);
		assert.deepEqual(done.tables.sort(), ["audit_event", "meeting", "plant", "record"], "no phase or training row");
	}
	const three = [[p1.id, p2.id, p3.id], 3, "met"];
	assert.deepEqual(await counted(), three);
	assert.equal(ok(await complete(p3, "2026-10-05T14:00:00.000Z")).outcome, "noop");
	assert.deepEqual(await counted(), three, "the same practice twice counts once");
	refused(await w.unchanged(() => complete(future, "2026-10-20T14:00:00.000Z")), "invalid_input");
	refused(await w.unchanged(() => complete(cancelled, "2026-10-07T14:00:00.000Z")), "status_transition");
	assert.deepEqual(await counted(), three);
	assert.deepEqual([await plant(), await credits()], start);

	ok(await w.change(meetingsWriter.delete, (await w.meetingOf(p1.id)).revision, { meetingId: p1.id, reason: "Tidy" }));
	assert.deepEqual(ok(await w.read(meetingsReader.get, { meetingId: p1.id })), { status: "unavailable" });
	assert.deepEqual(await counted(), three, "a genuine practice off the list still counts");
	ok(
		await w.change(meetingsWriter.correctOccurrence, (await w.meetingOf(p2.id)).revision, {
			meetingId: p2.id,
			voided: true,
			reason: "Entered twice",
		}),
	);
	assert.deepEqual(await counted(), [[p1.id, p3.id], 2, "not_met"], "an invalid practice no longer counts");
	assert.equal((await w.meetingOf(p2.id)).occurrence.heldAt, "2026-10-03T14:00:00.000Z", "and keeps when it was held");
	const before = await w.one(
		sql`SELECT kind, before_value->'voidedAt' AS before, reason FROM audit_event WHERE subject_id=${p2.id} AND action='meetings.corrected'`,
	);
	assert.deepEqual(before, { kind: "correct", before: null, reason: "Entered twice" });
	assert.deepEqual([await plant(), await credits()], start);
});

test("AC:TARGET-MTG-003 AC:GAP-MTG-003 a meeting copies the chosen venue, later venue edits keep that copy, and a foreign, archived or failed choice writes nothing", async () => {
	const old = await hall({ name: "Old Hall", address: "90 Main St" });
	const oldMeeting = await w.schedule({ date: "2026-10-10", ...existing(old.id) });
	const renamed = ok(
		await w.change(venuesWriter.edit, old.revision, {
			venueId: old.id,
			patch: { name: "Hall", address: "100 Main St" },
		}),
	).venue;
	const chosen = await w.changes(() =>
		w.create(meetingsWriter.schedule, { type: "vision_meeting", ...AT, ...existing(old.id) }),
	);
	const meeting = ok(chosen.value).meeting;
	assert.deepEqual(
		[meeting.startsAt, meeting.venue],
		["2026-10-20T15:00:00.000Z", { id: old.id, name: "Hall", address: "100 Main St" }],
	);
	assert.deepEqual(chosen.added, SCHEDULED);
	assert.equal(chosen.tables.includes("venue"), false);
	const listed = ok(await w.read(venuesReader.list, {}, "member")).items.filter((v) => v.id === old.id);
	assert.deepEqual(
		listed.map((v) => [v.name, v.address, v.capacity, v.active]),
		[["Hall", "100 Main St", 80, true]],
	);
	const edited = await w.changes(() =>
		w.change(venuesWriter.edit, renamed.revision, { venueId: old.id, patch: { name: "New Hall" } }),
	);
	assert.equal(ok(edited.value).venue.name, "New Hall");
	assert.deepEqual(edited.added, effects("meetings.changed"));
	assert.deepEqual(edited.tables.sort(), ["audit_event", "plant", "record", "venue"], "no meeting row is rewritten");
	assert.deepEqual((await w.meetingOf(oldMeeting.id)).venue, { id: old.id, name: "Old Hall", address: "90 Main St" });
	assert.deepEqual((await w.meetingOf(meeting.id)).venue, { id: old.id, name: "Hall", address: "100 Main St" });
	const kept = await w.change(meetingsWriter.edit, oldMeeting.revision, {
		meetingId: oldMeeting.id,
		patch: { title: "Reviewed", ...existing(old.id) },
	});
	assert.equal(ok(kept).meeting.venue?.name, "Old Hall", "an unchanged choice keeps its copy");
	const other = await hall({ name: "Other Hall" });
	const moved = ok(
		await w.change(meetingsWriter.edit, ok(kept).meeting.revision, {
			meetingId: oldMeeting.id,
			patch: existing(other.id),
		}),
	).meeting;
	assert.equal(moved.venue?.name, "Other Hall", "a new choice is explicit");

	const foreignHall = ok(
		await w.create(venuesWriter.create, { name: "Hall", address: "1 Elsewhere", capacity: 80 }, "foreign"),
	).venue;
	const pick = (venueId: string, who?: "foreign" | "foreignMember" | "member") =>
		w.create(meetingsWriter.schedule, { type: "vision_meeting", ...AT, ...existing(venueId) }, who);
	const missing = said(await pick(randomUUID()));
	assert.deepEqual(said(await w.unchanged(() => pick(foreignHall.id))), missing);
	for (const who of ["foreign", "foreignMember"] as const) {
		const error = said(await w.unchanged(() => pick(old.id, who)));
		assert.deepEqual(error, missing, "a foreign choice reads as a missing one");
		const shown = await w.unchanged(() => w.read(venuesReader.get, { venueId: old.id }, who));
		assert.deepEqual(ok(shown), { status: "unavailable" });
		const names = ok(await w.read(venuesReader.list, {}, who)).items.map((v) => v.id);
		assert.deepEqual(names, [foreignHall.id]);
	}
	refused(await w.unchanged(() => pick(old.id, "member")));
	assert.equal(ok(await pick(foreignHall.id, "foreign")).meeting.venue?.address, "1 Elsewhere");
	const gone = ok(await w.change(venuesWriter.archive, other.revision, { venueId: other.id })).venue;
	refused(await w.unchanged(() => pick(gone.id)), "venue_archived");
	assert.equal(
		ok(await w.read(venuesReader.list, {})).items.some((v) => v.id === gone.id),
		false,
	);
	assert.ok(ok(await w.read(venuesReader.list, { archived: "include" })).items.some((v) => v.id === gone.id));

	for (const capacity of [0, -1, 1.5])
		refused(
			await w.unchanged(() => w.create(venuesWriter.create, { name: "Hall", address: "1 St", capacity })),
			"invalid_input",
		);
	assert.deepEqual([(await hall({ capacity: 1 })).capacity, (await hall({ capacity: null })).capacity], [1, null]);

	const picker = {
		requestKey: key(),
		input: { type: "vision_meeting", ...AT, venue: { kind: "new", venue: { name: "Ghost", address: "1 Nowhere" } } },
	};
	const ghosts = () => w.count(sql`SELECT count(*)::int AS n FROM venue WHERE name='Ghost'`);
	const selected = { requestKey: key(), input: { type: "vision_meeting", ...AT, ...existing(old.id) } };
	for (const request of [picker, selected])
		for (const table of ["meeting", "meeting_kit_item", "audit_event"])
			await w.unchanged(() =>
				w.failing(table, "INSERT", async () =>
					refused(await w.write(meetingsWriter.schedule, request), "required_write_failed"),
				),
			);
	assert.equal(await ghosts(), 0);
	assert.equal(ok(await w.write(meetingsWriter.schedule, selected)).meeting.venue?.name, "New Hall");
	assert.equal(ok(await w.write(meetingsWriter.schedule, picker)).meeting.venue?.name, "Ghost");
	assert.equal(await ghosts(), 1);
	assert.equal((await w.meetingOf(meeting.id)).venue?.name, "Hall", "saved meetings stay as they were");
});

test("AC:TARGET-MTG-004 AC:GAP-MTG-004 an archived venue stays on its meeting, takes no new one, and comes back with its history and corrections", async () => {
	const v = await hall();
	const m = await w.schedule(existing(v.id));
	const archived = ok(await w.change(venuesWriter.archive, v.revision, { venueId: v.id })).venue;
	assert.equal(archived.active, false);
	const onList = async (input: object) => ok(await w.read(venuesReader.list, input)).items.some((x) => x.id === v.id);
	assert.deepEqual([await onList({}), await onList({ archived: "only" })], [false, true]);
	const history = async () => (await venueOf(v.id)).history.map((h) => h.kind);
	assert.deepEqual(await history(), ["archive", "create"]);
	const selection = {
		requestKey: "TARGET-MTG-004-request-1",
		input: { type: "vision_meeting", ...AT, ...existing(v.id) },
	};
	for (let repeat = 0; repeat < 2; repeat++)
		refused(await w.unchanged(() => w.write(meetingsWriter.schedule, selection)), "venue_archived");
	const other = await w.schedule();
	refused(
		await w.unchanged(() =>
			w.change(meetingsWriter.edit, other.revision, { meetingId: other.id, patch: existing(v.id) }),
		),
		"venue_archived",
	);
	const same = ok(
		await w.change(meetingsWriter.edit, m.revision, {
			meetingId: m.id,
			patch: { notes: "Bring chairs", ...existing(v.id) },
		}),
	).meeting;
	const copy = { id: v.id, name: "Hall", address: "100 Main St" };
	assert.deepEqual([same.venue, same.notes], [copy, "Bring chairs"]);
	assert.deepEqual(await history(), ["archive", "create"], "no history is removed");

	const restore = { requestKey: key(), expectedRevision: archived.revision, input: { venueId: v.id } };
	const missing = said(await w.change(venuesWriter.restore, "1", { venueId: randomUUID() }));
	for (const who of ["foreign", "foreignMember"] as const) {
		assert.deepEqual(said(await w.unchanged(() => w.write(venuesWriter.restore, restore, who))), missing);
		refused(
			await w.unchanged(() =>
				w.change(venuesWriter.correct, archived.revision, { venueId: v.id, patch: { notes: "x" }, reason: "x" }, who),
			),
		);
		const seen = ok(await w.read(venuesReader.history, { venueId: v.id }, who));
		assert.deepEqual(seen.items, []);
	}
	refused(await w.unchanged(() => w.write(venuesWriter.restore, restore, "member")));
	for (const [table, event] of [
		["venue", "UPDATE"],
		["audit_event", "INSERT"],
	] as const)
		await w.unchanged(() =>
			w.failing(table, event, async () =>
				refused(await w.write(venuesWriter.restore, restore), "required_write_failed"),
			),
		);
	assert.equal((await venueOf(v.id)).venue.active, false);
	assert.deepEqual(await history(), ["archive", "create"]);
	const done = await w.changes(() => w.write(venuesWriter.restore, restore));
	const restored = ok(done.value).venue;
	assert.equal(restored.active, true);
	assert.deepEqual(
		[done.added, done.tables.sort()],
		[effects("meetings.changed"), ["audit_event", "plant", "record", "venue"]],
	);
	assert.deepEqual(await history(), ["restore", "archive", "create"]);
	assert.deepEqual((await w.meetingOf(m.id)).venue, copy);
	assert.deepEqual(await w.unchanged(() => w.write(venuesWriter.restore, restore)), done.value, "a retry adds nothing");
	assert.equal(await onList({}), true);
	const fresh = await w.schedule(existing(v.id));
	assert.deepEqual(fresh.venue, copy, "a restored venue can be chosen again");

	const correct = (address: string) => () =>
		w.change(venuesWriter.correct, restored.revision, {
			venueId: v.id,
			patch: { address },
			reason: "Correct street number",
		});
	const { value: tabs, added } = await w.recorded(() =>
		w.queued(sql`SELECT FROM plant WHERE id=${w.P.id} FOR UPDATE`, [correct("102 Main St"), correct("104 Main St")]),
	);
	const [first, second] = tabs as [Awaited<ReturnType<ReturnType<typeof correct>>>, { status: string }];
	assert.equal(ok(first).venue.address, "102 Main St");
	refused(second, "conflict");
	assert.deepEqual(added, effects("meetings.corrected"), "two tabs: one correction, one history row");
	const after = await venueOf(v.id);
	assert.equal(after.venue.address, "102 Main St");
	const [entry] = after.history;
	assert.deepEqual(
		[entry?.kind, entry?.before, entry?.after, entry?.actorId, entry?.reason, entry?.occurredAt.slice(0, 10)],
		[
			"correct",
			{ address: "100 Main St" },
			{ address: "102 Main St" },
			w.actors.admin.id,
			"Correct street number",
			"2026-10-13",
		],
	);
	assert.deepEqual(await history(), ["correct", "restore", "archive", "create"]);
	refused(await w.unchanged(() => correct("106 Main St")()), "conflict");
	for (const id of [m.id, fresh.id]) assert.deepEqual((await w.meetingOf(id)).venue, copy);
});

const DEFAULT = [
	{ id: "v1", title: "Welcome", minutes: 10 },
	{ id: "v2", title: "Worship", minutes: 15 },
	{ id: "v3", title: "Vision", minutes: 25 },
	{ id: "v4", title: "Q&A", minutes: 15 },
	{ id: "v5", title: "Response", minutes: 10 },
	{ id: "v6", title: "Fellowship", minutes: 15 },
];

test("AC:TARGET-MTG-005 an agenda reorders, retimes and empties whole, refuses every bad section, and a newer default never replaces it", async () => {
	const m = await w.schedule();
	assert.deepEqual(
		m.agenda.sections.map(({ title, minutes }) => ({ title, minutes })),
		DEFAULT.map(({ title, minutes }) => ({ title, minutes })),
	);
	assert.deepEqual([m.agenda.totalMinutes, m.agenda.defaultVersion], [90, 1]);
	assert.equal(new Set(m.agenda.sections.map((s) => s.id)).size, 6);
	const replace = (expectedRevision: string, sections: unknown, requestKey: string = key()) =>
		w.write(meetingsWriter.replaceAgenda, { requestKey, expectedRevision, input: { meetingId: m.id, sections } });
	const agenda = async () => {
		const { sections, totalMinutes, defaultVersion } = ok(
			await w.read(meetingsReader.readAgenda, { meetingId: m.id }, "member"),
		);
		return { sections, totalMinutes, defaultVersion };
	};
	let { revision } = ok(await replace(m.revision, DEFAULT)).agenda;
	const reversed = [...DEFAULT].reverse();
	const reorder = await w.recorded(() => replace(revision, reversed, "agenda-reorder"));
	assert.deepEqual(reorder.added, effects("meetings.changed"));
	assert.deepEqual(
		(await agenda()).sections.map((s) => s.id),
		["v6", "v5", "v4", "v3", "v2", "v1"],
	);
	assert.deepEqual(await agenda(), { sections: reversed, totalMinutes: 90, defaultVersion: 1 });
	assert.deepEqual(await w.unchanged(() => replace(revision, reversed, "agenda-reorder")), reorder.value);
	refused(await w.unchanged(() => replace(revision, DEFAULT)), "conflict");
	revision = ok(reorder.value).agenda.revision;

	const bad: [string, unknown, string][] = [
		[
			"too many",
			Array.from({ length: 41 }, (_, i) => ({ id: `s${i}`, title: "Section", minutes: 1 })),
			"input.sections",
		],
		["long title", [{ id: "v1", title: "x".repeat(121), minutes: 10 }], "input.sections.0.title"],
		["negative", [{ id: "v1", title: "Welcome", minutes: -1 }], "input.sections.0.minutes"],
		["fractional", [{ id: "v1", title: "Welcome", minutes: 1.5 }], "input.sections.0.minutes"],
	];
	for (const [name, sections, path] of bad) {
		const error = refused(await w.unchanged(() => replace(revision, sections)), "invalid_input");
		assert.deepEqual(
			error.details.issues.map((i: { path: string }) => i.path),
			[path],
			name,
		);
		assert.deepEqual(await agenda(), { sections: reversed, totalMinutes: 90, defaultVersion: 1 }, name);
	}
	const edges = [
		Array.from({ length: 40 }, (_, i) => ({ id: `s${i}`, title: "Section", minutes: 1 })),
		[{ id: "v1", title: "x".repeat(120), minutes: 0 }],
		[{ id: "v1", title: "Welcome", minutes: 600 }],
	];
	for (const sections of edges) {
		revision = ok(await replace(revision, sections)).agenda.revision;
		assert.deepEqual((await agenda()).sections, sections, "the limits themselves are valid");
	}
	for (const [sections, totalMinutes] of [
		[[{ id: "v1", title: "Welcome", minutes: 20 }], 20],
		[[], 0],
		[[{ id: "custom", title: "Our welcome", minutes: 20 }], 20],
	] as const) {
		const saved = await w.recorded(() => replace(revision, sections));
		assert.deepEqual(saved.added, effects("meetings.changed"));
		revision = ok(saved.value).agenda.revision;
		assert.deepEqual(await agenda(), { sections, totalMinutes, defaultVersion: 1 });
	}
	const reference = visionAgenda as { version: number };
	reference.version = 2;
	try {
		assert.deepEqual((await w.schedule()).agenda.defaultVersion, 2, "a meeting made now copies the newer default");
		const custom = [{ id: "custom", title: "Our welcome", minutes: 20 }];
		assert.deepEqual(await w.unchanged(agenda), { sections: custom, totalMinutes: 20, defaultVersion: 1 });
		const renamed = [{ id: "custom", title: "Our own welcome", minutes: 25 }];
		const kept = ok(await replace(revision, renamed)).agenda;
		assert.deepEqual([kept.defaultVersion, kept.totalMinutes], [1, 25]);
		assert.deepEqual(await agenda(), { sections: renamed, totalMinutes: 25, defaultVersion: 1 });
	} finally {
		reference.version = 1;
	}
	refused(
		await w.unchanged(() =>
			w.change(meetingsWriter.replaceAgenda, revision, { meetingId: m.id, sections: [] }, "foreign"),
		),
	);
	refused(
		await w.unchanged(() =>
			w.change(meetingsWriter.replaceAgenda, revision, { meetingId: m.id, sections: [] }, "member"),
		),
	);
});

test("AC:TARGET-MTG-006 a Vision meeting has one kit however often it is asked for, its ticks come back off, and no other meeting gets one", async () => {
	const request = { requestKey: "kit-M1", input: { type: "vision_meeting", ...AT } };
	const made = ok(await w.write(meetingsWriter.schedule, request)).meeting;
	assert.deepEqual(ok(await w.unchanged(() => w.write(meetingsWriter.schedule, request))).meeting, made);
	const kits = (id: string) =>
		w.rows(sql`SELECT kit_version, (SELECT count(*)::int FROM meeting_kit_item k WHERE k.meeting_id=m.id) AS items,
			(SELECT count(DISTINCT item_key)::int FROM meeting_kit_item k WHERE k.meeting_id=m.id) AS keys FROM meeting m WHERE id=${id}`);
	const one = [{ kit_version: 1, items: 23, keys: 23 }];
	assert.deepEqual(await kits(made.id), one);
	const populate = { requestKey: "kit-M1-again", expectedRevision: made.revision, input: { meetingId: made.id } };
	for (let repeat = 0; repeat < 2; repeat++)
		assert.equal(ok(await w.write(meetingsWriter.populateKit, populate)).outcome, "noop");
	assert.deepEqual(await kits(made.id), one);

	await w.admin.execute(sql`DELETE FROM meeting_kit_item WHERE meeting_id=${made.id}`);
	await w.admin.execute(sql`UPDATE meeting SET kit_version=NULL WHERE id=${made.id}`);
	const listKit = (who?: "foreign" | "foreignMember") => w.read(meetingsReader.listKit, { meetingId: made.id }, who);
	assert.deepEqual(ok(await w.unchanged(() => listKit())).items, [], "a read never adds the missing kit");
	const offer = { requestKey: "kit-M1-offer", expectedRevision: made.revision, input: { meetingId: made.id } };
	const accepted = await w.recorded(() =>
		w.queued(sql`SELECT FROM plant WHERE id=${w.P.id} FOR UPDATE`, [
			() => w.write(meetingsWriter.populateKit, offer),
			() => w.change(meetingsWriter.populateKit, made.revision, { meetingId: made.id }),
		]),
	);
	assert.deepEqual(
		(accepted.value as { value: { outcome: string } }[]).map((r) => r.value.outcome),
		["changed", "noop"],
	);
	assert.deepEqual(accepted.added, effects("meetings.changed", "meetings.changed"));
	assert.deepEqual(await w.unchanged(() => w.write(meetingsWriter.populateKit, offer)), accepted.value[0]);
	assert.deepEqual(await kits(made.id), one);

	const kit = ok(await w.unchanged(() => listKit()));
	assert.deepEqual([kit.version, kit.items.length, kit.checked, kit.total], [1, 23, 0, 23]);
	assert.deepEqual([...new Set(kit.items.map((i) => i.category))].sort(), [
		"av",
		"essential",
		"materials",
		"organization",
		"setup",
	]);
	const item = async () => ok(await listKit()).items[0]!;
	const update = async (patch: object, who?: "member" | "foreign") =>
		w.change(
			meetingsWriter.updateKitItem,
			(await item()).revision,
			{ meetingId: made.id, itemId: kit.items[0]!.id, patch },
			who,
		);
	const foreign = await w.person("Foreign helper", { plant: w.Q.id });
	const retired = await w.person("Retired helper");
	await w.admin.execute(sql`UPDATE person SET state='retired', retired_at=clock_timestamp() WHERE id=${retired}`);
	for (const assigneePersonId of [foreign, retired])
		refused(await w.unchanged(() => update({ assigneePersonId })), "invalid_subject");
	const helper = await w.person("Live helper");
	assert.equal(ok(await update({ assigneePersonId: helper })).items[0]!.assignee?.personId, helper);
	for (const who of ["member", "foreign"] as const) refused(await w.unchanged(() => update({ checked: true }, who)));
	for (const [checked, total] of [
		[true, 1],
		[false, 0],
	] as const) {
		const saved = await w.recorded(() => update({ checked }));
		assert.deepEqual(saved.added, effects("meetings.changed"));
		const shown = ok(await listKit());
		assert.deepEqual(
			[ok(saved.value).checked, shown.checked, shown.total, (await w.meetingOf(made.id)).kit?.checked],
			[total, total, 23, total],
		);
	}
	for (const who of ["foreign", "foreignMember"] as const) refused(await w.unchanged(() => listKit(who)));

	for (const type of ["orientation", "prelaunch_practice"]) {
		const m = await w.schedule({ type });
		refused(
			await w.unchanged(() => w.change(meetingsWriter.populateKit, m.revision, { meetingId: m.id })),
			"wrong_meeting_type",
		);
		assert.deepEqual(await kits(m.id), [{ kit_version: null, items: 0, keys: 0 }]);
	}
	assert.equal(
		await w.count(sql`SELECT count(*)::int AS n FROM meeting_kit_item k JOIN meeting m ON m.id=k.meeting_id
			WHERE m.type<>'vision_meeting'`),
		0,
	);
});
