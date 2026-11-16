import test, { after, before } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { sql } from "../../../packages/db/src/query.ts";
import { fixture } from "../identity/invitations-support.mts";
import { ok } from "../../support/fixture.mts";
import { frozenClock, instant } from "../../../packages/contracts/src/common/index.ts";
import { createFacts } from "../../../packages/domain/src/intelligence/index.ts";
import { createLaunchReader, createLaunchWriter } from "../../../packages/domain/src/launch/index.ts";
import { readCatalog, readReadiness } from "../../../packages/domain/src/phases/index.ts";

const TODAY = frozenClock(instant.parse("2026-10-12T17:00:00.000Z"));
const CONSTITUTED = "Constituted as a church";
let f, reader, writer, facts, catalog;
const one = async (q) => (await f.admin.execute(q)).rows[0];
const key = () => randomUUID();
const revision = async (who) => ok(await reader.readPlan(f.db, who.actor)).plan.revision;
const read = async (who) => ok(await facts.readFacts(f.db, who.actor, {}));
const phase5 = async (who) =>
	Object.fromEntries(
		readReadiness(catalog, (await read(who)).criteria)
			.find((r) => r.phase === 5)!
			.criteria.map((x) => [x.key, x.status]),
	);
const choose = async (who, org) =>
	ok(
		await writer.choosePath(f.db, who.actor, {
			requestKey: key(),
			expectedRevision: await revision(who),
			input: { path: "milestone", organizationId: org.id },
		}),
	);
const record = async (who, date) =>
	ok(
		await writer.recordGathering(f.db, who.actor, {
			requestKey: key(),
			expectedRevision: await revision(who),
			input: { date, note: null },
		}),
	);
const correct = async (who, date) =>
	ok(
		await writer.correctGathering(f.db, who.actor, {
			requestKey: key(),
			expectedRevision: await revision(who),
			input: { date, note: null, reason: "The vote was the Sunday before" },
		}),
	);
const clear = async (who) =>
	ok(
		await writer.clearGathering(f.db, who.actor, {
			requestKey: key(),
			expectedRevision: await revision(who),
			input: { reason: "Recorded on the wrong church" },
		}),
	);
const footprint = (w) =>
	one(sql`SELECT (SELECT count(*)::int FROM task WHERE plant_id=${w.id}) tasks,
		(SELECT count(*)::int FROM meeting WHERE plant_id=${w.id}) meetings,
		(SELECT count(*)::int FROM person WHERE tenant_id=${w.id}) people,
		(SELECT count(*)::int FROM contact_outcome WHERE plant_id=${w.id}) contacts,
		(SELECT count(*)::int FROM mail WHERE tenant_id=${w.id}) mail,
		(SELECT count(*)::int FROM notice WHERE tenant_id=${w.id}) notices,
		(SELECT count(*)::int FROM audit_event WHERE tenant_id=${w.id}) audits,
		(SELECT count(*)::int FROM phase_transition WHERE plant_id=${w.id}) moves,
		(SELECT phase FROM plant WHERE id=${w.id}) phase,
		(SELECT revision::text FROM launch WHERE plant_id=${w.id}) launch`);

async function seated(w, role) {
	const a = await f.account();
	await f.seat(a, w, role);
	return { ...a, actor: await f.actor(a.session) };
}
async function church() {
	const w = await f.workspace("plant");
	await f.admin.execute(sql`UPDATE plant SET name='Harvest Point',timezone='America/Chicago',phase=5 WHERE id=${w.id}`);
	const hill = await f.workspace("sending_network");
	await f.admin.execute(sql`UPDATE organization SET name='Hill Country Network',gathering_milestone_offered=true,
		gathering_milestone_name=${CONSTITUTED} WHERE id=${hill.id}`);
	await f.admin.execute(sql`INSERT INTO affiliation(plant_id,organization_id,accepted_at,share_people,share_meetings,
		share_tasks,share_ministry_teams,share_wiki,share_activity,shared_findings)
		VALUES(${w.id},${hill.id},clock_timestamp()-interval '1 day',false,false,false,false,false,false,false)`);
	return { w, hill, owner: await seated(w, "owner") };
}

before(async () => {
	f = await fixture();
	reader = createLaunchReader(TODAY);
	writer = createLaunchWriter({ notices: async () => {}, clock: TODAY });
	facts = createFacts({ clock: TODAY });
	catalog = await readCatalog();
});
after(() => f?.close());

