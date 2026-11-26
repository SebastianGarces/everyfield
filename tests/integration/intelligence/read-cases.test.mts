import test, { after, before } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import * as c from "../../../packages/contracts/src/intelligence/index.ts";
import { coldStartTitle } from "../../../packages/contracts/src/intelligence/cold-start.ts";
import { sql } from "../../../packages/db/src/query.ts";
import { RequestActor } from "../../../packages/domain/src/access/session.ts";
import {
	createAssessmentJob,
	createAssessments,
	createFacts,
	createSignals,
	runAssessmentBatch,
	type Drafter,
} from "../../../packages/domain/src/intelligence/index.ts";
import { getPlant, listPlants } from "../../../packages/domain/src/oversight/index.ts";
import { peopleWriter, withPeopleWrite } from "../../../packages/domain/src/people/index.ts";
import { scriptedAssessmentDrafter } from "../../../packages/evry-scripted/src/scripted-assessment.ts";
import { QUALITY, STANDING } from "../../../apps/web/src/features/intelligence/assessment-model.ts";
import { ok } from "../../support/fixture.mts";
import { caseOf, type Case } from "../target/sql/core/support.mts";
import { CANARY, church, type Church, type ChurchPlant, type StoredRun } from "./assessment-church.mts";

type Dated = Case & { clock: { now: string } };
const K = (id: string) => caseOf("intelligence", id) as Dated;
const given = <T,>(k: Case, name: string) => (k.given[name] as { value: T }).value;
const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const NOW = K("PI-CASE-019").clock.now;

let calls = 0;
const counted = (options: Parameters<typeof scriptedAssessmentDrafter>[0] = {}): Drafter => {
	const inner = scriptedAssessmentDrafter(options);
	return { id: inner.id, draft: (call, signal) => (calls++, inner.draft(call, signal)) };
};

let c0: Church;
let clockMs = Date.parse(NOW);
const clock = { now: () => new Date(clockMs).toISOString() as never };
const job = createAssessmentJob({ clock });
const assessments = createAssessments({ clock });
const signals = createSignals({ clock });

type Seated = { id: string; actor: RequestActor };
async function seat(w: Church, p: ChurchPlant, role: "admin" | "member"): Promise<Seated> {
	const a = await w.database.actor(p as never, role);
	return { id: a.id, actor: (await RequestActor.resolve(w.db, a.session as never)) as RequestActor };
}
async function publish(p: { actor: RequestActor; id: string }, drafter: Drafter = counted(), on: Church = c0) {
	const requestId = randomUUID();
	ok(await (on === c0 ? assessments : a16).requestRefresh(on.db, p.actor, { requestId }));
	await runAssessmentBatch(on === c0 ? job : job16, on.db, drafter, 20);
	return on.one<StoredRun & { source_revision: string; rubric_sha256: string; rubric_version: string }>(
		sql`SELECT * FROM assessment_run WHERE plant_id=${p.id} AND demand_key=${"manual/" + requestId}`,
	);
}
const view = async (p: { actor: RequestActor }) => ok(await assessments.readAssessment(c0.db, p.actor, {}));
const refusedCode = (r: { status: string; error?: { code: string } }) =>
	r.status === "refused" ? r.error!.code : r.status;
const replica = (q: ReturnType<typeof sql>, on: Church = c0) =>
	on.admin.transaction(async (tx) => {
		await tx.execute(sql`SET LOCAL session_replication_role = replica`);
		await tx.execute(q);
	});
const shareAll = (p: { affiliation: string | null }, people = true, ministry = true) =>
	c0.admin.execute(sql`UPDATE affiliation SET share_people=${people},share_meetings=true,share_tasks=true,
		share_ministry_teams=${ministry},shared_findings=true WHERE id=${p.affiliation}`);
const directorOf = async (n: Awaited<ReturnType<Church["network"]>>) =>
	(await RequestActor.resolve(c0.db, n.director.session as never)) as RequestActor;
let shared: Awaited<ReturnType<Church["network"]>> | undefined;
const theNetwork = async () => (shared ??= await c0.network("Case Read Network"));
const noticesOf = (p: { id: string }, on: Church = c0) =>
	on.one<{ n: number }>(sql`SELECT ((SELECT count(*) FROM notice WHERE tenant_id=${p.id})
		+(SELECT count(*) FROM mail WHERE tenant_id=${p.id}))::int AS n`);

const K16 = K("PI-CASE-016");
let c16: Church;
const clock16 = { now: () => K16.clock.now as never };
const job16 = createAssessmentJob({ clock: clock16 });
const a16 = createAssessments({ clock: clock16 });
const f16 = createFacts({ clock: clock16 });
before(async () => {
	c0 = await church("pibread", { clock: new Date(Date.parse(NOW) - HOUR) });
	await c0.release("methodology-2026.11");
	c16 = await church("pibread16", { clock: new Date(Date.parse(K16.clock.now) - HOUR) });
	await c16.release("methodology-2026.10");
});
after(async () => {
	await c0?.database.close();
	await c16?.database.close();
});

