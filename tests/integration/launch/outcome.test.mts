import test, { after, before } from "node:test";
import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { sql } from "../../../packages/db/src/query.ts";
import { fixture } from "../identity/invitations-support.mts";
import { ok, refused } from "../../support/fixture.mts";
import { frozenClock, instant } from "../../../packages/contracts/src/common/index.ts";
import { countdown, GUEST_QUESTION, reviewedOf } from "../../../packages/contracts/src/launch/index.ts";
import {
	authorizeLaunchNotices,
	createLaunchReader,
	createLaunchWriter,
} from "../../../packages/domain/src/launch/index.ts";
import { PeopleReadContext, withPeopleWrite } from "../../../packages/domain/src/people/core.ts";
import { peopleMerge, peopleReader, peopleUnmerge, peopleWriter } from "../../../packages/domain/src/people/index.ts";
import { createPhaseWriter, phaseReader } from "../../../packages/domain/src/phases/index.ts";
import { createMailService } from "../../../apps/web/src/server/jobs/mail.ts";
import { seatedNotificationService } from "../../../apps/web/src/server/jobs/seated-notifications.ts";
import { launchNotices } from "../../../apps/web/src/server/launch/notices.ts";

// WP-046: what happened on Launch Sunday. Every write runs through the writer the /launch actions call, every read
// through the reader the page calls, on its own schema of the development or CI database. "Today" is Oct 12, 2026 in
// Harvest Point's time zone (America/Chicago); the planned Launch Sunday is Oct 10.

const TODAY = frozenClock(instant.parse("2026-10-12T17:00:00.000Z"));
let f, reader, writer, phases;
const rows = async (q) => (await f.admin.execute(q)).rows;
const one = async (q) => (await rows(q))[0];
const plan = async (who) => ok(await reader.readPlan(f.db, who.actor)).plan;
const journal = async (who) => ok(await reader.readJournal(f.db, who.actor)).entries;
const key = () => randomUUID();
const record = (who, input, expectedRevision, requestKey = key()) =>
	writer.recordOutcome(f.db, who.actor, {
		requestKey,
		expectedRevision,
		input: { attendance: null, decisions: null, note: null, ...input },
	});
const correct = (who, input, expectedRevision, requestKey = key()) =>
	writer.correctOutcome(f.db, who.actor, { requestKey, expectedRevision, input });
const guest = (who, input, requestKey = key()) => writer.addGuestAttendance(f.db, who.actor, { requestKey, input });
const BLANK = {
	wentWell: null,
	toChange: null,
	operations: null,
	followUpPlan: null,
	supportNeeded: null,
	missingNames: null,
	missingCount: null,
};
/** Save (or submit) the debrief over the draft the plan `p` shows. */
const debrief = (who, p, answers, submit = false) =>
	writer[submit ? "submitDebrief" : "saveDebriefDraft"](f.db, who.actor, {
		requestKey: key(),
		expectedRevision: p.debrief.draft?.revision ?? "0",
		input: { draftId: p.debrief.draft?.id ?? null, answers: { ...BLANK, ...answers } },
	});
const summary = (who, p, body, publish = false) =>
	writer[publish ? "publishDebriefSummary" : "saveDebriefSummaryDraft"](f.db, who.actor, {
		requestKey: key(),
		expectedRevision: p.summary.draft?.revision ?? "0",
		input: { draftId: p.summary.draft?.id ?? null, body },
	});
