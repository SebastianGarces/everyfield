// Plant Intelligence assessments that stay current (WP-043): demand from durable state, the scheduled tick with the
// scripted drafter only, the fenced publication and the planter's read. "The planter opens Plant Intelligence and sees
// X" is intelligence.readAssessment called as that planter. Each test drives real native writes and the real tick
// (or the same job functions the tick calls), and moves a test clock instead of waiting.
import test, { after, before } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { sql } from "../../../packages/db/src/query.ts";
import { RequestActor } from "../../../packages/domain/src/access/session.ts";
import * as c from "../../../packages/contracts/src/intelligence/index.ts";
import {
	ASSESSMENT_TIMING,
	createAssessmentJob,
	createAssessments,
	createPrivateCare,
} from "../../../packages/domain/src/intelligence/index.ts";
import { commitments, peopleWriter } from "../../../packages/domain/src/people/index.ts";
import { readIntelligence, requestIntelligenceRefresh } from "../../../packages/domain/src/oversight/intelligence.ts";
import { scriptedAssessmentDrafter } from "../../../packages/evry/src/runtime/scripted-assessment.ts";
import { scheduledJobs } from "../../../apps/web/src/server/jobs/scheduled.ts";
import { ok } from "../../support/fixture.mts";
import { church, type Church } from "./assessment-church.mts";

const DAY = 86_400_000;
let c0: Church;
let clockMs = Date.now();
const clock = { now: () => new Date(clockMs).toISOString() as never };
const job = createAssessmentJob({ clock });
const assessments = createAssessments({ clock });
const secret = "cron-" + randomUUID();
const scripted = scriptedAssessmentDrafter;

before(async () => {
	c0 = await church("t299o");
	await c0.release("methodology-2026.10");
});
after(() => c0?.database.close());

/** The real scheduled runner at the test clock, with the scripted drafter. */
async function tick(drafter = scripted()) {
	const run = scheduledJobs({
		secret,
		db: c0.db,
		storage: null,
		cleanup: null,
		reminders: null,
		digests: null,
		mail: null,
		assessments: { drafter },
		now: () => new Date(clockMs),
	});
	const response = await run(
		new Request("http://localhost/api/cron/jobs", { headers: { authorization: `Bearer ${secret}` } }),
	);
	const body = await response.json();
	assert.equal(body.steps.assessment.status, "ok", JSON.stringify(body.steps));
	return body;
}
const view = async (p: { actor: RequestActor }) => ok(await assessments.readAssessment(c0.db, p.actor, {}));
const runs = (p: { id: string }) =>
	c0.rows(sql`SELECT id,outcome,reason,demand,demand_key,as_of,source_revision,reference_activation,result,facts,
		model_input,attempts,input_tokens,output_tokens,pending_attempts,drafts,retry_at,deadline_at,delta
		FROM assessment_run WHERE plant_id=${p.id} ORDER BY captured_at,id`);
const jobs = (p: { id: string }) =>
	c0.rows(sql`SELECT producer_key,state,error_code,next_attempt_at FROM job WHERE kind='assessment'
		AND subject_record_id=${p.id} ORDER BY eligible_at,id`);
const iso = (ms: number) => new Date(ms).toISOString();
/** A plant whose first assessment is published, and the clock back at real time. */
async function assessed(name: string, options = {}) {
	clockMs = Date.now();
	const p = await c0.harvest(name, options);
	await job.scheduleAssessments(c0.db);
	await job.runAssessmentBatch(c0.db, scripted(), 20);
	assert.equal((await view(p)).current?.asOf !== undefined, true, "first assessment published");
	return p;
}
const invalid = () => scripted({ script: (d) => ({ ...d, focus: { ...d.focus, citations: [] } }) });
/** Every other plant's demand runs too; these keep each test's assertions to its own plant. */
const drain = () => job.runAssessmentBatch(c0.db, scripted(), 50);

