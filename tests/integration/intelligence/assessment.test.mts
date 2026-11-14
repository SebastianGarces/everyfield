// Plant Intelligence assessments through the operations the Plant Intelligence screen will call (WP-041 to WP-043): an
// Owner's intelligence.requestRefresh run by the assessment job with the scripted drafter only,
// intelligence.readAssessment and intelligence.resolveCitation.
// One synthetic church on a scratch schema; the tests run in order and share its plants and reference releases.
import test, { after, before } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { sql } from "../../../packages/db/src/query.ts";
import { RequestActor } from "../../../packages/domain/src/access/session.ts";
import {
	createAssessmentJob,
	createAssessments,
	createFacts,
	runAssessmentBatch,
} from "../../../packages/domain/src/intelligence/index.ts";
import { scriptedAssessmentDrafter, shortDate } from "../../../packages/evry/src/runtime/scripted-assessment.ts";
import { ok } from "../../support/fixture.mts";
import { CANARY, church, type Church } from "./assessment-church.mts";

let c: Church, N, H, T, R2;
const assessments = createAssessments();
const job = createAssessmentJob();
const facts = createFacts();
let firstRun: string;

before(async () => {
	c = await church("t298a");
	N = await c.network();
	H = await c.harvest("Harvest Point", { network: N });
	T = await c.phaseThree();
});
after(() => c?.database.close());

/** An Owner's fresh-assessment request, run by the job: the run as its outcome, reason and drafts. */
async function run(p, drafter = scriptedAssessmentDrafter(), requestId = randomUUID()) {
	ok(await assessments.requestRefresh(c.db, p.actor, { requestId }));
	await runAssessmentBatch(job, c.db, drafter, 20);
	const row = await c.one(
		sql`SELECT * FROM assessment_run WHERE plant_id=${p.id} AND demand_key=${"manual/" + requestId}`,
	);
	const result = {
		runId: row.id,
		outcome: row.outcome,
		grounding: row.grounding,
		reason: row.reason,
		drafts: row.drafts.map((d) => ({ ordinal: d.ordinal, violations: d.violations })),
	};
	return { runId: row.id as string, drafter, result };
}
const view = async (p) => ok(await assessments.readAssessment(c.db, p.actor, {}));
const cite = async (p, runId, key) => ok(await assessments.resolveCitation(c.db, p.actor, { runId, key }));
const stored = (runId) => c.one(sql`SELECT * FROM assessment_run WHERE id=${runId}`);
const citedKeys = (a) => [a.focus, ...a.supporting, ...a.positives].flatMap((p) => p.citations.map((x) => x.key));

test("with no activated methodology reference a run publishes nothing and says guidance couldn't be checked", async () => {
	const { runId, result, drafter } = await run(H);
	assert.deepEqual(
		[result.outcome, result.grounding, result.reason, result.drafts],
		["degraded", "degraded", "reference_missing", []],
	);
	assert.equal(drafter.calls.length, 0, "no model call without grounding");
	const v = await view(H);
	assert.equal(v.current, null);
	assert.deepEqual(v.newest, { state: "failed", retryAt: null, grounding: "degraded" });
	assert.equal(ok(await facts.readFacts(c.db, H.actor, {})).committedAdults.exact, 30);
	const row = await stored(runId);
	assert.deepEqual([row.result, row.model_input, row.reference_release], [null, null, null]);
});

test("AC:PI-CASE-018 every citation of a Phase 1 assessment opens the exact fact and date or the exact article, section and version", async () => {
	await c.release("methodology-2026.10");
	const counts = async () =>
		c.one(sql`SELECT (SELECT count(*) FROM task WHERE plant_id=${H.id})::int AS tasks,
			(SELECT count(*) FROM phase_transition WHERE plant_id=${H.id})::int AS phases,
			(SELECT count(*) FROM communication WHERE plant_id=${H.id})::int AS messages,
			(SELECT count(*) FROM job)::int AS jobs,(SELECT count(*) FROM notice WHERE tenant_id=${H.id})::int AS notices,(SELECT phase FROM plant WHERE id=${H.id}) AS phase`);
	const before = await counts();
	const { runId, result } = await run(H);
	firstRun = runId;
	assert.deepEqual([result.outcome, result.grounding, result.reason], ["published", "grounded", null]);
	assert.deepEqual(
		await counts(),
		{ ...before, jobs: before.jobs + 1 },
		"a run writes no task, phase, message or notice; its one job is the request's",
	);

	const a = (await view(H)).current;
	assert.deepEqual(
		[a.runId, a.phase, a.rubricVersion, a.reference, a.ageDays],
		[runId, 1, "v1", { release: "methodology-2026.10", activation: 1 }, 0],
	);
	const keys = citedKeys(a);
	assert.ok(keys.some((k) => !k.startsWith("passage:")));
	assert.ok(keys.some((k) => k.startsWith("passage:")));
	const today = c.today;
	for (const key of keys) {
		const opened = await cite(H, runId, key);
		assert.equal(opened.status, "verified", key);
		if (opened.kind === "fact") {
			assert.deepEqual([opened.measuredOn, opened.formulaVersion], [today, "plant-facts/1"]);
			assert.equal(opened.asOf, a.asOf);
		} else {
			assert.ok([1, null].includes(opened.phase), `${key} is Phase 1 or general guidance`);
			assert.equal(opened.version.release, "methodology-2026.10");
			assert.equal(opened.currentVersion, true);
			// The section is its heading, or null for the article's opening text; the text is the exact cited text.
			const stored = (await c.one(sql`SELECT result FROM assessment_run WHERE id=${runId}`)).result.citations[key];
			assert.deepEqual([opened.slug, opened.section, opened.text], [stored.slug, stored.section, stored.text]);
		}
	}
	// The exact values the facts recorded, with the two people who fill the roles, each linked while still live.
	const holders = await c.rows(sql`SELECT id AS "personId",display_name AS name FROM person WHERE plant_id=${H.id}
		AND display_name IN ('Adult 04','Adult 05') ORDER BY display_name`);
	assert.deepEqual(await cite(H, runId, "coverage.filled"), {
		status: "verified",
		kind: "fact",
		key: "coverage.filled",
		label: "Ministry responsibilities filled",
		value: 2,
		people: { shown: holders, hidden: 0 },
		asOf: a.asOf,
		measuredOn: today,
		formulaVersion: "plant-facts/1",
	});
	const missing = await assessments.resolveCitation(c.db, H.actor, { runId, key: "nothing.here" });
	assert.equal(missing.status === "refused" && missing.error.code, "not_found");
});

