import test, { after, before } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { sql } from "../../../packages/db/src/query.ts";
import { fixture } from "../identity/invitations-support.mts";
import { ok, refused as refusal } from "../../support/fixture.mts";
import { frozenClock, instant } from "../../../packages/contracts/src/common/index.ts";
import { createLaunchReader, createLaunchWriter } from "../../../packages/domain/src/launch/index.ts";
import { createPhaseWriter, phaseReader } from "../../../packages/domain/src/phases/index.ts";

// T-296: a milestone a network or sending church offers ends the gathering phase instead of Launch Sunday. Every
// write runs through the writer the /launch actions call, every read through the reader the page calls. "Today" is
// Oct 12, 2026 in Harvest Point's time zone (America/Chicago). Hill Country Network offers "Constituted as a church";
// Grace Austin, Harvest Point's sending church, offers "First gathering multiplied".

const TODAY = frozenClock(instant.parse("2026-10-12T17:00:00.000Z"));
const CONSTITUTED = "Constituted as a church";
const MEANING = "The church adopts its constitution and elects its first leaders.";
let f, reader, writer, phases;
const rows = async (q) => (await f.admin.execute(q)).rows;
const one = async (q) => (await rows(q))[0];
const key = () => randomUUID();
/** A refusal with this code and, when given, these details. */
const refused = (result, code, details = undefined) => {
	const error = refusal(result, code);
	if (details !== undefined) assert.deepEqual(error.details, details);
	return error;
};
const plan = async (who) => ok(await reader.readPlan(f.db, who.actor)).plan;
const offers = async (who) => ok(await reader.readGatheringOffers(f.db, who.actor));
const journal = async (who) => ok(await reader.readJournal(f.db, who.actor)).entries;
const choose = async (who, input, expectedRevision = undefined) =>
	writer.choosePath(f.db, who.actor, {
		requestKey: key(),
		expectedRevision: expectedRevision ?? (await plan(who)).revision,
		input,
	});
const useMilestone = (who, org) => choose(who, { path: "milestone", organizationId: org.id });
const useSunday = (who) => choose(who, { path: "launch_sunday" });
const record = async (who, input, requestKey = key()) =>
	writer.recordGathering(f.db, who.actor, {
		requestKey,
		expectedRevision: (await plan(who)).revision,
		input: { note: null, ...input },
	});
const correct = async (who, input) =>
	writer.correctGathering(f.db, who.actor, {
		requestKey: key(),
		expectedRevision: (await plan(who)).revision,
		input: { note: null, ...input },
	});
const clear = async (who, reason) =>
	writer.clearGathering(f.db, who.actor, {
		requestKey: key(),
		expectedRevision: (await plan(who)).revision,
		input: { reason },
	});
/** Every row the milestone path could touch, to prove a switch or a record changed nothing else. */
const footprint = (w) =>
	one(sql`SELECT (SELECT count(*)::int FROM task WHERE plant_id=${w.id}) tasks,
		(SELECT coalesce(jsonb_agg(jsonb_build_object('id',id,'status',status,'revision',revision::text) ORDER BY id),'[]')
			FROM task WHERE plant_id=${w.id}) task_rows,
		(SELECT count(*)::int FROM launch_milestone WHERE plant_id=${w.id}) milestones,
		(SELECT count(*)::int FROM person WHERE tenant_id=${w.id}) people,
		(SELECT count(*)::int FROM meeting WHERE plant_id=${w.id}) meetings,
		(SELECT count(*)::int FROM mail WHERE tenant_id=${w.id}) mail,
		(SELECT count(*)::int FROM notice WHERE tenant_id=${w.id}) notices,
		(SELECT count(*)::int FROM job WHERE tenant_id=${w.id}) jobs,
		(SELECT count(*)::int FROM phase_transition WHERE plant_id=${w.id}) moves,
		(SELECT phase FROM plant WHERE id=${w.id}) phase,
		(SELECT jsonb_build_object('status',status,'target',target_date::text) FROM launch WHERE plant_id=${w.id}) launch`);
const audits = async (w) => (await one(sql`SELECT count(*)::int n FROM audit_event WHERE tenant_id=${w.id}`)).n;
const launchRow = (w) =>
	one(sql`SELECT gathering_path,gathering_organization_id::text AS org,gathering_reached_on::text AS reached_on,
		gathering_reached_name AS name,gathering_note AS note,revision::text FROM launch WHERE plant_id=${w.id}`);

