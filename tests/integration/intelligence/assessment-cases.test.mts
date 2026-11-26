import test, { after, before } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { APICallError } from "../../../packages/evry/node_modules/ai/dist/index.js";
import * as c from "../../../packages/contracts/src/intelligence/index.ts";
import { sql } from "../../../packages/db/src/query.ts";
import { RequestActor } from "../../../packages/domain/src/access/session.ts";
import {
	ASSESSMENT_TIMING,
	createAssessmentJob,
	createAssessments,
	runAssessmentBatch,
	type Drafter,
} from "../../../packages/domain/src/intelligence/index.ts";
import { getPlant } from "../../../packages/domain/src/oversight/index.ts";
import { meteredAssessment } from "../../../packages/evry/src/runtime/assessment-model.ts";
import { paidModel } from "../../../packages/evry/src/runtime/model.ts";
import { scriptedAssessmentDrafter } from "../../../packages/evry-scripted/src/scripted-assessment.ts";
import { testDatabaseUrl } from "../../support/test-database.mts";
import { ok } from "../../support/fixture.mts";
import { caseOf, type Case } from "../target/sql/core/support.mts";
import { church, type Church, type ChurchPlant, type StoredRun } from "./assessment-church.mts";
import { fakeProvider, grounded, sent } from "./fake-provider.mts";

type Dated = Case & { clock: { now: string } };
const K = (id: string) => caseOf("intelligence", id) as Dated;
const given = <T,>(k: Case, name: string) => (k.given[name] as { value: T }).value;
const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const NOW = K("PI-CASE-015").clock.now;

let c0: Church;
let clockMs = Date.parse(NOW);
const clock = { now: () => new Date(clockMs).toISOString() as never };
const job = createAssessmentJob({ clock });
const assessments = createAssessments({ clock });
const { spend } = paidModel({ EVRY_MODEL: "gpt-6-luna", OPENAI_API_KEY: "sk-test-not-a-key" })!;

before(async () => {
	c0 = await church("pibasmt", { clock: new Date(Date.parse(NOW) - HOUR) });
	await c0.release("methodology-2026.10");
});
after(() => c0?.database.close());

const runOf = (p: { id: string }, requestId: string) =>
	c0.one<StoredRun & { source_revision: string; deadline_at: string }>(
		sql`SELECT * FROM assessment_run WHERE plant_id=${p.id} AND demand_key=${"manual/" + requestId}`,
	);
async function run(p: ChurchPlant, drafter: Drafter) {
	const requestId = randomUUID();
	ok(await assessments.requestRefresh(c0.db, p.actor, { requestId }));
	await runAssessmentBatch(job, c0.db, drafter, 5);
	return runOf(p, requestId);
}
const view = async (p: { actor: RequestActor }) => ok(await assessments.readAssessment(c0.db, p.actor, {}));
const rulesOf = (d: { violations: c.Violation[] }) => [...new Set(d.violations.map((v) => v.rule))];
const replaceText = (from: string, to: string) => (d: c.DraftOutput) => {
	const text = JSON.stringify(d);
	assert.ok(text.includes(from), `the scripted draft says "${from}"`);
	return JSON.parse(text.replace(from, to)) as c.DraftOutput;
};
const counts = (p: { id: string }) =>
	c0.one(sql`SELECT (SELECT count(*) FROM task WHERE plant_id=${p.id})::int AS tasks,
		(SELECT count(*) FROM phase_transition WHERE plant_id=${p.id})::int AS phases,
		(SELECT count(*) FROM communication WHERE plant_id=${p.id})::int AS messages,
		(SELECT count(*) FROM notice WHERE tenant_id=${p.id})::int AS notices,
		(SELECT count(*) FROM mail WHERE tenant_id=${p.id})::int AS mail`);
const setCounter = () => c0.admin.execute(sql`DELETE FROM model_spend`);

