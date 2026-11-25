import test, { after, before } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import * as c from "../../../../../packages/contracts/src/intelligence/index.ts";
import { dayText } from "../../../../../packages/contracts/src/common/index.ts";
import { sql } from "../../../../../packages/db/src/query.ts";
import { RequestActor } from "../../../../../packages/domain/src/access/session.ts";
import { createAssessments, createFacts } from "../../../../../packages/domain/src/intelligence/index.ts";
import { invokeRead, readCatalog, type EvryActor } from "../../../../../packages/evry/src/index.ts";
import {
	readAssessmentHistory,
	readAssessmentRun,
	readColdStartGuidance,
	readOwnFeedback,
} from "../../../../../packages/evry/src/adapters/intelligence/reads/assessment.ts";
import { ok } from "../../../../support/fixture.mts";
import { CANARY, intelligenceChurch, TODAY, type IntelligenceChurch } from "../../../evals/intelligence-church.mts";
import { harness } from "../../../evals/intelligence-harness.mts";

const assessments = createAssessments();
const facts = createFacts();
let ch: IntelligenceChurch;
let owner: EvryActor, admin: EvryActor, member: EvryActor;
let h: ReturnType<typeof harness>;
before(async () => {
	ch = await intelligenceChurch("evryhist");
	h = harness(ch.db, TODAY);
	owner = (await h.freshActor(ch.seats.owner.session))!;
	admin = (await h.freshActor(ch.seats.admin.session))!;
	member = (await h.freshActor(ch.seats.member.session))!;
});
after(() => ch?.database.close());

const authority = async (session: string = ch.seats.owner.session) =>
	(await RequestActor.resolve(ch.db, session as never)) as RequestActor;
const read = (adapter: unknown, actor: EvryActor = owner, input: unknown = {}) =>
	invokeRead(ch.db, actor, adapter as never, input);
const copy = async (set: { days: number; outcome?: string; plant?: string; summary?: string }, source: string) => {
	const id = randomUUID();
	const unpublished = set.outcome !== undefined;
	await ch.admin.execute(sql`INSERT INTO assessment_run SELECT (jsonb_populate_record(NULL::assessment_run,
		to_jsonb(r)||jsonb_build_object('id',${id}::text,'demand_key','manual/'||gen_random_uuid(),
			'plant_id',coalesce(${set.plant ?? null}::uuid,r.plant_id),
			'as_of',r.as_of-make_interval(days=>${set.days}),'captured_at',r.captured_at-make_interval(days=>${set.days}),
			'facts',jsonb_set(CASE WHEN ${set.days}>20 THEN r.facts-'training' ELSE r.facts END,'{today}',
				to_jsonb(((r.as_of-make_interval(days=>${set.days})) AT TIME ZONE 'America/Chicago')::date::text)))
		||CASE WHEN ${unpublished} THEN jsonb_build_object('outcome',${set.outcome ?? null}::text,'result',NULL,'available_at',NULL,
			'delta',NULL,'reason',CASE ${set.outcome ?? null}::text WHEN 'failed' THEN 'invalid_drafts' WHEN 'superseded' THEN 'changed_input'
				WHEN 'degraded' THEN 'guidance_unavailable' WHEN 'deferred' THEN 'busy' END,
			'retry_at',CASE WHEN ${set.outcome ?? null}::text='deferred' THEN clock_timestamp()+interval '1 hour' END,
			'settled_at',CASE WHEN ${set.outcome ?? null}::text NOT IN ('pending','deferred') THEN r.captured_at END,
			'grounding',CASE WHEN ${set.outcome ?? null}::text='degraded' THEN 'degraded' ELSE 'grounded' END,
			'model_input',CASE WHEN ${set.outcome ?? null}::text<>'degraded' THEN r.model_input END)
		ELSE jsonb_build_object('available_at',r.available_at-make_interval(days=>${set.days}),
			'result',CASE WHEN ${set.summary ?? null}::text IS NULL THEN r.result
				ELSE jsonb_set(r.result,'{draft,summary}',to_jsonb(${set.summary ?? null}::text)) END) END)).*
		FROM assessment_run r WHERE r.id=${source}::uuid`);
	if (!unpublished)
		await ch.admin.execute(sql`INSERT INTO assessment_insight SELECT (jsonb_populate_record(NULL::assessment_insight,
			to_jsonb(i)||jsonb_build_object('id',gen_random_uuid(),'run_id',${id}::text,'plant_id',coalesce(${set.plant ?? null}::uuid,i.plant_id)))).*
			FROM assessment_insight i WHERE i.run_id=${source}::uuid`);
	return id;
};
const current = async () => ok(await assessments.readAssessment(ch.db, await authority(), {})) as c.AssessmentView;
const trendText = (v: c.TrendValue) =>
	v.state === "measured" ? v.value : v.state === "unknown" ? "Unknown" : "Not measured";