async function seated(w, role, name = "Synthetic person") {
	const a = await f.account();
	await f.admin.execute(
		sql`UPDATE auth_user SET name=${name} WHERE id=(SELECT auth_user_id FROM account WHERE id=${a.id})`,
	);
	await f.seat(a, w, role);
	return { ...a, actor: await f.actor(a.session) };
}
async function organization(kind, name, milestone = null) {
	const o = await f.workspace(kind);
	await f.admin.execute(sql`UPDATE organization SET name=${name},
		gathering_milestone_offered=${milestone !== null},gathering_milestone_name=${milestone?.name ?? null},
		gathering_milestone_description=${milestone?.description ?? null} WHERE id=${o.id}`);
	return o;
}
const affiliate = (w, o) =>
	f.admin.execute(sql`INSERT INTO affiliation(plant_id,organization_id,accepted_at,share_people,share_meetings,
		share_tasks,share_ministry_teams,share_wiki,share_activity,shared_findings)
		VALUES(${w.id},${o.id},clock_timestamp()-interval '1 day',false,false,false,false,false,false,false)`);
/** Harvest Point, affiliated with Hill Country Network (and Grace Austin when `both`), with an Owner, Admin and Member. */
async function church({ planned = null, both = false } = {}) {
	const w = await f.workspace("plant");
	await f.admin.execute(sql`UPDATE plant SET name='Harvest Point', timezone='America/Chicago' WHERE id=${w.id}`);
	const hill = await organization("sending_network", "Hill Country Network", { name: CONSTITUTED, description: MEANING });
	const grace = await organization("sending_church", "Grace Austin", { name: "First gathering multiplied" });
	await affiliate(w, hill);
	if (both) await affiliate(w, grace);
	const owner = await seated(w, "owner", "Olivia Owner");
	const admin = await seated(w, "admin", "Adam Admin");
	const member = await seated(w, "member", "Mia Member");
	const hillOwner = await seated(hill, "owner", "Hank Network");
	if (planned)
		ok(
			await writer.schedule(f.db, owner.actor, {
				requestKey: key(),
				expectedRevision: "1",
				input: { date: planned, reason: null },
			}),
		);
	return { w, hill, grace, owner, admin, member, hillOwner };
}

before(async () => {
	f = await fixture();
	reader = createLaunchReader(TODAY);
	writer = createLaunchWriter({ notices: async () => {}, clock: TODAY });
	phases = createPhaseWriter({ notices: async () => {} });
});
after(() => f?.close());

test("a church whose network offers a milestone is offered it by name and organization; an unaffiliated church is offered nothing", async () => {
	const c = await church();
	assert.deepEqual(await offers(c.owner), [
		{ organizationId: c.hill.id, organizationName: "Hill Country Network", name: CONSTITUTED, description: MEANING },
	]);
	assert.deepEqual((await plan(c.owner)).path, { kind: "launch_sunday" });

	const alone = await f.workspace("plant");
	const loner = await seated(alone, "owner");
	assert.deepEqual(await offers(loner), []);
	assert.deepEqual((await plan(loner)).path, { kind: "launch_sunday" });
	// A milestone that is turned off, or offered by an organization the church is not affiliated with, is not offered.
	await f.admin.execute(sql`UPDATE organization SET gathering_milestone_offered=false WHERE id=${c.hill.id}`);
	assert.deepEqual(await offers(c.owner), []);
});

test("with two offers the Owner picks one; the plan shows it, who chose it and what it means, and history keeps the switch", async () => {
	const c = await church({ both: true });
	assert.deepEqual(
		(await offers(c.owner)).map((o) => [o.organizationName, o.name]),
		[
			["Grace Austin", "First gathering multiplied"],
			["Hill Country Network", CONSTITUTED],
		],
	);
	const changed = ok(await useMilestone(c.owner, c.hill));
	assert.equal(changed.outcome, "changed");
	const expected = {
		kind: "milestone",
		organizationId: c.hill.id,
		organizationName: "Hill Country Network",
		offered: { name: CONSTITUTED, description: MEANING },
		reached: null,
	};
	assert.deepEqual(changed.plan.path, expected);
	assert.deepEqual((await plan(c.owner)).path, expected, "it is still there on reload");
	assert.deepEqual((await plan(c.member)).path, expected, "a Member sees the path too");

	// The same choice again changes nothing and adds no history.
	const n = await audits(c.w);
	assert.equal(ok(await useMilestone(c.owner, c.hill)).outcome, "noop");
	assert.equal(await audits(c.w), n);

	const [entry] = await journal(c.owner);
	assert.deepEqual(entry.change, {
		kind: "path",
		to: "milestone",
		milestone: CONSTITUTED,
		organization: "Hill Country Network",
	});
	assert.deepEqual(entry.actor, { accountId: c.owner.id, displayName: "Olivia Owner" });
	assert.match(entry.at, /^\d{4}-\d\d-\d\dT/);

	// Switching to the other organization's milestone is one more switch.
	ok(await useMilestone(c.admin, c.grace));
	assert.equal((await plan(c.owner)).path.offered.name, "First gathering multiplied");
});