test("a never-assessed plant: the next tick queues its first assessment unasked; until it publishes the read says being prepared, then it shows the first assessment with its as-of", async () => {
	clockMs = Date.now();
	const p = await c0.harvest("First Light");
	assert.deepEqual(await view(p), { current: null, newest: null });
	let during: c.AssessmentView | null = null;
	const drafter = scripted({
		during: async () => {
			if (!during && (await runs(p)).some((r) => r.outcome === "pending")) during = await view(p);
		},
	});
	await tick(drafter);
	await drain();
	assert.deepEqual(during, { current: null, newest: { state: "preparing", retryAt: null, grounding: "grounded" } });
	const v = await view(p);
	assert.equal(v.newest, null);
	assert.equal(v.current!.asOf, iso(clockMs));
	assert.equal(v.current!.measuredOn, c0.today);
	assert.equal(v.current!.ageDays, 0);
	const [run] = await runs(p);
	assert.deepEqual([run.outcome, run.demand], ["published", "time"]);
	assert.equal((await c0.one(sql`SELECT count(*)::int AS n FROM notice WHERE tenant_id=${p.id}`)).n, 0, "no notice");
});

test("a new committed adult publishes a new assessment dated after the change; the earlier one is unchanged; a failed write, an exact retry, a no-op and an unrelated field queue no run", async () => {
	const p = await assessed("Cedar Hill");
	const [first] = await runs(p);
	const before = JSON.stringify(first);
	clockMs += 60_000;
	const who = await c0.committed(p, "Newest Adult", 1);
	await tick();
	await drain();
	const after = await runs(p);
	assert.equal(after.length, 2);
	assert.equal(JSON.stringify(after[0]), before, "the earlier run stays exactly as it was");
	assert.deepEqual([after[1].outcome, after[1].demand], ["published", "change"]);
	const v = await view(p);
	assert.equal(v.current!.runId, after[1].id);
	assert.ok(Date.parse(v.current!.asOf) > Date.parse(first.as_of));
	assert.equal(v.current!.delta!.previousRunId, first.id);
	assert.deepEqual(
		v.current!.delta!.changed.find((d) => d.key === "committedAdults.count"),
		{ key: "committedAdults.count", label: "Committed adults", before: 30, after: 31 },
	);

	// A failed write: a commitment for a person who does not exist is refused and writes nothing.
	const failed = await c0.db.transaction((t) =>
		commitments.createCommitment(
			t as never,
			p.ctx as never,
			{
				requestKey: randomUUID(),
				input: { personId: randomUUID(), kind: "core_group", occurredOn: c0.day(-1) },
			} as never,
		),
	);
	assert.equal(failed.status, "refused");
	// An exact retry of the write that already landed, and a real no-op and an unrelated field.
	const person = ok(
		await c0.db.transaction((t) =>
			peopleWriter.createPerson(
				t as never,
				p.ctx as never,
				{
					requestKey: "00000000-0000-4000-8000-000000000299",
					input: { displayName: "Retry Twice", adultClassification: "adult" },
				} as never,
			),
		),
	).person as { id: string; revision: string };
	await tick();
	await drain();
	const settled = (await runs(p)).length;
	ok(
		await c0.db.transaction((t) =>
			peopleWriter.createPerson(
				t as never,
				p.ctx as never,
				{
					requestKey: "00000000-0000-4000-8000-000000000299",
					input: { displayName: "Retry Twice", adultClassification: "adult" },
				} as never,
			),
		),
	);
	ok(
		await c0.db.transaction((t) =>
			peopleWriter.updatePerson(
				t as never,
				p.ctx as never,
				{
					requestKey: randomUUID(),
					expectedRevision: person.revision,
					input: { personId: person.id, patch: { city: "Waco" } },
				} as never,
			),
		),
	);
	await tick();
	await drain();
	assert.equal((await runs(p)).length, settled, "no new run for a retry, a no-op or an unrelated field");
	assert.ok(who.id);
});