test("AC:PI-CASE-016 an Admin's cached read of R1 shows its exact as-of and that the records moved on, calls no model, and two renders write no seen mark; one explicit open writes one", async () => {
	const k = K16;
	const p = await c16.harvest("Case 016 Church");
	const A = await seat(c16, p, "admin");
	const r1 = await publish({ actor: A.actor, id: p.id }, counted(), c16);
	assert.equal(r1.outcome, "published");
	assert.equal(new Date(r1.as_of).toISOString(), new Date(given<string>(k, "as_of")).toISOString());
	await c16.committed(p, "Case 016 New Adult", 0);
	const since = ok(await f16.readFactsSinceRun(c16.db, A.actor, {}));
	assert.notEqual(since.facts.sourceRevision, r1.source_revision, "the current source differs from the assessed one");
	assert.equal(since.outOfDateRunId === r1.id, k.expected.result.stale);

	const seenRows = () =>
		c16.one<{ n: number }>(sql`SELECT count(*)::int AS n FROM assessment_seen WHERE run_id=${r1.id}`);
	const opened = () =>
		c16.one<{ n: number }>(sql`SELECT count(*)::int AS n FROM audit_event WHERE tenant_id=${p.id}
			AND action='intelligence.assessment_opened'`);
	const before = calls;
	for (let pass = 0; pass < given<number>(k, "render_passes"); pass++) {
		const v = ok(await a16.readAssessment(c16.db, A.actor, {}));
		assert.equal(v.current!.runId, r1.id, k.expected.result.assessment as string);
		assert.equal(Date.parse(v.current!.asOf), Date.parse(k.expected.result.as_of as string));
		assert.equal(v.current!.ageDays, 0);
		assert.equal(v.seen, false);
	}
	assert.equal(calls - before, k.expected.result.model_calls);
	assert.equal((await seenRows()).n, k.expected.result.render_seen_writes);
	assert.equal((await opened()).n, 0);

	const ack = () => a16.markAssessmentSeen(c16.db, A.actor, { runId: r1.id });
	assert.deepEqual(
		[ok(await ack()).outcome, ok(await ack()).outcome],
		["recorded", "already_seen"],
		"ACK1 and its replay",
	);
	assert.equal((await seenRows()).n, k.expected.result.ack_receipts);
	assert.equal((await opened()).n, 1, "one audit row for the open");
	assert.equal(ok(await a16.readAssessment(c16.db, A.actor, {})).seen, true);
	assert.equal(calls - before, 0);
	assert.equal((await noticesOf(p, c16)).n, 0, "event null: no notice or mail");
});

test("AC:PI-CASE-018 a legacy index citation never reads as the stored answer: the snapshot keeps true, the typed key opens true, a mismatch and an unknown path read can't be verified", async () => {
	const k = K("PI-CASE-018");
	const p = await c0.harvest("Case 018 Church");
	const [attested] = given<{ manual: { attestations: { signalKey: string; value: boolean }[] } }>(k, "snapshot").manual
		.attestations;
	const answer = (v: boolean) => (v ? "yes" : "not_yet");
	ok(
		await signals.attest(c0.db, p.actor, {
			requestKey: randomUUID(),
			expectedRevision: "0",
			input: { key: attested!.signalKey, value: answer(attested!.value) },
		}),
	);
	const r = await publish(p);
	const typed = given<{ path: string; value: boolean }>(k, "typed_current_factref");
	const key = `attestations.${typed.path.split(".").at(-1)}`;
	const [legacyPath, legacyValue] = given<string>(k, "legacy_citation").split("=") as [string, string];
	const stored = () =>
		c0.one<{ facts: unknown; result: StoredRun["result"] }>(
			sql`SELECT facts,result FROM assessment_run WHERE id=${r.id}`,
		);
	const cite = (citations: Record<string, unknown>) =>
		replica(sql`UPDATE assessment_run SET result=jsonb_set(result,'{citations}',(result->'citations')||${JSON.stringify(citations)}::jsonb)
			WHERE id=${r.id}`);
	const fact = (k2: string, value: unknown) => ({
		kind: "fact",
		key: k2,
		label: `Answer: ${attested!.signalKey}`,
		value,
	});
	await cite({
		[key]: fact(key, answer(typed.value)),
		[legacyPath]: fact(legacyPath, answer(legacyValue === "true")),
	});
	const before = await stored();
	const snapshotValue = c.factCatalog(c.plantFacts.parse(before.facts)).find((f) => f.key === key)!.value;
	assert.equal(snapshotValue === "yes", k.expected.result.legacy_stored);

	const resolve = (citation: string) => assessments.resolveCitation(c0.db, p.actor, { runId: r.id, key: citation });
	const current = ok(await resolve(key));
	assert.ok(current.status === "verified" && current.kind === "fact");
	assert.equal(current.value === "yes", k.expected.result.current_value);
	assert.equal(current.asOf, new Date(r.as_of).toISOString());
	const legacy = ok(await resolve(legacyPath));
	assert.deepEqual(legacy, { status: k.expected.result.unknown_path, key: legacyPath });
	const legacyCited = (before.result!.citations[legacyPath] as { value: string }).value === "yes";
	assert.equal(legacyCited, k.expected.result.legacy_cited);
	assert.equal(legacyCited !== (current.value === "yes"), k.expected.result.disagreement);

	await cite({ [key]: fact(key, answer(!typed.value)) });
	assert.deepEqual(
		ok(await resolve(key)),
		{ status: "unverifiable", key },
		"a cited value that disagrees with the snapshot is refused",
	);
	await cite({ "manual.nothing.here": fact("manual.nothing.here", "yes") });
	assert.deepEqual(ok(await resolve("manual.nothing.here")), {
		status: k.expected.result.unknown_path,
		key: "manual.nothing.here",
	});
	assert.deepEqual((await stored()).facts, before.facts, "the stored snapshot value is never rewritten");
	assert.equal(refusedCode(await resolve("no.such.key")), "not_found");
	const member = await seat(c0, p, "member");
	assert.equal(
		refusedCode(await assessments.resolveCitation(c0.db, member.actor, { runId: r.id, key })),
		"access_denied",
	);
});

