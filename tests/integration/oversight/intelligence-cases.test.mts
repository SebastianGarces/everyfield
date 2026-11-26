import test, { after, before } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { sql } from "../../../packages/db/src/query.ts";
import { RequestActor } from "../../../packages/domain/src/access/session.ts";
import rubric from "../../../docs/reference/network-rubric-v1.json" with { type: "json" };
import {
	patternText,
	RUBRIC_VERSION,
	type IntelligencePattern,
	type IntelligenceView,
	type Level,
} from "../../../packages/contracts/src/oversight/health.ts";
import {
	createAssessmentJob,
	createAssessments,
	createPrivateCare,
	runAssessmentBatch,
} from "../../../packages/domain/src/intelligence/index.ts";
import {
	createOrganizationAdapter,
	geographyReference,
	installGeographyRelease,
	readReportingLocation,
	suggestRegions,
} from "../../../packages/domain/src/organizations/index.ts";
import {
	getPlant,
	listPlants,
	readIntelligence,
	readPattern,
	requestIntelligenceRefresh,
	submitIntelligenceFeedback,
} from "../../../packages/domain/src/oversight/index.ts";
import { gatedTransaction } from "../../../packages/domain/src/operations/writes.ts";
import { evryActor } from "../../../packages/evry/src/context/actor.ts";
import {
	readIntelligenceHistory,
	readNetworkIntelligence,
} from "../../../packages/evry/src/adapters/oversight/reads/index.ts";
import { scriptedAssessmentDrafter } from "../../../packages/evry-scripted/src/scripted-assessment.ts";
import { pinSchemaClock } from "../../support/test-database.mts";
import { ok, type Actor } from "../../support/fixture.mts";
import { CANARY, church, ZONE, type Church, type ChurchPlant } from "../intelligence/assessment-church.mts";
import { caseOf } from "../target/sql/core/support.mts";

type Result = Record<string, unknown>;
const expected = (id: string) => (caseOf("intelligence", id).expected as { result: Result }).result;
const argumentsOf = (id: string) => caseOf("intelligence", id).action.arguments as Result;
const base = caseOf("intelligence", "NI-001") as ReturnType<typeof caseOf> & { clock: { now: string } };
const given = base.given as Record<string, Record<string, unknown>>;
let pinned = 0;
const clock = { now: () => new Date(pinned).toISOString() as never };
const job = createAssessmentJob({ clock });
const assessments = createAssessments({ clock });
const care = createPrivateCare();
const api = createOrganizationAdapter(
	{ async invitation() {}, invalidate: () => sql`UPDATE job SET state=state WHERE false` } as never,
	geographyReference,
);
const LEVELS: Level[] = ["region", "state", "country", "portfolio"];
const COLUMNS = [
	"share_people",
	"share_meetings",
	"share_tasks",
	"share_ministry_teams",
	"share_wiki",
	"share_activity",
	"shared_findings",
] as const;
const ACCOUNT_ONLY = ["share_foundations"] as const;
type Column = (typeof COLUMNS)[number];
const AUSTIN = { city: "Austin", stateProvince: "TX", country: "US" };
const STREET = "4100 Private Street";
const NOT_SHARED = "Not shared";

let c0: Church;
let P: ChurchPlant, Q: ChurchPlant;
let alex: Actor;
let orgA: Awaited<ReturnType<Church["database"]["organization"]>>;
let runA: string;
const forbidden: string[] = [];

async function at(instant: string) {
	pinned = Date.parse(instant);
	await pinSchemaClock(c0.admin, c0.database.schema, new Date(instant));
}
const as = async (who: { session: string }) =>
	(await RequestActor.resolve(c0.db, who.session as never)) as RequestActor;
async function org(name: string, kind: "sending_network" | "sending_church" = "sending_network") {
	const o = await c0.database.organization(kind, { name, timezone: ZONE });
	return { ...o, admin: await c0.database.actor(o, "admin") };
}
type Org = Awaited<ReturnType<typeof org>>;
async function link(p: { id: string }, o: { id: string }, off: Column[] = []) {
	const id = randomUUID();
	await c0.admin
		.execute(sql`INSERT INTO affiliation(id,plant_id,organization_id,accepted_at,${sql.raw(COLUMNS.join(","))})
		VALUES(${id},${p.id},${o.id},clock_timestamp()-interval '1 day',${sql.join(
			COLUMNS.map((c) => sql`${!off.includes(c)}`),
			sql`,`,
		)})`);
	return id;
}
const end = (affiliation: string) =>
	c0.admin.execute(sql`UPDATE affiliation SET ended_at=clock_timestamp() WHERE id=${affiliation}`);
const set = (affiliation: string, column: Column, on: boolean) =>
	c0.admin.execute(sql`UPDATE affiliation SET ${sql.raw(column)}=${on} WHERE id=${affiliation}`);
const endSeat = (who: Actor) =>
	c0.admin.execute(sql`UPDATE seat SET ended_at=clock_timestamp() WHERE account_id=${who.id} AND ended_at IS NULL`);
async function refresh(who: { session: string }) {
	const runId = randomUUID();
	assert.deepEqual(await requestIntelligenceRefresh(c0.db, await as(who), { runId }), {
		status: "ok",
		value: { runId, outcome: "changed" },
	});
	return runId;
}
const read = async (who: { session: string }, level: Level = "portfolio", runId: string | null = null) =>
	readIntelligence(c0.db, await as(who), { level, runId });
const view = async (who: { session: string }, level: Level = "portfolio", runId: string | null = null) => {
	const v = await read(who, level, runId);
	assert.ok(v, "the read answers");
	return v;
};
const rowsOf = (v: IntelligenceView) => v.groups.flatMap((g) => g.rows);
const namesOf = (v: IntelligenceView) => rowsOf(v).map((r) => r.name);
const patternsOf = (v: IntelligenceView) => v.groups.flatMap((g) => g.patterns);
const lensPattern = (v: IntelligenceView, lens = "vision") =>
	patternsOf(v).find(
		(p): p is Extract<IntelligencePattern, { rule: "NIR-01" }> => p.rule === "NIR-01" && p.lens === lens,
	) ?? null;
const rowOf = (v: IntelligenceView, name: string) => rowsOf(v).find((r) => r.name === name) ?? null;
const evry = async (who: { session: string }, level: Level = "portfolio") =>
	readNetworkIntelligence.invoke(c0.db as never, evryActor(await as(who)), { level }, null);
const evryHistory = async (who: { session: string }, input: { level?: Level; runId?: string } = {}) =>
	readIntelligenceHistory.invoke(c0.db as never, evryActor(await as(who)), input, null);
const evryGroups = async (who: { session: string }) => String((await evry(who)).facts?.groups);
const stored = async (runId: string) =>
	c0.rows<{ plant_id: string; overdue_followups: number | null; growth_days: number | null }>(
		sql`SELECT * FROM network_intelligence_plant WHERE run_id=${runId} ORDER BY plant_id`,
	);
