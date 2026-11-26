import test, { after, before } from "node:test";
import assert from "node:assert/strict";
import { AsyncResource } from "node:async_hooks";
import { randomUUID } from "node:crypto";
import { sql } from "../../../packages/db/src/query.ts";
import { RequestActor } from "../../../packages/domain/src/access/session.ts";
import * as c from "../../../packages/contracts/src/intelligence/index.ts";
import {
	createAssessmentJob,
	createAssessments,
	runAssessmentBatch,
} from "../../../packages/domain/src/intelligence/index.ts";
import { commitments, peopleWriter } from "../../../packages/domain/src/people/index.ts";
import { scriptedAssessmentDrafter } from "../../../packages/evry-scripted/src/scripted-assessment.ts";
import { scheduledJobs } from "../../../apps/web/src/server/jobs/scheduled.ts";
import { ok } from "../../support/fixture.mts";
import { church, type Church, type StoredRun } from "./assessment-church.mts";
import { gatedTransaction } from "../../../packages/domain/src/operations/writes.ts";

const DAY = 86_400_000;
let c0: Church;
let clockMs = Date.now();
const clock = { now: () => new Date(clockMs).toISOString() as never };
const job = createAssessmentJob({ clock });
const assessments = createAssessments({ clock });
const scripted = (options: Parameters<typeof scriptedAssessmentDrafter>[0] = {}) =>
	scriptedAssessmentDrafter(options.during ? { ...options, during: AsyncResource.bind(options.during) } : options);

before(async () => {
	c0 = await church("t299o");
	await c0.release("methodology-2026.10");
});
after(() => c0?.database.close());

async function tick(drafter = scripted()) {
	const run = scheduledJobs({
		db: c0.db,
		storage: null,
		cleanup: null,
		effects: null,
		digests: null,
		mail: null,
		assessments: { drafter },
		now: () => new Date(clockMs),
	});
	const response = await run();
	const body = await response.json();
	assert.equal(body.steps.assessment.status, "ok", JSON.stringify(body.steps));
	return body;
}
const view = async (p: { actor: RequestActor }) => ok(await assessments.readAssessment(c0.db, p.actor, {}));
const runs = (p: { id: string }) =>
	c0.rows<
		StoredRun & { retry_at: string | null; deadline_at: string }
	>(sql`SELECT id,outcome,reason,demand,demand_key,as_of,source_revision,reference_activation,result,facts,
		model_input,attempts,input_tokens,output_tokens,pending_attempts,drafts,retry_at,deadline_at,delta
		FROM assessment_run WHERE plant_id=${p.id} ORDER BY captured_at,id`);
const jobs = (p: { id: string }) =>
	c0.rows<{
		producer_key: string;
	}>(sql`SELECT producer_key,state,error_code,next_attempt_at FROM job WHERE kind='assessment'
		AND subject_record_id=${p.id} ORDER BY eligible_at,id`);
const iso = (ms: number) => new Date(ms).toISOString();
async function assessed(name: string, options = {}) {
	clockMs = Date.now();
	const p = await c0.harvest(name, options);
	await job.scheduleAssessments(c0.db);
	await runAssessmentBatch(job, c0.db, scripted(), 20);
	assert.equal((await view(p)).current?.asOf !== undefined, true, "first assessment published");
	return p;
}
const invalid = () => scripted({ script: (d) => ({ ...d, focus: { ...d.focus, citations: [] } }) });
const drain = () => runAssessmentBatch(job, c0.db, scripted(), 50);

