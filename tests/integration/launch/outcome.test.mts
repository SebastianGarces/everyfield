import test, { after, before } from "node:test";
import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { sql, type SQL } from "../../../packages/db/src/query.ts";
import { fixture } from "../identity/invitations-support.mts";
import { type Workspace, ok, refused } from "../../support/fixture.mts";
import {
	calendarContext,
	frozenClock,
	instant,
	localDateTime,
	personId,
	resolveCalendar,
	timeZone,
} from "../../../packages/contracts/src/common/index.ts";
import {
	countdown,
	type DebriefAnswers,
	GUEST_QUESTION,
	type Plan,
	reviewedOf,
} from "../../../packages/contracts/src/launch/index.ts";
import {
	authorizeLaunchNotices,
	createLaunchReader,
	createLaunchWriter,
} from "../../../packages/domain/src/launch/index.ts";
import { createPrivateCare } from "../../../packages/domain/src/intelligence/index.ts";
import { PeopleReadContext, withPeopleWrite } from "../../../packages/domain/src/people/core.ts";
import { peopleMerge, peopleReader, peopleUnmerge, peopleWriter } from "../../../packages/domain/src/people/index.ts";
import { createPhaseWriter, phaseReader } from "../../../packages/domain/src/phases/index.ts";
import { createMailService } from "../../../packages/domain/src/jobs/mail.ts";
import { seatedNotificationService } from "../../../packages/domain/src/jobs/seated-notifications.ts";
import { launchNotices } from "../../../apps/web/src/features/launch/notices.ts";
import type { WriteTx } from "../../../packages/domain/src/access/session.ts";
import { gatedTransaction } from "../../../packages/domain/src/operations/writes.ts";

const TODAY = frozenClock(instant.parse("2026-10-12T17:00:00.000Z"));
let f: Awaited<ReturnType<typeof fixture>>;
let reader: ReturnType<typeof createLaunchReader>;
let writer: ReturnType<typeof createLaunchWriter>;
let phases: ReturnType<typeof createPhaseWriter>;
type Row = Record<string, unknown>;
const rows = async <R extends Row = Row>(q: SQL) => (await f.admin.execute<R>(q)).rows;
const one = async <R extends Row = Row>(q: SQL) => (await rows<R>(q))[0]!;
type Church = Awaited<ReturnType<typeof church>>;
type Who = Pick<Church["owner"], "actor">;
const plan = async (who: Who) => ok(await reader.readPlan(f.db, who.actor)).plan;
const journal = async (who: Who) => ok(await reader.readJournal(f.db, who.actor)).entries;
const key = () => randomUUID();
const record = (who: Who, input: object, expectedRevision: string, requestKey: string = key()) =>
	writer.recordOutcome(f.db, who.actor, {
		requestKey,
		expectedRevision,
		input: { attendance: null, decisions: null, note: null, ...input },
	});
const correct = (who: Who, input: object, expectedRevision: string, requestKey: string = key()) =>
	writer.correctOutcome(f.db, who.actor, { requestKey, expectedRevision, input });
const guest = (who: Who, input: object, requestKey: string = key()) =>
	writer.addGuestAttendance(f.db, who.actor, { requestKey, input });
const BLANK = {
	wentWell: null,
	toChange: null,
	operations: null,
	followUpPlan: null,
	supportNeeded: null,
	missingNames: null,
	missingCount: null,
};
type Draft = { draft: { id: string; revision: string } | null } | null;
const debrief = (who: Who, p: { debrief: Draft }, answers: Partial<DebriefAnswers>, submit = false) =>
	writer[submit ? "submitDebrief" : "saveDebriefDraft"](f.db, who.actor, {
		requestKey: key(),
		expectedRevision: p.debrief!.draft?.revision ?? "0",
		input: { draftId: p.debrief!.draft?.id ?? null, answers: { ...BLANK, ...answers } },
	});
const summary = (who: Who, p: { summary: Draft }, body: string, publish = false) =>
	writer[publish ? "publishDebriefSummary" : "saveDebriefSummaryDraft"](f.db, who.actor, {
		requestKey: key(),
		expectedRevision: p.summary!.draft?.revision ?? "0",
		input: { draftId: p.summary!.draft?.id ?? null, body },
	});
const named = (p: Plan) => p.guests.named!.map((g) => g.displayName);
type Footprint = Record<
	"people" | "guests" | "debriefs" | "summaries" | "tasks" | "meetings" | "mail" | "notices" | "audits" | "phase",
	number
> & { revision: string };
const footprint = (w: { id: string }) =>
	one<Footprint>(sql`SELECT (SELECT count(*)::int FROM person WHERE tenant_id=${w.id}) people,
		(SELECT count(*)::int FROM launch_guest WHERE plant_id=${w.id}) guests,
		(SELECT count(*)::int FROM launch_debrief WHERE plant_id=${w.id}) debriefs,
		(SELECT count(*)::int FROM launch_summary WHERE plant_id=${w.id}) summaries,
		(SELECT count(*)::int FROM task WHERE plant_id=${w.id}) tasks,
		(SELECT count(*)::int FROM meeting WHERE plant_id=${w.id}) meetings,
		(SELECT count(*)::int FROM mail WHERE tenant_id=${w.id}) mail,
		(SELECT count(*)::int FROM notice WHERE tenant_id=${w.id}) notices,
		(SELECT count(*)::int FROM audit_event WHERE tenant_id=${w.id}) audits,
		(SELECT phase FROM plant WHERE id=${w.id}) phase,
		(SELECT revision::text FROM launch WHERE plant_id=${w.id}) revision`);