test("switching either way creates, deletes or changes no task or readiness milestone and moves no phase", async () => {
	// Before any launch date: no prep tasks, either way.
	const fresh = await church();
	const empty = await footprint(fresh.w);
	ok(await useMilestone(fresh.owner, fresh.hill));
	assert.deepEqual({ ...(await footprint(fresh.w)), launch: null }, { ...empty, launch: null });
	assert.equal((await footprint(fresh.w)).tasks, 0);
	assert.equal((await footprint(fresh.w)).milestones, 0);
	ok(await useSunday(fresh.owner));
	assert.equal((await footprint(fresh.w)).tasks, 0);

	// With Launch Sunday set for Oct 30: the 23 prep tasks and 9 milestones stay exactly as they were.
	const dated = await church({ planned: "2026-10-30" });
	const was = await footprint(dated.w);
	assert.equal(was.tasks, 23);
	assert.equal(was.milestones, 9);
	const sunday = await plan(dated.owner);
	ok(await useMilestone(dated.owner, dated.hill));
	assert.deepEqual(await footprint(dated.w), was);
	ok(await useSunday(dated.owner));
	assert.deepEqual(await footprint(dated.w), was);
	const back = await plan(dated.owner);
	assert.deepEqual(back.path, { kind: "launch_sunday" });
	assert.deepEqual([back.launch.status, back.launch.targetDate], [sunday.launch.status, sunday.launch.targetDate]);
	assert.deepEqual(back.milestones, sunday.milestones);
	assert.deepEqual(
		(await journal(dated.owner)).slice(0, 2).map((e) => e.change),
		[
			{ kind: "path", to: "launch_sunday", milestone: CONSTITUTED, organization: "Hill Country Network" },
			{ kind: "path", to: "milestone", milestone: CONSTITUTED, organization: "Hill Country Network" },
		],
	);
});

test("the Owner records the milestone reached on Oct 11 with a note; a later or invalid date or a long note saves nothing; the same values add nothing", async () => {
	const c = await church();
	ok(await useMilestone(c.owner, c.hill));
	const n = await audits(c.w);
	refused(await record(c.owner, { date: "2026-10-13" }), "invalid_gathering", { problem: "date_in_future" });
	refused(await record(c.owner, { date: "2026-02-30" }), "invalid_gathering", { problem: "invalid_date" });
	refused(await record(c.owner, { date: "Oct 11" }), "invalid_gathering", { problem: "invalid_date" });
	refused(await record(c.owner, { date: "2026-10-11", note: "a".repeat(2001) }), "invalid_gathering", {
		problem: "note_too_long",
	});
	assert.equal(await audits(c.w), n);
	assert.equal((await launchRow(c.w)).reached_on, null);

	const saved = ok(await record(c.owner, { date: "2026-10-11", note: "  Voted in by all 31 members.  " }));
	assert.deepEqual(saved.plan.path.reached, { name: CONSTITUTED, date: "2026-10-11", note: "Voted in by all 31 members." });
	// Today itself, in the church's time zone, is allowed: Oct 12 in Chicago while it is already Oct 12 in UTC too.
	const entries = (await journal(c.owner)).length;
	assert.equal(ok(await record(c.owner, { date: "2026-10-11", note: "Voted in by all 31 members." })).outcome, "noop");
	assert.equal((await journal(c.owner)).length, entries, "re-saving adds no Launch history entry");
	assert.deepEqual((await journal(c.owner))[0].change, {
		kind: "gathering",
		event: "recorded",
		name: CONSTITUTED,
		from: null,
		to: "2026-10-11",
		noteChanged: true,
		reason: null,
	});
	const max = await church();
	ok(await useMilestone(max.owner, max.hill));
	ok(await record(max.owner, { date: "2026-10-12", note: "a".repeat(2000) }));
	assert.equal((await launchRow(max.w)).note.length, 2000);
});