test("AC:PI-CASE-019 eight lens tiles: Vision measured with no insight is Not raised, Prayer is Unknown, generosity and funding keep their own ages, Training is Watch, and the withheld leadership concern carries no reason", async () => {
	const k = K("PI-CASE-019");
	clockMs = Date.parse(NOW);
	const network = await theNetwork();
	const p = await c0.harvest("Case 019 Church", { network });
	const adult = await c0.one<{ id: string }>(
		sql`SELECT id FROM person WHERE plant_id=${p.id} AND display_name='Adult 06'`,
	);
	const program = await c0.one<{ id: string; version: number }>(sql`INSERT INTO training_program(plant_id,name,required)
		VALUES(${p.id},'Safe kids',true) RETURNING id,version`);
	await c0.admin.execute(sql`INSERT INTO training_assignment(plant_id,program_id,person_id,version,state,effective_on)
		VALUES(${p.id},${program.id},${adult.id},${program.version},'active',${c0.day(-2)})`);
	assert.equal(given(k, "generosity"), "true_attested_age45days");
	assert.equal(given(k, "funding"), "true_attested_nonexpiring");
	for (const [key, asOf] of [
		["core_group_giving", c0.day(-45)],
		["financial_base_established", c0.day(0)],
	] as const)
		ok(
			await signals.attest(c0.db, p.actor, {
				requestKey: randomUUID(),
				expectedRevision: "0",
				input: { key, value: "yes", asOf },
			}),
		);
	const r = await publish(p);
	const before = calls;
	const a = (await view(p)).current!;
	assert.equal(a.runId, r.id);
	assert.equal(calls, before, "the scorecard read calls no model");
	assert.equal(a.lenses.length, k.expected.result.tile_count);
	assert.equal(given(k, "eight_lenses"), true);
	const tile = Object.fromEntries(a.lenses.map((l) => [l.key, l]));
	assert.equal(given(k, "vision"), "measured_no_insight");
	assert.deepEqual([tile.vision!.quality, tile.vision!.points], ["measured", []]);
	assert.equal(STANDING[tile.vision!.standing].label, k.expected.result.vision);
	assert.equal(given(k, "prayer"), "unknown");
	assert.equal(QUALITY[tile.prayer!.quality].label, k.expected.result.prayer);
	assert.equal(tile.prayer!.standing, "insufficient", "Unknown never passes");
	assert.equal(tile.generosity!.quality, "attested");
	assert.deepEqual(
		tile.generosity!.attestations.map((x) => [x.key, x.answered, x.asOf, x.needsRenewing]),
		[
			["core_group_giving", true, c0.day(-45), true],
			["financial_base_established", true, c0.day(0), false],
		],
		"each answer keeps its own date and renewal",
	);
	assert.equal(given(k, "authorized_watch_insight"), "training");
	assert.equal(STANDING[tile.training!.standing].label, k.expected.result.training);
	assert.equal(given(k, "withheld_insight"), "leadership");
	const leadership = a.concerns.find((x) => x.lens === "leadership");
	assert.ok(leadership, "the planter sees the leadership concern");

	await shareAll(p, true, false);
	ok(await assessments.markAssessmentSeen(c0.db, p.actor, { runId: r.id }));
	const org = (await getPlant(c0.db, await directorOf(network), p.id, () => {}, clock))!;
	assert.ok(org.assessment.status === "released");
	assert.equal(org.assessment.concerns.find((x) => x.id === leadership.id) ?? null, null);
	assert.ok(org.assessment.withheld >= 1);
	assert.deepEqual(Object.keys(org.assessment).sort(), ["asOf", "concerns", "phase", "runId", "status", "withheld"]);
	const reason = (org.assessment as Record<string, unknown>).reason ?? null;
	assert.equal(reason, k.expected.result.withheld_leadership_reason);
	assert.doesNotMatch(JSON.stringify(org), /leadership|ministry responsibilities/i);
});