async function seated(w: Workspace, role: "owner" | "admin" | "member", name = "Synthetic person") {
	const a = await f.account();
	await f.admin.execute(
		sql`UPDATE auth_user SET name=${name} WHERE id=(SELECT auth_user_id FROM account WHERE id=${a.id})`,
	);
	await f.seat(a, w, role);
	return { ...a, actor: await f.actor(a.session) };
}
async function church({ planned = "2026-10-10" }: { planned?: string | null } = {}) {
	const w = await f.workspace("plant");
	await f.admin.execute(sql`UPDATE plant SET name='Harvest Point', timezone='America/Chicago' WHERE id=${w.id}`);
	const owner = await seated(w, "owner", "Olivia Owner");
	const admin = await seated(w, "admin", "Adam Admin");
	const member = await seated(w, "member", "Mia Member");
	if (planned)
		ok(
			await writer.schedule(f.db, owner.actor, {
				requestKey: key(),
				expectedRevision: "1",
				input: { date: planned, reason: null },
			}),
		);
	return { w, owner, admin, member };
}
async function launched(input: object = {}) {
	const c = await church();
	const p = await plan(c.owner);
	ok(await record(c.owner, { actualDate: "2026-10-11", attendance: 40, decisions: 6, ...input }, p.revision));
	return c;
}
async function person(w: { id: string }, name: string) {
	const id = randomUUID();
	await f.admin.execute(sql`INSERT INTO person(id,tenant_id,plant_id,display_name,source,stage,adult_classification,
		commitment_state,pipeline_position,state,created_at)
		VALUES(${id},${w.id},${w.id},${name},'other','prospect','unknown','unknown','1','live',clock_timestamp())`);
	return id;
}

before(async () => {
	f = await fixture();
	const mail = createMailService({
		db: f.db,
		encryptionKey: randomBytes(32),
		addressKey: randomBytes(32),
		from: "launch@example.test",
		authorize: authorizeLaunchNotices,
		transport: {
			async send() {
				return { kind: "accepted", id: randomUUID() };
			},
			async lookup() {
				return { kind: "unknown" };
			},
		},
	});
	reader = createLaunchReader(TODAY);
	writer = createLaunchWriter({ notices: launchNotices(seatedNotificationService(mail)), clock: TODAY });
	phases = createPhaseWriter({ notices: async () => {} });
});
after(() => f?.close());

test("AC:LAUNCH46-001 AC:CASE-LCH-006 Launch Sunday held on Oct 11 sits beside the planned Oct 10, which stays, and no meeting is made", async () => {
	const c = await church();
	const before = await plan(c.owner);
	assert.equal(before.today, "2026-10-12");
	assert.equal(before.outcome, null);
	assert.deepEqual(countdown(before.launch, before.today), { kind: "overdue", days: 2 });
	const meetings = (await footprint(c.w)).meetings;

	const saved = ok(
		await record(
			c.owner,
			{ actualDate: "2026-10-11", attendance: 40, decisions: 6, note: "  A full gym.  " },
			before.revision,
		),
	);
	assert.equal(saved.outcome, "changed");
	const p = saved.plan;
	assert.equal(p.launch!.targetDate, "2026-10-10");
	assert.equal(p.launch!.status, "completed");
	assert.deepEqual(countdown(p.launch, p.today), { kind: "completed" });
	assert.deepEqual(
		{ ...p.outcome, recordedAt: undefined },
		{
			actualDate: "2026-10-11",
			attendance: 40,
			decisions: 6,
			note: "A full gym.",
			recordedAt: undefined,
			recordedBy: { accountId: c.owner.id, displayName: "Olivia Owner" },
		},
	);
	assert.equal((await footprint(c.w)).meetings, meetings);
	refused(await record(c.owner, { actualDate: "2026-10-11" }, p.revision), "conflict");
});

test("a launch with no date, a later date or a postponement refuses an outcome until Launch Sunday arrives, with nothing written", async () => {
	const early = async (c: Church) => {
		const p = await plan(c.owner);
		const before = await footprint(c.w);
		const error = refused(await record(c.owner, { actualDate: "2026-10-11", attendance: 40 }, p.revision), "not_ready");
		assert.deepEqual(error.details, { needs: "launch_sunday" });
		assert.deepEqual(await footprint(c.w), before);
		assert.equal((await plan(c.owner)).outcome, null);
	};
	await early(await church({ planned: null }));
	await early(await church({ planned: "2026-10-13" }));
	const postponed = await church();
	ok(
		await writer.postpone(f.db, postponed.owner.actor, {
			requestKey: key(),
			expectedRevision: (await plan(postponed.owner)).launch!.revision,
			input: { reason: "The venue fell through." },
		}),
	);
	await early(postponed);

	const today = await church({ planned: "2026-10-12" });
	const p = ok(
		await record(today.owner, { actualDate: "2026-10-12", attendance: 40 }, (await plan(today.owner)).revision),
	).plan;
	assert.equal(p.launch!.status, "completed");
	assert.equal(p.outcome!.actualDate, "2026-10-12");
});

test("AC:CASE-LCH-008 AC:LAUNCH46-012 no future date, counts 0 to 1,000,000, a note of 10,000; empty is not recorded and 0 is 0", async () => {
	const c = await church();
	let p = await plan(c.owner);
	const m = p.milestones[0]!;
	ok(
		await writer.completeMilestone(f.db, c.owner.actor, {
			requestKey: key(),
			expectedRevision: m.revision,
			input: { milestoneId: m.id, reviewed: reviewedOf(m.tasks) },
		}),
	);
	p = await plan(c.owner);
	assert.equal(p.outcome, null);
	assert.equal(countdown(p.launch, p.today).kind, "overdue");

	const before = await footprint(c.w);
	const problem = async (input: object) =>
		refused(await record(c.owner, { actualDate: "2026-10-11", ...input }, p.revision), "invalid_outcome").details
			.problem;
	assert.equal(await problem({ actualDate: "2026-10-13" }), "date_in_future");
	assert.equal(await problem({ attendance: 1_000_001 }), "count_out_of_range");
	assert.equal(await problem({ decisions: -1 }), "count_out_of_range");
	assert.equal(await problem({ note: "x".repeat(10_001) }), "note_too_long");
	refused(await record(c.owner, { actualDate: "2026-10-11", attendance: 2.5 }, p.revision), "invalid_input");
	assert.deepEqual(await footprint(c.w), before);

	const saved = ok(
		await record(
			c.owner,
			{ actualDate: "2026-10-12", attendance: 1_000_000, decisions: 0, note: "x".repeat(10_000) },
			p.revision,
		),
	).plan;
	assert.equal(saved.outcome!.attendance, 1_000_000);
	const empty = ok(
		await correct(
			c.owner,
			{ actualDate: "2026-10-11", attendance: null, decisions: 0, note: null, reason: "Counted again" },
			saved.revision,
		),
	).plan;
	assert.equal(empty.outcome!.attendance, null);
	assert.equal(empty.outcome!.decisions, 0);
});