const EARLIER = "This looks at an earlier month of launch progress in Phase 1.";
let latest: string, earlier: string;

test("AC:PI-CASE-020 assessment history is the Trends screen's own runs, newest first, with absent facts Not measured and no unpublished run", async () => {
	latest = (await current()).current!.runId;
	earlier = await copy({ days: 14, summary: EARLIER }, latest);
	await copy({ days: 28 }, latest);
	for (const outcome of ["failed", "degraded", "pending", "superseded"]) await copy({ days: 21, outcome }, latest);
	const screen = ok(await assessments.readHistory(ch.db, await authority(), {})) as c.AssessmentHistory;
	const got = await read(readAssessmentHistory);
	assert.equal(screen.runs.length, 3);
	assert.deepEqual(
		got.rows.map((r) => [r.id, r.label, r.fields]),
		screen.runs.map((r, n) => [
			r.runId,
			dayText(r.measuredOn),
			{
				latest: n === 0,
				phase: `Phase ${r.phase}`,
				...Object.fromEntries(c.TREND_FACTS.map((f, i) => [f.label, trendText(r.values[i]!)])),
			},
		]),
	);
	assert.equal(got.rows[2]!.fields["Required training completed"], "Not measured");
	assert.equal(got.facts?.newer, null);
	assert.equal(got.facts?.published, `The latest published assessment was measured ${got.rows[0]!.label}.`);
	for (let n = 0; n < 12; n++) await copy({ days: 35 + n }, latest);
	assert.equal((await read(readAssessmentHistory)).rows.length, 12, "up to twelve");
});

test("INV-privacy: one earlier assessment reads from its own snapshot; another plant's, an unpublished and an unknown run are not found", async () => {
	const got = await read(readAssessmentRun, owner, { runId: earlier });
	const run = ok(await assessments.readRun(ch.db, await authority(), { runId: earlier })) as c.Assessment;
	const now = (await current()).current!;
	assert.notEqual(run.measuredOn, now.measuredOn);
	assert.equal(got.facts?.summary, EARLIER);
	assert.deepEqual(
		[got.facts?.measuredOn, got.facts?.phase, got.facts?.latest, got.facts?.runId],
		[dayText(run.measuredOn), run.phase, false, earlier],
	);
	const points = [run.focus, ...run.supporting, ...run.positives];
	assert.deepEqual(
		got.rows.filter((r) => r.fields.role).map((r) => [r.label, r.fields.body, r.fields.ordinal]),
		points.map((p, n) => [p.title, p.body, n]),
	);
	assert.deepEqual(
		got.rows.filter((r) => r.fields.lens).map((r) => r.label),
		run.lenses.map((l) => l.label),
	);
	assert.deepEqual(
		got.rows.filter((r) => r.kind === "criterion").map((r) => [r.label, r.fields.status]),
		run.criteria.map((x) => [
			x.label,
			{ met: "Met", not_met: "Not met", unknown: "Unknown", not_tracked: "Not tracked" }[x.status],
		]),
	);
	const text = JSON.stringify([got, await read(readAssessmentHistory)]);
	assert.ok(!text.includes(CANARY));
	for (const { display_name } of await ch.rows<{ display_name: string }>(
		sql`SELECT display_name FROM person WHERE plant_id=${ch.cedar.id}`,
	))
		assert.ok(!text.includes(display_name), display_name);

	const foreign = await copy({ days: 3, plant: ch.plants["Harvest Point"]!.id }, latest);
	const hidden = [foreign, randomUUID()];
	for (const outcome of ["failed", "pending", "superseded"]) hidden.push(await copy({ days: 5, outcome }, latest));
	for (const runId of hidden) {
		const reply = await read(readAssessmentRun, owner, { runId });
		assert.deepEqual([reply.status, reply.rows], ["not_found", []], runId);
	}
});

