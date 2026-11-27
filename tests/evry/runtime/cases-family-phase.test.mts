import test, { after, before } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import type { AssessmentView } from "../../../packages/contracts/src/intelligence/index.ts";
import {
	createAssessmentJob,
	createAssessments,
	createFacts,
	createRelease,
	createSignals,
	runAssessmentBatch,
} from "../../../packages/domain/src/intelligence/index.ts";
import { createWikiProducer } from "../../../packages/domain/src/wiki/index.ts";
import { scriptedAssessmentDrafter } from "../../../packages/evry-scripted/src/scripted-assessment.ts";
import { CANARY, church, type Church as AssessedChurch } from "../../integration/intelligence/assessment-church.mts";
import { ok, type Actor } from "../../support/fixture.mts";
import { nativePorts } from "../evals/settings-ports.mts";
import { caseWorld, propose, read, reads, rowsOf, sql, type CaseWorld, type Play, type Reply } from "./case-world.mts";
import { seedFoundations } from "./foundations.mts";

let ch: AssessedChurch;
let w: CaseWorld;
before(async () => {
	ch = await church("familyphase", { clock: new Date("2026-10-13T16:00:00Z"), max: 10 });
	await ch.release("methodology-2026.10");
	w = await caseWorld("familyphase", { on: ch.database, native: nativePorts() });
});
after(() => (w ?? ch?.database)?.close());

const assessments = createAssessments();
async function runJob(during?: () => Promise<void>, limit = 20) {
	const { t } = await w.one<{ t: string }>(
		sql`SELECT to_char((clock_timestamp()+interval '1 millisecond') AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS t`,
	);
	await runAssessmentBatch(
		createAssessmentJob({ clock: { now: () => t as never } }),
		w.db,
		scriptedAssessmentDrafter(during ? { during } : {}),
		limit,
	);
}