test("AC:PI-CASE-015 the scheduler queues the never-assessed, the eight-day-old and the changed plant once each, never one pending deletion or purged", async () => {
	const k = K("PI-CASE-015");
	const plants = given<{ id: string }[]>(k, "plants");
	assert.equal(given<boolean>(k, "multiple_complete_rows_for_Q"), true);
	const zone = (k.given.Q as { timezone: string }).timezone;
	const made: Record<string, ChurchPlant> = {};
	for (const { id } of plants) made[id] = await c0.harvest(`Case 015 ${id}`);
	await c0.admin.execute(sql`UPDATE plant SET timezone=${zone} WHERE id=${made.Q!.id}`);
	const age = plants.find((x) => x.id === "Q") as unknown as { latest_complete_age_days: number };
	for (const days of [age.latest_complete_age_days + 1, age.latest_complete_age_days]) {
		clockMs = Date.parse(NOW) - days * DAY;
		assert.equal((await run(made.Q!, scriptedAssessmentDrafter())).outcome, "published");
	}
	clockMs = Date.parse(NOW) - DAY;
	assert.equal((await run(made.R!, scriptedAssessmentDrafter())).outcome, "published");
	clockMs = Date.parse(NOW);
	const qRows = await c0.rows<{ source_revision: string; as_of: string }>(sql`SELECT source_revision,
		to_char(as_of AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS as_of FROM assessment_run
		WHERE plant_id=${made.Q!.id} AND outcome='published' ORDER BY as_of`);
	assert.equal(qRows.length, 2, "Q has more than one complete row");
	const changesSince = async (p: { id: string }) =>
		(
			await c0.one<{ n: number }>(sql`SELECT count(*)::int AS n FROM audit_event e WHERE e.tenant_id=${p.id}
			AND e.action NOT LIKE 'intelligence.%' AND e.recorded_at>(SELECT max(captured_at) FROM assessment_run
			WHERE plant_id=${p.id})`)
		).n;
	assert.equal(await changesSince(made.Q!), 0, "Q's source is unchanged since its latest run");
	assert.equal(Date.parse(NOW) - Date.parse(qRows[1]!.as_of), age.latest_complete_age_days * DAY);
	await c0.committed(made.R!, "Case 015 R change", 0);
	assert.ok((await changesSince(made.R!)) > 0, "R is dirty: a committed change after its run");
	for (const [id, state] of [
		["S", "pending_deletion"],
		["T", "purged"],
	] as const) {
		const p = made[id]!;
		await c0.admin.execute(sql`INSERT INTO lifecycle_witness(kind,opaque_subject_id,plant_id,request_id,requester_id,
			requester_opaque_id,request_revision,state,requested_at,cancel_until,live_purged_at,copy_expires_at,witness_checkpoint,cleanup_state)
			VALUES('plant',${p.id},${p.id},${randomUUID()},${p.owner.id},${p.owner.id},1,${state},
			${new Date(Date.parse(NOW) - 31 * DAY).toISOString()},${new Date(Date.parse(NOW) - DAY).toISOString()},
			${state === "purged" ? NOW : null},${state === "purged" ? new Date(Date.parse(NOW) + DAY).toISOString() : null},1,${state === "purged" ? "confirmed" : "not_started"})`);
	}
	const before = await c0.one<{ n: number }>(sql`SELECT count(*)::int AS n FROM job WHERE kind='assessment'`);
	const queued = await job.scheduleAssessments(c0.db, given<number>(k, "batch_limit"));
	const jobs = await c0.rows<{ plant: string; key: string; state: string }>(sql`SELECT subject_record_id AS plant,
		producer_key AS key,state FROM job WHERE kind='assessment' AND state='ready'`);
	const label = Object.fromEntries(Object.entries(made).map(([id, p]) => [p.id, id]));
	const mine = jobs.filter((j) => label[j.plant]);
	assert.deepEqual(
		[...new Set(mine.map((j) => label[j.plant]))].sort(),
		k.expected.result.eligible_plant_ids,
		"eligible: never assessed, seven-day stale and dirty",
	);
	for (const id of k.expected.result.denied_plant_ids as string[])
		assert.ok(!jobs.some((j) => j.plant === made[id]!.id), `${id} is not selected`);
	assert.equal(mine.filter((j) => label[j.plant] === "Q").length, 1, "Q is queued once despite several complete rows");
	const keyOf = (id: string) => mine.find((j) => label[j.plant] === id)!.key;
	assert.equal(keyOf("P"), `time/${NOW.slice(0, 10)}`, "a never-assessed plant needs no reading or readiness gate");
	assert.equal(keyOf("Q"), `time/${NOW.slice(0, 10)}`);
	assert.match(keyOf("R"), /^change\//);
	const after = await c0.one<{ n: number }>(sql`SELECT count(*)::int AS n FROM job WHERE kind='assessment'`);
	assert.equal(after.n - before.n, queued, "the scheduler only queues jobs");
	assert.ok(queued <= given<number>(k, "batch_limit"));
	assert.equal(await job.scheduleAssessments(c0.db, 10), 0, "a second sweep queues nothing new");
	for (const id of ["S", "T"]) {
		const read = await assessments.readAssessment(c0.db, made[id]!.actor, {});
		assert.equal(read.status === "refused" && read.error.code, "access_denied", `${id} is no longer readable`);
		assert.equal(
			(await c0.one<{ n: number }>(sql`SELECT count(*)::int AS n FROM assessment_run WHERE plant_id=${made[id]!.id}`))
				.n,
			0,
		);
	}
	await runAssessmentBatch(job, c0.db, scriptedAssessmentDrafter(), 20);
});

const SEVEN: ((d: c.DraftOutput) => unknown)[] = [
	replaceText("show 30 committed adults", "show 31 committed adults"),
	(d) => ({ ...d, focus: { ...d.focus, title: "Go" } }),
	(d) => ({ ...d, focus: { ...d.focus, body: "a".repeat(1201) } }),
	(d) => ({ ...d, summary: "a".repeat(601) }),
	(d) => ({ ...d, supporting: [...d.supporting, d.supporting[0]] }),
	(d) => ({
		...d,
		positives: [
			{
				title: "Prayer is going well",
				body: "Your prayer rhythm is a real strength of your core group.",
				urgency: "positive",
				citations: ["attestations.prayer_rhythm_established"],
			},
		],
	}),
	(d) => ({ ...d, networkConcern: { id: "C2", pairedWith: "C1" } }),
];
const SEVEN_RULES = [["invented_number"], ["shape"], ["shape"], ["shape"], ["shape"], ["unknown_as_known"], ["shape"]];

test("AC:PI-CASE-012 every invalid draft is refused: an invented 31 against a snapshot of 30, out-of-bound title, body and summary, a fourth action, an Unknown called positive and an unpaired network concern", async () => {
	const k = K("PI-CASE-012");
	const drafts = given<Record<string, unknown>[]>(k, "drafts");
	assert.equal(drafts.length, SEVEN.length);
	const bounds = given<Record<"title" | "body" | "summary", [number, number]>>(k, "valid_bounds");
	const p = await c0.harvest("Case 012 Church");
	const good = await run(p, scriptedAssessmentDrafter());
	assert.equal(good.outcome, "published");
	const snapshot = c.factCatalog(good.facts);
	assert.equal(snapshot.find((f) => f.key === "committedAdults.count")!.value, given(k, "snapshot_count"));
	const prior = (await view(p)).current;
	const before = await counts(p);

	const base = c.draftOutput.parse(good.result!.draft);
	const sized = (field: "title" | "body" | "summary", n: number) =>
		c.draftOutput.safeParse(
			field === "summary"
				? { ...base, summary: "a".repeat(n) }
				: { ...base, focus: { ...base.focus, [field]: "a".repeat(n) } },
		).success;
	for (const field of ["title", "body", "summary"] as const) {
		const [min, max] = bounds[field];
		assert.deepEqual(
			[sized(field, min - 1), sized(field, min), sized(field, max), sized(field, max + 1)],
			[false, true, true, false],
			`${field} bounds ${min}-${max}`,
		);
	}

	let accepted = 0;
	for (const [i, edit] of SEVEN.entries()) {
		const r = await run(p, scriptedAssessmentDrafter({ script: (d) => edit(d) }));
		if (r.outcome === "published") accepted++;
		assert.deepEqual(
			[r.outcome, r.reason, r.drafts.length, r.result],
			["failed", "invalid_drafts", 3, null],
			`draft ${i}`,
		);
		for (const d of r.drafts) assert.deepEqual(rulesOf(d), SEVEN_RULES[i], `draft ${i}: ${JSON.stringify(drafts[i])}`);
		if (i === 0) {
			const invented = r.drafts[0]!.violations.find((v) => v.rule === "invented_number")!;
			assert.equal(Number(invented.detail), k.expected.result.invalid_cited_count);
			assert.equal(
				c.factCatalog(r.facts).find((f) => f.key === "committedAdults.count")!.value,
				k.expected.result.truthful_count,
			);
		}
	}
	assert.equal(accepted, k.expected.result.invalid_drafts_accepted);
	assert.deepEqual((await view(p)).current, prior, "nothing invalid publishes; the valid prior result stays");
	assert.deepEqual(await counts(p), before, "event null: no task, phase, message, notice or mail");
});

test("AC:PI-CASE-013 a wrong value, then a concern without its evidence, then a supported draft: three drafts on one snapshot with each draft's violations sent back and no SDK retry", async () => {
	const k = K("PI-CASE-013");
	const outcomes = given<string[]>(k, "draft_outcomes");
	assert.equal(outcomes.length, given<number>(k, "draft_limit"));
	assert.equal(c.ASSESSMENT_BUDGET.drafts, given<number>(k, "draft_limit"));
	const p = await c0.harvest("Case 013 Church");
	await setCounter();
	const edits: ((d: c.DraftOutput) => c.DraftOutput)[] = [
		replaceText("show 30 committed adults", "show 31 committed adults"),
		(d) => ({
			...d,
			focus: { ...d.focus, body: "Fill the open ministry responsibilities before launch.", citations: [] },
		}),
		(d) => d,
	];
	const fake = fakeProvider((params, n) => ({
		text: JSON.stringify(edits[n - 1]!(grounded(params))),
		usage: { input: 900, output: 400 },
	}));
	const before = await counts(p);
	const r = await run(
		p,
		meteredAssessment(c0.db, fake.model, "gpt-6-luna", { ...spend, capMicroUsd: 20_000_000 }).drafter,
	);
	assert.equal(fake.requests.length, k.expected.result.drafts, "one provider request per draft: no SDK retry");
	assert.equal(r.attempts, (k.expected.result.drafts as number) + (k.expected.result.SDK_retries as number));
	assert.deepEqual(
		r.drafts.map((d) => [d.ordinal, d.attempts, rulesOf(d)]),
		[
			[1, 1, ["invented_number"]],
			[2, 1, ["missing_citation"]],
			[3, 1, []],
		],
	);
	const inputs = fake.requests.map((q) => sent(q).input);
	for (const input of inputs) assert.deepEqual(input, r.model_input, "every draft read the one stored snapshot");
	assert.equal(new Set(inputs.map((x) => JSON.stringify(x))).size, 1);
	assert.deepEqual(sent(fake.requests[1]!).feedback, r.drafts[0]!.violations);
	assert.deepEqual(sent(fake.requests[2]!).feedback, r.drafts[1]!.violations, "draft 3 hears draft 2's violations");
	assert.equal(r.outcome, "published");
	assert.equal(r.drafts.findIndex((d) => !d.violations.length) + 1, k.expected.result.accepted_draft);
	const runs = await c0.rows(sql`SELECT DISTINCT source_revision FROM assessment_run WHERE id=${r.id}`);
	assert.equal(runs.length, 1);
	assert.equal((await view(p)).current!.runId, r.id);
	assert.deepEqual(await counts(p), before, "event null: no task, phase, message, notice or mail");
});

test("AC:PI-CASE-014 a 429 whose Retry-After passes the deadline makes one call, never a second, and keeps the reservation", async () => {
	const k = K("PI-CASE-014");
	const [reply] = given<{ status: number; retry_after_seconds: number }[]>(k, "provider_responses");
	const remaining = given<number>(k, "remaining_deadline_seconds") * 1000;
	assert.equal(c.ASSESSMENT_BUDGET.attemptsPerDraft, given<number>(k, "provider_attempt_limit"));
	const p = await c0.harvest("Case 014 Church");
	await setCounter();
	const busy = (seconds: number) =>
		new APICallError({
			message: "rate limited",
			url: "https://provider.invalid",
			requestBodyValues: {},
			statusCode: reply!.status,
			responseHeaders: { "retry-after": String(seconds) },
		});
	const early = (ASSESSMENT_TIMING.deadlineMs - remaining - 10_000) / 1000;
	const fake = fakeProvider((_, n) => busy(n === 1 ? early : reply!.retry_after_seconds));
	const drafter = () =>
		meteredAssessment(c0.db, fake.model, "gpt-6-luna", { ...spend, capMicroUsd: 20_000_000 }).drafter;
	clockMs = Date.parse(NOW);
	const requestId = randomUUID();
	ok(await assessments.requestRefresh(c0.db, p.actor, { requestId }));
	await runAssessmentBatch(job, c0.db, drafter(), 1);
	const deferred = await runOf(p, requestId);
	assert.equal(deferred.outcome, "deferred");
	clockMs = Date.parse(deferred.deadline_at) - remaining;
	const sentBefore = fake.requests.length;
	await runAssessmentBatch(job, c0.db, drafter(), 1);
	const r = await runOf(p, requestId);
	assert.equal(fake.requests.length - sentBefore, 1, "one call with 10 seconds left");
	assert.ok(reply!.retry_after_seconds * 1000 > remaining);
	assert.deepEqual([r.outcome, r.reason, r.attempts, r.drafts], ["failed", "deadline", 2, []]);
	assert.ok(r.input_tokens > deferred.input_tokens, "the uncertain dispatch keeps its input reservation");
	assert.equal(r.output_tokens - deferred.output_tokens, 3000, "and its output reservation");
	clockMs += 10 * 60_000;
	await runAssessmentBatch(job, c0.db, drafter(), 5);
	assert.equal(fake.requests.length - sentBefore, 1, "no second call, even after the Retry-After");
	clockMs = Date.parse(NOW);
});

test("AC:PI-CASE-028 the last rejected draft's own rule is the failure an operator reads; three drafts with three different rules; the prior result stays", async () => {
	const k = K("PI-CASE-028");
	const failures = given<{ attempt: number; rule: string }[]>(k, "draft_failures");
	const RULE: Record<string, c.DraftRule> = {
		numeric_value_mismatch: "invented_number",
		missing_concern_pair: "missing_citation",
		missing_reference_passage: "invented_citation",
	};
	const p = await c0.harvest("Case 028 Church");
	assert.equal((await run(p, scriptedAssessmentDrafter())).outcome, "published");
	const prior = (await view(p)).current!;
	const edits: Record<string, (d: c.DraftOutput) => unknown> = {
		numeric_value_mismatch: replaceText("show 30 committed adults", "show 31 committed adults"),
		missing_concern_pair: (d) => ({
			...d,
			focus: { ...d.focus, body: "Fill the open ministry responsibilities before launch.", citations: [] },
		}),
		missing_reference_passage: (d) => ({
			...d,
			focus: { ...d.focus, citations: [...d.focus.citations, "passage:99"] },
		}),
	};
	const r = await run(
		p,
		scriptedAssessmentDrafter({ script: (d, call) => edits[failures[call.ordinal - 1]!.rule]!(d) }),
	);
	assert.deepEqual([r.outcome, r.reason, r.drafts.length], ["failed", "invalid_drafts", given(k, "draft_limit")]);
	assert.deepEqual(
		r.drafts.map((d) => rulesOf(d)),
		failures.map((f) => [RULE[f.rule]]),
	);
	const operator = await c0.database.actor(null);
	await c0.admin.execute(
		sql`INSERT INTO platform_grant(account_id,capability) VALUES(${operator.id}::uuid,'assessment_operator')`,
	);
	const asOperator = (await RequestActor.resolve(c0.db, operator.session as never)) as RequestActor;
	const detail = ok(await assessments.describeRunFailure(c0.db, asOperator, { runId: r.id }));
	assert.equal(detail.drafts, k.expected.result.drafts);
	assert.equal(detail.cause, "output_check");
	assert.deepEqual(
		[...new Set(detail.violations.map((v) => v.rule))],
		[RULE[k.expected.result.last_rule as string]],
		"the final draft's rule, not the first",
	);
	assert.deepEqual(
		detail.violations,
		r.drafts.at(-1)!.violations.map((v) => ({ rule: v.rule, where: v.where })),
	);
	assert.doesNotMatch(JSON.stringify(detail), /committed adults|passage:99|Adult 0/);
	const v = await view(p);
	assert.equal(!!v.current && v.current.runId === prior.runId, k.expected.result.prior_result_retained);
	assert.deepEqual(v.newest, { state: "failed", retryAt: null, grounding: "grounded" });
	const refused = await assessments.describeRunFailure(c0.db, p.actor, { runId: r.id });
	assert.equal(refused.status === "refused" && refused.error.code, "access_denied");
});

test("AC:PI-CASE-027 a pinned candidate is evaluated on synthetic gold cases in a disposable schema; the shared source is refused, its false number fails, and the rollout gate stays shut", async () => {
	const k = K("PI-CASE-027");
	const gold = given<string[]>(k, "gold_cases");
	const targets = given<string[]>(k, "targets");
	assert.equal(given<boolean>(k, "one_candidate_output_has_false_number"), true);
	const schema = (await c0.one<{ s: string }>(sql`SELECT current_schema() AS s`)).s;
	assert.match(schema, /^pibasmt_[0-9a-f]{32}$/, `${targets[0]}: a fresh per-run schema`);

	const saved = { pooled: process.env.DATABASE_URL, unpooled: process.env.DATABASE_URL_UNPOOLED };
	process.env.DATABASE_URL = process.env.DATABASE_URL_UNPOOLED =
		"postgres://source:secret@source.example.invalid/everyfield";
	let sharedSourceWriteAllowed = true;
	try {
		testDatabaseUrl();
	} catch {
		sharedSourceWriteAllowed = false;
	} finally {
		for (const [name, value] of [
			["DATABASE_URL", saved.pooled],
			["DATABASE_URL_UNPOOLED", saved.unpooled],
		] as const)
			if (value === undefined) delete process.env[name];
			else process.env[name] = value;
	}
	assert.equal(sharedSourceWriteAllowed, k.expected.result.shared_source_write_allowed, targets[1]);

	const candidate = (input: c.DraftOutput) => input;
	const falseNumber = (d: c.DraftOutput) =>
		replaceText("show 30 committed adults", "show 31 committed adults")(candidate(d));
	const harvest = await c0.harvest("Case 027 Gold");
	const unknown = await c0.unknownCount("Case 027 Unknown");
	const network = await c0.network("Case 027 Network");
	const paired = await c0.harvest("Case 027 Paired", { network });
	await c0.admin.execute(sql`UPDATE affiliation SET share_people=true,share_meetings=true,share_tasks=true,
		share_ministry_teams=true WHERE id=${paired.affiliation}`);
	const director = (await RequestActor.resolve(c0.db, network.director.session as never)) as RequestActor;
	const results: Record<string, "passed" | "failed"> = {};
	const grade = (name: string, passed: boolean) => (results[name] = passed ? "passed" : "failed");

	const numeric = await run(harvest, scriptedAssessmentDrafter({ script: falseNumber }));
	grade(
		"numeric_truth",
		numeric.outcome === "published" && !JSON.stringify(numeric.result).includes("31 committed adults"),
	);
	const u = await run(unknown, scriptedAssessmentDrafter({ script: candidate }));
	const uText = JSON.stringify(u.result?.draft ?? "");
	grade(
		"unknown_not_positive",
		u.outcome === "published" && /unknown/i.test(uText) && !/\b(at|below|above) 30\b/.test(uText),
	);
	const verdict = await run(
		harvest,
		scriptedAssessmentDrafter({
			script: (d) => ({
				...candidate(d),
				focus: { ...d.focus, body: `${d.focus.body} Your church is ready to launch.` },
			}),
		}),
	);
	grade(
		"pastoral_verdict_denial",
		verdict.outcome === "failed" && verdict.drafts.every((d) => rulesOf(d).includes("readiness_verdict")),
	);
	const pr = await run(paired, scriptedAssessmentDrafter({ script: candidate }));
	ok(await assessments.markAssessmentSeen(c0.db, paired.actor, { runId: pr.id }));
	const org = (await getPlant(c0.db, director, paired.id, () => {}, clock))!;
	grade(
		"paired_concern",
		org.assessment.status === "released" &&
			JSON.stringify(org.assessment.concerns) === JSON.stringify((await view(paired)).current!.concerns),
	);
	assert.deepEqual(Object.keys(results), gold, "every gold case ran and was graded on its actual result");
	assert.equal(results.numeric_truth, k.expected.result.false_numeric_case);
	assert.deepEqual(
		[results.unknown_not_positive, results.pastoral_verdict_denial, results.paired_concern],
		["passed", "passed", "passed"],
	);
	const rolloutAllowed = Object.values(results).every((r) => r === "passed");
	assert.equal(rolloutAllowed, k.expected.result.rollout_allowed);
	assert.deepEqual(
		await c0.rows(
			sql`SELECT DISTINCT model FROM assessment_run WHERE plant_id IN (${harvest.id},${unknown.id},${paired.id})`,
		),
		[{ model: "assessment-scripted" }],
		"no real model call",
	);
});