test("AC:PI-PURPOSE-001 the model input and the draft hold counts and dates of interviews, never notes, scores or check-ins", async () => {
	const { runId, drafter } = await run(H);
	const row = await stored(runId);
	for (const text of [JSON.stringify(row.model_input), JSON.stringify(drafter.calls), JSON.stringify(row.result)]) {
		assert.doesNotMatch(text, new RegExp(CANARY));
		assert.doesNotMatch(text, /not_qualified|struggling|maturity|Adult 0\d/i);
	}
	const interviews = row.model_input.facts.filter((f) => f.key.startsWith("humanRecords."));
	assert.deepEqual(
		interviews.map((f) => [f.key, f.value]),
		[
			["humanRecords.interviews", 2],
			["humanRecords.interviewsLatestOn", c.day(-10)],
			["humanRecords.fourCs", 2],
			["humanRecords.fourCsLatestOn", c.day(-10)],
		],
	);
	const positives = (await view(H)).current.positives.map((p) => p.body);
	assert.ok(positives.includes(`2 interviews recorded, latest ${shortDate(c.day(-10))}.`), positives.join(" | "));
});

test("after a new reference activation last month's assessment still cites its own version; a new one cites the new", async () => {
	R2 = await c.release("methodology-2026.11", (body) => body.replace("Every", "Each"));
	const old = (await c.one(sql`SELECT result FROM assessment_run WHERE id=${firstRun}`)).result;
	for (const [key, value] of Object.entries(old.citations as Record<string, any>)) {
		if (value.kind !== "passage" || value.sourceKind !== "global") continue;
		const opened = await cite(H, firstRun, key);
		assert.deepEqual(
			[opened.status, opened.version.release, opened.currentVersion],
			["verified", "methodology-2026.10", false],
		);
	}
	const { runId } = await run(H);
	const a = (await view(H)).current;
	assert.deepEqual([a.runId, a.reference], [runId, { release: "methodology-2026.11", activation: 2 }]);
	const passages = (await stored(runId)).model_input.passages.filter((p) => p.sourceKind === "global");
	assert.ok(passages.length > 0);
	assert.ok(
		passages.every(
			(p) => p.version.release === "methodology-2026.11" && Object.values(R2.revisions).includes(p.revisionId),
		),
	);
});

test("AC:PI-CASE-018 a citation whose stored passage or fact no longer matches reads can't be verified, with no text", async () => {
	const old = (await c.one(sql`SELECT result FROM assessment_run WHERE id=${firstRun}`)).result;
	const [key, passage] = Object.entries(old.citations as Record<string, any>).find(
		([, v]) => v.kind === "passage" && v.sourceKind === "global",
	);
	// Revisions are frozen by a trigger; the edit goes around it, as a corrupted or replaced source would.
	await c.admin.transaction(async (tx) => {
		await tx.execute(sql`SET LOCAL session_replication_role = replica`);
		await tx.execute(sql`UPDATE article_revision SET body=body||' Edited later.' WHERE id=${passage.revisionId}`);
	});
	assert.deepEqual(await cite(H, firstRun, key), { status: "unverifiable", key });
	// A run's snapshot is frozen by a trigger too; this edit goes around it the same way.
	await c.admin.transaction(async (tx) => {
		await tx.execute(sql`SET LOCAL session_replication_role = replica`);
		await tx.execute(
			sql`UPDATE assessment_run SET facts=jsonb_set(facts,'{coverage,filled}','7') WHERE id=${firstRun}`,
		);
	});
	assert.deepEqual(await cite(H, firstRun, "coverage.filled"), { status: "unverifiable", key: "coverage.filled" });
});