test("AC:LAUNCH46-003 AC:CASE-LCH-006 typing only Mara adds a new Person named Mara, linked as a Launch Sunday guest, with nothing made up", async () => {
	const c = await church();
	refused(await guest(c.owner, { displayName: "Mara" }), "not_ready");
	ok(await record(c.owner, { actualDate: "2026-10-11", attendance: 40 }, (await plan(c.owner)).revision));
	const before = await footprint(c.w);
	const p = ok(await guest(c.owner, { displayName: "  Mara " })).plan;
	assert.deepEqual(named(p), ["Mara"]);
	assert.equal(p.guests.count, 1);
	const mara = await one(sql`SELECT p.display_name,p.first_name,p.last_name,p.email,p.phone,p.linked_account_id,p.state,
		p.stage,p.source,p.birth_date,p.adult_classification,p.commitment_state,
		(SELECT count(*)::int FROM commitment k WHERE k.person_id=p.id) commitments,
		(SELECT count(*)::int FROM seat s WHERE s.plant_id=p.plant_id) seats,
		(SELECT count(*)::int FROM launch_guest g WHERE g.person_id=p.id) links
		FROM person p WHERE p.id=${p.guests.named![0]!.personId}`);
	assert.deepEqual(mara, {
		display_name: "Mara",
		first_name: null,
		last_name: null,
		email: null,
		phone: null,
		linked_account_id: null,
		state: "live",
		stage: "attendee",
		source: "event",
		birth_date: null,
		adult_classification: "unknown",
		commitment_state: "unknown",
		commitments: 0,
		seats: 3,
		links: 1,
	});
	const after = await footprint(c.w);
	assert.equal(after.people, before.people + 1);
	assert.equal(after.guests, before.guests + 1);
	const created = await one(sql`SELECT actor_id,kind FROM audit_event WHERE action='people.created'
		AND subject_id=${p.guests.named![0]!.personId}`);
	assert.deepEqual(created, { actor_id: c.owner.id, kind: "create" });
	const twice = key();
	const saves = await Promise.all([1, 2].map(() => guest(c.owner, { displayName: "Noor" }, twice)));
	assert.ok(saves.some((r) => r.status === "ok"));
	ok(await guest(c.owner, { displayName: "Noor" }, twice));
	assert.deepEqual(
		await one(sql`SELECT count(*)::int people,
			(SELECT count(*)::int FROM launch_guest g JOIN person n ON n.id=g.person_id WHERE n.tenant_id=${c.w.id}
				AND n.display_name='Noor') guests FROM person WHERE tenant_id=${c.w.id} AND display_name='Noor'`),
		{ people: 1, guests: 1 },
		"two taps and a retry: one Person, one guest",
	);
	refused(await guest(c.owner, { displayName: "   " }), "invalid_input");
	refused(await guest(c.owner, { displayName: "x".repeat(256) }), "invalid_input");
});

test("AC:LAUNCH46-004 AC:LAUNCH46-002 picking the suggested Alex Kim links him; a second save, a retry and a typed name never make a second Alex", async () => {
	const c = await launched();
	const alex = await person(c.w, "Alex Kim");
	await person(c.w, "Alexis Moreno");
	const matches = ok(await reader.suggestGuests(f.db, c.owner.actor, "Alex Kim"));
	assert.deepEqual(
		matches.map((m) => [m.displayName, m.alreadyGuest]),
		[["Alex Kim", false]],
	);
	const requestKey = key();
	const linked = ok(await guest(c.owner, { personId: alex }, requestKey));
	assert.equal(linked.outcome, "changed");
	assert.deepEqual(named(linked.plan), ["Alex Kim"]);
	assert.equal(ok(await guest(c.owner, { personId: alex }, requestKey)).outcome, "changed");
	assert.equal(ok(await guest(c.owner, { personId: alex })).outcome, "noop");
	assert.equal((await rows(sql`SELECT 1 FROM launch_guest WHERE person_id=${alex}`)).length, 1);
	assert.deepEqual(
		ok(await reader.suggestGuests(f.db, c.owner.actor, "alex k")).map((m) => m.alreadyGuest),
		[true],
	);
	const count = async () =>
		(await one(sql`SELECT count(*)::int n FROM person WHERE tenant_id=${c.w.id} AND display_name='Alex Kim'`)).n;
	assert.equal(await count(), 1);
	const other = await f.workspace("plant");
	refused(await guest(c.owner, { personId: await person(other, "Alex Kim") }), "access_denied");
	assert.equal(await count(), 1);

	const namesake = await person(c.w, "Alex Kim");
	const exact = ok(await guest(c.owner, { personId: namesake })).plan;
	assert.deepEqual(
		exact.guests.named!.map((g) => g.personId).sort(),
		[alex, namesake].sort(),
		"the exact Alex picked, not the other one",
	);
	assert.equal(await count(), 2, "two people with one name stay two");
});

test("AC:LAUNCH46-005 attendance 100 with 20 named guests shows both, and no placeholder People exist for the other 80", async () => {
	const c = await launched({ attendance: 100 });
	const before = await footprint(c.w);
	for (let i = 1; i <= 20; i++) ok(await guest(c.owner, { displayName: `Guest ${i}` }));
	const p = await plan(c.owner);
	assert.equal(p.outcome!.attendance, 100);
	assert.equal(p.guests.count, 20);
	assert.equal((await footprint(c.w)).people, before.people + 20);
});

