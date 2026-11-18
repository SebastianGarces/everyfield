import test, { after, before } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { sql } from "../../../packages/db/src/query.ts";
import { RequestActor } from "../../../packages/domain/src/access/session.ts";
import * as c from "../../../packages/contracts/src/intelligence/index.ts";
import {
	createAssessmentJob,
	createAssessments,
	runAssessmentBatch,
	type Drafter,
} from "../../../packages/domain/src/intelligence/index.ts";
import { getPlant, listPlants } from "../../../packages/domain/src/oversight/index.ts";
import { scriptedAssessmentDrafter } from "../../../packages/evry/src/runtime/scripted-assessment.ts";
import { ok } from "../../support/fixture.mts";
import { church, type Church } from "./assessment-church.mts";

const HOUR = 3_600_000;
let c0: Church;
let clockMs = Date.now();
const clock = { now: () => new Date(clockMs).toISOString() as never };
const job = createAssessmentJob({ clock });
const assessments = createAssessments({ clock });
let calls = 0;
const counted = (): Drafter => {
	const inner = scriptedAssessmentDrafter();
	return { id: inner.id, draft: (call, signal) => (calls++, inner.draft(call, signal)) };
};

before(async () => {
	c0 = await church("t300v");
	await c0.release("methodology-2026.11");
});
after(() => c0?.database.close());

type P = Awaited<ReturnType<Church["harvest"]>>;
const view = (p: { actor: RequestActor }) => assessments.readAssessment(c0.db, p.actor, {}).then(ok);
async function publish(p: P) {
	ok(await assessments.requestRefresh(c0.db, p.actor, { requestId: randomUUID() }));
	await runAssessmentBatch(job, c0.db, counted(), 20);
	const v = await view(p);
	assert.ok(v.current, "published");
	return v.current;
}
async function assessedPlant(name: string, { phase = 2, share = true } = {}) {
	clockMs = Date.now();
	const net = await c0.database.organization("sending_network", {
		name: `${name} Network`,
		timezone: "America/Chicago",
	});
	const p = await c0.harvest(name, { network: net });
	await c0.admin.execute(sql`UPDATE plant SET phase=${phase} WHERE id=${p.id}`);
	await c0.admin.execute(sql`UPDATE affiliation SET share_people=${share},share_meetings=${share},share_tasks=${share},
		share_ministry_teams=${share},shared_findings=${share} WHERE id=${p.affiliation}`);
	const seat = await c0.database.actor(net, "admin");
	const director = (await RequestActor.resolve(c0.db, seat.session as never)) as RequestActor;
	const run = await publish(p);
	return { p, net, director, run };
}
const audits = (p: { id: string }, action: string) =>
	c0.rows(sql`SELECT actor_id,kind,metadata FROM audit_event WHERE tenant_id=${p.id} AND action=${action}
		ORDER BY occurred_at,id`);
const runRow = (id: string) => c0.one(sql`SELECT to_jsonb(r) AS row FROM assessment_run r WHERE r.id=${id}`);
const orgView = (director: RequestActor, p: { id: string }) => getPlant(c0.db, director, p.id, () => {}, clock);

test("an Owner opens a Phase 2 assessment: one main focus, two supporting points, what's going well apart, eight lens tiles each measured, attested or Unknown, Phase 2's exit criteria with evidence and the date, read with no model call", async () => {
	const { p, run } = await assessedPlant("Lakeside Church");
	const before = calls;
	const v = await view(p);
	assert.equal(calls, before, "opening the page asks the model for nothing");
	const a = v.current!;
	assert.equal(a.runId, run.runId);
	assert.equal(a.phase, 2);
	assert.equal(a.measuredOn, c0.today);
	assert.ok(a.focus.title);
	assert.equal(a.supporting.length, 2);
	assert.ok(
		a.positives.every((x) => x.severity === "info"),
		"what's going well holds only positive points",
	);
	assert.deepEqual(
		a.lenses.map((l) => l.key),
		["vision", "ownership", "critical_mass", "cohesion", "prayer", "generosity", "leadership", "training"],
	);
	const lens = Object.fromEntries(a.lenses.map((l) => [l.key, l]));
	assert.equal(lens.critical_mass!.quality, "measured");
	assert.equal(lens.vision!.quality, "measured");
	assert.equal(lens.leadership!.quality, "measured");
	assert.equal(lens.prayer!.quality, "unknown");
	assert.equal(lens.generosity!.quality, "unknown");
	assert.equal(lens.prayer!.standing, "insufficient", "no evidence is never a pass");
	assert.deepEqual(
		lens.critical_mass!.evidence.find((e) => e.key === "committedAdults.atLeast"),
		{ key: "committedAdults.atLeast", label: "Committed adults known so far", value: 30 },
	);
	assert.deepEqual(
		a.criteria.map((x) => [x.key, x.status]),
		[
			["all_team_leaders", "not_met"],
			["launch_date_set", "unknown"],
		],
	);
	assert.deepEqual(
		a.criteria[0]!.evidence.map((e) => [e.key, e.value]),
		[
			["coverage.filled", 2],
			["coverage.slots", 8],
			["coverage.people", 2],
		],
	);
	assert.equal(v.currentPhase, 2);
});