test("AC:PI-CASE-022 the network's health: Not shared, no concern from a near date alone, a readiness concern for a 30-day launch with an open role, Watch from a released concern, and a mixed concern withheld when people is off", async () => {
	const k = K("PI-CASE-022");
	clockMs = Date.parse(NOW);
	const plants = given<Record<string, number | string | boolean>[]>(k, "plants");
	const spec = Object.fromEntries(plants.map((x) => [x.id as string, x]));
	const network = await theNetwork();
	const director = await directorOf(network);
	const made: Record<string, ChurchPlant> = {};
	const launch = (p: { id: string }, days: number) =>
		c0.admin.execute(sql`INSERT INTO launch(plant_id,status,target_date) VALUES(${p.id},'scheduled',${c0.day(days)})`);

	made.P = await c0.harvest("Case 022 P", { network });
	assert.equal(spec.P!.sharing, "OFF");
	await c0.admin.execute(sql`UPDATE affiliation SET shared_findings=false WHERE id=${made.P.affiliation}`);
	for (const id of ["Q", "R"] as const) {
		made[id] = await c0.plant(`Case 022 ${id}`, { network });
		await shareAll(made[id]);
		const holder = await c0.person(made[id], `Case 022 ${id} Leader`);
		await c0.role(made[id], "worship", holder);
		if (Number(spec[id]!.role_gap)) await c0.role(made[id], "children", null);
		await launch(made[id], Number(spec[id]!.days_to_launch));
	}
	await c0.admin.execute(
		sql`UPDATE plant SET timezone=${(k.given.Q as { timezone: string }).timezone} WHERE id=${made.Q!.id}`,
	);
	made.S = await c0.harvest("Case 022 S", { network });
	await shareAll(made.S);
	const mixedKeys = ["committedAdults.count"];
	const r = await publish(
		made.S,
		counted({
			script: (d) => ({ ...d, focus: { ...d.focus, citations: [...new Set([...d.focus.citations, ...mixedKeys])] } }),
		}),
	);
	assert.equal(r.outcome, "published");
	ok(await assessments.markAssessmentSeen(c0.db, made.S.actor, { runId: r.id }));
	const mixed = (await view(made.S)).current!.concerns.find((x) => x.evidence.some((e) => e.key === mixedKeys[0]))!;
	assert.ok(
		mixed.evidence.some((e) => e.key.startsWith("coverage.")),
		"the concern needs people and ministry teams",
	);
	assert.deepEqual(given(k, "mixed_source_result_requires"), ["people", "ministry_teams"]);

	const health = async () =>
		Object.fromEntries(
			(await listPlants(c0.db, director, clock))!.plants
				.filter((x) => Object.values(made).some((p) => p.id === x.plantId))
				.map((x) => [Object.keys(made).find((id) => made[id]!.id === x.plantId)!, x.health]),
		);
	const h = await health();
	assert.equal(h.P, "limited_visibility");
	assert.deepEqual((await getPlant(c0.db, director, made.P.id, () => {}, clock))!.assessment, { status: "withheld" });
	assert.equal(k.expected.result.P, "Not shared");
	assert.equal(h.Q === "launch_readiness", k.expected.result.Q_date_only_concern);
	assert.equal(h.Q, "not_assessed", "a near date with no gap is no concern and never On track");
	assert.equal(h.R === "launch_readiness", k.expected.result.R_readiness_concern);
	assert.equal(h.S, (k.expected.result.S as string).toLowerCase());
	const shared = (await getPlant(c0.db, director, made.S.id, () => {}, clock))!.assessment;
	assert.ok(shared.status === "released" && shared.concerns.some((x) => x.id === mixed.id));

	assert.equal(given(k, "people_sharing"), "OFF");
	await shareAll(made.S, false, true);
	const off = (await getPlant(c0.db, director, made.S.id, () => {}, clock))!;
	assert.ok(off.assessment.status === "released");
	assert.equal(off.assessment.concerns.find((x) => x.id === mixed.id) ?? null, k.expected.result.withheld_mixed_result);
	assert.ok(off.assessment.withheld >= 1);
	assert.equal(off.plant.health, "limited_visibility", "a withheld concern is never On track");
	assert.doesNotMatch(JSON.stringify(off), new RegExp(`${CANARY}|Adult 0|committedAdults`));
});

test("AC:PI-CASE-023 the network sees the prior released R0 at 71h59m59s after the new result's availability and the new result at exactly 72h; every concern it sees is the planter's own", async () => {
	const k = K("PI-CASE-023");
	clockMs = Date.parse(NOW);
	const network = await theNetwork();
	const director = await directorOf(network);
	const p = await c0.harvest("Case 023 Church", { network });
	await shareAll(p);
	const r0 = await publish(p);
	ok(await assessments.markAssessmentSeen(c0.db, p.actor, { runId: r0.id }));
	const r1 = await publish(p);
	const available = given<string>(k, "available_at");
	const earlier = new Date(Date.parse(available) - 7 * DAY).toISOString();
	await replica(sql`UPDATE assessment_run SET available_at=${earlier}::timestamptz WHERE id=${r0.id}`);
	await replica(sql`UPDATE assessment_seen SET seen_at=${earlier}::timestamptz WHERE run_id=${r0.id}`);
	await replica(sql`UPDATE assessment_run SET available_at=${available}::timestamptz WHERE id=${r1.id}`);
	assert.equal(given(k, "eligible_opened"), false);
	assert.equal(
		(await c0.one<{ n: number }>(sql`SELECT count(*)::int AS n FROM assessment_seen WHERE run_id=${r1.id}`)).n,
		0,
	);
	assert.equal((await view(p)).current!.runId, r1.id, "the planter reads the new result at once");

	const [justBefore, atBoundary] = given<string[]>(k, "times");
	assert.equal(Date.parse(justBefore!) - Date.parse(available), 72 * HOUR - 1000, "71h59m59s");
	assert.equal(Date.parse(atBoundary!) - Date.parse(available), 72 * HOUR, "72h");
	const released = async (at: string) => {
		clockMs = Date.parse(at);
		return (await getPlant(c0.db, director, p.id, () => {}, clock))!.assessment;
	};
	const label = { [r0.id]: given<string>(k, "prior_released"), [r1.id]: "eligible_new_result" };
	const before = await released(justBefore!);
	assert.ok(before.status === "released");
	assert.equal(label[before.runId], k.expected.result["71h59m59s"]);
	const at = await released(atBoundary!);
	assert.ok(at.status === "released");
	assert.equal(label[at.runId], k.expected.result["72h"]);

	assert.equal(given(k, "same_category"), true);
	const planter = ok(await assessments.readRun(c0.db, p.actor, { runId: r1.id })).concerns;
	assert.ok(planter.length > 0);
	assert.deepEqual(at.concerns, planter, "the same concern ids and evidence as the planter's");
	const unmatched = at.concerns.filter((x) => !planter.some((y) => y.id === x.id));
	assert.equal(unmatched.length > 0, k.expected.result.unmatched_concern_accepted);
	assert.ok(
		at.concerns.every((x) => x.id.startsWith(`${r1.id}:`)),
		"an organization concern is a planter concern id",
	);
	clockMs = Date.parse(NOW);
});