test("AC:PI-CASE-024 each Owner and Admin reads only their own rating, comment and date, or that they gave none", async () => {
	assert.deepEqual([(await read(readOwnFeedback)).rows, (await read(readOwnFeedback)).facts?.rated], [[], 0]);
	const rate = async (session: string, runId: string, rating: string, comment: string) =>
		ok(await assessments.submitFeedback(ch.db, await authority(session), { runId, ordinal: 0, rating, comment }));
	await rate(ch.seats.owner.session, latest, "useful", "OWNER-COMMENT");
	await rate(ch.seats.admin.session, latest, "not_useful", "ADMIN-COMMENT");
	await rate(ch.seats.owner.session, earlier, "not_useful", "");
	const view = await current();
	const mine = await read(readOwnFeedback);
	assert.deepEqual(
		mine.rows.map((r) => [r.label, r.fields.assessment, r.fields.rating, r.fields.comment]),
		[
			[view.current!.focus.title, dayText(view.current!.measuredOn), "Useful", "OWNER-COMMENT"],
			[
				view.current!.focus.title,
				dayText(
					(ok(await assessments.readRun(ch.db, await authority(), { runId: earlier })) as c.Assessment).measuredOn,
				),
				"Not useful",
				null,
			],
		],
	);
	assert.equal(
		mine.rows[0]!.fields.ratedOn,
		new Intl.DateTimeFormat("en-US", { dateStyle: "medium", timeZone: "America/Chicago" }).format(
			new Date(view.feedback[0]!.recordedAt),
		),
	);
	assert.ok(!JSON.stringify(mine).includes("ADMIN-COMMENT"));
	const theirs = await read(readOwnFeedback, admin);
	assert.deepEqual(
		theirs.rows.map((r) => [r.fields.rating, r.fields.comment]),
		[["Not useful", "ADMIN-COMMENT"]],
	);
});

test("INV-freshness: history and one assessment say a newer one is being prepared or waiting, and which published one they used; settled says nothing", async () => {
	const said = async () => {
		const history = await read(readAssessmentHistory);
		const run = await read(readAssessmentRun, owner, { runId: earlier });
		assert.equal(history.facts?.newer, run.facts?.newer);
		const when = dayText(
			(ok(await assessments.readRun(ch.db, await authority(), { runId: earlier })) as c.Assessment).measuredOn,
		);
		assert.equal(run.facts?.published, `This is the published assessment measured ${when}.`);
		return history.facts?.newer;
	};
	assert.equal(await said(), null);
	ok(await assessments.requestRefresh(ch.db, await authority(), { requestId: randomUUID() }));
	assert.equal((await current()).newest?.state, "preparing");
	assert.equal(await said(), "A newer assessment is being prepared.");
	const waiting = await copy({ days: -1, outcome: "deferred" }, latest);
	assert.equal((await current()).newest?.state, "deferred");
	assert.equal(await said(), "A newer assessment is waiting for the assessment service and will try again shortly.");
	await ch.admin.execute(sql`DELETE FROM assessment_run WHERE id=${waiting}`);
	await ch.admin.execute(
		sql`UPDATE job SET state='cancelled',finished_at=clock_timestamp() WHERE kind='assessment' AND subject_record_id=${ch.cedar.id} AND state='ready'`,
	);
	assert.equal((await current()).newest, null);
	assert.equal(await said(), null);
});