test("AC:LAUNCH46-011 AC:B02-019 a partial debrief stays a draft; submitting with one-word answers records the date and name", async () => {
	const c = await church();
	let p = await plan(c.owner);
	refused(await debrief(c.owner, p, { wentWell: "Early" }), "not_ready");
	ok(await record(c.owner, { actualDate: "2026-10-11", attendance: 40 }, p.revision));
	p = await plan(c.owner);
	assert.deepEqual(p.debrief, { draft: null, submitted: null });

	p = ok(await debrief(c.owner, p, { wentWell: "Worship", toChange: "  Parking  " })).plan;
	assert.equal(p.debrief!.draft!.answers.wentWell, "Worship");
	assert.equal(p.debrief!.draft!.answers.toChange, "Parking");
	assert.equal(p.debrief!.draft!.submittedAt, null);
	assert.equal(p.debrief!.submitted, null);
	p = await plan(c.owner);
	assert.equal(p.debrief!.draft!.answers.toChange, "Parking");
	assert.deepEqual(p.evidence.guestNamesEntered.status, "unknown");
	assert.deepEqual(p.evidence.debriefDone.status, "unknown");
	const stale = { ...p, debrief: { ...p.debrief, draft: null } };
	refused(await debrief(c.owner, stale, { wentWell: "Other tab" }), "conflict");
	assert.equal(ok(await debrief(c.owner, p, { wentWell: "Worship", toChange: "Parking" })).outcome, "noop");

	const problem = async (answers: Partial<DebriefAnswers>) =>
		refused(await debrief(c.owner, p, answers, true), "invalid_debrief").details.problem;
	assert.equal(await problem({ wentWell: "Worship" }), "guest_answer_needed");
	assert.equal(await problem({ missingNames: "yes" }), "guest_count_needed");
	assert.equal(await problem({ missingNames: "yes", missingCount: 0 }), "count_out_of_range");
	const done = ok(
		await debrief(
			c.owner,
			p,
			{
				wentWell: "Worship",
				toChange: "Parking",
				operations: "Kids",
				followUpPlan: "Texts",
				supportNeeded: "Prayer",
				missingNames: "no",
			},
			true,
		),
	).plan;
	assert.equal(done.debrief!.draft, null);
	assert.equal(done.debrief!.submitted!.version, 1);
	assert.deepEqual(done.debrief!.submitted!.submittedBy, { accountId: c.owner.id, displayName: "Olivia Owner" });
	assert.ok(done.debrief!.submitted!.submittedAt);
	assert.equal(
		GUEST_QUESTION,
		"Was there anyone that visited as a guest and has not been entered by name into our People CRM?",
	);
	assert.equal(done.outcome!.attendance, 40);
	assert.equal("attendance" in done.debrief!.submitted!.answers, false);
});

test("AC:LAUNCH46-008 AC:LAUNCH46-010 AC:LAUNCH46-009 AC:B02-020 Yes 3 is not met with 3 remaining, naming 2 keeps 3, No is met, a later draft changes nothing", async () => {
	const c = await launched();
	let p = await plan(c.owner);
	p = ok(await debrief(c.owner, p, { missingNames: "yes", missingCount: 3 }, true)).plan;
	assert.deepEqual(p.evidence.guestNamesEntered, { status: "not_met", remaining: 3 });
	assert.deepEqual(p.evidence.debriefDone, { status: "met" });

	ok(await guest(c.owner, { displayName: "June" }));
	ok(await guest(c.owner, { displayName: "Theo" }));
	p = await plan(c.owner);
	assert.equal(p.guests.count, 2);
	assert.deepEqual(p.evidence.guestNamesEntered, { status: "not_met", remaining: 3 });

	p = ok(await debrief(c.owner, p, { missingNames: "no" }, true)).plan;
	assert.deepEqual(p.evidence.guestNamesEntered, { status: "met", remaining: null });
	assert.equal(p.debrief!.submitted!.version, 2);
	assert.deepEqual(
		await rows(
			sql`SELECT version,missing_names,missing_count FROM launch_debrief WHERE plant_id=${c.w.id} ORDER BY version`,
		),
		[
			{ version: 1, missing_names: "yes", missing_count: 3 },
			{ version: 2, missing_names: "no", missing_count: null },
		],
	);
	p = ok(await debrief(c.owner, p, { missingNames: "yes" })).plan;
	assert.deepEqual(p.evidence.guestNamesEntered, { status: "met", remaining: null });
	p = ok(await debrief(c.owner, p, { wentWell: "Half done" })).plan;
	assert.deepEqual(p.evidence.guestNamesEntered, { status: "met", remaining: null });
	assert.deepEqual(p.evidence.debriefDone, { status: "met" });
	const n = (await footprint(c.w)).audits;
	const clean = { ...p, debrief: { ...p.debrief, draft: null } };
	await f.admin.execute(sql`DELETE FROM launch_debrief WHERE plant_id=${c.w.id} AND submitted_at IS NULL`);
	assert.equal(ok(await debrief(c.owner, clean, { missingNames: "no" }, true)).outcome, "noop");
	assert.equal((await footprint(c.w)).audits, n);
});

test("AC:B03-037 the calendar resolver answers by itself at version 1, check-ins open on twelve weeks and Launch reads Guest data entered and Debrief done with nothing left to approve", async () => {
	const c = await launched();
	const none = (await plan(c.owner)).evidence;
	assert.deepEqual(
		[none.guestNamesEntered.status, none.debriefDone.status],
		["unknown", "unknown"],
		"an unsubmitted debrief is not a pending decision",
	);
	const submitted = ok(
		await debrief(c.owner, await plan(c.owner), { missingNames: "yes", missingCount: 3 }, true),
	).plan;
	const launch = (await plan(c.admin)).evidence;
	assert.deepEqual(launch, submitted.evidence);
	assert.deepEqual(
		{ guest_data_entered: launch.guestNamesEntered, debrief_done: launch.debriefDone },
		{ guest_data_entered: { status: "not_met", remaining: 3 }, debrief_done: { status: "met" } },
	);
	const stored = await rows(sql`SELECT missing_names,missing_count,submitted_at IS NOT NULL AS submitted
		FROM launch_debrief WHERE plant_id=${c.w.id}`);
	assert.deepEqual(stored, [{ missing_names: "yes", missing_count: 3, submitted: true }]);
	const quiet = await footprint(c.w);
	await plan(c.owner);
	await plan(c.member);
	assert.deepEqual(await footprint(c.w), quiet, "reading the workspace records nothing");

	const chicago = timeZone.parse("America/Chicago");
	const gap = localDateTime.parse("2027-03-14T02:30:00"),
		fold = localDateTime.parse("2026-11-01T01:30:00");
	assert.deepEqual(resolveCalendar(gap, chicago, "automatic"), {
		kind: "resolved",
		entered: gap,
		zone: chicago,
		occurrence: { instant: "2027-03-14T08:30:00.000Z", offsetSeconds: -18_000 },
		resolverVersion: 1,
		adjustmentSeconds: 3600,
	});
	assert.deepEqual(resolveCalendar(fold, chicago, "automatic"), {
		kind: "resolved",
		entered: fold,
		zone: chicago,
		occurrence: { instant: "2026-11-01T06:30:00.000Z", offsetSeconds: -18_000 },
		resolverVersion: 1,
		adjustmentSeconds: 0,
	});
	assert.equal(resolveCalendar(gap, chicago, "entered").kind, "gap");
	assert.equal(resolveCalendar(fold, chicago, "entered").kind, "fold");
	assert.equal(calendarContext(chicago, TODAY).resolverVersion, 1);

	await f.admin.execute(sql`UPDATE account SET personal_timezone='America/Chicago' WHERE id=${c.owner.id}`);
	let now = instant.parse("2026-07-20T18:00:00.000Z");
	const care = createPrivateCare({ clock: { now: () => now } });
	const steady = { spiritual: "steady", family: "steady", financial: "steady", pace: "steady" };
	for (let week = 0; week < 13; week++) {
		now = instant.parse(new Date(Date.parse("2026-07-20T18:00:00.000Z") + week * 7 * 86_400_000).toISOString());
		ok(
			await care.save(f.db, c.owner.actor, {
				requestKey: key(),
				expectedRevision: ok(await care.readCurrent(f.db, c.owner.actor, {})).revision,
				input: { answers: steady, note: "" },
			}),
		);
	}
	const strip = ok(await care.readTrends(f.db, c.owner.actor, {}));
	assert.deepEqual([strip.weeks.length, strip.pageCount], [12, 2]);
	assert.deepEqual([strip.weeks[0]!.startsOn, strip.weeks[11]!.startsOn], ["2026-10-12", "2026-07-27"]);
});