const storedPlants = async (runId: string) => (await stored(runId)).map((r) => r.plant_id).sort();
function bounded(payload: unknown, label: string) {
	const text = JSON.stringify(payload);
	for (const value of forbidden) assert.ok(!text.includes(value), `${label} carries ${value}`);
	assert.doesNotMatch(
		text,
		/"(street|email|phone|personId|accountId|note|answers|summary|title|body|focus|supporting|interviews?|fourCs|four_cs|rank|ranking|score|manifest|contributors|daysToLaunch|unfilledRoles|overdueFollowUps|unownedFollowUps|growthDays|requiredTraining|outstandingTraining)"/,
		label,
	);
}
function shapes(v: IntelligenceView) {
	for (const r of rowsOf(v)) {
		if (r.status === "not_shared") {
			assert.deepEqual(Object.keys(r).sort(), ["name", "plantId", "status"]);
			continue;
		}
		assert.deepEqual(Object.keys(r).sort(), ["assessment", "health", "name", "plantId", "results", "status"]);
		assert.ok(
			Object.values(r.results).every((x) => typeof x === "string"),
			"rule results are states, not counts",
		);
		if (r.assessment.status === "released") {
			assert.deepEqual(Object.keys(r.assessment).sort(), ["asOf", "concerns", "phase", "runId", "status", "withheld"]);
			for (const c of r.assessment.concerns)
				assert.deepEqual(Object.keys(c).sort(), ["evidence", "id", "lens", "ordinal", "severity"]);
		}
	}
	for (const p of patternsOf(v)) for (const x of p.plants) assert.deepEqual(Object.keys(x).sort(), ["name", "plantId"]);
}
async function save(p: ChurchPlant) {
	const current = (await readReportingLocation(c0.db, p.actor))!;
	const region = (await suggestRegions(c0.db, p.actor, AUSTIN))!.find((c) => c.area.code === "12420")!.regionItemId;
	const selected = { kind: "plant" as const, id: p.id };
	await gatedTransaction(c0.db, async (tx) => {
		assert.ok(await RequestActor.claimWrite(tx, p.owner.session as never, selected as never));
		return api["organizations.correctReportingLocation"](
			tx,
			p.owner.session as never,
			selected as never,
			{
				requestKey: randomUUID(),
				expectedRevision: current.revision,
				input: {
					plant: selected,
					locality: AUSTIN,
					referenceVersionId: current.referenceVersionId,
					regionItemId: region,
				},
			} as never,
		);
	});
}
async function publish(p: ChurchPlant, seen = true) {
	ok(await assessments.requestRefresh(c0.db, p.actor, { requestId: randomUUID() }));
	await runAssessmentBatch(job, c0.db, scriptedAssessmentDrafter(), 20);
	const current = ok(await assessments.readAssessment(c0.db, p.actor, {})).current!;
	if (seen) ok(await assessments.markAssessmentSeen(c0.db, p.actor, { runId: current.runId }));
	return current;
}

before(async () => {
	const available = String(given["P-released"]!.available_at);
	pinned = Date.parse(available);
	c0 = await church("ni", { clock: new Date(available) });
	await c0.release("methodology-2026.11");
	await installGeographyRelease(c0.admin);
	P = await c0.plant("P", { phase: Number(String(given.P!.phase).replace("Phase", "")) });
	Q = await c0.plant("Q");
	await c0.admin.execute(sql`UPDATE plant SET timezone=${String(given.Q!.timezone)} WHERE id=${Q.id}`);
	for (const p of [P, Q]) {
		await c0.admin.execute(sql`UPDATE plant SET city='Austin',state_province='TX',country='US',street=${STREET}
			WHERE id=${p.id}`);
		await save(p);
		const pat = await c0.person(p, `Pat ${p.name} Private`);
		await c0.humanRecords(p, pat, 10);
		await c0.checkIn(p);
		for (const r of await c0.rows<{ id: string; display_name: string }>(
			sql`SELECT id,display_name FROM person WHERE plant_id=${p.id}`,
		))
			forbidden.push(r.id, r.display_name);
		forbidden.push(p.owner.id, p.owner.email);
		await publish(p, false);
	}
	for (const r of await c0.rows<{ d: { summary: string; focus: Result; supporting: Result[] } }>(
		sql`SELECT result->'draft' AS d FROM assessment_run WHERE plant_id IN (${P.id},${Q.id})`,
	))
		forbidden.push(r.d.summary, ...[r.d.focus, ...r.d.supporting].flatMap((x) => [String(x.title), String(x.body)]));
	forbidden.push(CANARY, STREET, "Private Street", "struggling", "Struggling");
	const A = given.A!;
	orgA = await c0.database.organization("sending_network", { name: String(given["Org-A"]!.id), timezone: ZONE });
	alex = await c0.database.actor(orgA, "admin", {
		email: String(A.email),
		account: { personal_timezone: A.personal_timezone },
	});
	assert.equal(given["seat-A"]!.role, "Admin");
	await at(String(base.clock.now));
	await c0.admin.execute(
		sql`UPDATE auth_session SET expires_at=${String(given["session-A"]!.expires_at)}::timestamptz`,
	);
	await link(P, orgA);
	await link(Q, orgA);
	runA = await refresh(alex);
});
after(() => c0?.database.close());

test("AC:NI-001 AC:NI-033 AC:NI-037 two distinct released contributors make a pattern of 2 at every level, named by plant only, with no person, raw assessment, ranking, extra consent or anonymity claim", async () => {
	const e = expected("NI-001");
	for (const level of LEVELS) {
		const v = await view(alex, level);
		assert.deepEqual(namesOf(v), e.plant_rows, level);
		assert.deepEqual(namesOf(v), expected("NI-037").plant_rows, level);
		const vision = lensPattern(v)!;
		assert.equal(vision.support, e.pattern_support, level);
		assert.equal(vision.support, expected("NI-033").pattern_support_floor, level);
		assert.deepEqual(
			vision.plants.map((x) => x.name),
			e.plant_rows,
		);
		assert.deepEqual(
			patternsOf(v)
				.map((p) => [p.rule, p.rule === "NIR-01" ? p.lens : null, p.support, p.observed])
				.sort(),
			[
				["NIR-01", "critical_mass", 2, 2],
				["NIR-01", "leadership", 2, 2],
				["NIR-01", "vision", 2, 2],
			],
			level,
		);
		for (const r of rowsOf(v)) {
			assert.ok(r.status === "shared" && r.health === "watch", `${r.name}: Watch`);
			assert.ok(r.assessment.status === "released" && r.assessment.concerns.some((c) => c.lens === "vision"));
		}
		shapes(v);
		bounded(v, level);
	}
	assert.equal(e.individual_people, null);
	assert.equal(e.raw_assessments, null);
	bounded(await evry(alex), "Evry read");
	const directory = (await listPlants(c0.db, await as(alex)))!;
	assert.deepEqual(directory.plants.map((x) => x.name).sort(), ["P", "Q"]);
	const v = await view(alex);
	for (const p of patternsOf(v)) assert.doesNotMatch(JSON.stringify(patternText(p)), /anonym|consent/i);
	const consent = await c0.rows<{ column_name: string }>(sql`SELECT column_name FROM information_schema.columns
		WHERE table_schema=${c0.database.schema} AND table_name='affiliation' AND column_name ~ '^share'`);
	assert.deepEqual(
		consent.map((c) => c.column_name).sort(),
		[...COLUMNS, ...ACCOUNT_ONLY].sort(),
		"no extra consent column",
	);
	assert.equal(expected("NI-033").extra_required_consent, false);
	assert.equal(expected("NI-033").formal_anonymity_claim, false);
	assert.deepEqual(expected("NI-037").allowed_fields, ["plant_name", "lens_state", "shared_reason", "plant_link"]);
	assert.equal(expected("NI-037").ranking, null);
	assert.deepEqual(namesOf(v), [...namesOf(v)].sort(), "rows in name order, never by score");
});