test("the plant moves to Phase 3 after its Phase 2 assessment: the read keeps it as a Phase 2 assessment with Phase 2's criteria and shows the current phase separately", async () => {
	const { p } = await assessedPlant("Riverbend Church");
	await c0.admin.execute(sql`UPDATE plant SET phase=3 WHERE id=${p.id}`);
	const v = await view(p);
	assert.equal(v.currentPhase, 3);
	assert.equal(v.current!.phase, 2);
	assert.deepEqual(
		v.current!.criteria.map((x) => x.key),
		["all_team_leaders", "launch_date_set"],
		"Phase 2's criteria, never Phase 3's",
	);
});

test("a fact citation opens the exact value and date from the run's own snapshot, and links only the people the reader can still open; a passage citation opens the passage the run read", async () => {
	const { p, run } = await assessedPlant("Cedar Grove Church");
	const gone = (await c0.one(sql`SELECT id FROM person WHERE plant_id=${p.id} AND display_name='Adult 07'`)).id;
	await c0.admin.execute(sql`UPDATE person SET state='retired' WHERE id=${gone}`);
	const fact = ok(
		await assessments.resolveCitation(c0.db, p.actor, { runId: run.runId, key: "committedAdults.atLeast" }),
	);
	assert.equal(fact.status, "verified");
	assert.ok(fact.status === "verified" && fact.kind === "fact");
	assert.equal(fact.value, 30, "the snapshot's value, not today's 29");
	assert.equal(fact.measuredOn, c0.today);
	assert.equal(fact.asOf, run.asOf);
	assert.equal(fact.people.shown.length, 29);
	assert.equal(fact.people.hidden, 1);
	assert.ok(!fact.people.shown.some((x) => x.personId === gone), "no link to a record the reader cannot open");
	assert.ok(!JSON.stringify(fact).includes(gone));
	const stored = (await runRow(run.runId)).row as {
		result: { citations: Record<string, { kind: string; text?: string }> };
	};
	const passageKey = Object.keys(stored.result.citations).find((k) => stored.result.citations[k]!.kind === "passage");
	assert.ok(passageKey, "the scripted draft cites a passage");
	const passage = ok(await assessments.resolveCitation(c0.db, p.actor, { runId: run.runId, key: passageKey }));
	assert.ok(passage.status === "verified" && passage.kind === "passage");
	assert.equal(passage.text, stored.result.citations[passageKey]!.text);
	assert.equal(
		refused(await assessments.resolveCitation(c0.db, p.actor, { runId: run.runId, key: "nothing.here" })),
		"not_found",
	);
});

test("Not useful with a comment is saved as the reader's own, bound to that point and run; the run does not change; a second Admin's feedback is theirs alone and cannot change the first", async () => {
	const { p, run } = await assessedPlant("Hillcrest Church");
	const runBefore = JSON.stringify((await runRow(run.runId)).row);
	const saved = ok(
		await assessments.submitFeedback(c0.db, p.actor, {
			runId: run.runId,
			ordinal: 1,
			rating: "not_useful",
			comment: "  We already did this last month.  ",
		}),
	);
	assert.equal(saved.outcome, "saved");
	assert.deepEqual([saved.feedback.rating, saved.feedback.comment], ["not_useful", "We already did this last month."]);
	const again = await view(p);
	assert.deepEqual(
		again.feedback.map((f) => [f.ordinal, f.rating, f.comment]),
		[[1, "not_useful", "We already did this last month."]],
	);

	const admin = await c0.database.actor(p as never, "admin");
	const second = (await RequestActor.resolve(c0.db, admin.session as never)) as RequestActor;
	assert.deepEqual((await view({ actor: second })).feedback, [], "nobody reads another account's feedback");
	ok(await assessments.submitFeedback(c0.db, second, { runId: run.runId, ordinal: 1, rating: "useful", comment: "" }));
	assert.deepEqual(
		(await view({ actor: second })).feedback.map((f) => [f.ordinal, f.rating, f.comment]),
		[[1, "useful", null]],
	);
	assert.deepEqual(
		(await view(p)).feedback.map((f) => [f.ordinal, f.rating, f.comment]),
		[[1, "not_useful", "We already did this last month."]],
		"the second Admin's save left the first account's feedback as it was",
	);
	const rows =
		await c0.rows(sql`SELECT account_id,rating,rubric_version FROM assessment_feedback WHERE run_id=${run.runId}
		ORDER BY rating`);
	assert.deepEqual(
		rows.map((r) => [r.account_id, r.rating, r.rubric_version]),
		[
			[p.owner.id, "not_useful", "v1"],
			[admin.id, "useful", "v1"],
		],
	);
	assert.equal(JSON.stringify((await runRow(run.runId)).row), runBefore, "the assessment itself is unchanged");
	assert.equal(
		refused(
			await assessments.submitFeedback(c0.db, p.actor, {
				runId: randomUUID(),
				ordinal: 1,
				rating: "useful",
				comment: "",
			}),
		),
		"not_found",
		"feedback needs a point of a published run of this plant",
	);
});