test("AC:LAUNCH46-021 AC:LAUNCH46-014 AC:CASE-LCH-004 a draft alone is unknown for both, and neither milestone can be completed or reopened by hand", async () => {
	const c = await launched();
	const p = ok(await debrief(c.owner, await plan(c.owner), { missingNames: "no", wentWell: "Draft only" })).plan;
	assert.deepEqual(p.evidence, {
		guestNamesEntered: { status: "unknown", remaining: null },
		debriefDone: { status: "unknown" },
		submittedAt: null,
	});
	const before = await footprint(c.w);
	for (const milestoneId of ["guest_data_entered", "debrief_done"]) {
		refused(
			await writer.completeMilestone(f.db, c.owner.actor, {
				requestKey: key(),
				expectedRevision: "1",
				input: { milestoneId, reviewed: "" },
			}),
			"derived_evidence_only",
		);
		refused(
			await writer.reopenMilestone(f.db, c.owner.actor, {
				requestKey: key(),
				expectedRevision: "1",
				input: { milestoneId },
			}),
			"derived_evidence_only",
		);
	}
	assert.deepEqual(await footprint(c.w), before);
});

test("AC:CASE-LCH-007 AC:B02-021 correcting 40 to 50 with a reason is history once; the phase stays and no task is made", async () => {
	const c = await launched();
	const p = await plan(c.owner);
	refused(
		await correct(
			c.owner,
			{ ...p.outcome, recordedAt: undefined, recordedBy: undefined, attendance: 50, reason: "" },
			p.revision,
		),
		"invalid_input",
	);
	const input = { actualDate: "2026-10-11", attendance: 50, decisions: 6, note: null, reason: "Counted the nursery" };
	refused(await correct(c.owner, { ...input, reason: " " }, p.revision), "invalid_reason");
	const before = await footprint(c.w);
	const fixed = ok(await correct(c.owner, input, p.revision)).plan;
	assert.equal(fixed.outcome!.attendance, 50);
	assert.equal(fixed.outcome!.recordedAt, p.outcome!.recordedAt);
	const again = ok(await correct(c.owner, input, fixed.revision));
	assert.equal(again.outcome, "noop");
	refused(await correct(c.owner, { ...input, attendance: 60 }, p.revision), "conflict");
	const after = await footprint(c.w);
	assert.equal(after.audits, before.audits + 1);
	assert.deepEqual([after.phase, after.tasks], [before.phase, before.tasks]);
	const entry = (await journal(c.owner)).filter((e) => e.change.kind === "outcome")[0]!;
	assert.deepEqual(entry.change, {
		kind: "outcome",
		event: "corrected",
		changes: [{ field: "attendance", before: 40, after: 50 }],
		reason: "Counted the nursery",
	});
	assert.deepEqual(entry.actor, { accountId: c.owner.id, displayName: "Olivia Owner" });
	assert.ok(entry.at);
});