test("an Owner's or Admin's fresh-assessment request reads being prepared and then the new assessment; a repeated id queues one run; a Member is refused and nothing is queued", async () => {
	const p = await assessed("Brook Street");
	const requestId = randomUUID();
	assert.deepEqual(ok(await assessments.requestRefresh(c0.db, p.actor, { requestId })), {
		requestId,
		state: "preparing",
	});
	ok(await assessments.requestRefresh(c0.db, p.actor, { requestId }));
	assert.deepEqual((await view(p)).newest, { state: "preparing", retryAt: null, grounding: null });
	await tick();
	await drain();
	const all = await runs(p);
	assert.deepEqual(
		all.map((r) => [r.demand, r.outcome]),
		[
			["time", "published"],
			["manual", "published"],
		],
	);
	assert.equal((await view(p)).current!.runId, all[1].id);
	const requester = await c0.one(sql`SELECT requested_by FROM assessment_run WHERE id=${all[1].id}`);
	assert.equal(requester.requested_by, p.owner.id);

	const admin = await c0.database.actor(p, "admin");
	const asAdmin = (await RequestActor.resolve(c0.db, admin.session as never)) as RequestActor;
	ok(await assessments.requestRefresh(c0.db, asAdmin, { requestId: randomUUID() }));
	await tick();
	await drain();
	assert.equal((await runs(p)).length, 3);

	const member = await c0.database.actor(p, "member");
	const asMember = (await RequestActor.resolve(c0.db, member.session as never)) as RequestActor;
	const before = (await jobs(p)).length;
	const refused = await assessments.requestRefresh(c0.db, asMember, { requestId: randomUUID() });
	assert.equal(refused.status === "refused" && refused.error.code, "access_denied");
	assert.equal((await jobs(p)).length, before);
});

test("AC:ASMT-001 after eight quiet days with skipped ticks the next tick publishes a new as-of, no more than seven days old, whose days-to-launch matches today", async () => {
	const p = await assessed("Quiet Creek");
	await c0.admin.execute(
		sql`INSERT INTO launch(plant_id,target_date,status) VALUES(${p.id},${c0.day(30)},'scheduled')`,
	);
	await tick();
	await drain();
	const start = (await runs(p)).length;
	clockMs += 3 * DAY;
	await tick();
	assert.equal((await runs(p)).length, start, "three quiet days owe nothing");
	// Days four to seven: no tick ran at all. Day eight's tick still owes the refresh.
	clockMs += 5 * DAY;
	await tick();
	await drain();
	const latest = (await runs(p)).at(-1)!;
	assert.deepEqual([latest.demand, latest.outcome], ["time", "published"]);
	const v = await view(p);
	assert.equal(v.current!.asOf, iso(clockMs));
	assert.ok(v.current!.ageDays <= 7);
	assert.equal(v.current!.measuredOn, c0.day(8));
	assert.equal(v.current!.daysToLaunch, 22);
	clockMs = Date.now();
});

