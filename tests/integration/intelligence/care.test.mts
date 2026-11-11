import test, { after, before } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { sql } from "../../../packages/db/src/query.ts";
import { fixture } from "../identity/invitations-support.mts";
import { createPrivateCare, personalCalendar } from "../../../packages/domain/src/intelligence/index.ts";
import {
	createLifecycleCleanup,
	deletionOperations,
	timezoneOperations,
} from "../../../packages/domain/src/settings/index.ts";
import { peopleMerge, peopleWriter } from "../../../packages/domain/src/people/index.ts";
import { enqueueJob, queueJobs } from "../../../apps/web/src/server/jobs/queue.ts";
import { nextMonday } from "../../../apps/web/src/features/settings/time.ts";
import { evryActor } from "../../../packages/evry/src/context/actor.ts";
import { READ_DOMAINS, readCatalog } from "../../../packages/evry/src/catalog/catalog.ts";

// WP-039 slice 1: private weekly check-ins, through the privateCare operations the /me/check-in actions call and the
// personal timezone operations Settings calls, on a scratch schema of the development or CI database. The clock is
// injected so weeks, boundaries and date lines are exact.

let f, care, tz, deletion;
let now = "2026-10-13T16:00:00.000Z";
const clock = { now: () => now };
const ok = (r) => {
	assert.equal(r.status, "ok", JSON.stringify(r));
	return r.value;
};
const refused = (r, code) => {
	assert.equal(r.status, "refused", JSON.stringify(r));
	assert.equal(r.error.code, code);
	assert.deepEqual(r.error.details, {});
	return r.error;
};
/** A refusal without its correlation id, to compare two refusals. */
const bare = (r) => (r.status === "refused" ? { ...r, error: { ...r.error, correlationId: null } } : r);
const rows = async (q) => (await f.admin.execute(q)).rows;
const one = async (q) => (await rows(q))[0];
const root = fileURLToPath(new URL("../../../", import.meta.url));
/** A database refusal: drizzle wraps the PostgreSQL error, so match its cause. */
const rejects = (promise, pattern) =>
	assert.rejects(promise, (e) => {
		assert.match(String(e.cause?.message ?? e.message), pattern);
		return true;
	});
const levels = (spiritual, family, financial, pace) => ({ spiritual, family, financial, pace });
const STEADY = levels("steady", "steady", "steady", "steady");
const STRAINED = levels("strained", "steady", "strained", "strained");

/** An account with a seat in `w`, its personal zone (null: never confirmed) and its request actor. */
async function seated(w, role = "admin", zone = "America/Chicago") {
	const a = await f.account();
	await f.seat(a, w, role);
	if (zone) await f.admin.execute(sql`UPDATE account SET personal_timezone=${zone} WHERE id=${a.id}`);
	return { ...a, w, actor: await f.actor(a.session) };
}
const current = (who, raw = {}) => care.readCurrent(f.db, who.actor, raw);
const history = (who, page = 1) => care.readHistory(f.db, who.actor, { page });
const trends = (who) => care.readTrends(f.db, who.actor, {});
const save = (who, answers, expectedRevision, note = "", requestKey = randomUUID()) =>
	care.save(f.db, who.actor, { requestKey, expectedRevision, input: { answers, note } });
const correct = (who, weekId, answers, expectedRevision, note = "", requestKey = randomUUID()) =>
	care.correct(f.db, who.actor, { requestKey, expectedRevision, input: { weekId, answers, note } });
const revisionOf = async (who) => ok(await current(who)).revision;
/** Save `answers` for the week that holds `at`. */
async function saveAt(who, at, answers = STEADY, note = "") {
	now = at;
	return ok(await save(who, answers, await revisionOf(who), note));
}
/** Every private-care row of an author. */
const footprint = (who) =>
	one(sql`SELECT (SELECT count(*)::int FROM private_calendar WHERE author_id=${who.id}) calendars,
		(SELECT count(*)::int FROM private_week WHERE author_id=${who.id}) weeks,
		(SELECT count(*)::int FROM private_week_revision WHERE author_id=${who.id}) revisions,
		(SELECT revision::text FROM private_calendar WHERE author_id=${who.id}) revision`);