test("AC:CASE-LCH-002 AC:CASE-LCH-010 Launch history lists date moves, postponement, milestones and the outcome; a deleted account is a former account", async () => {
	const c = await church({ planned: "2026-11-10" });
	let p = await plan(c.owner);
	ok(
		await writer.schedule(f.db, c.admin.actor, {
			requestKey: key(),
			expectedRevision: p.revision,
			input: { date: "2026-11-17", reason: "Gym booked" },
		}),
	);
	p = await plan(c.owner);
	ok(
		await writer.postpone(f.db, c.owner.actor, {
			requestKey: key(),
			expectedRevision: p.revision,
			input: { reason: "Kids leader open" },
		}),
	);
	p = await plan(c.owner);
	ok(
		await writer.schedule(f.db, c.owner.actor, {
			requestKey: key(),
			expectedRevision: p.revision,
			input: { date: "2026-12-06", reason: null },
		}),
	);
	p = await plan(c.owner);
	let m = p.milestones[0]!;
	m = ok(
		await writer.completeMilestone(f.db, c.owner.actor, {
			requestKey: key(),
			expectedRevision: m.revision,
			input: { milestoneId: m.id, reviewed: reviewedOf(m.tasks) },
		}),
	).milestone;
	ok(
		await writer.reopenMilestone(f.db, c.owner.actor, {
			requestKey: key(),
			expectedRevision: m.revision,
			input: { milestoneId: m.id },
		}),
	);

	const entries = await journal(c.owner);
	assert.deepEqual(
		entries.map((e) => e.change),
		[
			{ kind: "milestone", event: "reopened", title: m.title },
			{ kind: "milestone", event: "completed", title: m.title },
			{ kind: "date", event: "rescheduled", from: null, to: "2026-12-06", reason: null },
			{ kind: "date", event: "postponed", from: "2026-11-17", to: null, reason: "Kids leader open" },
			{ kind: "date", event: "moved", from: "2026-11-10", to: "2026-11-17", reason: "Gym booked" },
			{ kind: "date", event: "scheduled", from: null, to: "2026-11-10", reason: null },
		],
	);
	assert.deepEqual(
		entries.map((e) => e.actor?.displayName),
		["Olivia Owner", "Olivia Owner", "Olivia Owner", "Olivia Owner", "Adam Admin", "Olivia Owner"],
	);
	assert.deepEqual(
		entries.map((e) => e.at),
		entries
			.map((e) => e.at)
			.toSorted()
			.toReversed(),
	);

	await f.admin
		.execute(sql`UPDATE audit_event SET actor_token=coalesce(actor_token,encode(sha256(convert_to(tenant_id::text||'/'||actor_id::text,'UTF8')),'hex')),
		actor_id=NULL WHERE actor_id=${c.admin.id}`);
	const moved = (await journal(c.owner)).find((e) => e.change.kind === "date" && e.change.event === "moved")!;
	assert.equal(moved.actor, null);
	assert.deepEqual(moved.change, {
		kind: "date",
		event: "moved",
		from: "2026-11-10",
		to: "2026-11-17",
		reason: "Gym booked",
	});
	assert.equal(JSON.stringify(moved).includes("Adam"), false);
	assert.equal(JSON.stringify(moved).includes(c.admin.email), false);

	ok(
		await writer.schedule(f.db, c.owner.actor, {
			requestKey: key(),
			expectedRevision: (await plan(c.owner)).revision,
			input: { date: "2026-10-11", reason: "Venue opened early" },
		}),
	);
	const now = await plan(c.owner);
	ok(await record(c.owner, { actualDate: "2026-10-11", attendance: 40 }, now.revision));
	const kinds = (await journal(c.owner))
		.slice(0, 1)
		.map((e) => [e.change.kind, "event" in e.change ? e.change.event : undefined]);
	assert.deepEqual(kinds, [["outcome", "recorded"]]);
	refused(await reader.readJournal(f.db, c.member.actor), "access_denied");
});

test("AC:B02-030 AC:LAUNCH46-015 AC:LAUNCH46-019 the summary publishes only what the planter wrote, versions stay, and nothing else happens", async () => {
	const c = await launched();
	let p = await plan(c.owner);
	refused(await summary(c.owner, p, "Service held."), "not_ready");
	p = ok(
		await debrief(
			c.owner,
			p,
			{ wentWell: "Private reflection: Mara cried", supportNeeded: "Pray for June", missingNames: "no" },
			true,
		),
	).plan;
	const empty: unknown = p.summary;
	assert.deepEqual(empty, { draft: null, published: [] });
	const before = await footprint(c.w);

	p = ok(await summary(c.owner, p, "Service held.")).plan;
	assert.equal(p.summary!.draft!.body, "Service held.");
	assert.equal(p.summary!.published.length, 0);
	refused(await summary(c.owner, p, " ", true), "invalid_summary");
	refused(await summary(c.owner, p, "x".repeat(4001), true), "invalid_summary");
	p = ok(await summary(c.owner, p, "Service held. Next review is Tuesday.", true)).plan;
	assert.equal(p.summary!.draft, null);
	assert.deepEqual(
		p.summary!.published.map((s) => [s.version, s.body, s.publishedBy!.displayName]),
		[[1, "Service held. Next review is Tuesday.", "Olivia Owner"]],
	);
	assert.ok(p.summary!.published[0]!.publishedAt);
	assert.equal(ok(await summary(c.owner, p, "Service held. Next review is Tuesday.", true)).outcome, "noop");
	p = ok(await summary(c.owner, p, "Service held. Team review Tuesday.", true)).plan;
	assert.deepEqual(
		p.summary!.published.map((s) => [s.version, s.body]),
		[
			[2, "Service held. Team review Tuesday."],
			[1, "Service held. Next review is Tuesday."],
		],
	);
	const after = await footprint(c.w);
	assert.deepEqual(
		[after.tasks, after.people, after.mail, after.notices, after.phase, after.meetings],
		[before.tasks, before.people, before.mail, before.notices, before.phase, before.meetings],
	);
	const published = (await journal(c.owner)).filter((e) => e.change.kind === "summary");
	assert.deepEqual(
		published.map((e) => ("version" in e.change ? e.change.version : undefined)),
		[2, 1],
	);
	const audit = JSON.stringify(
		await rows(sql`SELECT before_value,after_value,metadata,result FROM audit_event WHERE tenant_id=${c.w.id}`),
	);
	assert.equal(audit.includes("Team review"), false);
	assert.equal(audit.includes("Mara cried"), false);
});

test("AC:LAUNCH46-016 AC:LAUNCH46-018 AC:B02-031 an organization reads the published summary only under shared findings and Meetings, per link", async () => {
	const c = await launched();
	let p = ok(
		await debrief(c.owner, await plan(c.owner), { missingNames: "no", supportNeeded: "Private support note" }, true),
	).plan;
	const network = await f.workspace("sending_network");
	const sender = await f.workspace("sending_church");
	const stranger = await f.workspace("sending_network");
	const orgActor = async (w: Workspace) => {
		const a = await f.account();
		await f.seat(a, w, "owner");
		return f.actor(a.session);
	};
	const [n, s, x] = [await orgActor(network), await orgActor(sender), await orgActor(stranger)];
	const link = async (org: { id: string }, findings: boolean, meetings: boolean) =>
		(
			await one(sql`INSERT INTO affiliation(plant_id,organization_id,accepted_at,share_people,share_meetings,share_tasks,
			share_ministry_teams,share_wiki,share_activity,shared_findings)
			VALUES(${c.w.id},${org.id},clock_timestamp(),false,${meetings},false,false,false,false,${findings}) RETURNING id`)
		).id;
	const nLink = await link(network, true, true);
	await link(sender, true, false);
	const read = (who: Who["actor"]) => reader.readPublishedSummary(f.db, who, c.w.id);
	p = ok(await summary(c.owner, p, "Draft words")).plan;
	assert.equal(await read(n), null);
	p = ok(await summary(c.owner, p, "Service held.", true)).plan;
	const shared = await read(n);
	assert.deepEqual(
		{ ...shared, publishedAt: undefined },
		{ version: 1, body: "Service held.", publishedAt: undefined },
	);
	assert.equal(JSON.stringify(shared).includes("Private support"), false);
	assert.equal(await read(s), null);
	assert.equal(await read(x), null);
	assert.equal(await read(c.owner.actor), null);
	const second = await f.workspace("sending_network");
	const n2 = await orgActor(second);
	await link(second, true, true);
	await f.admin.execute(sql`UPDATE affiliation SET ended_at=clock_timestamp() WHERE id=${nLink}`);
	assert.equal(await read(n), null);
	assert.equal((await read(n2))!.body, "Service held.");
	await f.admin.execute(sql`UPDATE affiliation SET shared_findings=false WHERE organization_id=${second.id}`);
	assert.equal(await read(n2), null);
});