test("AC:ASMT-005 a failed output check and a busy provider leave the previous assessment with its real as-of and age, plus the newest run's state and retry instant; a deferred run waits for it and never runs past its deadline", async () => {
	const p = await assessed("River Bend");
	const prior = (await view(p)).current!;
	clockMs += 2 * DAY;
	ok(await assessments.requestRefresh(c0.db, p.actor, { requestId: randomUUID() }));
	await job.runAssessmentBatch(c0.db, invalid(), 1);
	let v = await view(p);
	assert.deepEqual([v.current!.runId, v.current!.asOf, v.current!.ageDays], [prior.runId, prior.asOf, 2]);
	assert.deepEqual(v.newest, { state: "failed", retryAt: null, grounding: "grounded" });

	// 429 with Retry-After 90 s: deferred to exactly that instant.
	ok(await assessments.requestRefresh(c0.db, p.actor, { requestId: randomUUID() }));
	const busy = scripted({ busy: [{ status: 429, retryAfterSeconds: 90 }] });
	await job.runAssessmentBatch(c0.db, busy, 1);
	const retryAt = iso(clockMs + 90_000);
	v = await view(p);
	assert.equal(v.current!.runId, prior.runId);
	assert.deepEqual(v.newest, { state: "deferred", retryAt, grounding: "grounded" });
	const waiting = await c0.one(sql`SELECT j.state,j.next_attempt_at FROM job j JOIN assessment_run r
		ON j.kind='assessment' AND j.subject_record_id=r.plant_id AND j.producer_key=r.demand_key
		WHERE r.plant_id=${p.id} AND r.outcome='deferred'`);
	assert.deepEqual([waiting.state, new Date(waiting.next_attempt_at).toISOString()], ["retry_wait", retryAt]);
	clockMs += 60_000;
	assert.equal(await job.runAssessmentBatch(c0.db, busy, 1), 0, "nothing runs before the retry instant");
	clockMs += 31_000;
	await job.runAssessmentBatch(c0.db, busy, 1);
	const resumed = (await runs(p)).at(-1)!;
	assert.deepEqual([resumed.outcome, resumed.attempts], ["published", 2]);
	assert.equal(busy.calls.length, 2, "one dispatch per call: the busy one and the one that published");

	// A 503 whose wait would pass the run's deadline fails it as a deadline, never later.
	ok(await assessments.requestRefresh(c0.db, p.actor, { requestId: randomUUID() }));
	await job.runAssessmentBatch(
		c0.db,
		scripted({ busy: [{ status: 503, retryAfterSeconds: ASSESSMENT_TIMING.deadlineMs / 1000 }] }),
		1,
	);
	const late = (await runs(p)).at(-1)!;
	assert.deepEqual([late.outcome, late.reason], ["failed", "deadline"]);
	assert.equal((await view(p)).current!.runId, resumed.id);
	clockMs = Date.now();
});

test("AC:PI-PROVIDER-001 replies 429, 503, 503 then 200 make four accounted dispatches across ticks and publish; four busy replies fail the draft as a provider cause", async () => {
	const p = await assessed("Pine Hollow");
	ok(await assessments.requestRefresh(c0.db, p.actor, { requestId: randomUUID() }));
	const drafter = scripted({ busy: [{ status: 429 }, { status: 503 }, { status: 503 }] });
	for (let i = 0; i < 4; i++) {
		await job.runAssessmentBatch(c0.db, drafter, 1);
		clockMs += 5 * 60_000;
	}
	const run = (await runs(p)).at(-1)!;
	assert.deepEqual([run.outcome, run.attempts, drafter.calls.length], ["published", 4, 4]);
	ok(await assessments.requestRefresh(c0.db, p.actor, { requestId: randomUUID() }));
	const down = scripted({ busy: [{ status: 503 }, { status: 503 }, { status: 503 }, { status: 503 }] });
	for (let i = 0; i < 5; i++) {
		await job.runAssessmentBatch(c0.db, down, 1);
		clockMs += 5 * 60_000;
	}
	const failed = (await runs(p)).at(-1)!;
	assert.deepEqual([failed.outcome, failed.reason, failed.attempts, down.calls.length], ["failed", "attempts", 4, 4]);
	clockMs = Date.now();
});

test("AC:ASMT-003 a record changed while the draft is in flight supersedes that run without publishing; the newer run publishes facts from one snapshot", async () => {
	const p = await assessed("Mill Road");
	const before = (await view(p)).current!;
	let changed = false;
	const racing = scripted({
		during: async () => {
			if (changed) return;
			changed = true;
			await c0.committed(p, "Joined Mid-Draft", 0);
		},
	});
	ok(await assessments.requestRefresh(c0.db, p.actor, { requestId: randomUUID() }));
	await job.runAssessmentBatch(c0.db, racing, 1);
	const [, raced] = await runs(p);
	assert.deepEqual([raced.outcome, raced.reason, raced.result], ["superseded", "changed_input", null]);
	assert.equal((await view(p)).current!.runId, before.runId, "the superseded run is never current");
	await job.runAssessmentBatch(c0.db, scripted(), 1);
	const newer = (await runs(p)).at(-1)!;
	assert.deepEqual([newer.outcome, newer.demand], ["published", "followup"]);
	assert.equal(newer.facts.committedAdults.exact, 31);
	assert.deepEqual(newer.model_input.facts, c.factCatalog(newer.facts), "every fact from the one captured snapshot");
});