/** The personal timezone change as Settings runs it: preview, then the confirmed change. */
const accountCtx = (who) => ({ session: who.session, selected: { kind: "account", id: who.id } });
async function previewZone(who, timeZone) {
	return ok(await f.db.transaction((tx) => tz.previewPersonalTimezone(tx, accountCtx(who), { timeZone })));
}
function setZone(who, preview, requestKey = randomUUID()) {
	return f.db.transaction((tx) =>
		tz.setPersonalTimezone(tx, accountCtx(who), {
			requestKey,
			expectedRevision: preview.expectedRevision,
			input: { timeZone: preview.newZone, previewId: preview.previewId, confirmed: true },
		}),
	);
}
async function changeZone(who, timeZone) {
	return ok(await setZone(who, await previewZone(who, timeZone)));
}
const nextAt = async (who) =>
	(await one(sql`SELECT to_char(next_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS"Z"') AS at, zone
		FROM private_calendar WHERE author_id=${who.id}`)) ?? null;

before(async () => {
	f = await fixture();
	care = createPrivateCare({ clock });
	const job = (tx, i, kind) =>
		enqueueJob(tx, {
			tenant: i.owner.id,
			kind,
			subject: i.owner.id,
			key: `care-test/${kind}/${i.operationId}/${i.revision}`,
			revision: i.revision,
			eligibleAt: new Date().toISOString(),
		});
	tz = timezoneOperations({ replan: (tx, i) => job(tx, i, "digest") }, personalCalendar, clock);
	deletion = deletionOperations({
		queue: (tx, i) =>
			queueJobs(tx, [
				{
					tenant: i.subject.id,
					kind: "lifecycle_purge",
					subject: i.witnessId,
					key: "purge/" + i.requestId,
					revision: i.revision,
					eligibleAt: i.eligibleAt,
				},
			]),
	});
});
after(() => f?.close());

test("AC:B03-021 criterion 1: with no confirmed personal zone, reads and saves ask for it and insert nothing", async () => {
	now = "2026-10-13T16:00:00.000Z";
	const w = await f.workspace();
	// The church is in UTC and the account has none: neither UTC, the church zone nor a device zone stands in.
	const a = await seated(w, "admin", null);
	refused(await current(a), "personal_timezone_confirmation_required");
	refused(await history(a), "personal_timezone_confirmation_required");
	refused(await trends(a), "personal_timezone_confirmation_required");
	refused(await save(a, STEADY, "0"), "personal_timezone_confirmation_required");
	assert.deepEqual(await footprint(a), { calendars: 0, weeks: 0, revisions: 0, revision: null });
	// Confirming a zone in Settings is the way through.
	await changeZone(a, "Europe/London");
	const read = ok(await current(a));
	assert.equal(read.zone, "Europe/London");
	assert.equal(read.week.startsOn, "2026-10-12");
});

test("AC:B03-020 criterion 3: the week starts on the Monday of the author's own zone and keeps its id and ordinal", async () => {
	now = "2026-10-11T23:30:00.000Z";
	const w = await f.workspace();
	const cases = [
		["America/Chicago", "2026-10-05"],
		["Pacific/Auckland", "2026-10-12"],
		["Pacific/Kiritimati", "2026-10-12"],
		["Pacific/Pago_Pago", "2026-10-05"],
	];
	for (const [zone, monday] of cases) {
		const a = await seated(w, "admin", zone);
		const read = ok(await current(a));
		assert.deepEqual(
			{ zone: read.zone, id: read.week.id, ordinal: read.week.ordinal, startsOn: read.week.startsOn },
			{ zone, id: null, ordinal: 1, startsOn: monday },
		);
		const saved = ok(await save(a, STEADY, read.revision));
		assert.equal(saved.week.startsOn, monday);
		assert.equal(saved.week.endsOn, new Date(Date.parse(monday) + 6 * 86_400_000).toISOString().slice(0, 10));
		assert.equal(saved.week.zone, zone);
		assert.equal(saved.week.ordinal, 1);
		assert.ok(saved.week.id);
		const again = ok(await current(a));
		assert.equal(again.week.id, saved.week.id);
		const stored = await one(sql`SELECT ordinal,zone,starts_on::text AS starts_on,ends_on::text AS ends_on
			FROM private_week WHERE id=${saved.week.id}`);
		assert.deepEqual(stored, { ordinal: 1, zone, starts_on: monday, ends_on: saved.week.endsOn });
	}
});