test("a correction needs a reason and keeps both dates; a reached milestone is cleared with a reason before going back to Launch Sunday", async () => {
	const c = await church();
	ok(await useMilestone(c.owner, c.hill));
	ok(await record(c.owner, { date: "2026-10-11" }));
	const n = await audits(c.w);
	refused(await correct(c.owner, { date: "2026-10-04", reason: "  " }), "invalid_reason", { problem: "empty" });
	assert.equal(await audits(c.w), n);

	const fixed = ok(await correct(c.owner, { date: "2026-10-04", reason: "The vote was the Sunday before" }));
	assert.deepEqual(fixed.plan.path.reached, { name: CONSTITUTED, date: "2026-10-04", note: null });
	let history = await journal(c.owner);
	assert.deepEqual(
		history.slice(0, 2).map((e) => e.change),
		[
			{
				kind: "gathering",
				event: "corrected",
				name: CONSTITUTED,
				from: "2026-10-11",
				to: "2026-10-04",
				noteChanged: false,
				reason: "The vote was the Sunday before",
			},
			{ kind: "gathering", event: "recorded", name: CONSTITUTED, from: null, to: "2026-10-11", noteChanged: false, reason: null },
		],
	);
	assert.deepEqual(history[0].actor, { accountId: c.owner.id, displayName: "Olivia Owner" });

	refused(await useSunday(c.owner), "gathering_reached");
	refused(await useMilestone(c.owner, c.grace), "gathering_reached");
	refused(await clear(c.owner, ""), "invalid_reason", { problem: "empty" });
	assert.equal((await launchRow(c.w)).reached_on, "2026-10-04");

	ok(await clear(c.owner, "Recorded on the wrong church"));
	assert.equal((await plan(c.owner)).path.reached, null);
	history = await journal(c.owner);
	assert.deepEqual(history[0].change, {
		kind: "gathering",
		event: "cleared",
		name: CONSTITUTED,
		from: "2026-10-04",
		to: null,
		noteChanged: false,
		reason: "Recorded on the wrong church",
	});
	ok(await useSunday(c.owner));
	assert.deepEqual((await plan(c.owner)).path, { kind: "launch_sunday" });
	assert.deepEqual(
		(await journal(c.owner)).map((e) => [e.change.kind, e.change.event ?? e.change.to]),
		[
			["path", "launch_sunday"],
			["gathering", "cleared"],
			["gathering", "corrected"],
			["gathering", "recorded"],
			["path", "milestone"],
		],
	);
});

test("recording, correcting and clearing move no phase and make nothing else; the journey shows the milestone reached as its own entry", async () => {
	const c = await church({ planned: "2026-10-30" });
	const journey = async () => ok(await phaseReader.readHistory(f.db, c.owner.actor));
	let h = await journey();
	ok(await phases.declare(f.db, c.owner.actor, { requestKey: key(), expectedRevision: h.state.revision, input: { phase: 3 } }));
	h = await journey();
	ok(
		await phases.transition(f.db, c.owner.actor, {
			requestKey: key(),
			expectedRevision: h.state.revision,
			input: { toPhase: 4, reason: "Gathering weekly" },
		}),
	);
	ok(await useMilestone(c.owner, c.hill));
	const was = await footprint(c.w);
	ok(await record(c.owner, { date: "2026-10-11", note: "Constitution adopted" }));
	assert.deepEqual(await footprint(c.w), was);
	h = await journey();
	assert.equal(h.state.phase, 4);
	assert.deepEqual(
		h.entries.slice(-3).map((e) => [e.kind, e.toPhase ?? e.reachedOn]),
		[
			["initial_declaration", 3],
			["movement", 4],
			["gathering", "2026-10-11"],
		],
	);
	assert.equal(h.entries.at(-1).name, CONSTITUTED);
	assert.deepEqual(h.entries.at(-1).actor, { accountId: c.owner.id, displayName: "Olivia Owner" });

	const count = h.entries.length;
	ok(await correct(c.owner, { date: "2026-10-04", note: "Constitution adopted", reason: "Earlier vote" }));
	assert.deepEqual(await footprint(c.w), was);
	h = await journey();
	assert.equal(h.entries.length, count, "a correction is not a second journey entry");
	assert.equal(h.entries.at(-1).reachedOn, "2026-10-04");
	ok(await clear(c.owner, "Not yet constituted"));
	assert.deepEqual(await footprint(c.w), was);
	assert.equal((await journey()).entries.filter((e) => e.kind === "gathering").length, 0);
});