test("AC:ASMT-004 a worker whose claim expired and was taken over cannot publish, even with matching data; the new owner resumes the same run and budget", async () => {
	const p = await assessed("Lake Shore");
	ok(await assessments.requestRefresh(c0.db, p.actor, { requestId: randomUUID() }));
	let replaced = false;
	const second = scripted();
	const first = scripted({
		during: async () => {
			if (replaced) return;
			replaced = true;
			clockMs += ASSESSMENT_TIMING.leaseMs + 1000;
			assert.equal(await job.runAssessmentBatch(c0.db, second, 1), 1, "the expired claim is taken over");
		},
	});
	await job.runAssessmentBatch(c0.db, first, 1);
	const all = await runs(p);
	const run = all.at(-1)!;
	assert.equal(all.length, 2, "one run for the demand");
	assert.deepEqual([run.outcome, run.attempts], ["published", 2]);
	const points = 3 + run.result.draft.positives.length;
	assert.equal((await c0.rows(sql`SELECT 1 FROM assessment_insight WHERE run_id=${run.id}`)).length, points);
	const audits = await c0.rows(sql`SELECT 1 FROM audit_event WHERE event_key=${"assessment:" + run.id}`);
	assert.equal(audits.length, 1, "published once");
	assert.equal(first.calls.length, 1);
	clockMs = Date.now();
});

test("AC:ASMT-007 a reference activation during drafting refuses publication, and so does a rollback to an earlier release under a new activation", async () => {
	const p = await assessed("Hill Top");
	const first = (await c0.rows(sql`SELECT id FROM reference_release WHERE release_key='methodology-2026.10'`))[0]!;
	const activation = (await runs(p))[0].reference_activation;
	ok(await assessments.requestRefresh(c0.db, p.actor, { requestId: randomUUID() }));
	let activated = false;
	await job.runAssessmentBatch(
		c0.db,
		scripted({
			during: async () => {
				if (activated) return;
				activated = true;
				await c0.release("methodology-2026.11");
			},
		}),
		1,
	);
	const raced = (await runs(p)).at(-1)!;
	assert.deepEqual([raced.outcome, raced.reason], ["superseded", "changed_reference"]);
	await job.runAssessmentBatch(c0.db, scripted(), 1);
	const next = (await runs(p)).at(-1)!;
	assert.equal(next.outcome, "published");
	assert.equal(Number(next.reference_activation), Number(activation) + 1);

	ok(await assessments.requestRefresh(c0.db, p.actor, { requestId: randomUUID() }));
	let rolled = false;
	await job.runAssessmentBatch(
		c0.db,
		scripted({
			during: async () => {
				if (rolled) return;
				rolled = true;
				await c0.activate(first.id);
			},
		}),
		1,
	);
	const rolledBack = (await runs(p)).at(-1)!;
	assert.deepEqual([rolledBack.outcome, rolledBack.reason], ["superseded", "changed_reference"]);
	await drain();
});

test("AC:ASMT-008 a plant that turned off sharing findings before its run finished adds nothing to its network's view, and still reads its own new assessment", async () => {
	const network = await c0.network("Prairie Network");
	const p = await assessed("Prairie Chapel", { network });
	ok(await assessments.requestRefresh(c0.db, p.actor, { requestId: randomUUID() }));
	await job.runAssessmentBatch(
		c0.db,
		scripted({
			during: async () => {
				await c0.admin.execute(sql`UPDATE affiliation SET shared_findings=false WHERE id=${p.affiliation}`);
			},
		}),
		1,
	);
	const run = (await runs(p)).at(-1)!;
	assert.equal(run.outcome, "published");
	assert.equal((await view(p)).current!.runId, run.id);
	const director = (await RequestActor.resolve(c0.db, network.director.session as never)) as never;
	const runId = randomUUID();
	assert.equal((await requestIntelligenceRefresh(c0.db, director, { runId })).status, "ok");
	const ni = (await readIntelligence(c0.db, director, { level: "portfolio", runId }))!;
	const rows = ni.groups.flatMap((g) => g.rows).filter((r) => r.plantId === p.id);
	assert.ok(
		rows.every((r) => r.status === "not_shared"),
		JSON.stringify(rows),
	);
	assert.equal(JSON.stringify(ni).includes(run.id), false);
});