test("AC:PI-CASE-011 a Phase 3 plant's assessment cites Phase 3 or general guidance only, never Phase 1-only passages", async () => {
	const { runId, result } = await run(T);
	assert.equal(result.outcome, "published");
	const input = (await stored(runId)).model_input;
	assert.equal(input.phase, 3);
	assert.ok(input.passages.every((p) => p.phase === 3 || p.phase === null));
	assert.ok(!input.passages.some((p) => p.slug === "core-group-commitment" || p.slug === "ministry-leaders"));
	const keys = citedKeys((await view(T)).current).filter((k) => k.startsWith("passage:"));
	const phases = [];
	for (const key of keys) phases.push((await cite(T, runId, key)).phase);
	assert.ok(phases.includes(3), "the Phase 3 training passage is cited");
	assert.ok(phases.every((p) => p === 3 || p === null));
});

test("when the methodology can't be read the facts stay, the previous assessment stays current with its age, and nothing new is published", async () => {
	const previous = (await view(H)).current;
	let result;
	await c.admin.transaction(async (tx) => {
		await tx.execute(sql`LOCK TABLE article_revision IN ACCESS EXCLUSIVE MODE`);
		result = (await run(H)).result;
	});
	assert.deepEqual([result.outcome, result.grounding, result.reason], ["degraded", "degraded", "guidance_unavailable"]);
	const v = await view(H);
	assert.deepEqual(v.current, previous);
	assert.equal(v.current.ageDays, 0);
	assert.deepEqual(v.newest, { state: "failed", retryAt: null, grounding: "degraded" });
	assert.equal((await stored(result.runId)).outcome, "degraded");
	assert.equal(ok(await facts.readFacts(c.db, H.actor, {})).committedAdults.exact, 30);
});

test("AC:PI-CASE-011 a network article cited before the plant left the network reads no longer available, with none of its text", async () => {
	const { runId } = await run(H);
	const cited = Object.entries((await stored(runId)).result.citations as Record<string, any>).find(
		([, v]) => v.kind === "passage" && v.sourceKind === "network",
	);
	assert.ok(cited, "the network's own follow-up article is cited");
	const [key] = cited;
	const opened = await cite(H, runId, key);
	assert.deepEqual([opened.status, opened.sourceKind], ["verified", "network"]);
	assert.match(opened.text, /network coach/);
	await c.admin.execute(sql`UPDATE affiliation SET ended_at=clock_timestamp() WHERE id=${H.affiliation}`);
	const gone = await cite(H, runId, key);
	assert.deepEqual(gone, { status: "unavailable", key });
	assert.doesNotMatch(JSON.stringify(gone), /coach|follow up/i);
	// A new run no longer finds the network's article at all.
	const after = (await stored((await run(H)).runId)).model_input.passages;
	assert.ok(!after.some((p) => p.sourceKind === "network"));
});

test("a network director cannot open a plant's assessment or its citations; a Member cannot either", async () => {
	const director = (await RequestActor.resolve(c.db, N.director.session)) as RequestActor;
	const refusedCode = (r) => (r.status === "refused" ? r.error.code : r.status);
	assert.equal(refusedCode(await assessments.readAssessment(c.db, director, {})), "access_denied");
	assert.equal(
		refusedCode(await assessments.resolveCitation(c.db, director, { runId: firstRun, key: "coverage.filled" })),
		"access_denied",
	);
	assert.equal(
		refusedCode(await assessments.requestRefresh(c.db, director, { requestId: randomUUID() })),
		"access_denied",
	);
	const member = await c.database.actor(H, "member");
	const asMember = (await RequestActor.resolve(c.db, member.session as never)) as RequestActor;
	assert.equal(refusedCode(await assessments.readAssessment(c.db, asMember, {})), "access_denied");
	// Another plant's Owner cannot open this plant's run by id.
	assert.equal(
		refusedCode(await assessments.resolveCitation(c.db, T.actor, { runId: firstRun, key: "coverage.filled" })),
		"not_found",
	);
});

test("a repeated request id records one run, one request audit row attributed to the Owner and one run audit row", async () => {
	const requestId = randomUUID();
	const { runId } = await run(H, scriptedAssessmentDrafter(), requestId);
	await run(H, scriptedAssessmentDrafter(), requestId);
	const r = await c.one(sql`SELECT
		(SELECT count(*) FROM assessment_run WHERE demand_key=${"manual/" + requestId})::int AS runs,
		(SELECT count(*) FROM audit_event WHERE action='intelligence.assessed' AND event_key=${"assessment:" + runId})::int AS audits,
		(SELECT actor_id FROM audit_event WHERE action='intelligence.refresh_requested'
			AND event_key=${"assessment-refresh:" + requestId}) AS actor,
		(SELECT requested_by FROM assessment_run WHERE id=${runId}) AS requester,
		(SELECT model FROM assessment_run WHERE id=${runId}) AS model`);
	assert.deepEqual(r, { runs: 1, audits: 1, actor: H.owner.id, requester: H.owner.id, model: "assessment-scripted" });
});