const groupRows = async (who: { session: string }, level: Level) =>
	(await evryHistory(who, { level })).rows.filter((r) => r.fields.row === "group").map((r) => r.fields);
const ONE_PLANT = "Only one plant here shares findings, and one plant alone isn't a pattern.";

test("AC:NI-002 AC:NI-012 AC:NI-041 one relevant contributor is a named row and never a pattern, at the whole organization, its metro and its state; findings off is Not shared", async () => {
	const o = await org("Singleton Network");
	const affiliation = await link(P, o);
	const run = await refresh(o.admin);
	for (const level of LEVELS) {
		const v = await view(o.admin, level);
		assert.deepEqual(namesOf(v), expected("NI-002").plant_rows, level);
		assert.deepEqual(namesOf(v), expected("NI-012").plant_rows, level);
		assert.deepEqual(namesOf(v), [expected("NI-041").singleton_row], level);
		assert.deepEqual(patternsOf(v), expected("NI-002").patterns, level);
		assert.deepEqual(patternsOf(v), expected("NI-012").patterns, level);
		assert.equal(v.groups.length, 1, level);
		assert.equal(v.groups[0]!.placement, "placed", `${level}: P counts at this level`);
		const r = rowOf(v, "P")!;
		assert.ok(r.status === "shared" && r.assessment.status === "released", "P is a named lens row");
		assert.ok(
			r.assessment.concerns.some((c) => c.lens === "vision"),
			"with relevant evidence",
		);
		assert.equal(expected("NI-002").status, "insufficient_contributors");
		assert.deepEqual(
			(await groupRows(o.admin, level)).map((g) => g.noPattern),
			[ONE_PLANT],
			level,
		);
	}
	const e41 = expected("NI-041");
	assert.deepEqual(argumentsOf("NI-041").levels, ["whole-org", "metro", "state"]);
	assert.deepEqual(
		[
			patternsOf(await view(o.admin, "portfolio")),
			patternsOf(await view(o.admin, "region")),
			patternsOf(await view(o.admin, "state")),
		],
		[e41.whole_patterns, e41.region_patterns, e41.state_patterns],
	);
	assert.deepEqual(
		(await view(o.admin, "region")).groups.map((g) => g.label),
		["Austin-Round Rock-San Marcos, TX (metro area)"],
	);
	assert.deepEqual(await storedPlants(run), [P.id]);

	await set(affiliation, "shared_findings", false);
	const v = await view(o.admin);
	assert.deepEqual(rowsOf(v), [{ status: "not_shared", plantId: P.id, name: "P" }]);
	assert.match(await evryGroups(o.admin), new RegExp(`P \\(${expected("NI-012").findings_OFF_label}\\)`));
	assert.deepEqual(patternsOf(v), []);
});

test("AC:NI-003 five directory plants, two sharing health and one relevant contributor: no pattern, support 1, the directory count stays 5", async () => {
	const a = argumentsOf("NI-003");
	const e = expected("NI-003");
	const o = await org("Directory Network");
	const unassessed = await c0.plant("R Unassessed");
	await link(P, o);
	await link(unassessed, o);
	const off = [Q, await c0.plant("S Quiet"), await c0.plant("T Quiet")];
	for (const p of off) await link(p, o, ["shared_findings"]);
	await refresh(o.admin);
	const v = await view(o.admin);
	assert.equal(rowsOf(v).length, a.directory_plants);
	assert.equal(rowsOf(v).length, e.directory_count);
	assert.equal((await listPlants(c0.db, await as(o.admin)))!.plants.length, e.directory_count);
	assert.equal(rowsOf(v).filter((r) => r.status === "shared").length, a.health_sharing_on_plants);
	const relevant = rowsOf(v).filter(
		(r) =>
			r.status === "shared" &&
			r.assessment.status === "released" &&
			r.assessment.concerns.some((c) => c.lens === "vision"),
	);
	assert.deepEqual(
		relevant.map((r) => r.name),
		["P"],
	);
	assert.equal(relevant.length, e.support);
	assert.equal(relevant.length, a.relevant_observed_contributors);
	assert.deepEqual(rowOf(v, "R Unassessed"), {
		...rowOf(v, "R Unassessed"),
		health: "not_assessed",
		assessment: { status: "not_assessed" },
	});
	assert.deepEqual(patternsOf(v), e.patterns);
	for (const p of off) assert.deepEqual(rowOf(v, p.name), { status: "not_shared", plantId: p.id, name: p.name });
});

test("AC:NI-004 AC:NI-040 findings off is Not shared with no state, reason or contribution, while the other categories stay on; one sharing plant is support 1 and no pattern", async () => {
	assert.equal(argumentsOf("NI-004").plant_health_results_sharing, "OFF");
	assert.equal(argumentsOf("NI-004").other_shared_categories, "ON");
	for (const [id, off, on] of [
		["NI-004", P, Q],
		["NI-040", Q, P],
	] as const) {
		const o = await org(`${id} Network`);
		const affiliation = await link(off, o, ["shared_findings"]);
		await link(on, o);
		const [row] = await c0.rows<Record<Column, boolean>>(sql`SELECT * FROM affiliation WHERE id=${affiliation}`);
		assert.deepEqual(
			COLUMNS.filter((c) => row![c]),
			COLUMNS.filter((c) => c !== "shared_findings"),
			"every other category is shared",
		);
		const run = await refresh(o.admin);
		assert.deepEqual(await storedPlants(run), [on.id], `${id}: ${off.name} contributes nothing to the run`);
		for (const level of LEVELS) {
			const v = await view(o.admin, level);
			assert.deepEqual(rowOf(v, off.name), { status: "not_shared", plantId: off.id, name: off.name }, level);
			const shown = rowOf(v, on.name)!;
			assert.ok(shown.status === "shared" && shown.health === "watch", `${id}: ${on.name} is Watch`);
			assert.ok(shown.assessment.status === "released" && shown.assessment.concerns.some((c) => c.lens === "vision"));
			assert.deepEqual(patternsOf(v), [], `${id} ${level}: one contributor is no pattern`);
			shapes(v);
		}
		assert.match(await evryGroups(o.admin), new RegExp(`${off.name} \\(${NOT_SHARED}\\)`));
	}
	const e4 = expected("NI-004");
	assert.deepEqual([e4.P_label, e4.P_state, e4.P_reason, e4.P_contribution], [NOT_SHARED, null, null, false]);
	const e40 = expected("NI-040");
	assert.deepEqual(
		[e40.P_state, e40.Q_label, e40.Q_state, e40.support, e40.patterns],
		["Watch", NOT_SHARED, null, 1, []],
	);
});