test("AC:EVRY-FAMILY-INTELLIGENCE-PHASE measures stay measured, attested or Unknown, one reader qualifies alone, only a person moves the phase, and a stale or revoked source publishes nothing", async () => {
	const network = await ch.network();
	const p = await ch.harvest("Harvest Point", { network });
	const A = await w.seated({ kind: "plant", id: p.id }, "admin");
	const c = await w.church({}, { plant: { kind: "plant", id: p.id }, admin: A });
	const owner = p.owner as unknown as Actor;
	const authority = () => w.authorityOf(owner);
	const view = async () => ok(await assessments.readAssessment(w.db, await authority(), {})) as AssessmentView;
	const runs = () =>
		w.rows(sql`SELECT id,outcome,reason FROM assessment_run WHERE plant_id=${p.id} ORDER BY captured_at,id`);
	const criteria = async (phase: number) =>
		rowsOf(await w.look(A, "intelligence.readExitCriteria", { phase }), "criterion");
	const status = async (phase: number, id: string) => {
		const row = (await criteria(phase)).find((r) => r.id === id);
		return row && [row.fields.status, row.fields.reading];
	};

	const C = await w.seated(null as never, "owner");
	const created = await w.apply(C, "onboarding.createPlant", { name: "Cedar Plant" });
	assert.ok(created.receipt);
	const plant = await w.one<{ id: string; phase: number }>(
		sql`SELECT p.id,p.phase FROM plant p JOIN seat s ON s.plant_id=p.id WHERE s.account_id=${C.id}`,
	);
	assert.equal(plant.phase, 1, "a church is created in Phase 1 with nothing read or measured");

	const seeded = rowsOf(await w.look(A, "intelligence.readColdStartGuidance", {}));
	assert.match(JSON.stringify(seeded), /Answer 7 attestations/);
	await w.apply(A, "intelligence.requestRefresh", {});
	await runJob();
	const first = (await view()).current!;
	const director = network.director as unknown as Actor;
	await w.admin.execute(
		sql`UPDATE affiliation SET share_people=true,share_meetings=true,share_tasks=true,share_ministry_teams=true WHERE id=${p.affiliation}`,
	);
	const seen = () => w.count(sql`SELECT count(*)::int AS n FROM assessment_seen WHERE run_id=${first.runId}`);
	const health = async () => rowsOf(await w.look(director, "oversight.listPlants", {}))[0].fields.health;
	await w.look(owner, "intelligence.readAssessment", {});
	assert.deepEqual([await seen(), await health()], [0, "Not yet assessed"], "Evry's read is not a person opening it");
	const aged = async (hours: number) => {
		await w.admin.execute(
			sql`UPDATE assessment_run SET available_at=available_at-make_interval(hours=>${hours}::int) WHERE id=${first.runId}`,
		);
		await createRelease().releaseDueAssessments(w.db);
	};
	await aged(71);
	assert.deepEqual([await seen(), await health()], [0, "Not yet assessed"], "not released before 72 hours");
	await aged(1);
	assert.deepEqual([await seen(), await health()], [0, "Watch"], "released after 72 hours unopened");
	ok(await assessments.markAssessmentSeen(w.db, await authority(), { runId: first.runId }));
	assert.deepEqual([await seen(), await health()], [1, "Watch"]);
	await w.admin.execute(sql`UPDATE affiliation SET shared_findings=false WHERE id=${p.affiliation}`);
	assert.equal(await health(), "Not shared", "a released health follows the current sharing");
	await w.admin.execute(sql`UPDATE affiliation SET shared_findings=true WHERE id=${p.affiliation}`);

	const scorecard = await w.look(A, "intelligence.readScorecard", {});
	const lens = (reply: Reply, key: string) => rowsOf(reply).find((r) => r.fields.lens === key)!.fields;
	assert.deepEqual(
		["vision", "critical_mass", "prayer", "generosity", "training"].map((k) => [k, lens(scorecard, k).evidence]),
		[
			["vision", "Measured"],
			["critical_mass", "Measured"],
			["prayer", "Unknown"],
			["generosity", "Unknown"],
			["training", "Unknown"],
		],
	);
	assert.equal(
		lens(scorecard, "training").facts,
		"Required training completed: Unknown; Required training assigned: 0",
		"nobody required is Unknown, never 0%",
	);
	assert.deepEqual(await status(3, "training_complete"), ["no data yet", null]);
	const native = ok(await createFacts().readFacts(w.db, await authority())) as Reply;
	assert.deepEqual(native.training, { status: "unknown", complete: 0, total: 0, programs: [] });

	const acquired = ["met", "5 days since the newest committed adult, on 2026-10-08"];
	const D0 = ch.day(-5);
	assert.deepEqual(await status(1, "growth_trajectory"), acquired);
	const [newest] = await w.rows<{ id: string }>(
		sql`SELECT person_id AS id FROM commitment WHERE plant_id=${p.id} ORDER BY signed_on DESC LIMIT 1`,
	);
	await w.apply(A, "people.withdrawCommitment", { personId: newest!.id, effectiveOn: "2026-10-13" });
	const cohort = (await w.look(A, "intelligence.readCommittedAdultCohort", {})).facts;
	assert.deepEqual([cohort.known, cohort.exact, cohort.measuredOn], [29, 29, "Oct 13, 2026"], "current eligibility");
	assert.deepEqual(await status(1, "committed_adults"), ["not met", "29 of 30 committed adults"]);
	assert.deepEqual(await status(1, "growth_trajectory"), acquired, `the first adult signed on ${D0} stays acquired`);
	const stored = (await w.rows(sql`SELECT signed_on::text FROM commitment WHERE person_id=${newest!.id}`))[0]!;
	assert.equal(stored.signed_on, "2026-10-08");
	assert.deepEqual((await view()).current!.runId, first.runId);

	const signals = createSignals();
	const candidate = async (name: string, input: object) =>
		ok(
			await signals.attestCandidate(w.db, await authority(), {
				requestKey: randomUUID(),
				expectedRevision: "0",
				input: {
					personId: await c.person(name),
					periodStart: "2026-08-15",
					periodEnd: "2026-10-13",
					statement: "Seen at every setup.",
					...input,
				},
			}),
		).candidate;
	assert.deepEqual(
		[
			await candidate("Both Sixty", { attended: true, volunteered: true }),
			await candidate("Attended Only", { attended: true, volunteered: false }),
			await candidate("Served Only", { attended: false, volunteered: true }),
		].map((x) => [x.days, x.established, x.reasons]),
		[
			[60, true, []],
			[60, false, ["volunteering_not_attested"]],
			[60, false, ["attendance_not_attested"]],
		],
	);

	const practices = () => w.look(A, "meetings.listCompletedPreLaunchPractices", {});
	for (const [n, date] of ["2026-10-01", "2026-10-03", "2026-10-06", "2026-10-08"].entries()) {
		const made = await w.apply(A, "meetings.schedule", {
			type: "prelaunch_practice",
			title: `Practice ${n + 1}`,
			date,
			time: "10:00",
		});
		const { id } = await w.one<{ id: string }>(
			sql`SELECT id FROM meeting WHERE plant_id=${p.id} AND title=${`Practice ${n + 1}`}`,
		);
		assert.ok(made.receipt);
		if (n < 3) await w.apply(A, "meetings.completePractice", { meetingId: id });
	}
	const [held] = rowsOf(await practices());
	assert.deepEqual([held.fields.held, held.fields.criterion], ["3", "met"], "a scheduled practice is not a held one");
	assert.deepEqual(await criteria(6), [], "no Phase 6 contact measure exists, so none reads zero");

	assert.equal(rowsOf(await w.look(A, "signals.listDefinitions", {})).length, 7);
	const key = "prayer_rhythm_established";
	await w.apply(A, "signals.attest", { key, value: "yes", asOf: "2026-10-12", detail: "We pray every Tuesday" });
	await w.apply(A, "signals.reaffirm", { key });
	await w.apply(A, "signals.correct", {
		action: "correct",
		key,
		value: "not_yet",
		asOf: "2026-10-13",
		detail: "We stopped last month",
	});
	const told = rowsOf(await w.look(A, "signals.getHistory", {}));
	assert.deepEqual(
		told.map((r) => r.fields.detail ?? null).filter(Boolean),
		["We stopped last month", "We pray every Tuesday", "We pray every Tuesday"],
		"a correction keeps what was said before",
	);

	const asked = await w.quiet(() =>
		w.ask(A, "Are we ready, and how is my family doing?", [
			reads("intelligence.readAssessment", {}),
			reads("intelligence.readScorecard", {}),
			reads("intelligence.readExitCriteria", {}),
			reads("phases.readReadiness", {}),
			reads("intelligence.readJourney", {}),
		]),
	);
	assert.doesNotMatch(JSON.stringify([asked.prompts, asked.saved]), new RegExp(`${CANARY}|struggling|strained`));
	const inputs = JSON.stringify(
		(await w.rows(sql`SELECT model_input FROM assessment_run WHERE plant_id=${p.id}`)).map((r) => r.model_input),
	);
	assert.doesNotMatch(inputs, new RegExp(`${CANARY}|struggling|not_qualified`), "no private care or human judgment");
	assert.deepEqual(
		asked.offered.filter((o) =>
			/care|privateWeek|executeDemand|publishAssessment|settleRun|markAssessmentSeen/i.test(o),
		),
		[],
	);

	const cited = () =>
		w.look(A, "intelligence.readAssessment", {}).then((r: Reply) =>
			rowsOf(r)
				.map((x) => String(x.fields.cites))
				.join("\n"),
		);
	assert.match(await cited(), /Our follow-up practice/);
	const run = (await view()).current!;
	const passage = [run.focus, ...run.supporting, ...run.positives]
		.flatMap((x) => x.citations)
		.find((x) => /Our follow-up practice/.test(x.label))!.key;
	const resolved = async () =>
		ok(await assessments.resolveCitation(w.db, await authority(), { runId: run.runId, key: passage })) as Reply;
	assert.match((await resolved()).text, /network coach/);
	await w.admin.execute(sql`UPDATE affiliation SET ended_at=clock_timestamp() WHERE id=${p.affiliation}`);
	assert.deepEqual(await resolved(), { status: "unavailable", key: passage });
	assert.doesNotMatch(await cited(), /network coach|within two days/, "none of its words");

	await w.apply(A, "intelligence.submitFeedback", { ordinal: 0, rating: "not_useful", comment: "Not our focus" });
	const mine = await w.look(A, "intelligence.readOwnFeedback", {});
	assert.deepEqual(
		rowsOf(mine).map((r) => [r.fields.rating, r.fields.comment]),
		[["Not useful", "Not our focus"]],
	);
	assert.deepEqual(rowsOf(await w.look(owner, "intelligence.readOwnFeedback", {})), [], "only its author's");
	assert.equal((await view()).current!.runId, run.runId);

	const before = await runs();
	await w.apply(A, "intelligence.requestRefresh", {});
	await runJob(async () => {
		await w.admin.execute(sql`UPDATE commitment SET signed_on='2026-10-07' WHERE person_id=${newest!.id}`);
	}, 1);
	const after = await runs();
	assert.deepEqual(
		after.slice(before.length).map((r) => [r.outcome, r.reason]),
		[["superseded", "changed_input"]],
		"a source that moved while it was drafted publishes nothing",
	);
	assert.equal((await view()).current!.runId, run.runId, "the earlier assessment stays current");
	assert.equal((await w.look(A, "intelligence.readAssessment", {})).facts.runId, run.runId, "Evry quotes it too");
	const jobs = () =>
		w.rows(sql`SELECT id,state FROM job WHERE kind='assessment' AND subject_record_id=${p.id} ORDER BY id`);
	const settled = await jobs();
	assert.equal((await w.prepare(A, "intelligence.requestRefresh", {})).status, "pending");
	assert.deepEqual(await jobs(), settled, "a review asks for nothing");

	const phaseOf = async (id: string) => Number((await w.one(sql`SELECT phase FROM plant WHERE id=${id}`)).phase);
	assert.equal(await phaseOf(p.id), 1, "no measure or assessment moves a phase");
	const reason = "Our teams are in training.";
	await w.apply(A, "phases.transition", { toPhase: 3, reason });
	const declared = rowsOf(await w.look(A, "phases.readHistory", {}));
	assert.deepEqual(
		[await phaseOf(p.id), declared[0].fields.phase, declared[0].fields.declarable],
		[3, "3", false],
		"a person's own move, to the phase they named",
	);
	const same = await w.prepare(A, "phases.transition", { toPhase: 3, reason });
	assert.match(same.review.refusal!, /^The church is already in /);
	await assert.rejects(w.approve(A, same), { code: "review_closed" });
	assert.equal(await w.count(sql`SELECT count(*)::int AS n FROM phase_transition WHERE plant_id=${p.id}`), 1);
	assert.equal(rowsOf(await w.look(A, "phases.readCatalog", {}), "phase").length, 7);
	assert.match(JSON.stringify(await w.look(A, "intelligence.readJourney", {})), /Our teams are in training/);
	await w.apply(C, "phases.declare", { phase: 0 });
	assert.equal(await phaseOf(plant.id), 0);

	const articles = await seedFoundations(w.admin);
	const wiki = createWikiProducer();
	const readers = [
		await w.seated({ kind: "plant", id: plant.id }, "admin"),
		await w.seated({ kind: "plant", id: plant.id }, "admin"),
	] as const;
	const finish = async (who: Actor, some: string[], fraction: string) => {
		for (const articleId of some)
			ok(
				await wiki.updateProgress(w.db, await w.authorityOf(who), {
					requestKey: randomUUID(),
					input: { articleId, fraction },
				}),
			);
	};
	const stats = async (who: Actor) => {
		const { discoveryRead, discoveryComplete, churchPhase } = (await w.look(who, "wiki.reading.stats", {})).facts;
		const { qualifyingReader } = ok(await wiki.readingStats(w.db, await w.authorityOf(who), {})) as Reply;
		return [discoveryRead, discoveryComplete, churchPhase, qualifyingReader];
	};
	await finish(readers[0], articles.slice(0, 4), "0.9");
	await finish(readers[1], articles.slice(4), "0.9");
	await finish(readers[1], articles.slice(0, 1), "0.80");
	assert.deepEqual(await stats(readers[0]), [4, false, 0, false], "readers never pool");
	assert.deepEqual(await stats(readers[1]), [2, false, 0, false], "exactly 80 percent is not read");
	await finish(readers[0], articles.slice(4), "0.81");
	assert.deepEqual(await stats(readers[0]), [6, true, 0, true], "one reader of all six");
	assert.equal(await phaseOf(plant.id), 0, "reading moves no phase");

	const said = "Refresh our assessment and move us to the next phase";
	const play: Play = [
		() => [
			read("intelligence.readCommittedAdultCohort", {}),
			read("intelligence.readAssessmentRun", { runId: run.runId }),
		],
		() => [
			propose("phases.transition", { toPhase: 4, reason }),
			propose("intelligence.submitFeedback", { ordinal: 0, rating: "useful" }),
		],
	];
	const move = await w.prepare(A, "phases.transition", { toPhase: 4, reason: "Four weeks out." });
	await c.foreignReview(move);
	await c.foreign(said, play, { secrets: ["Harvest Point", "Adult 01"], on: { onError: "go_on" } });
	await c.failedWrite(move, "phase_transition");
	assert.equal(await phaseOf(p.id), 4);
});
