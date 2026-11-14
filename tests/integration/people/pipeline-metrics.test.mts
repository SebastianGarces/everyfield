import test, { after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { sql } from "../../../packages/db/src/query.ts";
import { fixture, ok, refused, type Actor } from "../../support/fixture.mts";
import { RequestActor } from "../../../packages/domain/src/access/session.ts";
import { readPipelineMetrics } from "../../../packages/domain/src/people/index.ts";

// people.readPipelineMetrics (PPL-023), the internal count of recorded pipeline moves, against a migrated database.
// Harvest Point is in America/Chicago; every move is recorded at noon there on its date, as people.stage_changed rows.

const database = await fixture({ prefix: "pipeline_metrics", max: 4 });
const { admin } = database;
const db = database.pools.runtime;
after(() => database.close());

const authority = async (a: Actor) => {
	const r = await RequestActor.resolve(db, a.session as never);
	assert.ok(r instanceof RequestActor);
	return r;
};
const run = (q: ReturnType<typeof sql>) => admin.execute(q);
const AS_OF = "2026-10-13T16:00:00.000Z";
const transition = { from: "prospect", to: "attendee" };

async function person(plant: string, stage: string, state = "live") {
	const id = randomUUID();
	await run(sql`INSERT INTO person(id,tenant_id,plant_id,display_name,source,stage,adult_classification,commitment_state,
		pipeline_position,state,created_at,revision)
		VALUES(${id},${plant},${plant},'Someone','other',${stage},'unknown','unknown',random()*1000,${state},
		'2026-08-01T12:00:00Z',1)`);
	return id;
}
/** A recorded stage move on `day` (church-local noon), as the People writer stores it. */
async function move(plant: string, actor: string, id: string, from: string, to: string, day: string) {
	await run(sql`INSERT INTO audit_event(tenant_id,actor_id,action,kind,subject_type,subject_id,before_value,after_value,
		occurred_at) VALUES(${plant},${actor},'people.stage_changed','stage_change','person',${id},
		${JSON.stringify({ stage: from })}::jsonb,${JSON.stringify({ stage: to })}::jsonb,${day + "T17:00:00Z"})`);
}

test("AC:GAP-PPL-023 distinct People per adjacent forward step in an October window, with a rebuilt source cohort", async () => {
	const w = await database.plant({ name: "Harvest Point", timezone: "America/Chicago" });
	const a = await database.actor(w, "admin");
	const alex = await person(w.id, "prospect");
	const casey = await person(w.id, "attendee");
	const jamie = await person(w.id, "prospect");
	// Alex crosses twice with a move back between; Casey once; Jamie only in September.
	await move(w.id, a.id, alex, "prospect", "attendee", "2026-10-02");
	await move(w.id, a.id, alex, "attendee", "prospect", "2026-10-03");
	await move(w.id, a.id, alex, "prospect", "attendee", "2026-10-04");
	await move(w.id, a.id, alex, "attendee", "prospect", "2026-10-05");
	await move(w.id, a.id, casey, "prospect", "attendee", "2026-10-10");
	await move(w.id, a.id, jamie, "prospect", "attendee", "2026-09-20");
	await move(w.id, a.id, jamie, "attendee", "prospect", "2026-09-21");
	// A move after asOf is not part of the frozen answer.
	await move(w.id, a.id, jamie, "prospect", "attendee", "2026-10-20");

	const read = async (window: { from: string; through: string }) =>
		ok(await readPipelineMetrics(db, await authority(a), { asOf: AS_OF, ...window, transition }));
	assert.deepEqual(await read({ from: "2026-10-01", through: "2026-10-13" }), {
		asOf: AS_OF,
		sourceRevision: 7,
		window: { from: "2026-10-01", through: "2026-10-13", timeZone: "America/Chicago" },
		unit: "distinct_canonical_people",
		currentStageCounts: {
			prospect: 2,
			attendee: 1,
			following_up: 0,
			interviewed: 0,
			core_group: 0,
			launch_team: 0,
			leader: 0,
		},
		transition,
		distinctTransitionPeople: 2,
		denominator: 3,
		conversionRatio: { numerator: 2, denominator: 3 },
		conversionRatioStatus: "known",
		reason: null,
	});
	// Nobody was a prospect when July opened: Unknown, never a division by zero.
	const july = await read({ from: "2026-07-01", through: "2026-07-31" });
	assert.equal(july.distinctTransitionPeople, 0);
	assert.equal(july.denominator, 0);
	assert.equal(july.conversionRatio, null);
	assert.equal(july.conversionRatioStatus, "unknown");
	assert.equal(july.reason, "empty_cohort");
	// Only an exact adjacent forward step is a transition.
	refused(
		await readPipelineMetrics(db, await authority(a), {
			asOf: AS_OF,
			from: "2026-10-01",
			through: "2026-10-13",
			transition: { from: "prospect", to: "core_group" },
		}),
		"invalid_input",
	);
	// Another church's seat reads its own church only, and an organization seat reads nothing.
	const foreign = await database.actor(await database.plant({ timezone: "America/New_York" }), "member");
	const theirs = ok(
		await readPipelineMetrics(db, await authority(foreign), {
			asOf: AS_OF,
			from: "2026-10-01",
			through: "2026-10-13",
			transition,
		}),
	);
	assert.equal(theirs.distinctTransitionPeople, 0);
	assert.equal(theirs.sourceRevision, 0);
	const org = await database.actor(await database.organization("sending_network"), "owner");
	refused(
		await readPipelineMetrics(db, await authority(org), {
			asOf: AS_OF,
			from: "2026-10-01",
			through: "2026-10-13",
			transition,
		}),
		"access_denied",
	);
});

test("AC:TARGET-PPL-023 a merged record's moves count for its survivor once, and a folded history leaves the rate Unknown", async () => {
	const w = await database.plant({ name: "Harvest Point", timezone: "America/Chicago" });
	const a = await database.actor(w, "owner");
	const p1 = await person(w.id, "attendee");
	const p2 = await person(w.id, "attendee");
	const p3 = await person(w.id, "attendee", "merged");
	const r = await person(w.id, "attendee");
	const retired = await person(w.id, "attendee", "retired");
	await move(w.id, a.id, p1, "prospect", "attendee", "2026-09-03");
	await move(w.id, a.id, p1, "attendee", "prospect", "2026-09-04");
	await move(w.id, a.id, p1, "prospect", "attendee", "2026-09-05");
	await move(w.id, a.id, p2, "prospect", "attendee", "2026-09-12");
	await move(w.id, a.id, p3, "prospect", "attendee", "2026-09-20");
	await move(w.id, a.id, r, "prospect", "attendee", "2026-08-15");
	await move(w.id, a.id, retired, "prospect", "attendee", "2026-09-15");
	// P3 was merged into P1.
	await run(sql`INSERT INTO person_merge(id,tenant_id,source_id,survivor_id,prior,moved,source_revision,survivor_revision,
		references_digest) VALUES(${randomUUID()},${w.id},${p3},${p1},'{}'::jsonb,'{}'::jsonb,1,1,'x')`);

	const september = ok(
		await readPipelineMetrics(db, await authority(a), {
			asOf: AS_OF,
			from: "2026-09-01",
			through: "2026-09-30",
			transition,
		}),
	);
	assert.equal(september.distinctTransitionPeople, 2);
	assert.equal(september.denominator, null);
	assert.equal(september.conversionRatio, null);
	assert.equal(september.conversionRatioStatus, "unknown");
	assert.equal(september.reason, "cohort_unavailable");
	// Live canonical People only: P3 is P1 now, and the retired Person is not counted.
	assert.equal(september.currentStageCounts.attendee, 3);
});