test("AC:PI-CASE-024 an Admin's rating and comment on one insight is their own row, a replay keeps it, it prefills, a foreign insight and another author change nothing, and no score moves", async () => {
	const k = K("PI-CASE-024");
	clockMs = Date.parse(NOW);
	const p = await c0.harvest("Case 024 Church");
	const A = await seat(c0, p, "admin");
	const B = { id: p.owner.id, actor: p.actor };
	const r1 = await publish({ actor: A.actor, id: p.id });
	const foreign = await c0.harvest("Case 024 Foreign");
	const rf = await publish(foreign);
	const runRow = async () =>
		JSON.stringify(
			await c0.one(sql`SELECT to_jsonb(r) AS run,(SELECT jsonb_agg(to_jsonb(i) ORDER BY i.ordinal) FROM assessment_insight i
				WHERE i.run_id=r.id) AS insights FROM assessment_run r WHERE r.id=${r1.id}`),
		);
	const runBefore = await runRow();
	const request = {
		runId: r1.id,
		ordinal: 0,
		rating: given<string>(k, "rating"),
		comment: given<string>(k, "comment"),
	};
	assert.equal(given(k, "rubric"), r1.rubric_version);

	const saved = ok(await assessments.submitFeedback(c0.db, A.actor, request));
	assert.deepEqual(
		[saved.outcome, saved.feedback.rating, saved.feedback.comment],
		["saved", request.rating, request.comment],
	);
	const replay = ok(await assessments.submitFeedback(c0.db, A.actor, request));
	assert.equal(replay.outcome, "unchanged", "the replay of F1 writes nothing");
	assert.equal(
		refusedCode(await assessments.submitFeedback(c0.db, A.actor, { ...request, runId: rf.id })),
		"not_found",
		"a foreign insight takes no feedback",
	);
	ok(await assessments.submitFeedback(c0.db, B.actor, { ...request, rating: "not_useful", comment: "" }));

	const prefill = ok(await assessments.readOwnFeedback(c0.db, A.actor, {})).findings;
	assert.deepEqual(
		prefill.map((f) => [f.runId, f.ordinal, f.rating, f.comment]),
		[[r1.id, 0, request.rating, request.comment]],
	);
	const mine = await c0.rows<{
		account_id: string;
		run_id: string;
		ordinal: number;
		rating: string;
		comment: string;
		rubric_version: string;
	}>(
		sql`SELECT account_id,run_id,ordinal,rating,comment,rubric_version FROM assessment_feedback WHERE account_id=${A.id}`,
	);
	assert.equal(mine.length, k.expected.result.current_feedback_rows);
	const [row] = mine;
	assert.equal(row!.account_id === A.id ? "A" : "B", k.expected.result.author);
	assert.equal(row!.run_id === r1.id && row!.ordinal === 0 ? "I1" : "other", k.expected.result.insight);
	assert.deepEqual(
		[row!.rating, row!.comment, row!.rubric_version],
		[k.expected.result.rating, k.expected.result.comment, given(k, "rubric")],
	);
	assert.equal(given(k, "another_author"), "B");
	const theirs = await c0.rows(
		sql`SELECT rating FROM assessment_feedback WHERE run_id=${r1.id} AND account_id=${B.id}`,
	);
	assert.deepEqual(theirs, [{ rating: "not_useful" }], "B's feedback is B's own row");
	assert.equal((await runRow()) !== runBefore, k.expected.result.scores_changed);
	const audits = await c0.rows(sql`SELECT kind FROM audit_event WHERE tenant_id=${p.id} AND actor_id=${A.id}
		AND action='intelligence.feedback_saved'`);
	assert.deepEqual(audits, [{ kind: "create" }], "one audit row for the save, none for the replay");
	assert.equal((await noticesOf(p)).n, 0);
});