test("AC:B03-024 AC:PI-CARE-001 criterion 2: a save changes this week only, a same answer adds nothing and a key replays", async () => {
	now = "2026-10-13T16:00:00.000Z";
	const w = await f.workspace();
	const a = await seated(w);
	const firstKey = randomUUID();
	const first = ok(await save(a, STRAINED, "0", "Long week.", firstKey));
	assert.equal(first.outcome, "saved");
	assert.equal(first.revision, "1");
	assert.deepEqual(first.week.answer.answers, STRAINED);
	assert.equal(first.week.answer.note, "Long week.");
	assert.equal(first.week.startsOn, "2026-10-12");
	assert.equal(first.week.revisions.length, 1);
	// A second save in the same week changes that week.
	const second = ok(await save(a, STEADY, "1"));
	assert.equal(second.week.id, first.week.id);
	assert.equal(second.revision, "2");
	assert.deepEqual(second.week.answer.answers, STEADY);
	assert.equal(second.week.answer.note, null);
	assert.deepEqual(
		second.week.revisions.map((r) => r.answers),
		[STRAINED, STEADY],
	);
	assert.deepEqual(await footprint(a), { calendars: 1, weeks: 1, revisions: 2, revision: "2" });
	// The same answer again: no revision, no new calendar revision.
	const same = ok(await save(a, STEADY, "2", "   "));
	assert.equal(same.outcome, "unchanged");
	assert.equal(same.revision, "2");
	assert.deepEqual(await footprint(a), { calendars: 1, weeks: 1, revisions: 2, revision: "2" });
	// A retry of the first request returns the first answer and writes nothing.
	assert.deepEqual(ok(await save(a, STRAINED, "0", "Long week.", firstKey)), first);
	refused(await save(a, STEADY, "0", "", firstKey), "idempotency_conflict");
	assert.deepEqual(await footprint(a), { calendars: 1, weeks: 1, revisions: 2, revision: "2" });
	// A stale revision changes nothing; bounds are checked before anything runs.
	refused(await save(a, STRAINED, "1"), "revision_conflict");
	refused(await save(a, { ...STEADY, pace: "fine" }, "2"), "invalid_input");
	refused(await save(a, STEADY, "2", "x".repeat(2001)), "invalid_input");
	assert.equal(ok(await save(a, STEADY, "2", "x".repeat(2000))).week.answer.note.length, 2000);
	assert.deepEqual(await footprint(a), { calendars: 1, weeks: 1, revisions: 3, revision: "3" });
});

test("AC:B03-022 AC:PI-CARE-003 AC:B03-024 criterion 4: a zone change keeps the open week until the first future Monday of the new zone", async () => {
	now = "2026-10-13T16:00:00.000Z";
	const w = await f.workspace();
	const a = await seated(w);
	const saved = ok(await save(a, STRAINED, "0"));
	// Two edits across the date line, the second repeated with its request key.
	await changeZone(a, "Pacific/Auckland");
	const preview = await previewZone(a, "Pacific/Kiritimati");
	const key = randomUUID();
	ok(await setZone(a, preview, key));
	ok(await setZone(a, preview, key));
	const open = ok(await current(a));
	assert.equal(open.week.id, saved.week.id);
	assert.equal(open.week.zone, "America/Chicago");
	assert.equal(open.week.startsOn, "2026-10-12");
	assert.deepEqual(open.week.answer.answers, STRAINED);
	assert.equal((await footprint(a)).weeks, 1);
	assert.equal((await footprint(a)).revisions, 1);
	// Settings shows this boundary first: the first Monday strictly after now in Kiritimati (UTC+14).
	assert.equal(nextMonday(preview.asOf, "Pacific/Kiritimati"), "2026-10-19");
	assert.deepEqual(await nextAt(a), { at: "2026-10-18T10:00:00Z", zone: "Pacific/Kiritimati" });
	now = "2026-10-18T09:59:59.000Z";
	assert.equal(ok(await current(a)).week.id, saved.week.id);
	now = "2026-10-18T10:00:00.000Z";
	const next = ok(await current(a)).week;
	assert.deepEqual(
		{ id: next.id, ordinal: next.ordinal, zone: next.zone, startsOn: next.startsOn },
		{ id: null, ordinal: 2, zone: "Pacific/Kiritimati", startsOn: "2026-10-19" },
	);
	const second = ok(await save(a, STEADY, await revisionOf(a)));
	assert.equal(second.week.ordinal, 2);
	const page = ok(await history(a));
	assert.deepEqual(
		page.weeks.map((x) => [x.ordinal, x.zone, x.startsOn, x.id !== null]),
		[
			[2, "Pacific/Kiritimati", "2026-10-19", true],
			[1, "America/Chicago", "2026-10-12", true],
		],
	);
	assert.equal(page.weeks[1].id, saved.week.id);
	// Saves 1 and 4, the two zone changes 2 and 3; the replayed change adds none.
	assert.deepEqual(await footprint(a), { calendars: 1, weeks: 2, revisions: 2, revision: "4" });
});