test("AC:PI-CASE-028 three scheduled failures in a row hold the plant for review with the real cause and no plant data; it keeps its last good assessment; a material change runs again", async () => {
	const p = await assessed("Stone Bridge");
	const good = (await view(p)).current!;
	await drain();
	clockMs += 8 * DAY;
	for (let i = 0; i < 3; i++) {
		await tick(invalid());
		await job.runAssessmentBatch(c0.db, invalid(), 50);
		clockMs += DAY;
	}
	const failed = (await runs(p)).filter((r) => r.outcome === "failed");
	assert.equal(failed.length, 3);
	const before = (await runs(p)).length;
	await tick(invalid());
	await job.runAssessmentBatch(c0.db, invalid(), 50);
	assert.equal((await runs(p)).length, before, "a held plant gets no more scheduled runs");
	const v = await view(p);
	assert.equal(v.current!.runId, good.runId);
	assert.deepEqual(v.newest, { state: "needs_review", retryAt: null, grounding: "grounded" });

	const operator = await c0.database.actor(null);
	await c0.admin.execute(
		sql`INSERT INTO platform_grant(account_id,capability) VALUES(${operator.id}::uuid,'assessment_operator')`,
	);
	const asOperator = (await RequestActor.resolve(c0.db, operator.session as never)) as RequestActor;
	const list = ok(await assessments.listRunsForReview(c0.db, asOperator, {}));
	const held = list.find((r) => r.plantName === "Stone Bridge")!;
	assert.deepEqual([held.cause, held.drafts, held.streak.length], ["output_check", 3, 3]);
	const last = failed
		.at(-1)!
		.drafts.at(-1)
		.violations.map((v: c.Violation) => ({ rule: v.rule, where: v.where }));
	assert.ok(last.some((v: { rule: string }) => v.rule === "missing_citation"));
	assert.deepEqual(held.violations, last, "the final draft's own violations");
	const detail = ok(await assessments.describeRunFailure(c0.db, asOperator, { runId: held.runId }));
	assert.deepEqual(detail, held);
	const text = JSON.stringify(list);
	for (const raw of ["Adult 01", "committedAdults", "citations", "summary", "no citation"])
		assert.equal(text.includes(raw), false, `no plant data or model input/output: ${raw}`);
	for (const outsider of [p.actor])
		for (const reply of [
			await assessments.listRunsForReview(c0.db, outsider, {}),
			await assessments.describeRunFailure(c0.db, outsider, { runId: held.runId }),
		])
			assert.equal(reply.status === "refused" && reply.error.code, "access_denied");

	await c0.committed(p, "Back On Track", 0);
	await tick();
	await drain();
	assert.equal((await runs(p)).at(-1)!.outcome, "published");
	assert.equal((await view(p)).newest, null);
	clockMs = Date.now();
});

test("AC:ASMT-012 saving or correcting a private check-in queues no run and changes no assessment input", async () => {
	const p = await assessed("Willow Park");
	await tick();
	await drain();
	const before = await runs(p);
	const care = createPrivateCare();
	const current = ok(await care.readCurrent(c0.db, p.actor, {}));
	const answers = { spiritual: "steady", family: "strained", financial: "steady", pace: "strained" };
	const saved = ok(
		await care.save(c0.db, p.actor, {
			requestKey: randomUUID(),
			expectedRevision: current.revision,
			input: { answers, note: "a private note" },
		}),
	);
	const again = ok(await care.readCurrent(c0.db, p.actor, {}));
	ok(
		await care.correct(c0.db, p.actor, {
			requestKey: randomUUID(),
			expectedRevision: again.revision,
			input: { weekId: again.week.id, answers: { ...answers, pace: "steady" }, note: "corrected" },
		}),
	);
	assert.ok(saved);
	await tick();
	await drain();
	assert.deepEqual(await runs(p), before);
	assert.equal((await jobs(p)).filter((j) => j.producer_key.startsWith("change/")).length, 0);
});

