import test, { after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { sql } from "../../../packages/db/src/query.ts";
import { fixture, ok, refused, type Actor } from "../../support/fixture.mts";
import { RequestActor } from "../../../packages/domain/src/access/session.ts";
import { peopleMerge, peopleWriter, readPipelineMetrics } from "../../../packages/domain/src/people/index.ts";
import { gatedTransaction } from "../../../packages/domain/src/operations/writes.ts";
import { READ_DOMAINS } from "../../../packages/evry/src/catalog/catalog.ts";
import { REVIEWED_WRITES } from "../../../packages/evry/src/proposals/store.ts";
import { untouched } from "../../support/recorded.mts";
import { church, noReminders, reads } from "./people-support.mts";

const database = await fixture({ prefix: "pipeline_metrics", max: 4 });
const { admin } = database;
const db = database.pools.runtime;
after(() => database.close());

const authority = async (a: Actor) => {
	const r = await RequestActor.resolve(db, a.session);
	assert.ok(r instanceof RequestActor);
	return r;
};
const run = (q: ReturnType<typeof sql>) => admin.execute(q);
const AS_OF = "2026-10-13T16:00:00.000Z";
const transition = { from: "prospect", to: "attendee" };
const unchanged = <T,>(body: () => Promise<T>) => untouched(admin, body);

async function person(plant: string, stage: string, state = "live") {
	const id = randomUUID();
	await run(sql`INSERT INTO person(id,tenant_id,plant_id,display_name,source,stage,adult_classification,commitment_state,
		pipeline_position,state,created_at,revision)
		VALUES(${id},${plant},${plant},'Someone','other',${stage},'unknown','unknown',random()*1000,${state},
		'2026-08-01T12:00:00Z',1)`);
	return id;
}
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
	const former = await person(w.id, "attendee", "retired");
	await move(w.id, a.id, former, "prospect", "attendee", "2026-08-03");
	await move(w.id, a.id, former, "attendee", "prospect", "2026-08-04");
	await move(w.id, a.id, former, "prospect", "attendee", "2026-10-06");
	await move(w.id, a.id, former, "attendee", "following_up", "2026-10-07");
	await move(w.id, a.id, alex, "prospect", "attendee", "2026-10-02");
	await move(w.id, a.id, alex, "attendee", "prospect", "2026-10-03");
	await move(w.id, a.id, alex, "prospect", "attendee", "2026-10-04");
	await move(w.id, a.id, alex, "attendee", "prospect", "2026-10-05");
	await move(w.id, a.id, casey, "prospect", "attendee", "2026-10-10");
	await move(w.id, a.id, jamie, "prospect", "attendee", "2026-09-20");
	await move(w.id, a.id, jamie, "attendee", "prospect", "2026-09-21");
	await move(w.id, a.id, jamie, "prospect", "attendee", "2026-10-20");

	const read = async (window: { from: string; through: string }) =>
		ok(
			await unchanged(async () => readPipelineMetrics(db, await authority(a), { asOf: AS_OF, ...window, transition })),
		);
	assert.deepEqual(await read({ from: "2026-10-01", through: "2026-10-13" }), {
		asOf: AS_OF,
		sourceRevision: 11,
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
	const july = await read({ from: "2026-07-01", through: "2026-07-31" });
	assert.deepEqual(july, {
		asOf: AS_OF,
		sourceRevision: 11,
		window: { from: "2026-07-01", through: "2026-07-31", timeZone: "America/Chicago" },
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
		distinctTransitionPeople: 0,
		denominator: 0,
		conversionRatio: null,
		conversionRatioStatus: "unknown",
		reason: "empty_cohort",
	});
	refused(
		await readPipelineMetrics(db, await authority(a), {
			asOf: AS_OF,
			from: "2026-10-01",
			through: "2026-10-13",
			transition: { from: "prospect", to: "core_group" },
		}),
		"invalid_input",
	);
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
	const window = { asOf: AS_OF, from: "2026-10-01", through: "2026-10-13", transition };
	const claimed = RequestActor.of(foreign.session, (await authority(a)).actor);
	assert.deepEqual(await unchanged(() => readPipelineMetrics(db, claimed, window)), {
		status: "refused",
		error: { code: "access_denied" },
	});
	const named = (plant: string) =>
		unchanged(async () => readPipelineMetrics(db, await authority(foreign), { ...window, plant }));
	assert.deepEqual(await named(w.id), { status: "refused", error: { code: "invalid_input" } });
	assert.deepEqual(await named(randomUUID()), await named(w.id));
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

	const known = await read({ from: "2026-10-01", through: "2026-10-13" });
	const prior = await run(sql`SELECT * FROM audit_event ORDER BY id`);
	await run(sql`ALTER TABLE audit_event RENAME TO audit_event_away`);
	try {
		await assert.rejects(
			async () => readPipelineMetrics(db, await authority(a), window),
			(error) =>
				error instanceof Error &&
				error.cause instanceof Error &&
				/relation "audit_event" does not exist/.test(error.cause.message),
		);
	} finally {
		await run(sql`ALTER TABLE audit_event_away RENAME TO audit_event`);
	}
	assert.deepEqual((await run(sql`SELECT * FROM audit_event ORDER BY id`)).rows, prior.rows);
	assert.deepEqual(await read({ from: "2026-10-01", through: "2026-10-13" }), known);
});

test("AC:TARGET-PPL-023 a merged record's moves count for its survivor once, a missing history leaves the rate Unknown beside a rebuilt cohort, and another church learns nothing", async () => {
	const w = await database.plant({ name: "Harvest Point", timezone: "America/Chicago" });
	const a = await database.actor(w, "owner");
	const ctx = { session: a.session, selected: church(w.id) };
	const p1 = await person(w.id, "attendee");
	const p2 = await person(w.id, "attendee");
	const p3 = await person(w.id, "attendee");
	const r = await person(w.id, "prospect");
	const retired = await person(w.id, "attendee");
	const later = await person(w.id, "prospect");
	await run(sql`UPDATE person SET created_at='2026-10-20T12:00:00Z' WHERE id=${later}`);
	await move(w.id, a.id, p1, "prospect", "attendee", "2026-09-03");
	await move(w.id, a.id, p1, "attendee", "prospect", "2026-09-04");
	await move(w.id, a.id, p1, "prospect", "attendee", "2026-09-05");
	await move(w.id, a.id, p2, "prospect", "attendee", "2026-09-12");
	await move(w.id, a.id, p3, "prospect", "attendee", "2026-09-20");
	await move(w.id, a.id, r, "prospect", "attendee", "2026-08-15");
	await move(w.id, a.id, r, "attendee", "prospect", "2026-08-16");
	await move(w.id, a.id, retired, "prospect", "attendee", "2026-09-15");

	const september = async (who: Actor = a) =>
		unchanged(async () =>
			readPipelineMetrics(db, await authority(who), {
				asOf: AS_OF,
				from: "2026-09-01",
				through: "2026-09-30",
				transition,
			}),
		);
	const shown = (value: Awaited<ReturnType<typeof september>>) => {
		const m = ok(value);
		return [m.distinctTransitionPeople, m.denominator, m.conversionRatio, m.conversionRatioStatus, m.reason];
	};
	assert.deepEqual(shown(await september()), [4, 5, { numerator: 4, denominator: 5 }, "known", null]);

	const review = ok(
		await gatedTransaction(db, (t) => reads.getStatusWarnings(t, ctx, { personId: retired })),
	).reviewRevision;
	ok(
		await gatedTransaction(db, (t) =>
			peopleWriter.retirePerson(
				t,
				ctx,
				{
					requestKey: randomUUID(),
					expectedRevision: "1",
					input: { personId: retired, reason: "Moved away", reviewRevision: review, handoffs: [] },
				},
				noReminders,
			),
		),
	);
	assert.deepEqual(shown(await september()), [3, 4, { numerator: 3, denominator: 4 }, "known", null]);

	const merge = ok(
		await gatedTransaction(db, (t) => peopleMerge.getMergeReview(t, ctx, { sourceId: p3, survivorId: p1 })),
	);
	ok(
		await gatedTransaction(db, (t) =>
			peopleMerge.mergePeople(t, ctx, {
				requestKey: randomUUID(),
				input: { sourceId: p3, survivorId: p1, reviewDigest: merge.reviewDigest },
			}),
		),
	);
	const value = ok(await september());
	assert.deepEqual(value, {
		asOf: AS_OF,
		sourceRevision: 8,
		window: { from: "2026-09-01", through: "2026-09-30", timeZone: "America/Chicago" },
		unit: "distinct_canonical_people",
		currentStageCounts: {
			prospect: 1,
			attendee: 2,
			following_up: 0,
			interviewed: 0,
			core_group: 0,
			launch_team: 0,
			leader: 0,
		},
		transition,
		distinctTransitionPeople: 2,
		denominator: null,
		conversionRatio: null,
		conversionRatioStatus: "unknown",
		reason: "cohort_unavailable",
	});

	const q = await database.plant({ timezone: "America/New_York" });
	const foreign = await database.actor(q, "admin");
	const theirs = ok(await september(foreign));
	assert.deepEqual(
		[theirs.distinctTransitionPeople, theirs.sourceRevision, theirs.currentStageCounts.attendee, theirs.reason],
		[0, 0, 0, "empty_cohort"],
	);
	const claimed = RequestActor.of(foreign.session, (await authority(a)).actor);
	assert.deepEqual(
		await readPipelineMetrics(db, claimed, { asOf: AS_OF, from: "2026-09-01", through: "2026-09-30", transition }),
		{ status: "refused", error: { code: "access_denied" } },
	);

	const tools = [
		...Object.values(READ_DOMAINS).flatMap((list) => list.map((x): string => x.operation)),
		...Object.keys(REVIEWED_WRITES),
	];
	assert.ok(tools.includes("people.getPipelineData"));
	assert.deepEqual(
		tools.filter((x) => /metric|conversion|transition/i.test(x) && x.startsWith("people.")),
		[],
	);
});