test("AC:B03-023 criterion 4: a save and a zone change on one calendar give one accepted change and one conflict", async () => {
	now = "2026-10-13T16:00:00.000Z";
	const w = await f.workspace();
	// The zone change after a save it did not see is refused whole: the account keeps its zone.
	const a = await seated(w);
	ok(await save(a, STEADY, "0"));
	const preview = await previewZone(a, "Pacific/Auckland");
	ok(await save(a, STRAINED, "1"));
	refused(await setZone(a, preview), "conflict");
	assert.equal(
		(await one(sql`SELECT personal_timezone FROM account WHERE id=${a.id}`)).personal_timezone,
		"America/Chicago",
	);
	// A save from before a zone change is refused.
	const b = await seated(w);
	ok(await save(b, STEADY, "0"));
	ok(await setZone(b, await previewZone(b, "Pacific/Auckland")));
	refused(await save(b, STRAINED, "1"), "revision_conflict");
	// Both at once: exactly one wins.
	for (let i = 0; i < 4; i++) {
		const c = await seated(w);
		ok(await save(c, STEADY, "0"));
		const p = await previewZone(c, "Pacific/Auckland");
		const [saved, zoned] = await Promise.all([save(c, STRAINED, "1"), setZone(c, p)]);
		assert.equal([saved, zoned].filter((r) => r.status === "ok").length, 1, JSON.stringify([saved, zoned]));
		if (saved.status === "ok") assert.equal(zoned.error.code, "conflict");
		else assert.equal(saved.error.code, "revision_conflict");
		const fp = await footprint(c);
		assert.equal(fp.weeks, 1);
		assert.equal(fp.revision, "2");
	}
});

test("AC:B03-019 AC:B03-013 AC:B03-017 criterion 4: a church timezone change never rekeys personal weeks", async () => {
	now = "2026-10-13T16:00:00.000Z";
	const w = await f.workspace();
	const a = await seated(w, "owner", "Pacific/Auckland");
	const saved = ok(await save(a, STRAINED, "0"));
	const ctx = { session: a.session, selected: { kind: "plant", id: w.id } };
	const preview = ok(
		await f.db.transaction((tx) => tz.previewPlantTimezone(tx, ctx, { plant: w, timeZone: "Europe/London" })),
	);
	const changed = ok(
		await f.db.transaction((tx) =>
			tz.setPlantTimezone(tx, ctx, {
				requestKey: randomUUID(),
				expectedRevision: preview.expectedRevision,
				input: { plant: w, timeZone: "Europe/London", previewId: preview.previewId },
			}),
		),
	);
	assert.equal(changed.status, "changed");
	const read = ok(await current(a));
	assert.deepEqual(
		{ id: read.week.id, zone: read.week.zone, startsOn: read.week.startsOn, personal: read.zone },
		{ id: saved.week.id, zone: "Pacific/Auckland", startsOn: "2026-10-12", personal: "Pacific/Auckland" },
	);
	assert.deepEqual(await nextAt(a), { at: "2026-10-18T11:00:00Z", zone: "Pacific/Auckland" });
});

test("AC:B03-026 AC:GAP-PI-041 criterion 5: a correction keeps the week, its zone and author and the earlier answer", async () => {
	const w = await f.workspace();
	const a = await seated(w);
	const audits = async () => (await one(sql`SELECT count(*)::int AS n FROM audit_event WHERE tenant_id=${w.id}`)).n;
	const before = await audits();
	const past = await saveAt(a, "2026-09-30T17:00:00.000Z", STRAINED, "Tired.");
	await saveAt(a, "2026-10-13T16:00:00.000Z", STEADY);
	const page = ok(await history(a));
	// Oct 5 had no save: it is a week with no answer, and it cannot be corrected.
	assert.deepEqual(
		page.weeks.map((x) => [x.startsOn, x.answer?.answers.spiritual ?? null]),
		[
			["2026-10-12", "steady"],
			["2026-10-05", null],
			["2026-09-28", "strained"],
		],
	);
	const revision = page.revision;
	refused(await correct(a, page.weeks[1].id, STEADY, revision), "not_found");
	const fixed = ok(await correct(a, past.week.id, STEADY, revision, "Tired."));
	assert.equal(fixed.outcome, "saved");
	assert.deepEqual(
		{ id: fixed.week.id, zone: fixed.week.zone, startsOn: fixed.week.startsOn, current: fixed.week.current },
		{ id: past.week.id, zone: "America/Chicago", startsOn: "2026-09-28", current: false },
	);
	assert.deepEqual(fixed.week.answer.answers, STEADY);
	assert.deepEqual(
		fixed.week.revisions.map((r) => [r.kind, r.answers.spiritual]),
		[
			["save", "strained"],
			["correction", "steady"],
		],
	);
	// The same correction again adds no revision; a stale one is refused.
	const same = ok(await correct(a, past.week.id, STEADY, fixed.revision, "Tired."));
	assert.equal(same.outcome, "unchanged");
	refused(await correct(a, past.week.id, STRAINED, revision), "revision_conflict");
	const read = ok(await history(a));
	assert.deepEqual(read.weeks[2], fixed.week);
	assert.equal(read.weeks[0].answer.revision, 1);
	const stored = await one(
		sql`SELECT author_id,zone,ordinal,starts_on::text AS starts_on FROM private_week WHERE id=${past.week.id}`,
	);
	assert.deepEqual(stored, { author_id: a.id, zone: "America/Chicago", ordinal: 1, starts_on: "2026-09-28" });
	assert.equal(await audits(), before);
	// No operation removes a single check-in: the runtime login cannot delete one.
	await rejects(f.db.execute(sql`DELETE FROM private_week WHERE id=${past.week.id}`), /permission denied/);
	await rejects(
		f.db.execute(sql`DELETE FROM private_week_revision WHERE week_id=${past.week.id}`),
		/permission denied/,
	);
});