test("AC:NI-005 AC:NI-038 with people sharing off the people input is never captured and no people-derived result or reason shows; the shown reason is an actually shared finding", async () => {
	assert.equal(argumentsOf("NI-005").people_sharing, "OFF");
	const o = await org("People Off Network");
	await link(P, o, ["share_people"]);
	await link(Q, o, ["share_people"]);
	const run = await refresh(o.admin);
	assert.deepEqual(
		(await stored(run)).map((r) => r.growth_days),
		[null, null],
		"no people input in the run",
	);
	const v = await view(o.admin);
	for (const r of rowsOf(v)) {
		assert.ok(r.status === "shared" && r.assessment.status === "released");
		assert.equal(r.results["NIR-05"], "unknown", "growth is people-derived: Unknown");
		assert.deepEqual(
			r.assessment.concerns.map((c) => c.lens),
			["vision", "leadership"],
			"the critical-mass (people) concern is withheld",
		);
		assert.equal(r.assessment.withheld, 1);
		for (const c of r.assessment.concerns)
			for (const f of c.evidence) assert.doesNotMatch(f.key, /^(committedAdults|growth|humanRecords|cohesion)\./);
		const vision = r.assessment.concerns.find((c) => c.lens === "vision")!;
		assert.deepEqual(vision.evidence, [{ key: "vision.status", label: "Vision meeting rhythm", value: "unknown" }]);
	}
	assert.equal(lensPattern(v, "critical_mass"), null, "no people-derived pattern");
	assert.equal(lensPattern(v)?.support, 2, "the shared finding still makes its pattern");
	bounded(v, "people off");
	const e5 = expected("NI-005");
	assert.deepEqual([e5.people_input, e5.people_derived_result], [null, null]);
	const e38 = expected("NI-038");
	assert.deepEqual([e38.withheld_fact_reason, e38.private_note], [null, null]);
	assert.equal(e38.reason, "actually shared allowed finding");
});

test("AC:NI-006 the shared_findings key is the one Plant Health switch: off, the plant is not in Network Intelligence, and no second switch exists", async () => {
	const a = argumentsOf("NI-006");
	const e = expected("NI-006");
	assert.equal(a.target_key, "shared_findings");
	const o = await org("One Switch Network");
	const affiliation = await link(P, o, [a.target_key as Column]);
	await link(Q, o);
	const off = await refresh(o.admin);
	const [row] = await c0.rows<{ shared_findings: boolean }>(
		sql`SELECT shared_findings FROM affiliation WHERE id=${affiliation}`,
	);
	assert.equal(row!.shared_findings, e.shared_findings);
	assert.equal((await storedPlants(off)).includes(P.id), e.NI_included);
	assert.deepEqual(rowOf(await view(o.admin), "P"), { status: "not_shared", plantId: P.id, name: "P" });
	await set(affiliation, "shared_findings", true);
	const on = await refresh(o.admin);
	assert.ok((await storedPlants(on)).includes(P.id));
	assert.equal(lensPattern(await view(o.admin))?.support, 2);
	const consent = await c0.rows<{ column_name: string }>(sql`SELECT column_name FROM information_schema.columns
		WHERE table_schema=${c0.database.schema} AND table_name='affiliation'
		AND (column_name ~ 'shar|health|finding|consent|intelligence')`);
	assert.deepEqual(consent.map((c) => c.column_name).sort(), ["consent_revision", ...COLUMNS, ...ACCOUNT_ONLY].sort());
	for (const column of ACCOUNT_ONLY)
		await assert.rejects(
			c0.admin.execute(sql`UPDATE affiliation SET ${sql.raw(column)}=true WHERE id=${affiliation}`),
			(e: Error) => /affiliation_ck_3/.test(e.cause instanceof Error ? e.cause.message : e.message),
			`${column} is an account-link switch a plant link cannot turn on`,
		);
	assert.equal(e.second_toggle, false);
});

test("AC:NI-007 one plant approved by two organizations counts in A's run only, where its health is shared; B sees Not shared and neither sees the other's runs", async () => {
	const a = argumentsOf("NI-007");
	const e = expected("NI-007");
	assert.deepEqual(a.health_results_sharing, { A: "ON", B: "OFF" });
	const A = await org("NI-007 A");
	const B = await org("NI-007 B");
	await link(P, A);
	await link(P, B, ["shared_findings"]);
	const runOfA = await refresh(A.admin);
	const runOfB = await refresh(B.admin);
	assert.equal((await storedPlants(runOfA)).length, e.A_support);
	assert.equal((await storedPlants(runOfB)).length, e.B_support);
	const va = await view(A.admin);
	assert.ok(rowOf(va, "P")!.status === "shared");
	assert.equal(rowsOf(va).filter((r) => r.status === "shared").length, e.A_support);
	const vb = await view(B.admin);
	assert.deepEqual(rowsOf(vb), [{ status: "not_shared", plantId: P.id, name: "P" }]);
	assert.equal(rowsOf(vb).filter((r) => r.status === "shared").length, e.B_support);
	assert.deepEqual(
		va.history.map((h) => h.runId),
		[runOfA],
	);
	assert.deepEqual(
		vb.history.map((h) => h.runId),
		[runOfB],
	);
	assert.equal(await read(A.admin, "portfolio", runOfB), null, "B's run is not A's to read");
	assert.equal(await read(B.admin, "portfolio", runOfA), null);
	assert.equal(e.cross_org_runs_visible, false);
});

test("AC:NI-008 a network linked to P's sending church but not to P never reaches P", async () => {
	const a = argumentsOf("NI-008");
	assert.equal(a.plant_network_link, "absent");
	const sending = await org("NI-008 Sending Church", "sending_church");
	const N = await org("NI-008 N");
	await link(P, sending);
	await c0.admin
		.execute(sql`INSERT INTO affiliation(sending_church_id,organization_id,accepted_at,${sql.raw(COLUMNS.join(","))})
		VALUES(${sending.id},${N.id},clock_timestamp()-interval '1 day',false,false,false,false,false,false,false)`);
	await link(Q, N);
	const run = await refresh(N.admin);
	assert.deepEqual(await storedPlants(run), [Q.id]);
	for (const level of LEVELS) assert.deepEqual(namesOf(await view(N.admin, level)), ["Q"], level);
	const e = expected("NI-008");
	assert.equal(e.network_P_reachable, false);
	assert.equal(await getPlant(c0.db, await as(N.admin), P.id), e.body);
	assert.ok(!JSON.stringify(await evryHistory(N.admin)).includes(P.id));
	assert.ok(await getPlant(c0.db, await as(sending.admin), P.id), "the sending church itself reaches P");
});

test("AC:NI-009 pending, rejected, ended and history-only relationships include nothing", async () => {
	const states = argumentsOf("NI-009").relationship_state as string[];
	assert.deepEqual(states, ["pending", "rejected", "ended", "history-only"]);
	assert.equal(argumentsOf("NI-009").independent_valid_grant, false);
	const included: boolean[] = [];
	for (const state of states) {
		const o = await org(`NI-009 ${state}`);
		await link(Q, o);
		let earlier: string | null = null;
		if (state === "pending" || state === "rejected") {
			const id = randomUUID();
			await c0.admin.execute(sql`INSERT INTO record(id,kind,tenant_id) VALUES(${id},'invitation',${o.id})`);
			await c0.admin
				.execute(sql`INSERT INTO invitation(id,tenant_id,purpose,recipient_email,inviter_id,token_hash,state,
				created_at,acted_at) VALUES(${id},${o.id},'plant_network',${P.owner.email},${o.admin.id},${randomUUID()},
				${state === "pending" ? "pending" : "declined"},clock_timestamp(),${state === "pending" ? null : sql`clock_timestamp()`})`);
		} else {
			const affiliation = await link(P, o);
			if (state === "history-only") earlier = await refresh(o.admin);
			await end(affiliation);
		}
		const run = await refresh(o.admin);
		const views = [await view(o.admin), ...(earlier ? [await view(o.admin, "portfolio", earlier)] : [])];
		if (earlier) assert.ok((await storedPlants(earlier)).includes(P.id), "the older run had captured P");
		const reaches =
			(await storedPlants(run)).includes(P.id) ||
			views.some(
				(v) => namesOf(v).includes("P") || patternsOf(v).some((p) => p.plants.some((x) => x.plantId === P.id)),
			) ||
			(await getPlant(c0.db, await as(o.admin), P.id)) !== null;
		included.push(reaches);
		for (const v of views) assert.deepEqual(namesOf(v), ["Q"], state);
	}
	assert.deepEqual(included, expected("NI-009").included);
});