test("AC:PI-CASE-025 cold start: a quiet new plant reads not generated, a plant with a requested run reads queued, one whose new run failed keeps R0, and no read calls a model", async () => {
	const k = K("PI-CASE-025");
	clockMs = Date.parse(NOW);
	const subjects = Object.fromEntries(given<Record<string, unknown>[]>(k, "subjects").map((x) => [x.id as string, x]));
	const P = await c0.plant("Case 025 P");
	const Q = await c0.plant("Case 025 Q");
	await c0.admin.execute(
		sql`UPDATE plant SET timezone=${(k.given.Q as { timezone: string }).timezone} WHERE id=${Q.id}`,
	);
	const R = await c0.harvest("Case 025 R");
	assert.deepEqual([subjects.P!.material_event, subjects.Q!.material_event], [false, true]);
	await c0.committed(Q, "Case 025 Q Adult", 1);
	assert.equal(subjects.Q!.demand, "requested");
	const r0 = await publish(R);
	assert.equal(subjects.R!.complete_assessment, "R0");
	assert.equal(subjects.R!.new_run, "failed");
	const failed = await publish(R, counted({ script: (d) => ({ ...d, focus: { ...d.focus, citations: [] } }) }));
	assert.equal(failed.outcome, "failed");
	ok(await assessments.requestRefresh(c0.db, Q.actor, { requestId: randomUUID() }));

	const before = calls;
	const state = (v: c.AssessmentView) =>
		v.current
			? v.current.runId
			: !v.newest
				? "not_generated"
				: v.newest.state === "preparing"
					? "queued"
					: v.newest.state;
	const [p, q, r] = [await view(P), await view(Q), await view(R)];
	assert.equal(state(p), k.expected.result.P);
	assert.equal(coldStartTitle(p.newest).title, "Your first assessment hasn't been prepared yet");
	assert.equal(state(q), k.expected.result.Q);
	assert.equal(coldStartTitle(q.newest).title, "Your first assessment is on its way");
	assert.equal(state(r) === r0.id ? "R0" : state(r), k.expected.result.R_result);
	assert.deepEqual(r.newest, { state: "failed", retryAt: null, grounding: "grounded" });
	assert.equal(calls - before, k.expected.result.model_calls);
	assert.equal(
		(
			await c0.one<{ n: number }>(
				sql`SELECT count(*)::int AS n FROM assessment_run WHERE plant_id IN (${P.id},${Q.id})`,
			)
		).n,
		0,
		"reading generates nothing",
	);
});

test("AC:PI-CASE-026 a trace sink that throws on every write leaves R1 complete with no extra model call; telemetry holds only run, version, usage and status fields", async () => {
	const k = K("PI-CASE-026");
	clockMs = Date.parse(NOW);
	const p = await c0.harvest("Case 026 Church");
	await c0.checkIn(p);
	assert.equal(given(k, "trace_sink"), "throws");
	await runAssessmentBatch(job, c0.db, counted(), 50);
	const written: unknown[][] = [];
	const sinks = ["log", "info", "warn", "error", "debug"] as const;
	const saved = sinks.map((name) => console[name]);
	for (const name of sinks)
		console[name] = (...args: unknown[]) => {
			written.push(args);
			throw Error("trace sink down");
		};
	const before = calls;
	let r: Awaited<ReturnType<typeof publish>>;
	try {
		r = await publish(p);
	} finally {
		sinks.forEach((name, i) => (console[name] = saved[i]!));
	}
	assert.equal(r.outcome === "published" ? "complete" : r.outcome, k.expected.result.status);
	assert.equal((await view(p)).current!.runId, r.id, k.expected.result.assessment as string);
	assert.equal(calls - before - 1, k.expected.result.model_calls_added_by_trace_failure);
	const disallowed = given<string[]>(k, "disallowed_payload_keys");
	const leaked = (text: string) => disallowed.filter((d) => new RegExp(`"${d}"|${d}`, "i").test(text));
	assert.deepEqual(leaked(JSON.stringify(written)), k.expected.result.raw_log_fields);

	const allowed = given<string[]>(k, "allowed_fields");
	const COLUMN: Record<string, string> = {
		run_id: "id",
		schema_version: "formula_version",
		source_revision: "source_revision",
		rubric_hash: "rubric_sha256",
		model_id: "model",
		token_usage: "input_tokens",
		status: "outcome",
		reason_code: "reason",
	};
	assert.deepEqual(Object.keys(COLUMN), allowed);
	const row = (await c0.one(sql`SELECT to_jsonb(r) AS j FROM assessment_run r WHERE r.id=${r.id}`)).j as Record<
		string,
		unknown
	>;
	for (const field of allowed) assert.ok(COLUMN[field]! in row, `${field} is recorded`);
	assert.deepEqual([row.id, row.outcome, row.reason, row.model], [r.id, "published", null, "assessment-scripted"]);
	const audit = await c0.one<{ metadata: Record<string, unknown> }>(sql`SELECT metadata FROM audit_event
		WHERE action='intelligence.assessed' AND event_key=${"assessment:" + r.id}`);
	assert.deepEqual(Object.keys(audit.metadata).sort(), [
		"demand",
		"drafts",
		"grounding",
		"model",
		"outcome",
		"reason",
		"runId",
	]);
	assert.deepEqual(leaked(JSON.stringify(audit.metadata)), []);
	assert.doesNotMatch(JSON.stringify(audit.metadata) + JSON.stringify(row.model_input), new RegExp(CANARY));
});