const named = (p) => p.guests.named.map((g) => g.displayName);
/** Every row an outcome write can add, to prove a no-op or a refusal wrote nothing. */
const footprint = (w) =>
	one(sql`SELECT (SELECT count(*)::int FROM person WHERE tenant_id=${w.id}) people,
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

async function seated(w, role, name = "Synthetic person") {
	const a = await f.account();
	await f.admin.execute(
		sql`UPDATE auth_user SET name=${name} WHERE id=(SELECT auth_user_id FROM account WHERE id=${a.id})`,
	);
	await f.seat(a, w, role);
	return { ...a, actor: await f.actor(a.session) };
}
/** Harvest Point with its Owner, an Admin and a Member, planned Launch Sunday Oct 10, 2026. */
async function church({ planned = "2026-10-10" } = {}) {
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
/** A church whose Owner recorded Launch Sunday held on Oct 11 with attendance 40 and 6 decisions. */
async function launched(input = {}) {
	const c = await church();
	const p = await plan(c.owner);
	ok(await record(c.owner, { actualDate: "2026-10-11", attendance: 40, decisions: 6, ...input }, p.revision));
	return c;
}
async function person(w, name) {
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
	// Before anything is recorded, a passed planned date is overdue, never launched.
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
	assert.equal(p.launch.targetDate, "2026-10-10");
	assert.equal(p.launch.status, "completed");
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
	// Recording again is a correction, never a second record.
	refused(await record(c.owner, { actualDate: "2026-10-11" }, p.revision), "conflict");
});

test("AC:CASE-LCH-008 AC:LAUNCH46-012 no future date, counts 0 to 1,000,000, a note of 10,000; empty is not recorded and 0 is 0", async () => {
	const c = await church();
	let p = await plan(c.owner);
	// A completed milestone does not make the church launched either.
	const m = p.milestones[0];
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
	const problem = async (input) =>
		refused(await record(c.owner, { actualDate: "2026-10-11", ...input }, p.revision), "invalid_outcome").details
			.problem;
	assert.equal(await problem({ actualDate: "2026-10-13" }), "date_in_future");
	assert.equal(await problem({ attendance: 1_000_001 }), "count_out_of_range");
	assert.equal(await problem({ decisions: -1 }), "count_out_of_range");
	assert.equal(await problem({ note: "x".repeat(10_001) }), "note_too_long");
	refused(await record(c.owner, { actualDate: "2026-10-11", attendance: 2.5 }, p.revision), "invalid_input");
	assert.deepEqual(await footprint(c.w), before);

	// Today is allowed, and so are the bounds.
	const saved = ok(
		await record(
			c.owner,
			{ actualDate: "2026-10-12", attendance: 1_000_000, decisions: 0, note: "x".repeat(10_000) },
			p.revision,
		),
	).plan;
	assert.equal(saved.outcome.attendance, 1_000_000);
	const empty = ok(
		await correct(
			c.owner,
			{ actualDate: "2026-10-11", attendance: null, decisions: 0, note: null, reason: "Counted again" },
			saved.revision,
		),
	).plan;
	assert.equal(empty.outcome.attendance, null);
	assert.equal(empty.outcome.decisions, 0);
});

test("AC:LAUNCH46-003 AC:CASE-LCH-006 typing only Mara adds a new Person named Mara, linked as a Launch Sunday guest, with nothing made up", async () => {
	const c = await church();
	// Guests need a recorded Launch Sunday.
	refused(await guest(c.owner, { displayName: "Mara" }), "not_ready");
	ok(await record(c.owner, { actualDate: "2026-10-11", attendance: 40 }, (await plan(c.owner)).revision));
	const before = await footprint(c.w);
	const p = ok(await guest(c.owner, { displayName: "  Mara " })).plan;
	assert.deepEqual(named(p), ["Mara"]);
	assert.equal(p.guests.count, 1);
	const mara = await one(sql`SELECT p.display_name,p.first_name,p.last_name,p.email,p.phone,p.linked_account_id,p.state,
		p.stage,p.source,(SELECT count(*)::int FROM launch_guest g WHERE g.person_id=p.id) links
		FROM person p WHERE p.id=${p.guests.named[0].personId}`);
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
		links: 1,
	});
	const after = await footprint(c.w);
	assert.equal(after.people, before.people + 1);
	assert.equal(after.guests, before.guests + 1);
	// People's own history has the new Person, created by the Owner.
	const created = await one(sql`SELECT actor_id,kind FROM audit_event WHERE action='people.created'
		AND subject_id=${p.guests.named[0].personId}`);
	assert.deepEqual(created, { actor_id: c.owner.id, kind: "create" });
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
	// The same request replays its answer; picking him again changes nothing.
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
	// A Person of another church is never linked.
	const other = await f.workspace("plant");
	refused(await guest(c.owner, { personId: await person(other, "Alex Kim") }), "access_denied");
	assert.equal(await count(), 1);
});

test("AC:LAUNCH46-005 attendance 100 with 20 named guests shows both, and no placeholder People exist for the other 80", async () => {
	const c = await launched({ attendance: 100 });
	const before = await footprint(c.w);
	for (let i = 1; i <= 20; i++) ok(await guest(c.owner, { displayName: `Guest ${i}` }));
	const p = await plan(c.owner);
	assert.equal(p.outcome.attendance, 100);
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
	assert.equal(p.debrief.draft.answers.wentWell, "Worship");
	assert.equal(p.debrief.draft.answers.toChange, "Parking");
	assert.equal(p.debrief.draft.submittedAt, null);
	assert.equal(p.debrief.submitted, null);
	// Leaving and coming back reads the same draft; a second tab's save over an older draft is refused.
	p = await plan(c.owner);
	assert.equal(p.debrief.draft.answers.toChange, "Parking");
	assert.deepEqual(p.evidence.guestNamesEntered.status, "unknown");
	assert.deepEqual(p.evidence.debriefDone.status, "unknown");
	const stale = { ...p, debrief: { ...p.debrief, draft: null } };
	refused(await debrief(c.owner, stale, { wentWell: "Other tab" }), "conflict");
	assert.equal(ok(await debrief(c.owner, p, { wentWell: "Worship", toChange: "Parking" })).outcome, "noop");

	// Submitting needs the guest answer, and Yes needs how many; nothing else has a minimum.
	const problem = async (answers) =>
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
	assert.equal(done.debrief.draft, null);
	assert.equal(done.debrief.submitted.version, 1);
	assert.deepEqual(done.debrief.submitted.submittedBy, { accountId: c.owner.id, displayName: "Olivia Owner" });
	assert.ok(done.debrief.submitted.submittedAt);
	assert.equal(
		GUEST_QUESTION,
		"Was there anyone that visited as a guest and has not been entered by name into our People CRM?",
	);
	// The first area is the recorded Launch Sunday itself, not a copy.
	assert.equal(done.outcome.attendance, 40);
	assert.equal("attendance" in done.debrief.submitted.answers, false);
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

	// Correcting the submitted answer to No is the next version; the first stays.
	p = ok(await debrief(c.owner, p, { missingNames: "no" }, true)).plan;
	assert.deepEqual(p.evidence.guestNamesEntered, { status: "met", remaining: null });
	assert.equal(p.debrief.submitted.version, 2);
	assert.deepEqual(
		await rows(
			sql`SELECT version,missing_names,missing_count FROM launch_debrief WHERE plant_id=${c.w.id} ORDER BY version`,
		),
		[
			{ version: 1, missing_names: "yes", missing_count: 3 },
			{ version: 2, missing_names: "no", missing_count: null },
		],
	);
	// A later unfinished draft that says Yes, and one that answers nothing, never replace the submitted No.
	p = ok(await debrief(c.owner, p, { missingNames: "yes" })).plan;
	assert.deepEqual(p.evidence.guestNamesEntered, { status: "met", remaining: null });
	p = ok(await debrief(c.owner, p, { wentWell: "Half done" })).plan;
	assert.deepEqual(p.evidence.guestNamesEntered, { status: "met", remaining: null });
	assert.deepEqual(p.evidence.debriefDone, { status: "met" });
	// Submitting the same answers again over no draft adds nothing.
	const n = (await footprint(c.w)).audits;
	const clean = { ...p, debrief: { ...p.debrief, draft: null } };
	await f.admin.execute(sql`DELETE FROM launch_debrief WHERE plant_id=${c.w.id} AND submitted_at IS NULL`);
	assert.equal(ok(await debrief(c.owner, clean, { missingNames: "no" }, true)).outcome, "noop");
	assert.equal((await footprint(c.w)).audits, n);
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
	assert.equal(fixed.outcome.attendance, 50);
	// The first recording keeps its time and person.
	assert.equal(fixed.outcome.recordedAt, p.outcome.recordedAt);
	const again = ok(await correct(c.owner, input, fixed.revision));
	assert.equal(again.outcome, "noop");
	refused(await correct(c.owner, { ...input, attendance: 60 }, p.revision), "conflict");
	const after = await footprint(c.w);
	assert.equal(after.audits, before.audits + 1);
	assert.deepEqual([after.phase, after.tasks], [before.phase, before.tasks]);
	const [entry] = (await journal(c.owner)).filter((e) => e.change.kind === "outcome");
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
	let m = p.milestones[0];
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
	// Each entry keeps its original time, newest first.
	assert.deepEqual(
		entries.map((e) => e.at),
		entries
			.map((e) => e.at)
			.toSorted()
			.toReversed(),
	);

	// The Admin who moved the date deletes their account: the purge clears the actor and keeps an opaque token.
	await f.admin
		.execute(sql`UPDATE audit_event SET actor_token=coalesce(actor_token,encode(sha256(convert_to(tenant_id::text||'/'||actor_id::text,'UTF8')),'hex')),
		actor_id=NULL WHERE actor_id=${c.admin.id}`);
	const moved = (await journal(c.owner)).find((e) => e.change.kind === "date" && e.change.event === "moved");
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

	// The outcome and its correction join the same history.
	const now = await plan(c.owner);
	ok(await record(c.owner, { actualDate: "2026-10-11", attendance: 40 }, now.revision));
	const kinds = (await journal(c.owner)).slice(0, 1).map((e) => [e.change.kind, e.change.event]);
	assert.deepEqual(kinds, [["outcome", "recorded"]]);
	// A Member does not read Launch history.
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
	// Submitting the debrief published nothing.
	assert.deepEqual(p.summary, { draft: null, published: [] });
	const before = await footprint(c.w);

	p = ok(await summary(c.owner, p, "Service held.")).plan;
	assert.equal(p.summary.draft.body, "Service held.");
	assert.deepEqual(p.summary.published, []);
	refused(await summary(c.owner, p, " ", true), "invalid_summary");
	refused(await summary(c.owner, p, "x".repeat(4001), true), "invalid_summary");
	p = ok(await summary(c.owner, p, "Service held. Next review is Tuesday.", true)).plan;
	assert.equal(p.summary.draft, null);
	assert.deepEqual(
		p.summary.published.map((s) => [s.version, s.body, s.publishedBy.displayName]),
		[[1, "Service held. Next review is Tuesday.", "Olivia Owner"]],
	);
	assert.ok(p.summary.published[0].publishedAt);
	// Publishing the same text again adds nothing; an edit is the next version and the first stays.
	assert.equal(ok(await summary(c.owner, p, "Service held. Next review is Tuesday.", true)).outcome, "noop");
	p = ok(await summary(c.owner, p, "Service held. Team review Tuesday.", true)).plan;
	assert.deepEqual(
		p.summary.published.map((s) => [s.version, s.body]),
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
	// History names the version, never the text.
	const published = (await journal(c.owner)).filter((e) => e.change.kind === "summary");
	assert.deepEqual(
		published.map((e) => e.change.version),
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
	const orgActor = async (w) => {
		const a = await f.account();
		await f.seat(a, w, "owner");
		return f.actor(a.session);
	};
	const [n, s, x] = [await orgActor(network), await orgActor(sender), await orgActor(stranger)];
	const link = async (org, findings, meetings) =>
		(
			await one(sql`INSERT INTO affiliation(plant_id,organization_id,accepted_at,share_people,share_meetings,share_tasks,
			share_ministry_teams,share_wiki,share_activity,shared_findings)
			VALUES(${c.w.id},${org.id},clock_timestamp(),false,${meetings},false,false,false,false,${findings}) RETURNING id`)
		).id;
	const nLink = await link(network, true, true);
	await link(sender, true, false);
	const read = (who) => reader.readPublishedSummary(f.db, who, c.w.id);
	// Nothing is published yet: a draft is never readable.
	p = ok(await summary(c.owner, p, "Draft words")).plan;
	assert.equal(await read(n), null);
	p = ok(await summary(c.owner, p, "Service held.", true)).plan;
	// Readable at once, with no assessment release.
	const shared = await read(n);
	assert.deepEqual(
		{ ...shared, publishedAt: undefined },
		{ version: 1, body: "Service held.", publishedAt: undefined },
	);
	assert.equal(JSON.stringify(shared).includes("Private support"), false);
	// Meetings is not shared with the sending church, and the stranger has no link.
	assert.equal(await read(s), null);
	assert.equal(await read(x), null);
	// The plant itself is not an organization reader.
	assert.equal(await read(c.owner.actor), null);
	// Ending the network's link denies it and leaves a second valid link readable.
	const second = await f.workspace("sending_network");
	const n2 = await orgActor(second);
	await link(second, true, true);
	await f.admin.execute(sql`UPDATE affiliation SET ended_at=clock_timestamp() WHERE id=${nLink}`);
	assert.equal(await read(n), null);
	assert.equal((await read(n2)).body, "Service held.");
	// Turning findings off denies it too.
	await f.admin.execute(sql`UPDATE affiliation SET shared_findings=false WHERE organization_id=${second.id}`);
	assert.equal(await read(n2), null);
});

test("AC:LAUNCH46-020 a Member sees the outcome and guest count, and every Launch outcome write is refused with nothing written", async () => {
	const c = await launched();
	ok(await guest(c.owner, { displayName: "Mara" }));
	let p = ok(await debrief(c.owner, await plan(c.owner), { missingNames: "yes", missingCount: 2 }, true)).plan;
	p = ok(await summary(c.owner, p, "Service held.", true)).plan;
	const seen = await plan(c.member);
	assert.equal(seen.outcome.attendance, 40);
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
	const read = (body) => f.db.transaction((t) => body(t, new PeopleReadContext(c.owner.actor)));
	const write = (body) => withPeopleWrite(f.db, c.owner.actor, body);
	const merge = async (sourceId, survivorId) => {
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

	// Both are guests: Alex-2 merges into Alex-1, the roster names Alex-1 once and Alex-2's link stays as history.
	const merged = await merge(alex2, alex1);
	const p = await plan(c.owner);
	assert.deepEqual(named(p), ["Alex Kim"]);
	assert.equal(p.outcome.attendance, 40);
	assert.deepEqual(p.evidence.guestNamesEntered, { status: "not_met", remaining: 3 });
	assert.deepEqual(await links(), [alex1, alex2]);
	// A guest who merges into someone who was not a guest moves their link to the survivor.
	const mergedJo = await merge(alex1, jo);
	assert.deepEqual(named(await plan(c.owner)), ["Jo Park"]);
	assert.deepEqual(await links(), [jo, alex2]);
	// Unmerge moves it back.
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

test("AC:PERSONREF-LAUNCH-NAMED-GUEST-RETIRE a retired guest leaves the roster and keeps the link as history", async () => {
	const c = await launched();
	const mara = ok(await guest(c.owner, { displayName: "Mara" })).plan.guests.named[0].personId;
	const read = (body) => f.db.transaction((t) => body(t, new PeopleReadContext(c.owner.actor)));
	const { reviewRevision } = ok(await read((t, ctx) => peopleReader.getStatusWarnings(t, ctx, { personId: mara })));
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
	refused(await guest(c.owner, { personId: mara }), "access_denied");
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
	// A correction of the outcome is not a second journey entry.
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
		h.entries.slice(-3).map((e) => [e.kind, e.toPhase ?? e.actualDate]),
		[
			["initial_declaration", 3],
			["movement", 4],
			["launch_sunday", "2026-10-11"],
		],
	);
	assert.equal(h.state.phase, 4);
	assert.deepEqual(h.entries.at(-1).actor, { accountId: c.owner.id, displayName: "Olivia Owner" });
});