test("AC:NI-010 private care answers, notes and corrections reach no Network Intelligence actor: plant Owner, accepted planter, organization Owner, the refresh worker or Evry", async () => {
	const current = ok(await care.readCurrent(c0.db, P.actor, {}));
	const correction = `${CANARY}-correction`;
	ok(
		await care.save(c0.db, P.actor, {
			requestKey: randomUUID(),
			expectedRevision: current.revision,
			input: {
				answers: { spiritual: "strained", family: "strained", financial: "strained", pace: "strained" },
				note: correction,
			},
		}),
	);
	const own = JSON.stringify(ok(await care.readCurrent(c0.db, P.actor, {})));
	assert.ok(own.includes(correction) && own.includes("strained"), "the author still reads their own care");
	const o = await org("NI-010 Network");
	const orgOwner = await c0.database.actor(o, "owner");
	await link(P, o);
	await link(Q, o);
	const run = await refresh(orgOwner);
	const planter = await c0.database.actor(P, "admin");
	for (const who of [P.owner, planter]) assert.equal(await read(who), null, "a plant seat has no Network Intelligence");
	const audit = await c0.rows(sql`SELECT metadata FROM audit_event WHERE tenant_id=${o.id}`);
	for (const [label, payload] of [
		["organization Owner", await view(orgOwner)],
		["organization Owner, every level", await Promise.all(LEVELS.map((l) => view(orgOwner, l)))],
		["worker", { rows: await stored(run), audit }],
		["Evry", [await evry(orgOwner), await evryHistory(orgOwner)]],
	] as const) {
		bounded(payload, label);
		const text = JSON.stringify(payload);
		for (const canary of [correction, "strained", "Strained"]) assert.ok(!text.includes(canary), `${label}: ${canary}`);
	}
	const e = expected("NI-010");
	assert.deepEqual([e.private_answers, e.private_history], [null, null]);
	assert.deepEqual(argumentsOf("NI-010").actor, ["plant Owner", "accepted planter", "org Owner", "worker", "Evry"]);
});

test("AC:NI-011 AC:NI-022 AC:NI-023 AC:NI-039 AC:NI-044 every surface gives only plant name, lens state, shared reason and plant link: no raw assessment, person, interview, 4Cs, care, street, per-plant count table, manifest, made-up number or ranking", async () => {
	const surfaces: [string, unknown][] = [];
	for (const level of LEVELS) {
		const v = await view(alex, level);
		shapes(v);
		surfaces.push([`native ${level}`, v]);
		for (const p of patternsOf(v)) {
			surfaces.push([
				`finding plant list ${level}`,
				await readPattern(c0.db, await as(alex), { runId: runA, patternKey: p.key }),
			]);
			assert.equal(p.support, p.plants.length);
			assert.equal(new Set(p.plants.map((x) => x.plantId)).size, p.support, "distinct plants");
			if (p.rule === "NIR-01") {
				const released = rowsOf(v).filter((r) => r.status === "shared" && r.assessment.status === "released");
				assert.equal(p.observed, released.length);
				assert.deepEqual(
					p.plants.map((x) => x.name),
					released
						.filter(
							(r) =>
								r.status === "shared" &&
								r.assessment.status === "released" &&
								r.assessment.concerns.some((c) => c.lens === p.lens),
						)
						.map((r) => r.name),
				);
			}
			assert.deepEqual(p.citation, {
				rubric: RUBRIC_VERSION,
				rule: p.rule,
				source: "docs/reference/network-rubric-v1.json",
			});
			for (const x of p.plants)
				assert.ok(await getPlant(c0.db, await as(alex), x.plantId), "the canonical plant link opens");
		}
		surfaces.push(
			[`Evry ${level}`, await evry(alex, level)],
			[`Evry history ${level}`, await evryHistory(alex, { level, runId: runA })],
		);
	}
	for (const [label, payload] of surfaces) bounded(payload, label);
	const e11 = expected("NI-011");
	assert.deepEqual(e11.allowed_fields, ["plant_name", "lens_state", "shared_reason", "plant_link"]);
	assert.deepEqual([e11.raw_assessment, e11.people, e11.ranking], [null, null, null]);
	const e22 = expected("NI-022");
	assert.deepEqual([e22.fabricated_number_allowed, e22.contributor_manifest], [false, null]);
	const e23 = expected("NI-023");
	assert.deepEqual([e23.raw_manifest, e23.former_Wiki_body, e23.canonical_plant_link_allowed], [null, null, true]);
	const e39 = expected("NI-039");
	assert.deepEqual(
		[e39.people, e39.interviews, e39.four_cs, e39.raw_assessment, e39.per_plant_numeric_table],
		[null, null, null, null, null],
	);
	const e44 = expected("NI-044");
	assert.deepEqual(e44.allowed_fields, e11.allowed_fields);
	assert.deepEqual([e44.private_care, e44.street, e44.ranking], [null, null, null]);
	assert.ok(forbidden.includes(`${CANARY}-interview`) || forbidden.includes(CANARY));
});

test("AC:NI-013 a duplicate link, two assessment versions and a repeated run still count the plant once: support 1 and no pattern", async () => {
	const a = argumentsOf("NI-013");
	assert.equal(a.other_contributors, 0);
	const D = await c0.plant("D Twice Assessed");
	const first = await publish(D);
	const second = await publish(D);
	assert.notEqual(first.runId, second.runId, "two assessment versions");
	const o = await org("NI-013 Network");
	await link(D, o);
	await assert.rejects(
		link(D, o),
		(e: Error) => /affiliation_uq_0/.test(String(e.cause)),
		"a second link for the same pair is refused",
	);
	await refresh(o.admin);
	const run = await refresh(o.admin);
	assert.deepEqual(await storedPlants(run), [D.id], "one contribution");
	const v = await view(o.admin);
	assert.deepEqual(namesOf(v), ["D Twice Assessed"]);
	const r = rowOf(v, "D Twice Assessed")!;
	assert.ok(r.status === "shared" && r.assessment.status === "released");
	assert.equal(r.assessment.runId, second.runId, "the current version only");
	assert.ok(!JSON.stringify(v).includes(first.runId));
	const e = expected("NI-013");
	assert.equal(rowsOf(v).filter((x) => x.status === "shared").length, e.support);
	assert.deepEqual(patternsOf(v), e.patterns);
});