test("AC:LAUNCH46-020 a Member sees the outcome and guest count, and every Launch outcome write is refused with nothing written", async () => {
	const c = await launched();
	ok(await guest(c.owner, { displayName: "Mara" }));
	let p = ok(await debrief(c.owner, await plan(c.owner), { missingNames: "yes", missingCount: 2 }, true)).plan;
	p = ok(await summary(c.owner, p, "Service held.", true)).plan;
	const seen = await plan(c.member);
	assert.equal(seen.outcome!.attendance, 40);
	assert.deepEqual(seen.guests, { count: 1, named: null });
	assert.equal(seen.debrief, null);
	assert.equal(seen.summary, null);
	assert.deepEqual(seen.evidence.guestNamesEntered, { status: "not_met", remaining: 2 });

	const before = await footprint(c.w);
	const blank = { ...p, debrief: { draft: null }, summary: { draft: null } };
	refused(await record(c.member, { actualDate: "2026-10-11" }, p.revision), "access_denied");
	refused(
		await correct(
			c.member,
			{ actualDate: "2026-10-11", attendance: 1, decisions: null, note: null, reason: "x" },
			p.revision,
		),
		"access_denied",
	);
	refused(await guest(c.member, { displayName: "Theo" }), "access_denied");
	refused(await debrief(c.member, blank, { missingNames: "no" }), "access_denied");
	refused(await debrief(c.member, blank, { missingNames: "no" }, true), "access_denied");
	refused(await summary(c.member, blank, "Member words"), "access_denied");
	refused(await summary(c.member, blank, "Member words", true), "access_denied");
	refused(await reader.suggestGuests(f.db, c.member.actor, "Mara"), "access_denied");
	assert.deepEqual(await footprint(c.w), before);
});

test("AC:PERSONREF-LAUNCH-NAMED-GUEST-MERGE AC:PERSONREF-LAUNCH-NAMED-GUEST-UNMERGE AC:LAUNCH46-022 a guest link follows merge and Unmerge, once per Person", async () => {
	const c = await launched();
	const [alex1, alex2, jo] = [
		await person(c.w, "Alex Kim"),
		await person(c.w, "Alex K."),
		await person(c.w, "Jo Park"),
	];
	for (const id of [alex1, alex2]) ok(await guest(c.owner, { personId: id }));
	ok(await debrief(c.owner, await plan(c.owner), { missingNames: "yes", missingCount: 3 }, true));
	const read = <T,>(body: (tx: WriteTx, ctx: PeopleReadContext) => Promise<T>) =>
		gatedTransaction(f.db, (t) => body(t, new PeopleReadContext(c.owner.actor)));
	const write = <T,>(body: Parameters<typeof withPeopleWrite<T>>[2]) => withPeopleWrite(f.db, c.owner.actor, body);
	const merge = async (sourceId: string, survivorId: string) => {
		const r = ok(await read((t, ctx) => peopleMerge.getMergeReview(t, ctx, { sourceId, survivorId })));
		return ok(
			await write((t, ctx) =>
				peopleMerge.mergePeople(t, ctx, {
					requestKey: key(),
					input: { sourceId, survivorId, reviewDigest: r.reviewDigest, fieldChoices: {} },
				}),
			),
		);
	};
	const links = async () =>
		(await rows(sql`SELECT person_id FROM launch_guest WHERE plant_id=${c.w.id} ORDER BY recorded_at`)).map(
			(r) => r.person_id,
		);

	const merged = await merge(alex2, alex1);
	const p = await plan(c.owner);
	assert.deepEqual(named(p), ["Alex Kim"]);
	assert.equal(p.outcome!.attendance, 40);
	assert.deepEqual(p.evidence.guestNamesEntered, { status: "not_met", remaining: 3 });
	assert.deepEqual(await links(), [alex1, alex2]);
	const mergedJo = await merge(alex1, jo);
	assert.deepEqual(named(await plan(c.owner)), ["Jo Park"]);
	assert.deepEqual(await links(), [jo, alex2]);
	const preview = ok(await read((t, ctx) => peopleUnmerge.previewUnmerge(t, ctx, { mergeId: mergedJo.mergeId })));
	ok(
		await write((t, ctx) =>
			peopleUnmerge.unmergePeople(t, ctx, {
				requestKey: key(),
				expectedRevision: preview.reviewRevision,
				input: { mergeId: mergedJo.mergeId },
			}),
		),
	);
	assert.deepEqual(await links(), [alex1, alex2]);
	assert.deepEqual(named(await plan(c.owner)), ["Alex Kim"]);
	assert.ok(merged.mergeId);
});