test("a milestone recorded reached is First service held; correcting, clearing and recording each give a new source revision", async () => {
	const c = await church();
	await choose(c.owner, c.hill);
	const chosen = await read(c.owner);
	assert.equal(chosen.criteria.first_service_complete, "unknown");
	assert.deepEqual(chosen.firstService, { path: "milestone", status: "unknown", milestone: null, heldOn: null });
	assert.deepEqual(await phase5(c.owner), {
		first_service_complete: "unknown",
		guest_data_entered: "unknown",
		debrief_done: "unknown",
	});

	await record(c.owner, "2026-10-11");
	const reached = await read(c.owner);
	assert.deepEqual(reached.firstService, {
		path: "milestone",
		status: "met",
		milestone: CONSTITUTED,
		heldOn: "2026-10-11",
	});
	assert.deepEqual(await phase5(c.owner), {
		first_service_complete: "met",
		guest_data_entered: "unknown",
		debrief_done: "unknown",
	});
	assert.notEqual(reached.sourceRevision, chosen.sourceRevision);

	await correct(c.owner, "2026-10-04");
	const corrected = await read(c.owner);
	assert.deepEqual(corrected.firstService, {
		path: "milestone",
		status: "met",
		milestone: CONSTITUTED,
		heldOn: "2026-10-04",
	});
	assert.notEqual(corrected.sourceRevision, reached.sourceRevision);

	await clear(c.owner);
	const cleared = await read(c.owner);
	assert.equal(cleared.criteria.first_service_complete, "unknown");
	assert.deepEqual(cleared.firstService, { path: "milestone", status: "unknown", milestone: null, heldOn: null });
	assert.notEqual(cleared.sourceRevision, corrected.sourceRevision);
});

test("after a rename, the offering turned off or the affiliation ended, a reached milestone still counts under the name it was reached under", async () => {
	const c = await church();
	await choose(c.owner, c.hill);
	await record(c.owner, "2026-10-11");
	const expected = { path: "milestone", status: "met", milestone: CONSTITUTED, heldOn: "2026-10-11" };
	await f.admin.execute(
		sql`UPDATE organization SET gathering_milestone_name='Church constituted' WHERE id=${c.hill.id}`,
	);
	assert.deepEqual((await read(c.owner)).firstService, expected, "renamed");
	await f.admin.execute(sql`UPDATE organization SET gathering_milestone_offered=false WHERE id=${c.hill.id}`);
	assert.deepEqual((await read(c.owner)).firstService, expected, "turned off");
	await f.admin.execute(sql`UPDATE affiliation SET ended_at=clock_timestamp() WHERE plant_id=${c.w.id}`);
	const ended = await read(c.owner);
	assert.deepEqual(ended.firstService, expected, "affiliation ended");
	assert.equal(ended.criteria.first_service_complete, "met");
});

test("facts read for a day before the reached date read Unknown", async () => {
	const c = await church();
	await choose(c.owner, c.hill);
	await record(c.owner, "2026-10-11");
	const at = async (iso) =>
		ok(await createFacts({ clock: frozenClock(instant.parse(iso)) }).readFacts(f.db, c.owner.actor, {}));
	const before = await at("2026-10-10T23:00:00.000Z");
	assert.deepEqual([before.today, before.criteria.first_service_complete], ["2026-10-10", "unknown"]);
	const on = await at("2026-10-11T06:00:00.000Z");
	assert.deepEqual([on.today, on.criteria.first_service_complete], ["2026-10-11", "met"]);
});

test("a Launch Sunday church counts an actual Launch Sunday only; planned, scheduled and postponed read Unknown", async () => {
	const c = await church();
	const status = async () => (await read(c.owner)).criteria.first_service_complete;
	assert.equal(await status(), "unknown", "no launch yet");
	ok(
		await writer.schedule(f.db, c.owner.actor, {
			requestKey: key(),
			expectedRevision: "1",
			input: { date: "2026-10-25", reason: null },
		}),
	);
	const scheduled = await read(c.owner);
	assert.deepEqual(
		[scheduled.criteria.first_service_complete, scheduled.criteria.launch_date_set, scheduled.criteria.launch_window],
		["unknown", "met", "met"],
	);
	await f.admin.execute(sql`UPDATE launch SET status='postponed',target_date=NULL WHERE plant_id=${c.w.id}`);
	assert.equal(await status(), "unknown", "postponed");
	await f.admin.execute(sql`UPDATE launch SET status='planning' WHERE plant_id=${c.w.id}`);
	assert.equal(await status(), "unknown", "planning");
	await f.admin.execute(sql`UPDATE launch SET status='scheduled',target_date='2026-10-10' WHERE plant_id=${c.w.id}`);
	ok(
		await writer.recordOutcome(f.db, c.owner.actor, {
			requestKey: key(),
			expectedRevision: await revision(c.owner),
			input: { actualDate: "2026-10-11", attendance: 40, decisions: null, note: null },
		}),
	);
	const held = await read(c.owner);
	assert.deepEqual(held.firstService, { path: "launch_sunday", status: "met", heldOn: "2026-10-11" });
	assert.equal(held.criteria.first_service_complete, "met");
});

test("one plant's milestone never counts for another, and reading readiness writes nothing and moves no phase", async () => {
	const reached = await church();
	const other = await church();
	await choose(reached.owner, reached.hill);
	await choose(other.owner, other.hill);
	await record(reached.owner, "2026-10-11");
	const was = { reached: await footprint(reached.w), other: await footprint(other.w) };
	assert.equal((await read(reached.owner)).criteria.first_service_complete, "met");
	assert.equal((await read(other.owner)).criteria.first_service_complete, "unknown");
	assert.equal((await phase5(other.owner)).first_service_complete, "unknown");
	assert.deepEqual({ reached: await footprint(reached.w), other: await footprint(other.w) }, was);
	assert.equal(was.reached.phase, 5);
	const alone = await f.workspace("plant");
	const owner = await seated(alone, "owner");
	assert.deepEqual((await read(owner)).firstService, { path: "launch_sunday", status: "unknown", heldOn: null });
});