const cloneRun = (from: string, id: string, patch: ReturnType<typeof sql>) =>
	c0.admin.execute(sql`INSERT INTO assessment_run SELECT (jsonb_populate_record(NULL::assessment_run,
		to_jsonb(r)||jsonb_build_object('id',${id}::uuid,'demand_key',${"case/" + id}::text)||${patch})).*
		FROM assessment_run r WHERE r.id=${from}`);

test("AC:PI-CASE-020 history reads the last 12 complete runs, 4 to 15, from their original snapshots: run 4 keeps its committed 17 and has no contact metric, and run 15 reads a 48-hour task rate of 1 and an actual-contact rate of 0.5", async () => {
	const k = K("PI-CASE-020");
	clockMs = Date.parse(k.clock.now);
	const p = await c0.plant("Case 020 Church");
	const current = given<number>(k, "current_corrected_count");
	for (let i = 0; i < current; i++) await c0.committed(p, `History ${i + 1}`);
	const base = await publish(p);
	const ids = given<number[]>(k, "complete_run_ids");
	const label = new Map<string, number>([[base.id, ids.at(-1)!]]);
	const hour = (n: number) =>
		sql`(SELECT available_at FROM assessment_run WHERE id=${base.id})-make_interval(hours=>${n})`;
	for (const n of ids.slice(0, -1)) {
		const id = randomUUID();
		label.set(id, n);
		const old = n === 4;
		await cloneRun(
			base.id,
			id,
			sql`jsonb_build_object('available_at',${hour(ids.length - n)},'captured_at',${hour(ids.length - n)},
			'facts',(SELECT CASE WHEN ${old} THEN jsonb_set(r.facts #- '{followUps,contacted}','{committedAdults,known}',
				${given<number>(k, "run4_stored_committed_count")}::text::jsonb) ELSE r.facts END
				FROM assessment_run r WHERE r.id=${base.id}))`,
		);
	}
	assert.equal(given<boolean>(k, "run4_has_contact_metric"), false);
	await replica(sql`UPDATE assessment_run SET facts=jsonb_set(facts,'{followUps}',facts->'followUps'||
		'{"status":"measured","onTime":2,"measured":2,"contacted":1,"total":2}'::jsonb) WHERE id=${base.id}`);
	await cloneRun(
		base.id,
		randomUUID(),
		sql`jsonb_build_object('outcome','failed','reason','invalid_drafts','result',null,'available_at',null,
		'captured_at',clock_timestamp())`,
	);
	const before = calls;
	const h = ok(await assessments.readHistory(c0.db, p.actor, {}));
	assert.equal(calls, before);
	const run = (n: number) => h.runs.find((r) => label.get(r.runId) === n)!;
	const committed = TREND_INDEX("committedAdults.known");
	const value = (v: c.TrendValue) => (v.state === "measured" ? v.value : null);
	assert.deepEqual(
		{
			run_ids: h.runs.map((r) => label.get(r.runId)!).reverse(),
			run4_committed: value(run(4).values[committed]!),
			run4_contact: run(4).rates.actualContact,
			run15_task48h_rate: run(15).rates.followUpWithin48Hours,
			run15_contact_rate: run(15).rates.actualContact,
		},
		k.expected.result,
	);
	assert.equal(given<number>(k, "run15_task48h_rate"), 1);
	assert.equal(given<number>(k, "run15_actual_contact_rate"), 0.5);
	assert.equal(value(run(5).values[committed]!), current);
	assert.equal(ok(await createFacts({ clock }).readFacts(c0.db, p.actor, {})).committedAdults.known, current);
});
const TREND_INDEX = (key: string) => c.TREND_FACTS.findIndex((t) => t.key === key);