test("AC:B03-035 criterion 6: the strip shows the latest twelve weeks, the thirteenth is on page two, unanswered weeks stay", async () => {
	const w = await f.workspace();
	const a = await seated(w);
	const mondays = Array.from({ length: 13 }, (_, i) =>
		new Date(Date.parse("2026-07-20T00:00:00Z") + i * 7 * 86_400_000).toISOString().slice(0, 10),
	);
	for (const monday of mondays) await saveAt(a, monday + "T18:00:00.000Z", STEADY);
	now = "2026-10-14T18:00:00.000Z";
	const strip = ok(await trends(a));
	assert.equal(strip.weeks.length, 12);
	assert.equal(strip.pageCount, 2);
	assert.deepEqual(
		strip.weeks.map((x) => x.startsOn),
		mondays.slice(1).reverse(),
	);
	assert.equal(strip.weeks[0].current, true);
	assert.deepEqual(ok(await history(a, 1)), strip);
	assert.deepEqual(
		ok(await history(a, 2)).weeks.map((x) => x.startsOn),
		["2026-07-20"],
	);
	assert.deepEqual(ok(await history(a, 3)).weeks, []);
	assert.equal((await footprint(a)).weeks, 13);
	// A week with no save shows as unanswered, and a week that is due but has no row yet shows too.
	const b = await seated(w);
	await saveAt(b, "2026-09-30T18:00:00.000Z", STRAINED);
	await saveAt(b, "2026-10-14T18:00:00.000Z", STEADY);
	now = "2026-10-20T18:00:00.000Z";
	assert.deepEqual(
		ok(await trends(b)).weeks.map((x) => [x.startsOn, x.answer === null, x.id === null, x.current]),
		[
			["2026-10-19", true, true, true],
			["2026-10-12", false, false, false],
			["2026-10-05", true, false, false],
			["2026-09-28", false, false, false],
		],
	);
});

test("AC:PI-CARE-001 AC:ROLE43-010 AC:B03-025 AC:TEN-006 AC:TARGET-IDN-031 criterion 7: only the author reads or corrects a check-in", async () => {
	now = "2026-10-13T16:00:00.000Z";
	const w = await f.workspace();
	const a = await seated(w, "admin", "America/Chicago");
	const b = await seated(w, "admin", "Pacific/Auckland");
	const owner = await seated(w, "owner", "Pacific/Auckland");
	const member = await seated(w, "member", "America/Chicago");
	const saved = ok(await save(a, STRAINED, "0", "CARE-CANARY"));
	// Guessing a week id: the same not_found as a week that does not exist, with nothing in it.
	for (const other of [b, owner]) {
		const guessed = await correct(other, saved.week.id, STEADY, "0");
		const missing = await correct(other, randomUUID(), STEADY, "0");
		refused(guessed, "not_found");
		assert.deepEqual(bare(guessed), bare(missing));
		// Reads answer only for the caller's own calendar: B sees the same as an author with no check-ins.
		const own = ok(await current(other));
		assert.equal(own.revision, "0");
		assert.equal(own.week.id, null);
		assert.equal(own.week.answer, null);
		for (const read of [own, ok(await history(other)), ok(await trends(other))]) {
			const text = JSON.stringify(read);
			assert.ok(!text.includes(saved.week.id) && !text.includes("CARE-CANARY") && !text.includes("strained"), text);
		}
		// Naming an author in a request is not a way in: it is refused the same for A and for no one.
		assert.deepEqual(
			bare(await current(other, { author: a.id })),
			bare(await current(other, { author: randomUUID() })),
		);
		refused(await current(other, { author: a.id }), "invalid_input");
		refused(
			await care.save(f.db, other.actor, {
				requestKey: randomUUID(),
				expectedRevision: "1",
				input: { answers: STEADY, note: "", author: a.id },
			}),
			"invalid_input",
		);
	}
	// B's own save writes B's own calendar and leaves A's alone (B03-025: no upsert into A's stream).
	ok(await save(b, STEADY, "0"));
	const aRead = ok(await current(a));
	assert.deepEqual(aRead.week.answer.answers, STRAINED);
	assert.equal(aRead.week.answer.note, "CARE-CANARY");
	assert.equal(aRead.revision, "1");
	// A Member has no check-in at all.
	refused(await current(member), "access_denied");
	refused(await save(member, STEADY, "0"), "access_denied");
	refused(await correct(member, saved.week.id, STEADY, "1"), "access_denied");
	assert.deepEqual(await footprint(member), { calendars: 0, weeks: 0, revisions: 0, revision: null });
	// An author whose seat ended reads nothing, though the rows stay theirs.
	await f.admin.execute(sql`UPDATE seat SET ended_at=clock_timestamp() WHERE account_id=${b.id}`);
	refused(await current(b), "access_denied");
	refused(await save(b, STRAINED, "1"), "access_denied");
});