test("a feedback save and an Owner's first open each write one audit row; the same save again, a repeated open, a read and an organization seat write none", async () => {
	const { p, run, director } = await assessedPlant("Northgate Church");
	await view(p);
	await orgView(director, p);
	assert.deepEqual(await audits(p, "intelligence.assessment_opened"), [], "a read records no open");
	assert.equal(refused(await assessments.markAssessmentSeen(c0.db, director, { runId: run.runId })), "access_denied");
	assert.equal(ok(await assessments.markAssessmentSeen(c0.db, p.actor, { runId: run.runId })).outcome, "recorded");
	assert.equal(ok(await assessments.markAssessmentSeen(c0.db, p.actor, { runId: run.runId })).outcome, "already_seen");
	const opened = await audits(p, "intelligence.assessment_opened");
	assert.deepEqual(
		opened.map((r) => [r.actor_id, r.kind, r.metadata]),
		[[p.owner.id, "create", { runId: run.runId }]],
	);
	assert.equal((await view(p)).seen, true);

	const feedback = { runId: run.runId, ordinal: 0, rating: "useful", comment: "" };
	ok(await assessments.submitFeedback(c0.db, p.actor, feedback));
	assert.equal(ok(await assessments.submitFeedback(c0.db, p.actor, feedback)).outcome, "unchanged");
	ok(await assessments.submitFeedback(c0.db, p.actor, { ...feedback, comment: "Spot on." }));
	assert.deepEqual(
		(await audits(p, "intelligence.feedback_saved")).map((r) => [r.actor_id, r.kind, r.metadata]),
		[
			[p.owner.id, "create", { runId: run.runId, ordinal: 0, rubricVersion: "v1", fields: ["rating"] }],
			[p.owner.id, "edit", { runId: run.runId, ordinal: 0, rubricVersion: "v1", fields: ["comment"] }],
		],
		"audit names the changed fields, never the comment",
	);
});

test("the network sees a new assessment's health only after the planter opens it or 72 hours pass; until then the previous released result, or Not yet assessed", async () => {
	const { p, run: first, director } = await assessedPlant("Westfield Church");
	const released = async () => (await orgView(director, p))!.assessment;
	assert.deepEqual(await released(), { status: "not_assessed" }, "nothing released yet");
	const row = (await listPlants(c0.db, director, clock))!.plants.find((x) => x.plantId === p.id)!;
	assert.equal(row.health, "not_assessed");

	const available = Math.ceil(
		Number(
			(
				await c0.one(
					sql`SELECT extract(epoch FROM available_at)*1000 AS ms FROM assessment_run WHERE id=${first.runId}`,
				)
			).ms,
		),
	);
	clockMs = available + 72 * HOUR - 1000;
	assert.deepEqual(await released(), { status: "not_assessed" }, "71:59:59 after it became available");
	clockMs += 1000;
	const r1 = await released();
	assert.ok(r1.status === "released");
	assert.equal(r1.runId, first.runId, "72 hours after it became available");

	clockMs = Date.now();
	ok(await assessments.markAssessmentSeen(c0.db, p.actor, { runId: first.runId }));
	const second = await publish(p);
	assert.notEqual(second.runId, first.runId);
	const r2 = await released();
	assert.ok(r2.status === "released");
	assert.equal(r2.runId, first.runId, "the previous released result until the new one is released");

	clockMs += 60_000;
	ok(await assessments.markAssessmentSeen(c0.db, p.actor, { runId: second.runId }));
	const r3 = await released();
	assert.ok(r3.status === "released");
	assert.equal(r3.runId, second.runId, "the planter's first open releases it at once");
});