test("AC:NI-014 AC:NI-015 a missing result or fact is Unknown, a non-sharing plant is Not shared, and an observed zero stays 0: nothing defaults to healthy", async () => {
	assert.deepEqual(argumentsOf("NI-014").input, [
		"shared but missing result",
		"nonsharing plant",
		"missing required fact",
	]);
	const o = await org("NI-014 Network");
	const U = await c0.plant("U Missing Result");
	const V = await c0.plant("V No Tasks Shared");
	await link(U, o);
	await link(Q, o, ["shared_findings"]);
	await link(P, o);
	await link(V, o, ["share_tasks"]);
	const run = await refresh(o.admin);
	const v = await view(o.admin);
	const u = rowOf(v, "U Missing Result")!;
	const q = rowOf(v, "Q")!;
	const p = rowOf(v, "P")!;
	assert.ok(u.status === "shared" && p.status === "shared");
	assert.deepEqual(
		[u.health, u.assessment],
		["not_assessed", { status: "not_assessed" }],
		"shared but missing: Unknown",
	);
	assert.deepEqual(q, { status: "not_shared", plantId: Q.id, name: "Q" });
	assert.equal(p.results["NIR-06"], "unknown", "no required training on record: Unknown");
	const statuses = [
		u.assessment.status === "not_assessed" ? "Unknown" : u.health,
		q.status === "not_shared" ? NOT_SHARED : q.health,
		p.results["NIR-06"] === "unknown" ? "Unknown" : p.results["NIR-06"],
	];
	assert.deepEqual(statuses, expected("NI-014").statuses);
	assert.ok(rowsOf(v).every((r) => r.status === "not_shared" || r.health !== "on_track"));
	assert.equal(expected("NI-014").healthy_default, false);
	assert.equal(argumentsOf("NI-015").authorized_observed_value, 0);
	const counts = Object.fromEntries((await stored(run)).map((r) => [r.plant_id, r.overdue_followups]));
	assert.deepEqual(counts, { [U.id]: 0, [P.id]: 0, [V.id]: null });
	const e15 = expected("NI-015");
	assert.equal(counts[P.id], e15.observed_zero);
	assert.equal(counts[V.id], e15.unknown);
	const results = Object.fromEntries(
		rowsOf(v).flatMap((r) => (r.status === "shared" ? [[r.name, r.results["NIR-04"]]] : [])),
	);
	assert.deepEqual(results, { P: "clear", "U Missing Result": "clear", "V No Tasks Shared": "unknown" });
	assert.ok(
		patternsOf(v).every((x) => x.rule !== "NIR-04"),
		"zero overdue is no gap pattern",
	);
});

test("AC:NI-016 the plant's newest unreleased assessment stays out; the earlier released one is the current result until an eligible human opens the new one", async () => {
	const R = await c0.plant("R Embargoed");
	const r0 = await publish(R);
	const r1 = await publish(R, false);
	assert.notEqual(r0.runId, r1.runId);
	const o = await org("NI-016 Network");
	await link(R, o);
	await refresh(o.admin);
	const shown = rowOf(await view(o.admin), "R Embargoed")!;
	assert.ok(shown.status === "shared" && shown.assessment.status === "released");
	assert.equal(shown.assessment.runId, r0.runId, expected("NI-016").current_released_result as string);
	for (const level of LEVELS) {
		const text = JSON.stringify([await view(o.admin, level), await evryHistory(o.admin, { level })]);
		assert.ok(!text.includes(r1.runId), `${level}: ${String(expected("NI-016").unreleased_R1)} R1`);
	}
	ok(await assessments.markAssessmentSeen(c0.db, R.actor, { runId: r1.runId }));
	const opened = rowOf(await view(o.admin), "R Embargoed")!;
	assert.ok(opened.status === "shared" && opened.assessment.status === "released");
	assert.equal(opened.assessment.runId, r1.runId, "opened by its planter: released");
});

test("AC:NI-017 AC:NI-034 AC:NI-036 AC:NI-042 only a current seat of the same organization reads it and opens plant links; Owner and Admin refresh; each reader rates for themself; a removed reader is refused", async () => {
	const o = await org("NI-017 Network");
	const owner = await c0.database.actor(o, "owner");
	const member = await c0.database.actor(o, "member");
	const removed = await c0.database.actor(o, "member");
	const foreign = (await org("NI-017 Foreign")).admin;
	const seatless = await c0.database.actor(null);
	await link(P, o);
	await link(Q, o);
	const roles: string[] = [];
	for (const [role, who] of [
		["Owner", owner],
		["Admin", o.admin],
		["Member", member],
	] as const) {
		const runId = randomUUID();
		const reply = await requestIntelligenceRefresh(c0.db, await as(who), { runId });
		if (reply.status === "ok") roles.push(role);
		else assert.deepEqual(reply, { status: "refused", refusal: { code: "unavailable" } }, role);
	}
	assert.deepEqual(roles, expected("NI-036").refresh_allowed_roles);
	const runs = (await view(o.admin)).history.map((h) => h.runId);
	assert.equal(runs.length, 2);
	const foreignRun = randomUUID();
	ok(await requestIntelligenceRefresh(c0.db, await as(foreign), { runId: foreignRun }));
	assert.deepEqual(
		(await view(o.admin)).history.map((h) => h.runId),
		runs,
		"a foreign refresh makes no run here",
	);
	const run = runs[0]!;

	const allowed = [];
	for (const who of [member, foreign, seatless]) {
		const v = await read(who, "portfolio", run);
		allowed.push(v !== null && namesOf(v).join() === "P,Q");
	}
	assert.deepEqual(allowed, expected("NI-017").allowed);
	assert.deepEqual(namesOf(await view(foreign)), [], "the foreign seat's own view has none of A's plants");
	assert.equal(await read(seatless), null);

	const key = lensPattern(await view(member))!.key;
	ok(await submitIntelligenceFeedback(c0.db, await as(member), { runId: run, patternKey: key, rating: "useful" }));
	assert.equal(lensPattern(await view(member))!.rating, "useful");
	assert.equal(lensPattern(await view(o.admin))!.rating, null, "another reader sees none of it");
	assert.deepEqual(
		await submitIntelligenceFeedback(c0.db, await as(foreign), { runId: run, patternKey: key, rating: "useful" }),
		{ status: "refused", refusal: { code: "unavailable" } },
	);
	assert.equal(expected("NI-036").feedback_allowed, "own_reader");
	bounded(await view(member), "member");
	assert.equal(expected("NI-036").private_care, null);

	const link42 = async (who: Actor) => (await getPlant(c0.db, await as(who), P.id)) !== null;
	assert.ok(await link42(removed), "the link opened before the permission change");
	assert.ok(rowOf(await view(removed), "P"));
	await endSeat(removed);
	assert.deepEqual(
		[await link42(member), await link42(foreign), await link42(removed)],
		expected("NI-042").link_allowed,
	);

	const e34 = expected("NI-034");
	assert.equal(await read(removed, "portfolio", run), e34.body);
	assert.equal(await read(removed), e34.body);
	assert.deepEqual(
		await submitIntelligenceFeedback(c0.db, await as(removed), { runId: run, patternKey: key, rating: "useful" }),
		{ status: "refused", refusal: { code: "unavailable" } },
		`${String(e34.error_code)} is the uniform unavailable`,
	);
	await assert.rejects(evry(removed), /source_unavailable/);
});