test("AC:ROLE43-011 AC:SCHEMA-007 criterion 8: merges, relinks and role edits leave every check-in with its author", async () => {
	now = "2026-10-13T16:00:00.000Z";
	const w = await f.workspace();
	const a = await seated(w, "admin");
	const b = await seated(w, "owner");
	const saved = ok(await save(a, STRAINED, "0", "Mine."));
	const ctx = { session: b.session, selected: { kind: "plant", id: w.id } };
	const person = async (displayName) =>
		ok(
			await f.db.transaction((tx) =>
				peopleWriter.createPerson(tx, ctx, {
					requestKey: randomUUID(),
					input: { displayName, adultClassification: "adult" },
				}),
			),
		).person;
	const alex = await person("Alex Rivera"),
		casey = await person("Casey Rivera");
	await f.admin.execute(sql`UPDATE person SET linked_account_id=${a.id} WHERE id=${casey.id}`);
	const review = ok(
		await f.db.transaction((tx) => peopleMerge.getMergeReview(tx, ctx, { sourceId: alex.id, survivorId: casey.id })),
	);
	ok(
		await f.db.transaction((tx) =>
			peopleMerge.mergePeople(tx, ctx, {
				requestKey: randomUUID(),
				input: { sourceId: alex.id, survivorId: casey.id, reviewDigest: review.reviewDigest, fieldChoices: {} },
			}),
		),
	);
	// Relink the person to another account, and change the author's role.
	await f.admin.execute(sql`UPDATE person SET linked_account_id=${b.id} WHERE id=${casey.id}`);
	await f.admin.execute(sql`UPDATE seat SET role='admin' WHERE account_id=${b.id}`);
	await f.admin.execute(sql`UPDATE seat SET role='owner' WHERE account_id=${a.id}`);
	// The next request of each reads its new role.
	a.actor = await f.actor(a.session);
	b.actor = await f.actor(b.session);
	const after = ok(await current(a));
	assert.equal(after.week.id, saved.week.id);
	assert.equal(after.week.answer.note, "Mine.");
	assert.equal(ok(await current(b)).week.id, null);
	assert.deepEqual(
		await rows(sql`SELECT DISTINCT author_id FROM private_week WHERE plant_id=${w.id}
			UNION SELECT DISTINCT r.author_id FROM private_week_revision r JOIN private_week x ON x.id=r.week_id WHERE x.plant_id=${w.id}`),
		[{ author_id: a.id }],
	);
	// The database refuses a change of author or ordinal, even to its owner.
	for (const change of [
		sql`UPDATE private_week SET author_id=${b.id} WHERE id=${saved.week.id}`,
		sql`UPDATE private_week SET ordinal=2 WHERE id=${saved.week.id}`,
		sql`UPDATE private_week SET zone='UTC' WHERE id=${saved.week.id}`,
		sql`UPDATE private_calendar SET author_id=${b.id} WHERE author_id=${a.id}`,
		sql`UPDATE private_week_revision SET author_id=${b.id} WHERE week_id=${saved.week.id}`,
		sql`UPDATE private_week_revision SET note='Not mine.' WHERE week_id=${saved.week.id}`,
	])
		await rejects(f.admin.execute(change), /immutable_source_evidence/);
});