test("a never-assessed plant: the next tick queues its first assessment unasked; until it publishes the read says being prepared, then it shows the first assessment with its as-of", async () => {
	clockMs = Date.now();
	const p = await c0.harvest("First Light");
	assert.deepEqual(await view(p), { current: null, newest: null, currentPhase: 1, seen: false, feedback: [] });
	let during: c.AssessmentView | null = null;
	const drafter = scripted({
		during: async () => {
			if (!during && (await runs(p)).some((r) => r.outcome === "pending")) during = await view(p);
		},
	});
	await tick(drafter);
	await drain();
	assert.deepEqual(during, {
		current: null,
		newest: { state: "preparing", retryAt: null, grounding: "grounded" },
		currentPhase: 1,
		seen: false,
		feedback: [],
	});
	const v = await view(p);
	assert.equal(v.newest, null);
	assert.equal(v.current!.asOf, iso(clockMs));
	assert.equal(v.current!.measuredOn, c0.today);
	assert.equal(v.current!.ageDays, 0);
	const run = (await runs(p))[0]!;
	assert.deepEqual([run.outcome, run.demand], ["published", "time"]);
	assert.equal((await c0.one(sql`SELECT count(*)::int AS n FROM notice WHERE tenant_id=${p.id}`)).n, 0, "no notice");
});

test("a new committed adult publishes a new assessment dated after the change; the earlier one is unchanged; a failed write, an exact retry, a no-op and an unrelated field queue no run", async () => {
	const p = await assessed("Cedar Hill");
	const first = (await runs(p))[0]!;
	const before = JSON.stringify(first);
	clockMs += 60_000;
	const who = await c0.committed(p, "Newest Adult", 1);
	await tick();
	await drain();
	const after = await runs(p);
	assert.equal(after.length, 2);
	assert.equal(JSON.stringify(after[0]), before, "the earlier run stays exactly as it was");
	assert.deepEqual([after[1]!.outcome, after[1]!.demand], ["published", "change"]);
	const v = await view(p);
	assert.equal(v.current!.runId, after[1]!.id);
	assert.ok(Date.parse(v.current!.asOf) > Date.parse(first.as_of));
	assert.equal(v.current!.delta!.previousRunId, first.id);
	assert.deepEqual(
		v.current!.delta!.changed.find((d) => d.key === "committedAdults.count"),
		{ key: "committedAdults.count", label: "Committed adults", before: 30, after: 31 },
	);

	const failed = await gatedTransaction(c0.db, (t) =>
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
	const person = ok(
		await gatedTransaction(c0.db, (t) =>
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
		await gatedTransaction(c0.db, (t) =>
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
		await gatedTransaction(c0.db, (t) =>
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
	assert.equal((await view(p)).current!.runId, all[1]!.id);
	const requester = await c0.one(sql`SELECT requested_by FROM assessment_run WHERE id=${all[1]!.id}`);
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

test("AC:PI-CASE-028 three scheduled failures in a row hold the plant for review with the real cause and no plant data; it keeps its last good assessment; a material change runs again", async () => {
	const p = await assessed("Stone Bridge");
	const good = (await view(p)).current!;
	await drain();
	clockMs += 8 * DAY;
	for (let i = 0; i < 3; i++) {
		await tick(invalid());
		await runAssessmentBatch(job, c0.db, invalid(), 50);
		clockMs += DAY;
	}
	const failed = (await runs(p)).filter((r) => r.outcome === "failed");
	assert.equal(failed.length, 3);
	const before = (await runs(p)).length;
	await tick(invalid());
	await runAssessmentBatch(job, c0.db, invalid(), 50);
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
	assert.deepEqual(Object.keys(held).sort(), [
		"asOf",
		"cause",
		"demand",
		"drafts",
		"outcome",
		"plantName",
		"runId",
		"settledAt",
		"streak",
		"usage",
		"violations",
	]);
	const last = failed
		.at(-1)!
		.drafts.at(-1)!
		.violations.map((v) => ({ rule: v.rule, where: v.where }));
	assert.ok(last.some((v) => v.rule === "missing_citation"));
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
	const expected = [
		["failed", "persistence"],
		["pending", null],
		["failed", "persistence"],
	];
	for (let i = 0; i < 3; i++) {
		ok(await assessments.requestRefresh(c0.db, p.actor, { requestId: randomUUID() }));
		await runAssessmentBatch(job, c0.db, scripted(), 1);
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
	await runAssessmentBatch(
		job,
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
		severity: c.SEVERITY[(await runs(p)).at(-1)!.result!.draft.focus.urgency],
	});
	assert.equal(stored[1]!.severity, "high");
});