const linkedPair = async (name: string) => {
	const o = await org(name);
	const p = await link(P, o);
	await link(Q, o);
	return { o, p, run: await refresh(o.admin) };
};

test("AC:NI-019 AC:NI-043 a revoked plant's published pattern and row leave the latest run, history and Evry; findings off keeps only a Not shared name, and an ended link keeps nothing", async () => {
	const revoked = await linkedPair("NI-019 Network");
	const before = lensPattern(await view(revoked.o.admin))!;
	assert.deepEqual(
		before.plants.map((x) => x.name),
		["P", "Q"],
		"the published finding includes P",
	);
	await end(revoked.p);
	assert.deepEqual(argumentsOf("NI-019").requested_surface, ["latest", "history", "export", "cache", "Evry"]);
	const e19 = expected("NI-019");
	for (const level of LEVELS) {
		for (const [surface, v] of [
			["latest", await view(revoked.o.admin, level)],
			["history", await view(revoked.o.admin, level, revoked.run)],
		] as const) {
			assert.equal(lensPattern(v), e19.revoked_pattern, `${surface} ${level}`);
			assert.deepEqual(patternsOf(v), [], `${surface} ${level}: no pattern rests on P`);
			assert.equal(rowOf(v, "P"), e19.ended_row, `${surface} ${level}`);
		}
		const text = JSON.stringify([
			await evry(revoked.o.admin, level),
			await evryHistory(revoked.o.admin, { level, runId: revoked.run }),
		]);
		assert.ok(!text.includes(P.id) && !text.includes("[P]"), `Evry ${level}`);
	}
	assert.equal(
		await readPattern(c0.db, await as(revoked.o.admin), { runId: revoked.run, patternKey: before.key }),
		null,
	);
	assert.deepEqual(
		await submitIntelligenceFeedback(c0.db, await as(revoked.o.admin), {
			runId: revoked.run,
			patternKey: before.key,
			rating: "useful",
		}),
		{ status: "refused", refusal: { code: "unavailable" } },
	);
	assert.deepEqual(await storedPlants(revoked.run), [P.id, Q.id].sort(), "the stored run is not rewritten");

	const old = await linkedPair("NI-043 Network");
	const row = rowOf(await view(old.o.admin), "P")!;
	assert.ok(row.status === "shared" && row.health === "watch" && row.assessment.status === "released");
	assert.ok(await getPlant(c0.db, await as(old.o.admin), P.id));
	const e43 = expected("NI-043");
	await set(old.p, "shared_findings", false);
	for (const runId of [null, old.run]) {
		const v = await view(old.o.admin, "portfolio", runId);
		assert.deepEqual(
			rowOf(v, "P"),
			{ status: "not_shared", plantId: P.id, name: "P" },
			`${String(e43.OFF_state)} state`,
		);
	}
	assert.match(await evryGroups(old.o.admin), new RegExp(`P \\(${e43.OFF_label}\\)`));
	assert.ok(await getPlant(c0.db, await as(old.o.admin), P.id), "the page is still authorized");
	await end(old.p);
	for (const runId of [null, old.run])
		assert.equal(rowOf(await view(old.o.admin, "portfolio", runId), "P"), e43.ended_row);
	assert.equal(await getPlant(c0.db, await as(old.o.admin), P.id), e43.ended_link);
});

test("AC:NI-020 AC:NI-035 Network Intelligence runs the separate six-rule everyfield-network v1 rubric and leaves every plant's own assessment as it was, with no model call", async () => {
	const snapshot = () =>
		c0.rows(sql`SELECT id,outcome,source_revision,result,available_at FROM assessment_run
			WHERE plant_id IN (${P.id},${Q.id}) ORDER BY id`);
	const counts = () =>
		c0.one<{ jobs: number; runs: number }>(sql`SELECT (SELECT count(*)::int FROM job) AS jobs,
			(SELECT count(*)::int FROM assessment_run) AS runs`);
	const plantRuns = await snapshot();
	const work = await counts();
	const { o, run } = await linkedPair("NI-020 Network");
	await view(o.admin);
	await evry(o.admin);
	assert.deepEqual(await snapshot(), plantRuns, "the plant rubric's results are unchanged");
	assert.equal(expected("NI-020").plant_rubric_changed, false);
	assert.deepEqual(await counts(), work, "no assessment job or model call");
	const [stored] = await c0.rows<{ rubric_version: string }>(
		sql`SELECT rubric_version FROM network_intelligence_run WHERE id=${run}`,
	);
	const id = String(expected("NI-020").network_rubric);
	assert.equal(id, String(expected("NI-035").rubric_id));
	const [rubricId, version] = id.split(":");
	assert.equal(stored!.rubric_version, `${rubricId}/${version}`);
	assert.equal(RUBRIC_VERSION, `${rubric.rubric_id}/${rubric.version}`);
	assert.deepEqual([rubric.rubric_id, rubric.version], [rubricId, version]);
	assert.equal(rubric.separate_from_original_sme_plant_rubric, true);
	for (const p of patternsOf(await view(o.admin))) assert.equal(p.citation.rubric, stored!.rubric_version);
	assert.equal(rubric.rules.length, expected("NI-035").rule_count);
	assert.deepEqual(
		rubric.rules.map((r) => r.id),
		["NIR-01", "NIR-02", "NIR-03", "NIR-04", "NIR-05", "NIR-06"],
	);
	assert.equal(rubric.model_evaluation_status, expected("NI-035").model_proof);
});

test("AC:NI-024 two workers with the same request key make one run; the key from another organization is a conflict; no model is called", async () => {
	const work = await c0.one<{ jobs: number; runs: number }>(sql`SELECT (SELECT count(*)::int FROM job) AS jobs,
		(SELECT count(*)::int FROM assessment_run) AS runs`);
	const o = await org("NI-024 Network");
	const other = await org("NI-024 Other");
	await link(P, o);
	await link(Q, o);
	const runId = randomUUID();
	const authority = await as(o.admin);
	const replies = await Promise.all([1, 2].map(() => requestIntelligenceRefresh(c0.db, authority, { runId })));
	assert.deepEqual(replies.map((r) => (r.status === "ok" ? r.value.outcome : r.status)).sort(), ["changed", "noop"]);
	const runs = await c0.rows(sql`SELECT id FROM network_intelligence_run WHERE organization_id=${o.id}`);
	assert.equal(runs.length, expected("NI-024").assessments);
	assert.deepEqual(await storedPlants(runId), [P.id, Q.id].sort());
	assert.deepEqual(await requestIntelligenceRefresh(c0.db, await as(other.admin), { runId }), {
		status: "refused",
		refusal: { code: "conflict" },
	});
	assert.equal(expected("NI-024").changed_input_error, "idempotency_conflict");
	assert.equal(
		(await c0.rows(sql`SELECT id FROM network_intelligence_run WHERE organization_id=${other.id}`)).length,
		0,
	);
	assert.deepEqual(
		await c0.one(
			sql`SELECT (SELECT count(*)::int FROM job) AS jobs, (SELECT count(*)::int FROM assessment_run) AS runs`,
		),
		work,
		"no model call, in or out of the transaction",
	);
	assert.equal(expected("NI-024").model_call_under_transaction, false);
});