test("AC:LAUNCH46-022 AC:CASE-LCH-007 a wrong guest is relinked or voided once, history keeps both names and both counts, and nothing else moves", async () => {
	const { w, owner, admin, member } = await launched();
	const other = await launched();
	const [sam, maria] = [await person(w, "Sam Ortiz"), await person(w, "Maria Lopez")];
	ok(await guest(owner, { personId: sam }));
	ok(await guest(owner, { displayName: "Mara" }));
	const start = await plan(owner);
	const before = await footprint(w);
	const [samGuest, maraGuest] = start.guests.named!;
	const fix = (who: Who, g: { guestId: string; revision: string }, personId: string | null, requestKey = key()) =>
		writer.correctGuestAttendance(f.db, who.actor, {
			requestKey,
			expectedRevision: g.revision,
			input: { guestId: g.guestId, personId },
		});

	const theirs = await person(other.w, "Other Church");
	refused(await fix(member, samGuest!, maria), "access_denied");
	refused(await fix(other.owner, samGuest!, null), "conflict");
	refused(await fix(owner, samGuest!, theirs), "access_denied");
	refused(await fix(owner, samGuest!, maraGuest!.personId), "already_guest");
	refused(await fix(owner, { ...samGuest!, revision: "9" }, maria), "conflict");
	assert.equal(ok(await fix(owner, samGuest!, sam)).outcome, "noop");
	assert.deepEqual(await plan(owner), start, "no refusal or no-op changed anything");
	assert.deepEqual(await footprint(w), before);

	const relink = key();
	const relinked = ok(await fix(admin, samGuest!, maria, relink));
	assert.deepEqual(
		[relinked.outcome, named(relinked.plan).sort(), relinked.plan.guests.count],
		["changed", ["Mara", "Maria Lopez"], 2],
	);
	assert.equal(ok(await fix(admin, samGuest!, maria, relink)).outcome, "changed", "a retry answers as the first did");
	refused(await fix(admin, samGuest!, null, relink), "idempotency_conflict");
	refused(await fix(owner, samGuest!, null), "conflict");

	const voided = ok(await fix(owner, maraGuest!, null));
	assert.deepEqual([named(voided.plan), voided.plan.guests.count], [["Maria Lopez"], 1]);
	assert.deepEqual(
		[voided.plan.outcome, voided.plan.debrief, voided.plan.launch, voided.plan.evidence],
		[start.outcome, start.debrief, start.launch, start.evidence],
		"headcount, decisions and the debrief answer stay",
	);
	const after = await footprint(w);
	assert.deepEqual(
		{ ...after, audits: 0, guests: 0 },
		{ ...before, audits: 0, guests: 0 },
		"no person, task, mail or phase changed",
	);
	assert.equal(after.audits, before.audits + 2, "one entry per correction");
	assert.deepEqual(
		(await journal(owner))
			.filter((e) => e.change.kind === "guest" || e.change.kind === "guest_correction")
			.map((e) => [e.actor?.displayName, e.change]),
		[
			[
				"Olivia Owner",
				{ kind: "guest_correction", event: "voided", from: "Mara", to: null, countBefore: 2, countAfter: 1 },
			],
			[
				"Adam Admin",
				{
					kind: "guest_correction",
					event: "relinked",
					from: "Sam Ortiz",
					to: "Maria Lopez",
					countBefore: 2,
					countAfter: 2,
				},
			],
			["Olivia Owner", { kind: "guest", name: "Mara", added: true }],
			["Olivia Owner", { kind: "guest", name: "Sam Ortiz", added: false }],
		],
	);
	assert.equal(
		ok(await guest(owner, { personId: maraGuest!.personId })).plan.guests.count,
		2,
		"Mara can be named again",
	);
});

test("AC:PERSONREF-LAUNCH-NAMED-GUEST-RETIRE a retired guest leaves the roster and keeps the link as history", async () => {
	const c = await launched();
	const mara = ok(await guest(c.owner, { displayName: "Mara" })).plan.guests.named![0]!.personId;
	const read = <T,>(body: (tx: WriteTx, ctx: PeopleReadContext) => Promise<T>) =>
		gatedTransaction(f.db, (t) => body(t, new PeopleReadContext(c.owner.actor)));
	const { reviewRevision } = ok(
		await read((t, ctx) => peopleReader.getStatusWarnings(t, ctx, { personId: personId.parse(mara) })),
	);
	const { revision } = await one(sql`SELECT revision::text FROM person WHERE id=${mara}`);
	ok(
		await withPeopleWrite(f.db, c.owner.actor, (t, ctx) =>
			peopleWriter.retirePerson(
				t,
				ctx,
				{
					requestKey: key(),
					expectedRevision: revision,
					input: { personId: mara, reason: "Moved away", reviewRevision, handoffs: [] },
				},
				async () => {},
			),
		),
	);
	const p = await plan(c.owner);
	assert.deepEqual(p.guests, { count: 0, named: [] });
	assert.equal((await rows(sql`SELECT 1 FROM launch_guest WHERE person_id=${mara}`)).length, 1);
	assert.deepEqual(ok(await reader.suggestGuests(f.db, c.owner.actor, "Mara")), []);
	refused(await guest(c.owner, { personId: personId.parse(mara) }), "access_denied");
});

test("AC:CASE-LCH-011 the phase journey shows the declaration, the move and Launch Sunday as three entries, with nothing in between", async () => {
	const c = await church();
	const journey = async () => ok(await phaseReader.readHistory(f.db, c.owner.actor));
	let h = await journey();
	ok(
		await phases.declare(f.db, c.owner.actor, {
			requestKey: key(),
			expectedRevision: h.state.revision,
			input: { phase: 3 },
		}),
	);
	h = await journey();
	ok(
		await phases.transition(f.db, c.owner.actor, {
			requestKey: key(),
			expectedRevision: h.state.revision,
			input: { toPhase: 4, reason: "Team trained and ready" },
		}),
	);
	const before = (await journey()).entries.length;
	ok(await record(c.owner, { actualDate: "2026-10-11", attendance: 40 }, (await plan(c.owner)).revision));
	const p = await plan(c.owner);
	ok(
		await correct(
			c.owner,
			{ actualDate: "2026-10-11", attendance: 50, decisions: null, note: null, reason: "Recount" },
			p.revision,
		),
	);
	h = await journey();
	assert.equal(h.entries.length, before + 1);
	assert.deepEqual(
		h.entries
			.slice(-3)
			.map((e) => [e.kind, ("toPhase" in e ? e.toPhase : null) ?? ("actualDate" in e ? e.actualDate : undefined)]),
		[
			["initial_declaration", 3],
			["movement", 4],
			["launch_sunday", "2026-10-11"],
		],
	);
	assert.equal(h.state.phase, 4);
	assert.deepEqual(h.entries.at(-1)!.actor, { accountId: c.owner.id, displayName: "Olivia Owner" });
});