test("AC:PI-CASE-025 cold-start guidance is the screen's own title, body and steps in each state, calls nothing met, asks for nothing and stops once assessed", async () => {
	const plant = await ch.plant("New Life Church");
	const actor = (await h.freshActor(plant.owner.session))!;
	const jobs = async () =>
		(await ch.rows(sql`SELECT id FROM job WHERE kind='assessment' AND subject_record_id=${plant.id}`)).length;
	const titles: string[] = [];
	const matches = async () => {
		const view = ok(await assessments.readAssessment(ch.db, plant.actor, {})) as c.AssessmentView;
		const measured = ok(await facts.readFactsSinceRun(ch.db, plant.actor));
		const screen = c.coldStartGuidance(view.newest, (measured as { facts: c.PlantFacts }).facts);
		const got = await read(readColdStartGuidance, actor);
		assert.deepEqual(
			[got.facts?.title, got.facts?.body, got.facts?.results, got.facts?.noSteps],
			[screen.title, screen.body, screen.results, screen.steps.length ? null : screen.noSteps],
		);
		assert.deepEqual(
			got.rows.map((r) => [r.label, r.fields.detail, r.fields.href]),
			screen.steps.map((s) => [s.title, s.detail, s.href]),
		);
		assert.ok(screen.steps.length > 0);
		titles.push(screen.title);
		for (const row of got.rows) assert.doesNotMatch(JSON.stringify(row.fields), /\b(met|unmet|not met)\b/i);
	};
	await matches();
	assert.equal(await jobs(), 0, "reading asks for no assessment");
	const failed = await copy({ days: 0, outcome: "failed", plant: plant.id }, latest);
	await matches();
	await ch.admin.execute(sql`DELETE FROM assessment_run WHERE id=${failed}`);
	ok(await assessments.requestRefresh(ch.db, plant.actor, { requestId: randomUUID() }));
	await matches();
	assert.deepEqual(titles, [
		"Your first assessment hasn't been prepared yet",
		"Your first assessment couldn't be prepared yet",
		"Your first assessment is on its way",
	]);
	const assessed = await read(readColdStartGuidance);
	assert.deepEqual([assessed.facts?.assessed, assessed.rows], [true, []]);
	const measured = ok(await facts.readFacts(ch.db, plant.actor, {})) as c.PlantFacts;
	const full = {
		...measured,
		committedAdults: { ...measured.committedAdults, status: "met" as const, needsClassifying: [] },
		vision: { ...measured.vision, status: "on_rhythm" as never },
		followUps: { ...measured.followUps, status: "met" as never },
		coverage: { ...measured.coverage, filled: measured.coverage.slots },
		attestations: [],
	};
	assert.deepEqual(
		[c.coldStartGuidance(null, full).steps, c.coldStartGuidance(null, full).noSteps],
		[[], "Your records show no gap to act on yet."],
	);
});

test("INV-privacy: a Member and an organization seat are offered none of the assessment reads", async () => {
	const ops = [readAssessmentHistory, readAssessmentRun, readColdStartGuidance, readOwnFeedback];
	const director = (await h.freshActor(ch.seats.director.session))!;
	for (const actor of [member, director]) {
		const offered = readCatalog(actor).domains.flatMap((d) => d.operations.map((o) => o.operation));
		for (const op of ops) {
			assert.ok(!offered.includes(op.operation), op.operation);
			await assert.rejects(read(op, actor, { runId: latest }), { code: "access_denied" });
		}
	}
});