test("AC:NI-027 AC:NI-028 feedback binds to the readable run and finding, changes no score or rubric, replays once, and never reaches a foreign finding or another author's rating", async () => {
	const { o, run } = await linkedPair("NI-027 Network");
	const reader = await c0.database.actor(o, "member");
	const second = await c0.database.actor(o, "member");
	const finding = lensPattern(await view(reader))!;
	const runs = (await view(reader)).history;
	const input = { runId: run, patternKey: finding.key, rating: "useful" as const };
	assert.deepEqual(await submitIntelligenceFeedback(c0.db, await as(reader), input), {
		status: "ok",
		value: { outcome: "changed" },
	});
	const rows = () =>
		c0.rows<{ run_id: string; pattern_key: string; account_id: string; rating: string }>(
			sql`SELECT run_id,pattern_key,account_id,rating FROM network_intelligence_feedback WHERE run_id=${run} ORDER BY account_id`,
		);
	assert.deepEqual(await rows(), [{ run_id: run, pattern_key: finding.key, account_id: reader.id, rating: "useful" }]);
	const after = lensPattern(await view(reader))!;
	assert.deepEqual({ ...after, rating: null }, { ...finding, rating: null }, "scores unchanged");
	assert.deepEqual((await view(reader)).history, runs, "no rubric publication or new run");
	const e27 = expected("NI-027");
	assert.deepEqual(
		[e27.feedback_assessment, e27.feedback_finding, e27.scores_changed, e27.rubric_published],
		["R1", "F1", false, false],
	);

	assert.deepEqual(await submitIntelligenceFeedback(c0.db, await as(reader), input), {
		status: "ok",
		value: { outcome: "noop" },
	});
	const foreign = await linkedPair("NI-028 Foreign");
	const theirs = lensPattern(await view(foreign.o.admin))!;
	for (const attempt of [
		{ runId: foreign.run, patternKey: theirs.key, rating: "useful" as const },
		{ runId: run, patternKey: `${finding.key}:other`, rating: "useful" as const },
	])
		assert.deepEqual(await submitIntelligenceFeedback(c0.db, await as(reader), attempt), {
			status: "refused",
			refusal: { code: "unavailable" },
		});
	ok(await submitIntelligenceFeedback(c0.db, await as(second), { ...input, rating: "not_useful" }));
	const e28 = expected("NI-028");
	const mine = (await rows()).filter((r) => r.account_id === reader.id);
	assert.equal(mine.length, e28.feedback_rows);
	assert.equal(mine[0]!.rating, "useful", "another author does not overwrite it");
	assert.equal(e28.other_author_overwrite, false);
	assert.equal(e28.foreign_error, "access_denied");
	assert.equal(lensPattern(await view(reader))!.rating, "useful");
	assert.equal(lensPattern(await view(second))!.rating, "not_useful");
	assert.equal((await c0.rows(sql`SELECT 1 FROM network_intelligence_feedback WHERE run_id=${foreign.run}`)).length, 0);
});

test("AC:NI-032 a sending church and two networks that each approved the plant run independently; nothing is pooled", async () => {
	const orgs = argumentsOf("NI-032").orgs as string[];
	const made: { name: string; o: Org; run: string }[] = [];
	for (const name of orgs) {
		const o = await org(`NI-032 ${name}`, name.startsWith("sending-church") ? "sending_church" : "sending_network");
		await link(P, o);
		await link(Q, o);
		made.push({ name, o, run: await refresh(o.admin) });
	}
	const independent: string[] = [];
	for (const { name, o, run } of made) {
		const v = await view(o.admin);
		assert.deepEqual(
			v.history.map((h) => h.runId),
			[run],
			`${name}: its own run only`,
		);
		assert.deepEqual(await storedPlants(run), [P.id, Q.id].sort());
		assert.equal(lensPattern(v)!.support, 2);
		for (const otherRun of made.filter((m) => m.run !== run))
			assert.equal(await read(o.admin, "portfolio", otherRun.run), null);
		const [r] = await c0.rows<{ organization_id: string }>(
			sql`SELECT organization_id FROM network_intelligence_run WHERE id=${run}`,
		);
		if (r!.organization_id === o.id) independent.push(name);
	}
	assert.deepEqual(independent, expected("NI-032").independent_runs);
	const pooled = await c0.rows(sql`SELECT run_id FROM network_intelligence_plant
		WHERE run_id IN (${sql.join(
			made.map((m) => sql`${m.run}::uuid`),
			sql`,`,
		)}) GROUP BY run_id HAVING count(*) <> 2`);
	assert.deepEqual(pooled, [], "no run pools another organization's contributions");
	assert.equal(expected("NI-032").pooled_run, null);
});

test("AC:NI-018 a run captured with health on publishes nothing of P once findings are off (Not shared) or its link ends (no row), and the stored run is kept", async () => {
	for (const variant of ["off", "ended"] as const) {
		const { o, p, run } = await linkedPair(`Capture ${variant} Network`);
		const kept = await stored(run);
		if (variant === "off") await set(p, "shared_findings", false);
		else await end(p);
		for (const runId of [null, run]) {
			const v = await view(o.admin, "portfolio", runId);
			assert.deepEqual(
				rowOf(v, "P"),
				variant === "off" ? { status: "not_shared", plantId: P.id, name: "P" } : null,
				`${variant} ${runId}`,
			);
			assert.ok(
				patternsOf(v).every((x) => x.plants.every((y) => y.plantId !== P.id)),
				"P is not published",
			);
		}
		assert.deepEqual(await stored(run), kept, "the prior result is retained, not rewritten");
		assert.deepEqual(
			(await view(o.admin)).history.map((h) => h.runId),
			[run],
		);
	}
});

test("a source correction or a new released plant result gives a new run R2 and leaves R1 as it was", async () => {
	const R = await c0.plant("R Corrected");
	await publish(R);
	const o = await org("Correction Network");
	await link(R, o);
	await link(Q, o);
	const r1 = await refresh(o.admin);
	const kept = { rows: await stored(r1), view: await view(o.admin, "portfolio", r1) };
	const guest = await c0.person(R, "Guest Waiting");
	await c0.admin.execute(sql`INSERT INTO task(id,plant_id,title,category,priority,status,created_at,due_kind,due_date,
		person_id) VALUES(${randomUUID()},${R.id},'Call back','follow_up','medium','not_started',clock_timestamp(),'date_only',
		(clock_timestamp() AT TIME ZONE ${ZONE})::date - 3,${guest.id})`);
	const revised = await publish(R);
	const r2 = await refresh(o.admin);
	assert.notEqual(r2, r1);
	assert.deepEqual(
		(await view(o.admin)).history.map((h) => h.runId),
		[r2, r1],
	);
	const now = Object.fromEntries((await stored(r2)).map((r) => [r.plant_id, r.overdue_followups]));
	assert.equal(now[R.id], 1, "R2 reads the corrected source");
	const shown = rowOf(await view(o.admin), "R Corrected")!;
	assert.ok(
		shown.status === "shared" &&
			shown.assessment.status === "released" &&
			shown.assessment.runId === String(revised.runId),
	);
	assert.deepEqual(await stored(r1), kept.rows, "R1 is not rewritten");
	assert.deepEqual(
		rowsOf(await view(o.admin, "portfolio", r1)).map((r) => (r.status === "shared" ? r.results : null)),
		rowsOf(kept.view).map((r) => (r.status === "shared" ? r.results : null)),
	);
});