test("a rename keeps the reached name; a milestone turned off or an ended affiliation reads as no longer offered", async () => {
	const c = await church();
	ok(await useMilestone(c.owner, c.hill));
	ok(await record(c.owner, { date: "2026-10-11" }));
	await f.admin.execute(sql`UPDATE organization SET gathering_milestone_name='Church constituted' WHERE id=${c.hill.id}`);
	let p = await plan(c.owner);
	assert.equal(p.path.reached.name, CONSTITUTED, "reached under its old name");
	assert.equal(p.path.offered.name, "Church constituted");
	// Turned off after it was reached: the record and its history stay.
	await f.admin.execute(sql`UPDATE organization SET gathering_milestone_offered=false WHERE id=${c.hill.id}`);
	p = await plan(c.owner);
	assert.equal(p.path.offered, null);
	assert.deepEqual(p.path.reached, { name: CONSTITUTED, date: "2026-10-11", note: null });
	assert.equal((await journal(c.owner))[0].change.event, "recorded");

	// Turned off before it was reached: no longer offered; it can't be recorded, and Launch Sunday is one switch away.
	const off = await church();
	ok(await useMilestone(off.owner, off.hill));
	await f.admin.execute(sql`UPDATE organization SET gathering_milestone_offered=false WHERE id=${off.hill.id}`);
	p = await plan(off.owner);
	assert.deepEqual([p.path.kind, p.path.organizationName, p.path.offered], ["milestone", "Hill Country Network", null]);
	const n = await audits(off.w);
	refused(await record(off.owner, { date: "2026-10-11" }), "gathering_unavailable");
	assert.equal(await audits(off.w), n);
	ok(await useSunday(off.owner));
	assert.equal((await journal(off.owner))[0].change.milestone, CONSTITUTED);

	// The affiliation ends before it was reached.
	const ended = await church();
	ok(await useMilestone(ended.owner, ended.hill));
	await f.admin.execute(sql`UPDATE affiliation SET ended_at=clock_timestamp() WHERE plant_id=${ended.w.id}`);
	p = await plan(ended.owner);
	assert.deepEqual([p.path.organizationName, p.path.offered], ["Hill Country Network", null]);
	assert.deepEqual(await offers(ended.owner), []);
	ok(await useSunday(ended.owner));
	refused(await useMilestone(ended.owner, ended.hill), "gathering_unavailable");
});

test("a Member and an organization account see the path but every switch, record, correction and clear is refused with nothing written", async () => {
	const c = await church({ both: true });
	ok(await useMilestone(c.owner, c.hill));
	ok(await record(c.owner, { date: "2026-10-11", note: "Adopted" }));
	const shown = (await plan(c.member)).path;
	assert.deepEqual(shown.reached, { name: CONSTITUTED, date: "2026-10-11", note: "Adopted" });
	const before = { row: await launchRow(c.w), audits: await audits(c.w) };
	const revision = (await plan(c.owner)).revision;
	for (const who of [c.member, c.hillOwner]) {
		const q = (input) => ({ requestKey: key(), expectedRevision: revision, input });
		refused(await writer.choosePath(f.db, who.actor, q({ path: "launch_sunday" })), "access_denied");
		refused(
			await writer.choosePath(f.db, who.actor, q({ path: "milestone", organizationId: c.grace.id })),
			"access_denied",
		);
		refused(await writer.recordGathering(f.db, who.actor, q({ date: "2026-10-10", note: null })), "access_denied");
		refused(
			await writer.correctGathering(f.db, who.actor, q({ date: "2026-10-04", note: null, reason: "Earlier" })),
			"access_denied",
		);
		refused(await writer.clearGathering(f.db, who.actor, q({ reason: "Mistake" })), "access_denied");
		refused(await reader.readGatheringOffers(f.db, who.actor), "access_denied");
	}
	assert.deepEqual({ row: await launchRow(c.w), audits: await audits(c.w) }, before);
});

test("a retry with the same request key replays the first answer and writes once", async () => {
	const c = await church();
	ok(await useMilestone(c.owner, c.hill));
	const q = { requestKey: key(), expectedRevision: (await plan(c.owner)).revision, input: { date: "2026-10-11", note: null } };
	assert.equal(ok(await writer.recordGathering(f.db, c.owner.actor, q)).outcome, "changed");
	const n = await audits(c.w);
	assert.equal(ok(await writer.recordGathering(f.db, c.owner.actor, q)).outcome, "changed");
	assert.equal(await audits(c.w), n);
	refused(await writer.recordGathering(f.db, c.owner.actor, { ...q, input: { ...q.input, note: "Other" } }), "idempotency_conflict");
});