/** Counts of every shared record a check-in could feed: jobs, notices, mail, tasks, audit, conversations, PI state. */
const sideEffects = (w) =>
	one(sql`SELECT (SELECT count(*)::int FROM job) jobs,(SELECT count(*)::int FROM notice) notices,
		(SELECT count(*)::int FROM mail) mail,(SELECT count(*)::int FROM task WHERE plant_id=${w.id}) tasks,
		(SELECT count(*)::int FROM audit_event) audits,(SELECT count(*)::int FROM conversation) conversations,
		(SELECT revision::text FROM plant WHERE id=${w.id}) plant_revision,
		(SELECT material_revision::text FROM plant WHERE id=${w.id}) material_revision`);

test("AC:B03-034 AC:TARGET-IDN-033 criterion 9: three hard weeks in a row are shown back and nothing else happens", async () => {
	const w = await f.workspace();
	const a = await seated(w);
	const start = await sideEffects(w);
	const hard = [
		levels("strained", "steady", "steady", "steady"),
		levels("struggling", "steady", "steady", "steady"),
		levels("strained", "steady", "steady", "steady"),
	];
	await saveAt(a, "2026-09-30T18:00:00.000Z", hard[0]);
	await saveAt(a, "2026-10-07T18:00:00.000Z", hard[1]);
	await saveAt(a, "2026-10-14T18:00:00.000Z", hard[2]);
	const strip = ok(await trends(a));
	assert.deepEqual(Object.keys(strip).sort(), ["page", "pageCount", "revision", "weeks", "zone"]);
	assert.deepEqual(
		strip.weeks.map((x) => x.answer.answers),
		[hard[2], hard[1], hard[0]],
	);
	assert.deepEqual(Object.keys(ok(await current(a))).sort(), ["revision", "week", "zone"]);
	assert.deepEqual(await sideEffects(w), start);
});

test("AC:AUDIT-004 AC:B03-033 AC:ROLE43-012 criterion 10: the canary and every private field stay in the private tables", async () => {
	const w = await f.workspace();
	const a = await seated(w, "owner");
	const logged = [];
	const original = { log: console.log, error: console.error, warn: console.warn, info: console.info };
	for (const k of Object.keys(original)) console[k] = (...args) => logged.push(args.map(String).join(" "));
	let week;
	try {
		week = (await saveAt(a, "2026-10-07T18:00:00.000Z", STRAINED, "CARE-CANARY")).week;
		await saveAt(a, "2026-10-14T18:00:00.000Z", STEADY, "CARE-CANARY again");
		ok(await correct(a, week.id, STEADY, await revisionOf(a), "CARE-CANARY corrected"));
		await changeZone(a, "Pacific/Auckland");
		ok(await trends(a));
		ok(await history(a, 2));
	} finally {
		Object.assign(console, original);
	}
	assert.deepEqual(
		logged.filter((l) => /CARE-CANARY|strained/.test(l)),
		[],
	);
	// No other table of the schema holds the note, the week id or the week dates of this author.
	const tables = (
		await rows(sql`SELECT table_name FROM information_schema.tables WHERE table_schema=${f.schema}
			AND table_type='BASE TABLE' AND table_name NOT LIKE 'private\\_%' ORDER BY table_name`)
	).map((r) => r.table_name);
	assert.ok(tables.length > 50);
	const found = [];
	for (const table of tables) {
		const [hit] = await rows(
			sql`SELECT count(*)::int AS n FROM ${sql.identifier(table)} x WHERE x::text LIKE '%CARE-CANARY%' OR x::text LIKE ${"%" + week.id + "%"}`,
		);
		if (hit.n) found.push(table);
	}
	assert.deepEqual(found, []);
	// Evry has no private-care tool, read, reviewed write or catalog entry, for the author or anyone.
	const catalog = readCatalog(evryActor(a.actor));
	const tools = JSON.stringify({
		catalog,
		reads: READ_DOMAINS,
		generated: JSON.parse(readFileSync(join(root, "docs/catalog/evry-tools.json"), "utf8")),
	});
	// Adapters name "private care" only in their exclusion lists; meetings.checkIn is the door check-in of a meeting.
	assert.deepEqual(
		tools.replace(/"private care"/g, "").match(/privateCare|private.?care|private_week|weekly check-?in/gi),
		null,
	);
	// Only the intelligence domain names the private tables: no Evry, job, export, PI, organization or log path reads them.
	const offenders = [];
	const walk = (dir) => {
		for (const name of readdirSync(dir)) {
			const path = join(dir, name);
			if (name === "node_modules" || name.startsWith(".")) continue;
			if (statSync(path).isDirectory()) walk(path);
			else if (
				/\.(ts|tsx|mts|mjs|js)$/.test(name) &&
				/private_(week|calendar)|privateCare|createPrivateCare/.test(readFileSync(path, "utf8"))
			)
				offenders.push(path);
		}
	};
	for (const dir of ["packages/evry/src", "packages/domain/src", "apps/web/src"]) walk(join(root, dir));
	assert.deepEqual(
		offenders
			.map((p) => relative(root, p))
			.filter(
				(p) =>
					!p.startsWith("packages/domain/src/intelligence/") && !p.startsWith("apps/web/src/features/intelligence/"),
			),
		[],
	);
});