test("AC:PI-CASE-008 a profile edit is never fresh contact: the last confirmed contact on 2026-09-20 is not recent at 2026-10-13 12:00, and a legacy snapshot keeps its legacy-profile-proxy formula label", async () => {
	const k = K("PI-CASE-008");
	clockMs = Date.parse(k.clock.now);
	const p = await c0.plant("Case 008 Church");
	const who = await c0.committed(p, "Proxy Person");
	const base = await publish(p);
	const legacy = given<{ formula: string; person_updated_at: string }>(k, "snapshot_legacy");
	const legacyId = randomUUID();
	await cloneRun(
		base.id,
		legacyId,
		sql`jsonb_build_object('formula_version',${legacy.formula}::text,
		'available_at',(SELECT available_at-interval '1 day' FROM assessment_run WHERE id=${base.id}),
		'facts',(SELECT jsonb_set(r.facts,'{followUps,personUpdatedAt}',to_jsonb(${legacy.person_updated_at}::text))
			FROM assessment_run r WHERE r.id=${base.id}))`,
	);
	const stored = () =>
		c0.one<{ facts: unknown; formula_version: string }>(
			sql`SELECT facts,formula_version FROM assessment_run WHERE id=${legacyId}`,
		);
	const snapshot = await stored();
	const contact = randomUUID();
	await c0.admin.execute(sql`INSERT INTO record(id,kind,tenant_id) VALUES(${contact},'contact_outcome',${p.id})`);
	const last = given<string>(k, "last_confirmed_contact");
	await c0.admin.execute(sql`INSERT INTO contact_outcome(id,plant_id,person_id,outcome,occurred_at,recorded_at)
		VALUES(${contact},${p.id},${who.id},'contacted',${last + "T15:00:00Z"}::timestamptz,${last + "T15:00:00Z"}::timestamptz)`);
	const factsAt = createFacts({ clock: { now: () => given<string>(k, "as_of") as never } });
	const beforeEdit = ok(await factsAt.readFacts(c0.db, p.actor, {}));
	assert.equal(given<string>(k, "current_person_updated_at"), "2026-10-13");
	const { r } = await c0.one<{ r: string }>(sql`SELECT revision::text AS r FROM person WHERE id=${who.id}`);
	ok(
		await withPeopleWrite(c0.db, p.actor, (t, ctx) =>
			peopleWriter.updatePerson(t, ctx, {
				requestKey: randomUUID(),
				expectedRevision: r,
				input: { personId: who.id, patch: { email: "proxy.person@example.test" } },
			}),
		),
	);
	const facts = ok(await factsAt.readFacts(c0.db, p.actor, {}));
	const mine = facts.contact!.people.find((x) => x.person.id === who.id)!;
	const history = ok(await assessments.readHistory(c0.db, p.actor, {}));
	const legacyRun = history.runs.find((x) => x.runId === legacyId)!;
	assert.deepEqual(
		{
			actual_contact_date: mine.lastContactedAt!.slice(0, 10),
			recent: mine.recent,
			old_proxy_formula: legacyRun.formulaVersion,
		},
		k.expected.result,
	);
	assert.deepEqual(facts.contact, beforeEdit.contact, "the profile edit changes no contact fact");
	assert.equal(facts.sourceRevision, beforeEdit.sourceRevision);
	assert.deepEqual(await stored(), snapshot, "the legacy snapshot is never reinterpreted");
	assert.equal(history.runs.find((x) => x.runId === base.id)!.formulaVersion, c.FACTS_FORMULA_VERSION);
});

const point = (label: string, urgency: c.Urgency, citations: string[]) => ({
	title: `Item ${label}`,
	body: "A plain operational observation from the recorded facts.",
	urgency,
	citations,
});

test("AC:PI-CASE-017 the focus read returns primary I1, supplements I2 and I3, positives P1 and P2, and the rest of the ranked items, I4 and I5, as drill-down", async () => {
	const k = K("PI-CASE-017");
	clockMs = Date.parse(k.clock.now);
	const p = await c0.plant("Case 017 Church");
	await c0.committed(p, "Focus Person");
	const base = await publish(p);
	const ranked = given<string[]>(k, "persisted_nonpositive_ranked");
	const positives = given<string[]>(k, "persisted_positive");
	const lens: Record<string, c.LensKey> = {
		I1: "vision",
		I2: "critical_mass",
		I3: "cohesion",
		I4: "ownership",
		I5: "training",
	};
	const draft = {
		summary: "The church has a few recorded items to look at this week.",
		focus: point(ranked[0]!, "urgent", ["vision.daysSince"]),
		supporting: [point(ranked[1]!, "urgent", ["growth.daysSince"]), point(ranked[2]!, "watch", ["cohesion.committed"])],
		positives: positives.map((title) => point(title, "positive", ["coverage.filled"])),
	};
	await replica(sql`UPDATE assessment_run SET result=jsonb_set(result,'{draft}',${JSON.stringify(draft)}::jsonb),
		facts=jsonb_set(jsonb_set(jsonb_set(jsonb_set(jsonb_set(jsonb_set(facts,
			'{vision,status}','"direct"'),'{growth,status}','"stalled"'),'{cohesion,status}','"flagged"'),
			'{followUps}',facts->'followUps'||'{"status":"measured","onTime":1,"measured":3}'::jsonb),
			'{training,status}','"not_met"'),'{coverage,status}','"met"')
		WHERE id=${base.id}`);
	assert.equal(given<string>(k, "current_grants"), "valid");
	const before = calls;
	const focus = ok(await assessments.readFocus(c0.db, p.actor, {})).focus!;
	assert.equal(calls, before);
	const labelOf = (x: { title: string }) => x.title.replace(/^Item /, "");
	const named = (l: c.LensKey) => Object.keys(lens).find((x) => lens[x] === l)!;
	assert.deepEqual(
		{
			primary: labelOf(focus.primary),
			supplements: focus.supplements.map(labelOf),
			positive: focus.positives.map(labelOf),
			drilldown: focus.drilldown.map((x) => named(x.lens)),
		},
		k.expected.result,
	);
	assert.deepEqual(
		[focus.primary, ...focus.supplements].map((x) => x.lenses),
		[["vision"], ["critical_mass"], ["cohesion"]],
	);
	assert.deepEqual(
		focus.drilldown.map((x) => [x.severity, x.evidence.length > 0]),
		[
			["medium", true],
			["medium", true],
		],
	);
	const member = await seat(c0, p, "member");
	assert.equal(refusedCode(await assessments.readFocus(c0.db, member.actor, {})), "access_denied");
});