test("every concern the organization sees is one the planter sees, with the same id and evidence; the organization's read carries no person, check-in, growth-source or assessment text", async () => {
	const { p, run, director } = await assessedPlant("Eastgate Church");
	ok(await assessments.markAssessmentSeen(c0.db, p.actor, { runId: run.runId }));
	const plant = await view(p);
	const org = (await orgView(director, p))!;
	assert.ok(org.assessment.status === "released");
	assert.ok(plant.current!.concerns.length > 0, "the scripted draft raises a concern");
	assert.deepEqual(org.assessment.concerns, plant.current!.concerns, "same concern ids and evidence");
	assert.equal(org.plant.health, "watch");

	const payload = JSON.stringify(org);
	const people = await c0.rows(sql`SELECT id,display_name FROM person WHERE plant_id=${p.id}`);
	for (const who of people) {
		assert.ok(!payload.includes(who.id), "no person id");
		assert.ok(!payload.includes(who.display_name), "no person name");
	}
	const a = plant.current!;
	for (const text of [a.summary, a.focus.body, a.focus.title, ...a.supporting.map((x) => x.body)])
		assert.ok(!payload.includes(text), "no assessment text");
	for (const field of ['"body"', '"title"', '"text"', '"note"', '"source"', '"disengaged"', '"evidence":[{"person'])
		assert.ok(!payload.includes(field), `no ${field} field`);
	assert.ok(!payload.includes("canary"), "no private note, score or check-in");
});

test("a plant that does not share findings shows Limited visibility and nothing of its assessment, never On track; a concern on a category it does not share is held back", async () => {
	const { p, run, director } = await assessedPlant("Southridge Church", { share: false });
	ok(await assessments.markAssessmentSeen(c0.db, p.actor, { runId: run.runId }));
	const org = (await orgView(director, p))!;
	assert.deepEqual(org.assessment, { status: "withheld" });
	assert.equal(org.plant.health, "limited_visibility");

	await c0.admin.execute(sql`UPDATE affiliation SET shared_findings=true,share_people=true,share_meetings=true,
		share_tasks=true WHERE plant_id=${p.id}`);
	const partly = (await orgView(director, p))!;
	assert.ok(partly.assessment.status === "released");
	const plantConcerns = (await view(p)).current!.concerns;
	const teams = plantConcerns.filter((x) => x.evidence.some((e) => /^(coverage|training)\./.test(e.key)));
	assert.ok(teams.length > 0, "the scripted draft raises a ministry-responsibility concern");
	assert.ok(partly.assessment.concerns.every((x) => !teams.some((y) => y.id === x.id)));
	assert.equal(partly.assessment.withheld, teams.length);
	assert.equal(partly.plant.health, "limited_visibility");
});

test("trends show the latest twelve complete assessments, newest first and dated; a fact an older snapshot did not have reads Not measured, never zero", async () => {
	const { p, run } = await assessedPlant("Brookside Church");
	for (let week = 1; week <= 13; week++)
		await c0.admin.execute(sql`INSERT INTO assessment_run SELECT (jsonb_populate_record(NULL::assessment_run,
			to_jsonb(r)||jsonb_build_object('id',gen_random_uuid(),'demand_key','manual/'||gen_random_uuid(),
				'as_of',r.as_of-make_interval(days=>${week * 7}),'available_at',r.available_at-make_interval(days=>${week * 7}),
				'facts',jsonb_set(CASE WHEN ${week}=11 THEN r.facts-'training' ELSE r.facts END,'{today}',
					to_jsonb(((r.as_of-make_interval(days=>${week * 7})) AT TIME ZONE 'America/Chicago')::date::text))))).*
			FROM assessment_run r WHERE r.id=${run.runId}`);
	const before = calls;
	const history = ok(await assessments.readHistory(c0.db, p.actor, {}));
	assert.equal(calls, before);
	assert.equal(history.runs.length, 12);
	assert.equal(history.runs[0]!.runId, run.runId);
	const asOf = history.runs.map((r) => Date.parse(r.asOf));
	assert.deepEqual(
		asOf,
		[...asOf].sort((a, b) => b - a),
		"newest first",
	);
	const training = c.TREND_FACTS.findIndex((f) => f.key === "training.complete");
	const adults = c.TREND_FACTS.findIndex((f) => f.key === "committedAdults.known");
	assert.deepEqual(history.runs[11]!.values[training], { state: "not_measured" });
	assert.deepEqual(history.runs[11]!.values[adults], { state: "measured", value: 30 });
	assert.deepEqual(history.runs[0]!.values[training], { state: "unknown" }, "no required training assigned is Unknown");
});

const refused = (reply: { status: string; error?: { code: string } }) =>
	reply.status === "refused" ? reply.error!.code : `not refused (${reply.status})`;