/** A deletion request whose 30-day hold has passed, as the purge worker finds it. */
async function overdue(requester, subject) {
	const at = new Date(Date.now() - 31 * 86_400_000),
		requestId = randomUUID();
	await f.admin
		.execute(sql`INSERT INTO lifecycle_witness(kind,opaque_subject_id,account_id,plant_id,request_id,requester_id,
		requester_opaque_id,request_revision,state,requested_at,cancel_until,witness_checkpoint,cleanup_state)
		VALUES(${subject.kind},${subject.id},${subject.kind === "account" ? subject.id : null},
		${subject.kind === "plant" ? subject.id : null},${requestId},${requester.id},${requester.id},1,'pending_deletion',
		${at.toISOString()},${new Date(at.getTime() + 30 * 86_400_000).toISOString()},1,'not_started')`);
	return { subject, requestId, revision: "1" };
}

test("AC:ROLE43-018 AC:DEL58-005 AC:TARGET-IDN-032 criterion 11: deletion hides the author's check-ins at once and the purge removes them", async () => {
	now = "2026-10-13T16:00:00.000Z";
	const w = await f.workspace();
	const owner = await seated(w, "owner");
	const a = await seated(w, "admin");
	const gone = await seated(w, "admin");
	ok(await save(a, STRAINED, "0", "CARE-CANARY"));
	ok(await save(gone, STRAINED, "0", "CARE-CANARY"));
	ok(await save(owner, STEADY, "0"));
	// A personal deletion request hides the author's check-ins at once.
	const accountRevision = (await one(sql`SELECT revision::text AS r FROM account WHERE id=${a.id}`)).r;
	ok(
		await f.db.transaction((tx) =>
			deletion.requestAccountDeletion(tx, accountCtx(a), {
				requestKey: randomUUID(),
				expectedRevision: accountRevision,
				input: { confirmed: true },
			}),
		),
	);
	refused(await current(a), "access_denied");
	refused(await save(a, STEADY, "1"), "access_denied");
	refused(await correct(a, randomUUID(), STEADY, "1"), "access_denied");
	// No other Owner or Admin sees or inherits them.
	assert.equal(ok(await current(owner)).week.answer.note, null);
	// The purge at the deadline removes them and nothing else.
	const purge = createLifecycleCleanup(f.admin, {
		authorize: async () => true,
		removeOwnedResources: async () => true,
	});
	assert.equal((await purge(await overdue(gone, { kind: "account", id: gone.id }))).status, "purged");
	assert.deepEqual(await footprint(gone), { calendars: 0, weeks: 0, revisions: 0, revision: null });
	assert.equal((await footprint(owner)).weeks, 1);
	assert.equal((await footprint(a)).weeks, 1);
	// A workspace deletion hides every author's check-ins in that church with it.
	const other = await f.workspace();
	const o = await seated(other, "owner");
	ok(await save(o, STEADY, "0"));
	const plantRevision = (await one(sql`SELECT revision::text AS r FROM plant WHERE id=${other.id}`)).r;
	ok(
		await f.db.transaction((tx) =>
			deletion.requestWorkspaceDeletion(
				tx,
				{ session: o.session, selected: { kind: "plant", id: other.id } },
				{ requestKey: randomUUID(), expectedRevision: plantRevision, input: { plant: other, confirmed: true } },
			),
		),
	);
	refused(await current(o), "access_denied");
	// The church purge removes every author's check-ins there and leaves other churches alone.
	const third = await f.workspace();
	const t = await seated(third, "owner");
	const stays = await seated(w, "admin");
	ok(await save(t, STEADY, "0"));
	ok(await save(stays, STEADY, "0"));
	assert.equal((await purge(await overdue(t, { kind: "plant", id: third.id }))).status, "purged");
	assert.deepEqual(await footprint(t), { calendars: 0, weeks: 0, revisions: 0, revision: null });
	assert.equal((await footprint(stays)).weeks, 1);
	// Neither deletion's shared records count or name private care.
	const records =
		await rows(sql`SELECT a::text AS row FROM audit_event a WHERE a.tenant_id IN (${a.id},${gone.id},${other.id},${third.id})
		OR a.subject_id IN (${a.id},${gone.id},${other.id},${third.id})`);
	assert.ok(records.length > 0);
	assert.deepEqual(
		records.filter((r) => /private|care|week|CARE-CANARY/i.test(r.row)),
		[],
	);
});