test("publication writes the result, its insights by severity, the delta and the audit row together or none: a failure at each step leaves the previous assessment current", async () => {
	const p = await assessed("Fern Gully");
	const prior = (await view(p)).current!;
	const faults = [
		sql`CREATE FUNCTION t299_fail() RETURNS trigger LANGUAGE plpgsql AS $$BEGIN RAISE EXCEPTION 'injected'; END$$`,
		sql`CREATE TRIGGER t299_fail BEFORE INSERT ON assessment_insight FOR EACH ROW EXECUTE FUNCTION t299_fail()`,
	];
	for (const f of faults) await c0.admin.execute(f);
	const steps = [
		sql`DROP TRIGGER t299_fail ON assessment_insight`,
		sql`CREATE TRIGGER t299_fail BEFORE INSERT ON audit_event FOR EACH ROW WHEN (NEW.action='intelligence.assessed')
			EXECUTE FUNCTION t299_fail()`,
		sql`DROP TRIGGER t299_fail ON audit_event`,
		sql`CREATE TRIGGER t299_fail BEFORE UPDATE ON job FOR EACH ROW WHEN (NEW.state='succeeded' AND NEW.kind='assessment')
			EXECUTE FUNCTION t299_fail()`,
	];
	// The insights fail, then the audit row, then the job's end. A failing audit row also stops the failure record, so
	// that run stays pending for a later claim; the other two record a persistence failure.
	const expected = [
		["failed", "persistence"],
		["pending", null],
		["failed", "persistence"],
	];
	for (let i = 0; i < 3; i++) {
		ok(await assessments.requestRefresh(c0.db, p.actor, { requestId: randomUUID() }));
		await job.runAssessmentBatch(c0.db, scripted(), 1);
		const run = (await runs(p)).at(-1)!;
		assert.deepEqual([run.outcome, run.reason, run.result, run.delta], [...expected[i]!, null, null], `step ${i}`);
		assert.equal((await c0.rows(sql`SELECT 1 FROM assessment_insight WHERE run_id=${run.id}`)).length, 0);
		assert.equal((await view(p)).current!.runId, prior.runId);
		if (i < 2) {
			await c0.admin.execute(steps[i * 2]!);
			await c0.admin.execute(steps[i * 2 + 1]!);
		}
	}
	await c0.admin.execute(sql`DROP TRIGGER t299_fail ON job`);
	await c0.admin.execute(sql`DROP FUNCTION t299_fail()`);
	ok(await assessments.requestRefresh(c0.db, p.actor, { requestId: randomUUID() }));
	await job.runAssessmentBatch(
		c0.db,
		scripted({ script: (d) => ({ ...d, supporting: [{ ...d.supporting[0], urgency: "urgent" }, d.supporting[1]] }) }),
		1,
	);
	const v = (await view(p)).current!;
	assert.notEqual(v.runId, prior.runId);
	const severities = v.insights.map((i) => i.severity);
	assert.equal(severities[0], "high", "an urgent point is stored as high and listed first");
	assert.ok(severities.every((s) => s !== "critical"));
	assert.deepEqual([...severities].sort(), [...severities].sort(), JSON.stringify(severities));
	const stored = await c0.rows(
		sql`SELECT role,severity FROM assessment_insight WHERE run_id=${v.runId} ORDER BY ordinal`,
	);
	assert.deepEqual(stored[0], {
		role: "focus",
		severity: c.SEVERITY[(await runs(p)).at(-1)!.result.draft.focus.urgency as c.Urgency],
	});
	assert.equal(stored[1].severity, "high");
});
