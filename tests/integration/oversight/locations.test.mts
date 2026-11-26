import test, { after, before } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { sql } from "../../../packages/db/src/query.ts";
import { RequestActor } from "../../../packages/domain/src/access/session.ts";
import type { IntelligenceView, Level } from "../../../packages/contracts/src/oversight/health.ts";
import { correctReportingLocationRequest } from "../../../packages/contracts/src/organizations/requests.ts";
import {
	createAssessmentJob,
	createAssessments,
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
	readLocationHistory,
	readPattern,
	requestIntelligenceRefresh,
} from "../../../packages/domain/src/oversight/index.ts";
import { evryActor, invokeRead } from "../../../packages/evry/src/index.ts";
import type { SourceResult } from "../../../packages/evry/src/catalog/types.ts";
import {
	readIntelligenceHistory,
	readNetworkIntelligence,
	readPlantLocationHistory,
	readPlantLocations,
} from "../../../packages/evry/src/adapters/oversight/reads/index.ts";
import { caseOf } from "../target/sql/core/support.mts";
import { scriptedAssessmentDrafter } from "../../../packages/evry-scripted/src/scripted-assessment.ts";
import { ok } from "../../support/fixture.mts";
import { CANARY, church, type Church } from "../intelligence/assessment-church.mts";
import { gatedTransaction } from "../../../packages/domain/src/operations/writes.ts";

let c0: Church;
const job = createAssessmentJob();
const assessments = createAssessments();
const api = createOrganizationAdapter(
	{ async invitation() {}, invalidate: () => sql`UPDATE job SET state=state WHERE false` } as never,
	geographyReference,
);

before(async () => {
	c0 = await church("t386g");
	await c0.release("methodology-2026.11");
	await installGeographyRelease(c0.admin);
});
after(() => c0?.database.close());

type Plant = Awaited<ReturnType<Church["plant"]>>;
type Locality = { city: string | null; stateProvince: string | null; country: string | null };
const LEVELS: Level[] = ["region", "state", "country", "portfolio"];

async function network(name: string) {
	const org = await c0.database.organization("sending_network", { name, timezone: "America/Chicago" });
	const seat = await c0.database.actor(org, "admin");
	const admin = (await RequestActor.resolve(c0.db, seat.session as never)) as RequestActor;
	return { ...org, admin };
}
type Network = Awaited<ReturnType<typeof network>>;
async function link(p: { id: string }, net: { id: string }, share = true) {
	await c0.admin.execute(sql`INSERT INTO affiliation(plant_id,organization_id,accepted_at,share_people,share_meetings,
		share_tasks,share_ministry_teams,share_wiki,share_activity,shared_findings)
		VALUES(${p.id},${net.id},clock_timestamp()-interval '1 day',${share},${share},${share},${share},${share},${share},${share})`);
}
async function nearLaunch(p: Plant) {
	await c0.admin.execute(
		sql`INSERT INTO launch(plant_id,status,target_date) VALUES(${p.id},'scheduled',${c0.day(10)}::date)`,
	);
	const team = randomUUID(),
		role = randomUUID();
	for (const [id, kind] of [
		[team, "team"],
		[role, "team_role"],
	])
		await c0.admin.execute(sql`INSERT INTO record(id,kind,tenant_id) VALUES(${id},${kind},${p.id})`);
	await c0.admin.execute(
		sql`INSERT INTO team(id,plant_id,name,state,sort_order) VALUES(${team},${p.id},'Kids','active',1)`,
	);
	await c0.admin.execute(sql`INSERT INTO team_role(id,plant_id,team_id,name,leadership,sort_order,responsibility_key)
		VALUES(${role},${p.id},${team},'Kids lead',true,1,'children')`);
}
async function plant(name: string, where: Locality) {
	const p = await c0.plant(name, { phase: 2 });
	await c0.admin.execute(sql`UPDATE plant SET city=${where.city},state_province=${where.stateProvince},
		country=${where.country},street='4100 Private Street' WHERE id=${p.id}`);
	await nearLaunch(p);
	return p;
}
const candidates = async (p: Plant, where: Locality) => (await suggestRegions(c0.db, p.actor, where))!;
async function save(p: Plant, where: Locality, code: string | null) {
	const current = (await readReportingLocation(c0.db, p.actor))!;
	const offered = await candidates(p, where);
	const region = code === null ? null : offered.find((c) => c.area.code === code)!.regionItemId;
	assert.ok(code === null || region, `the picker offers ${code}`);
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
					locality: where,
					referenceVersionId: current.referenceVersionId,
					regionItemId: region,
				},
			} as never,
		);
	});
}
const refresh = async (net: Network) => {
	const runId = randomUUID();
	assert.equal((await requestIntelligenceRefresh(c0.db, net.admin, { runId })).status, "ok");
	return runId;
};
const read = async (net: Network, level: Level, runId: string | null = null) =>
	(await readIntelligence(c0.db, net.admin, { level, runId }))!;
function levelOf(v: IntelligenceView) {
	return Object.fromEntries(
		v.groups.map((g) => [
			g.key,
			{
				label: g.label,
				placement: g.placement,
				support: g.rows.filter((r) => r.status === "shared").length,
				pattern: g.patterns.find((x) => x.rule === "NIR-03")?.support ?? null,
			},
		]),
	);
}
const AUSTIN_TX = { city: "Austin", stateProvince: "TX", country: "US" };
const ROUND_ROCK = { city: "Round Rock", stateProvince: "TX", country: "US" };
const TORONTO = { city: "Toronto", stateProvince: "ON", country: "CA" };
const OMB = "geography/omb-23-01";

test("AC:GEO-001 a plant in a US metro Region counts under that official metro area, labelled as one, from the pinned July 2023 release", async () => {
	const net = await network("Metro Network");
	const [a, b] = [await plant("North Austin Church", AUSTIN_TX), await plant("Round Rock Church", ROUND_ROCK)];
	for (const p of [a, b]) await link(p, net);
	await save(a, AUSTIN_TX, "12420");
	await save(b, ROUND_ROCK, "12420");
	await refresh(net);
	const v = await read(net, "region");
	assert.deepEqual(levelOf(v), {
		"12420": {
			label: "Austin-Round Rock-San Marcos, TX (metro area)",
			placement: "placed",
			support: 2,
			pattern: 2,
		},
	});
	assert.deepEqual(
		v.geographyReleases.map((r) => r.key),
		[OMB],
	);
	assert.match(v.geographyReleases[0]!.credit, /OMB Bulletin 23-01 \(July 2023\)/);
});

test("AC:GEO-002 a plant in a micro Region counts under that official micro area, labelled as one", async () => {
	const net = await network("Micro Network");
	const kerrville = { city: "Kerrville", stateProvince: "TX", country: "US" };
	const [a, b] = [await plant("Kerrville Church", kerrville), await plant("Hill Fellowship", kerrville)];
	for (const p of [a, b]) {
		await link(p, net);
		await save(p, kerrville, "28500");
	}
	await refresh(net);
	assert.deepEqual(levelOf(await read(net, "region")), {
		"28500": { label: "Kerrville, TX (micro area)", placement: "placed", support: 2, pattern: 2 },
	});
});

test("AC:GEO-005 a multistate Region keeps both plants together while each counts in its own state", async () => {
	const net = await network("Tri-State Network");
	const ny = { city: "New York", stateProvince: "NY", country: "US" };
	const nj = { city: "Newark", stateProvince: "NJ", country: "US" };
	const [a, b] = [await plant("Harlem Church", ny), await plant("Newark Church", nj)];
	await link(a, net);
	await link(b, net);
	await save(a, ny, "35620");
	await save(b, nj, "35620");
	await refresh(net);
	assert.deepEqual(levelOf(await read(net, "region")), {
		"35620": { label: "New York-Newark-Jersey City, NY-NJ (metro area)", placement: "placed", support: 2, pattern: 2 },
	});
	assert.deepEqual(levelOf(await read(net, "state")), {
		"US:NJ": { label: "New Jersey", placement: "placed", support: 1, pattern: null },
		"US:NY": { label: "New York", placement: "placed", support: 1, pattern: null },
	});
	assert.deepEqual(levelOf(await read(net, "portfolio")), {
		portfolio: { label: "Whole portfolio", placement: "placed", support: 2, pattern: 2 },
	});
});

test("AC:GEO-006 AC:GEO-007 a Canadian plant has no supported Region but counts in its province, Canada and the whole portfolio; one plant per country makes no country pattern", async () => {
	const net = await network("Border Network");
	const [us, ca] = [await plant("Austin Hope", AUSTIN_TX), await plant("Toronto Church", TORONTO)];
	await link(us, net);
	await link(ca, net);
	await save(us, AUSTIN_TX, "12420");
	await save(ca, TORONTO, null);
	assert.deepEqual(await candidates(ca, TORONTO), [], "no Region standard outside the United States");
	await refresh(net);
	const at = async (level: Level) => levelOf(await read(net, level));
	assert.deepEqual(await at("region"), {
		"12420": { label: "Austin-Round Rock-San Marcos, TX (metro area)", placement: "placed", support: 1, pattern: null },
		unsupported_country: {
			label: "Region not supported outside the United States",
			placement: "unsupported_country",
			support: 1,
			pattern: null,
		},
	});
	assert.deepEqual(await at("state"), {
		"CA:ON": { label: "ON", placement: "placed", support: 1, pattern: null },
		"US:TX": { label: "Texas", placement: "placed", support: 1, pattern: null },
	});
	assert.deepEqual(await at("country"), {
		CA: { label: "CA", placement: "placed", support: 1, pattern: null },
		US: { label: "United States", placement: "placed", support: 1, pattern: null },
	});
	assert.deepEqual(await at("portfolio"), {
		portfolio: { label: "Whole portfolio", placement: "placed", support: 2, pattern: 2 },
	});
});

test("AC:GEO-008 a plant linked to the network directly and through its sending church counts once at every level", async () => {
	const net = await network("Twice Network");
	const church = await c0.database.organization("sending_church", {
		name: "Grace Austin",
		timezone: "America/Chicago",
	});
	const [a, b] = [await plant("Twice Linked Church", AUSTIN_TX), await plant("Once Linked Church", ROUND_ROCK)];
	await link(a, net);
	await link(b, net);
	await c0.admin.execute(sql`INSERT INTO affiliation(sending_church_id,organization_id,accepted_at,share_people,
		share_meetings,share_tasks,share_ministry_teams,share_wiki,share_activity,shared_findings)
		VALUES(${church.id},${net.id},clock_timestamp()-interval '1 day',false,false,false,false,false,false,false)`);
	await link(a, church);
	await save(a, AUSTIN_TX, "12420");
	await save(b, ROUND_ROCK, "12420");
	await refresh(net);
	for (const level of LEVELS) {
		const ids = (await read(net, level)).groups.flatMap((g) => g.rows.map((r) => r.plantId));
		assert.deepEqual(ids.sort(), [a.id, b.id].sort(), `${level}: each plant once`);
	}
	assert.equal(levelOf(await read(net, "region"))["12420"]!.pattern, 2, "two distinct plants, not three");
});

test("AC:GEO-013 AC:GEO-003 a place with two candidate Regions asks the planter to choose and never for a street; the chosen primary Region alone counts, once", async () => {
	const austin = { city: "Austin", stateProvince: null, country: "US" };
	const p = await plant("Two Austins Church", austin);
	const offered = await candidates(p, austin);
	assert.deepEqual(offered.map((c) => c.area.code).sort(), ["12380", "12420"]);
	assert.equal((await readReportingLocation(c0.db, p.actor))!.region, null);
	assert.deepEqual(Object.keys(correctReportingLocationRequest.shape.input.shape.locality.shape).sort(), [
		"city",
		"country",
		"stateProvince",
	]);

	const net = await network("Primary Network");
	await link(p, net);
	await save(p, austin, null);
	await refresh(net);
	assert.equal(levelOf(await read(net, "region")).unresolved?.placement, "unresolved", "no choice: unresolved");

	await save(p, austin, "12420");
	await refresh(net);
	const region = levelOf(await read(net, "region"));
	assert.deepEqual(Object.keys(region), ["12420"], "in its primary Region only");
	assert.equal(region["12420"]!.support, 1);
	for (const level of LEVELS)
		assert.equal(
			(await read(net, level)).groups.flatMap((g) => g.rows).filter((r) => r.plantId === p.id).length,
			1,
			`${level}: one contribution`,
		);
});

test("AC:GEO-004 AC:GEO-012 a plant outside the official list, one left unresolved and one in an unsupported country each show their status by name, with no Region or attested area guessed", async () => {
	const net = await network("Status Network");
	const nowhere = { city: "Nowhere", stateProvince: "TX", country: "US" };
	const [outside, unresolved, abroad] = [
		await plant("Prairie Church", nowhere),
		await plant("Unsure Church", AUSTIN_TX),
		await plant("Ottawa Church", { city: "Ottawa", stateProvince: "ON", country: "CA" }),
	];
	for (const p of [outside, unresolved, abroad]) await link(p, net);
	assert.deepEqual(await candidates(outside, nowhere), [], "the official list names no area for it");
	await save(outside, nowhere, null);
	await save(abroad, { city: "Ottawa", stateProvince: "ON", country: "CA" }, null);
	await refresh(net);
	const v = await read(net, "region");
	assert.deepEqual(
		v.groups.map((g) => [g.label, g.placement, g.rows.map((r) => r.name)]),
		[
			["Outside the official Region list", "outside_reference", ["Prairie Church"]],
			["Region not supported outside the United States", "unsupported_country", ["Ottawa Church"]],
			["Region unresolved", "unresolved", ["Unsure Church"]],
		],
	);
	assert.ok(
		v.groups.every((g) => !g.patterns.length),
		"no pattern for plants with no Region",
	);
	const at = async (level: Level) => levelOf(await read(net, level));
	assert.deepEqual(await at("state"), {
		"CA:ON": { label: "ON", placement: "placed", support: 1, pattern: null },
		"US:TX": { label: "Texas", placement: "placed", support: 2, pattern: 2 },
	});
	assert.deepEqual(await at("country"), {
		CA: { label: "CA", placement: "placed", support: 1, pattern: null },
		US: { label: "United States", placement: "placed", support: 2, pattern: 2 },
	});
	assert.deepEqual(await at("portfolio"), {
		portfolio: { label: "Whole portfolio", placement: "placed", support: 3, pattern: 3 },
	});
	for (const level of ["state", "country", "portfolio"] as const)
		assert.ok(
			(await read(net, level)).groups.some(
				(g) => g.placement === "placed" && g.rows.some((r) => r.name === "Unsure Church"),
			),
			`${level}: the unresolved plant still counts where its place is known`,
		);
	assert.doesNotMatch(JSON.stringify(v), /attest|geographic_?area|planting_?area/i);
	const location = (await readReportingLocation(c0.db, outside.actor))!;
	assert.deepEqual(Object.keys(location).sort(), ["canEdit", "locality", "referenceVersionId", "region", "revision"]);
	assert.equal(location.region, null);
});

test("INV-denominator: with one relevant plant in each of two metro areas only the larger levels show a pattern; a second relevant plant, not merely another plant, makes each metro's own", async () => {
	const net = await network("Two Metro Network");
	const DALLAS = { city: "Dallas", stateProvince: "TX", country: "US" };
	const [a1, d1] = [await plant("Austin First", AUSTIN_TX), await plant("Dallas First", DALLAS)];
	for (const p of [a1, d1]) await link(p, net);
	await save(a1, AUSTIN_TX, "12420");
	await save(d1, DALLAS, "19100");
	const quiet = await c0.plant("Dallas Quiet", { phase: 1 });
	await c0.admin.execute(sql`UPDATE plant SET city='Dallas',state_province='TX',country='US' WHERE id=${quiet.id}`);
	await link(quiet, net);
	await save(quiet, DALLAS, "19100");
	const patterns = async (level: Level) =>
		Object.fromEntries(Object.entries(levelOf(await read(net, level))).map(([k, v]) => [k, v.pattern]));
	await refresh(net);
	assert.equal(levelOf(await read(net, "region"))["19100"]!.support, 2, "the quiet plant shares the Region");
	assert.deepEqual(await patterns("region"), { "12420": null, "19100": null });
	assert.deepEqual(await patterns("state"), { "US:TX": 2 });
	assert.deepEqual(await patterns("country"), { US: 2 });
	assert.deepEqual(await patterns("portfolio"), { portfolio: 2 });

	const [a2, d2] = [await plant("Austin Second", AUSTIN_TX), await plant("Dallas Second", DALLAS)];
	for (const p of [a2, d2]) await link(p, net);
	await save(a2, AUSTIN_TX, "12420");
	await save(d2, DALLAS, "19100");
	await refresh(net);
	assert.deepEqual(await patterns("region"), { "12420": 2, "19100": 2 });
	assert.deepEqual(await patterns("state"), { "US:TX": 4 });
	assert.deepEqual(await patterns("country"), { US: 4 });
	assert.deepEqual(await patterns("portfolio"), { portfolio: 4 });
});

test("AC:GEO-009 a Region corrected from one area to another changes the current view; the earlier run keeps its Region", async () => {
	const net = await network("Correction Network");
	const austin = { city: "Austin", stateProvince: null, country: "US" };
	const p = await plant("Corrected Church", austin);
	await link(p, net);
	await save(p, austin, "12380");
	const before = await refresh(net);
	await save(p, austin, "12420");
	assert.deepEqual((await readReportingLocation(c0.db, p.actor))!.locality, austin, "the actual place is unchanged");
	await refresh(net);
	assert.deepEqual(Object.keys(levelOf(await read(net, "region"))), ["12420"], "current: the corrected Region");
	assert.deepEqual(Object.keys(levelOf(await read(net, "region", before))), ["12380"], "history: the Region it had");
});

test("AC:B02-029 Network Intelligence and the oversight plant view consume only released results: an embargoed newest run shows the previous one or Not yet assessed, and its concerns join no pattern until the planter opens it", async () => {
	const net = await network("Release Network");
	const [a, b] = [await c0.harvest("Lakeside Church"), await c0.harvest("Riverside Church")];
	for (const p of [a, b]) {
		await c0.admin.execute(sql`UPDATE plant SET phase=2 WHERE id=${p.id}`);
		await link(p, net);
	}
	const publish = async (p: Plant) => {
		ok(await assessments.requestRefresh(c0.db, p.actor, { requestId: randomUUID() }));
		await runAssessmentBatch(job, c0.db, scriptedAssessmentDrafter(), 20);
		return ok(await assessments.readAssessment(c0.db, p.actor, {})).current!;
	};
	const first = await publish(a);
	ok(await assessments.markAssessmentSeen(c0.db, a.actor, { runId: first.runId }));
	const newest = await publish(a);
	const unreleased = await publish(b);
	assert.notEqual(newest.runId, first.runId);
	await refresh(net);

	const rows = async (level: Level = "portfolio") =>
		Object.fromEntries(
			(await read(net, level)).groups.flatMap((g) =>
				g.rows.map((r) => [r.name, r.status === "shared" ? r.assessment : null]),
			),
		);
	const shared = async () =>
		(await read(net, "portfolio")).groups[0]!.patterns.filter((x) => x.rule === "NIR-01").map((x) => x.support);
	const lakeside = (await rows())["Lakeside Church"]!;
	assert.ok(lakeside.status === "released");
	assert.equal(lakeside.runId, first.runId, "the previous released result, not the embargoed newest");
	assert.deepEqual((await rows())["Riverside Church"], { status: "not_assessed" }, "nothing released: no input");
	assert.deepEqual(await shared(), [], "one released result makes no shared-concern pattern");
	const plantView = async (p: Plant) => (await getPlant(c0.db, net.admin, p.id, () => {}))!;
	const pv = (await plantView(a)).assessment;
	assert.ok(pv.status === "released");
	assert.equal(pv.runId, first.runId, "the plant view agrees");
	assert.deepEqual((await plantView(b)).assessment, { status: "not_assessed" });
	for (const level of LEVELS) {
		const view = await read(net, level);
		assert.deepEqual(await rows(level), {
			"Lakeside Church": lakeside,
			"Riverside Church": { status: "not_assessed" },
		});
		assert.ok(
			view.groups.every((g) => g.patterns.every((x) => x.rule !== "NIR-01")),
			`${level}: no pattern`,
		);
		for (const shown of [view, await plantView(a), await plantView(b)])
			for (const run of [newest, unreleased])
				assert.ok(!JSON.stringify(shown).includes(run.runId), `${level}: nothing from an unreleased run shows`);
	}

	ok(await assessments.markAssessmentSeen(c0.db, a.actor, { runId: newest.runId }));
	const riverside = ok(await assessments.readAssessment(c0.db, b.actor, {})).current!;
	ok(await assessments.markAssessmentSeen(c0.db, b.actor, { runId: riverside.runId }));
	const after = await rows();
	for (const [name, p, own] of [
		["Lakeside Church", a, newest],
		["Riverside Church", b, riverside],
	] as const) {
		const ni = after[name]!;
		assert.ok(ni.status === "released");
		assert.equal(ni.runId, own.runId);
		assert.deepEqual(ni.concerns, own.concerns, `${name}: same concern ids and evidence as the planter`);
		assert.deepEqual((await plantView(p)).assessment, ni, `${name}: the plant view tells the same story`);
	}
	assert.ok(newest.concerns.length > 0, "the scripted draft raises a concern");
	assert.ok((await shared()).length > 0 && (await shared()).every((n) => n === 2), "both released: a pattern of 2");
});

test("a plant that does not share findings reads Not shared at every level and Limited visibility on its plant view, while its planter sees the full assessment", async () => {
	const net = await network("Quiet Network");
	const p = await c0.harvest("Quiet Church");
	await c0.admin.execute(sql`UPDATE plant SET phase=2 WHERE id=${p.id}`);
	await link(p, net, false);
	ok(await assessments.requestRefresh(c0.db, p.actor, { requestId: randomUUID() }));
	await runAssessmentBatch(job, c0.db, scriptedAssessmentDrafter(), 20);
	const assessment = await assessments.readAssessment(c0.db, p.actor, {});
	if (assessment.status !== "ok" || !assessment.value.current) assert.fail(JSON.stringify(assessment));
	const own = assessment.value.current;
	ok(await assessments.markAssessmentSeen(c0.db, p.actor, { runId: own.runId }));
	await refresh(net);
	for (const level of LEVELS) {
		const rows = (await read(net, level)).groups.flatMap((g) => g.rows);
		assert.deepEqual(rows, [{ status: "not_shared", plantId: p.id, name: "Quiet Church" }], level);
	}
	const view = (await getPlant(c0.db, net.admin, p.id, () => {}))!;
	assert.deepEqual(view.assessment, { status: "withheld" });
	assert.equal(view.plant.health, "limited_visibility");
	assert.equal(own.lenses.length, 8, "the planter still sees every lens");
});

test("AC:GEO-011 AC:ORG55-005 the directory, the plant view and every Network Intelligence level carry no person, contact, street, private care or assessment text; the lead shows only as the approved display name, and never in Network Intelligence", async () => {
	const net = await network("Privacy Network");
	const p = await c0.harvest("Canary Church");
	await c0.admin.execute(sql`UPDATE plant SET phase=2, street='4100 Private Street' WHERE id=${p.id}`);
	await link(p, net);
	await save(p, AUSTIN_TX, "12420");
	const lead = await c0.person(p, "Alex Lead");
	await c0.admin.execute(
		sql`UPDATE person SET email='alex@example.test', phone='555-0101', street='12 Private Lane' WHERE id=${lead.id}`,
	);
	const team = randomUUID(),
		role = randomUUID(),
		op = randomUUID();
	for (const [id, kind] of [
		[team, "team"],
		[role, "team_role"],
	])
		await c0.admin.execute(sql`INSERT INTO record(id,kind,tenant_id) VALUES(${id},${kind},${p.id})`);
	await c0.admin.execute(
		sql`INSERT INTO team(id,plant_id,name,state,sort_order) VALUES(${team},${p.id},'Leadership','active',1)`,
	);
	await c0.admin.execute(sql`INSERT INTO team_role(id,plant_id,team_id,name,leadership,sort_order)
		VALUES(${role},${p.id},${team},'Lead planter',true,0)`);
	await c0.admin.execute(sql`INSERT INTO team_tenure(plant_id,role_id,person_id,started_on)
		VALUES(${p.id},${role},${lead.id},${c0.day(-30)})`);
	await c0.admin.execute(sql`INSERT INTO audit_event(id,tenant_id,actor_id,action,kind,subject_id)
		VALUES(${op},${p.id},${p.owner.id},'identity.domain_accepted','create',${p.id})`);
	await c0.admin.execute(sql`INSERT INTO onboarding_setup(plant_id,account_id,creation_operation_id,lead,journey,launch,
		people_step) VALUES(${p.id},${p.owner.id},${op},
		${JSON.stringify({ answer: "yes", assignment: { teamId: team, roleId: role, personId: lead.id } })}::jsonb,
		'{"status":"pending"}'::jsonb,'{"status":"pending"}'::jsonb,'pending')`);
	await c0.admin.execute(sql`UPDATE person SET email=${"person-" + CANARY + "@example.test"}, phone='555-0199',
		street='99 Private Court' WHERE plant_id=${p.id} AND id<>${lead.id}`);

	ok(await assessments.requestRefresh(c0.db, p.actor, { requestId: randomUUID() }));
	await runAssessmentBatch(job, c0.db, scriptedAssessmentDrafter(), 20);
	const assessment = await assessments.readAssessment(c0.db, p.actor, {});
	if (assessment.status !== "ok" || !assessment.value.current) assert.fail(JSON.stringify(assessment));
	const own = assessment.value.current;
	ok(await assessments.markAssessmentSeen(c0.db, p.actor, { runId: own.runId }));
	await refresh(net);

	const directory = (await listPlants(c0.db, net.admin))!;
	assert.equal(directory.plants.find((x) => x.plantId === p.id)!.leadPlanter, "Alex Lead");
	const plantView = (await getPlant(c0.db, net.admin, p.id, () => {}))!;
	assert.equal(plantView.plant.leadPlanter, "Alex Lead");
	assert.ok(plantView.assessment.status === "released" && plantView.assessment.concerns.length > 0);
	const intelligence = await Promise.all(LEVELS.map((level) => read(net, level)));

	const people = await c0.rows(sql`SELECT id,display_name,email,phone FROM person WHERE plant_id=${p.id}`);
	const forbidden = [
		...people.flatMap((x) => [x.id, x.email, x.phone]),
		...people.filter((x) => x.id !== lead.id).map((x) => x.display_name),
		p.owner.id,
		p.owner.email,
		lead.id,
		"Private Street",
		"Private Lane",
		"Private Court",
		CANARY,
		own.summary,
		own.focus.title,
		own.focus.body,
		...own.supporting.flatMap((x) => [x.title, x.body]),
		...own.positives.flatMap((x) => [x.title, x.body]),
	].filter((x): x is string => typeof x === "string" && x.length > 0);
	for (const [name, payload] of [
		["directory", directory],
		["plant view", plantView],
		...LEVELS.map((level, i) => [`Network Intelligence (${level})`, intelligence[i]] as const),
	] as const) {
		const text = JSON.stringify(payload);
		for (const value of forbidden) assert.ok(!text.includes(value), `${name} carries ${value}`);
		assert.doesNotMatch(text, /"(passage|note|source|disengaged|street|email|phone|personId|accountId)"/, name);
	}
	for (const v of intelligence) assert.ok(!JSON.stringify(v).includes("Alex Lead"), "no named person feeds NI");
});

type LiCase = {
	id: string;
	given: Record<string, { fixture_type: string; value?: unknown }>;
	action: { operation: string; arguments: Record<string, unknown> };
	expected: { state: Record<string, unknown>; result: Record<string, unknown>; event: unknown };
};
function li(id: string) {
	const c = caseOf("intelligence", id) as unknown as LiCase;
	assert.equal(c.action.operation, "organizationIntelligence.readLocations");
	assert.deepEqual(c.expected.state, {}, `${id}: the read changes no state`);
	assert.equal(c.expected.event, null);
	return { c, e: c.expected.result };
}
function given<T>(c: LiCase, key: string): T {
	const g = c.given[key];
	assert.ok(g?.fixture_type === "fixture", `${c.id} gives ${key}`);
	if (key in c.action.arguments)
		assert.deepEqual(c.action.arguments[key], g.value, `${c.id}: the read is asked about ${key}`);
	return g.value as T;
}
const DALLAS_TX = { city: "Dallas", stateProvince: "TX", country: "US" };
const NEW_YORK_NY = { city: "New York", stateProvince: "NY", country: "US" };
const NEWARK_NJ = { city: "Newark", stateProvince: "NJ", country: "US" };
const KERRVILLE_TX = { city: "Kerrville", stateProvince: "TX", country: "US" };
const NOWHERE_TX = { city: "Nowhere", stateProvince: "TX", country: "US" };
const NO_PLACE = { city: null, stateProvince: null, country: "US" };
const VENUE = "77 Meeting Hall Road";
const STREET = "4100 Private Street";
const COORDINATES = "30.267153, -97.743057";

async function quietPlant(name: string, where: Locality) {
	const p = await c0.plant(name, { phase: 1 });
	await c0.admin.execute(sql`UPDATE plant SET city=${where.city},state_province=${where.stateProvince},
		country=${where.country},street=${STREET} WHERE id=${p.id}`);
	return p;
}
async function contributor(
	net: Network,
	name: string,
	where: Locality,
	code: string | null | undefined,
	relevant = true,
) {
	const p = relevant ? await plant(name, where) : await quietPlant(name, where);
	await link(p, net);
	if (code !== undefined) await save(p, where, code);
	return p;
}
async function stopSharingFindings(p: Plant, net: Network) {
	const [a] = await c0.rows<{
		id: string;
		revision: string;
		consent: string;
	}>(sql`SELECT id, revision::text AS revision,
		consent_revision::text AS consent FROM affiliation WHERE plant_id=${p.id} AND organization_id=${net.id}`);
	const selected = { kind: "plant" as const, id: p.id };
	await gatedTransaction(c0.db, async (tx) => {
		assert.ok(await RequestActor.claimWrite(tx, p.owner.session as never, selected as never));
		return api["privacy.setSharing"](
			tx,
			p.owner.session as never,
			selected as never,
			{
				requestKey: randomUUID(),
				expectedRevision: a!.revision,
				input: {
					plant: selected,
					organization: { kind: "organization", id: net.id, organizationKind: "sending_network" },
					relationshipId: a!.id,
					expectedConsentRevision: a!.consent,
					category: "shared_findings",
					enabled: false,
				},
			} as never,
		);
	});
	assert.deepEqual(await c0.rows(sql`SELECT shared_findings FROM affiliation WHERE id=${a!.id}`), [
		{ shared_findings: false },
	]);
}

const PRIVATE_KEY =
	/^(street|address|venue_?address|meeting_?address|coordinates?|lat|latitude|lng|lon|longitude|geo_?point|people|persons?|personId|accountId|email|phone)$/i;
const LAT_LONG = /-?\d{1,3}\.\d{4,}\s*,\s*-?\d{1,3}\.\d{4,}/;
function noStreetOrPeople(payload: unknown, plants: Plant[], what: string) {
	const forbidden = [
		STREET,
		"Private Street",
		VENUE,
		COORDINATES,
		...plants.flatMap((p) => [p.owner.email, p.owner.id]),
	];
	const walk = (v: unknown, path: string): void => {
		if (typeof v === "string") {
			for (const f of forbidden) assert.ok(!v.includes(f), `${what} ${path} carries ${f}`);
			assert.doesNotMatch(v, LAT_LONG, `${what} ${path} carries coordinates`);
		} else if (Array.isArray(v)) v.forEach((x, i) => walk(x, `${path}[${i}]`));
		else if (v && typeof v === "object")
			for (const [k, x] of Object.entries(v)) {
				assert.doesNotMatch(k, PRIVATE_KEY, `${what} ${path}.${k}`);
				walk(x, `${path}.${k}`);
			}
	};
	walk(payload, "$");
}
async function writesFor(ids: string[]) {
	const any = `{${ids.join(",")}}`;
	return c0.rows(sql`SELECT
		(SELECT count(*)::int FROM audit_event WHERE tenant_id=ANY(${any}::uuid[]) OR subject_id=ANY(${any}::uuid[])) AS audits,
		(SELECT count(*)::int FROM notice WHERE tenant_id=ANY(${any}::uuid[])) AS notices`);
}
type Located = { views: Record<Level, IntelligenceView>; places: SourceResult };
async function located(net: Network, plants: Plant[], runId: string | null = null): Promise<Located> {
	const ids = [net.id, ...plants.map((p) => p.id)];
	const before = await writesFor(ids);
	const views = {} as Record<Level, IntelligenceView>;
	for (const level of LEVELS) views[level] = await read(net, level, runId);
	const places = await invokeRead(c0.db, evryActor(net.admin), readPlantLocations, {});
	assert.deepEqual(await writesFor(ids), before, "the location read records no event, audit row or notice");
	for (const level of LEVELS) noStreetOrPeople(views[level], plants, level);
	noStreetOrPeople(places, plants, "readLocations");
	return { views, places };
}
function supportAt(v: IntelligenceView) {
	return Object.fromEntries(
		v.groups.map((g) => [
			g.key,
			{
				placement: g.placement,
				contributors: g.rows.length,
				support: g.rows.filter((r) => r.status === "shared" && r.results["NIR-03"] === "gap").length,
				pattern: g.patterns.find((x) => x.rule === "NIR-03")?.support ?? null,
			},
		]),
	);
}
const placeOf = (l: Located, name: string) => l.places.rows.find((r) => r.label === name)!.fields;
const at = (support: number, contributors = support, placement = "placed") => ({
	placement,
	contributors,
	support,
	pattern: support >= 2 ? support : null,
});

test("AC:LI-001 two relevant plants in the Region their planters chose make that Region's pattern, with no street or person in the read", async () => {
	const { c, e } = li("LI-001");
	const n = given<number>(c, "relevant_current_contributors");
	assert.equal(given(c, "level"), "metro");
	assert.equal(given(c, "mapping"), "chosen authorized city/state mapping");
	const net = await network("LI-001 Network");
	const plants: Plant[] = [];
	for (let i = 0; i < n; i++)
		plants.push(await contributor(net, `LI-001 Church ${i + 1}`, i % 2 ? ROUND_ROCK : AUSTIN_TX, "12420"));
	await refresh(net);
	const l = await located(net, plants);
	assert.deepEqual(supportAt(l.views.region), { "12420": at(n) });
	assert.equal(e.support, n);
	assert.equal(e.patterns_allowed, supportAt(l.views.region)["12420"]!.pattern !== null);
	assert.deepEqual(
		l.views.region.groups[0]!.patterns.find((x) => x.rule === "NIR-03")!
			.plants.map((x) => x.plantId)
			.sort(),
		plants.map((p) => p.id).sort(),
	);
	assert.deepEqual([e.street, e.people], [null, null]);
	for (const p of plants) assert.equal(placeOf(l, p.name).region, "Austin-Round Rock-San Marcos, TX (metro area)");
});

test("AC:LI-002 one relevant plant in each of two metro areas of a state makes no metro pattern; the state and the whole portfolio count both", async () => {
	const { c, e } = li("LI-002");
	assert.deepEqual(
		[
			given(c, "metro_X_contributors"),
			given(c, "metro_Y_contributors"),
			given(c, "shared_state_contributors"),
			given(c, "whole_org_contributors"),
		],
		[1, 1, 2, 2],
	);
	const net = await network("LI-002 Network");
	const plants = [
		await contributor(net, "LI-002 Austin Church", AUSTIN_TX, "12420"),
		await contributor(net, "LI-002 Dallas Church", DALLAS_TX, "19100"),
	];
	await refresh(net);
	const l = await located(net, plants);
	assert.deepEqual(supportAt(l.views.region), { "12420": at(1), "19100": at(1) });
	assert.deepEqual([e.metro_X_pattern, e.metro_Y_pattern], [null, null]);
	assert.deepEqual(supportAt(l.views.state), { "US:TX": at(e.state_support as number) });
	assert.deepEqual(supportAt(l.views.portfolio), { portfolio: at(e.whole_support as number) });
});

test("AC:LI-003 a state with one relevant plant has no pattern while the whole portfolio of three makes one", async () => {
	const { c, e } = li("LI-003");
	assert.equal(given(c, "state_X_contributors"), 1);
	assert.equal(given(c, "whole_org_contributors"), 3);
	const net = await network("LI-003 Network");
	const plants = [
		await contributor(net, "LI-003 Austin Church", AUSTIN_TX, "12420"),
		await contributor(net, "LI-003 Harlem Church", NEW_YORK_NY, "35620"),
		await contributor(net, "LI-003 Newark Church", NEWARK_NJ, "35620"),
	];
	await refresh(net);
	const l = await located(net, plants);
	assert.deepEqual(supportAt(l.views.state), { "US:NJ": at(1), "US:NY": at(1), "US:TX": at(1) });
	assert.equal(e.state_X_pattern, null);
	assert.deepEqual(supportAt(l.views.portfolio), { portfolio: at(e.whole_support as number) });
});

test("AC:LI-004 ten relevant plants of another organization in the same Region lend no support to this organization's one", async () => {
	const { c, e } = li("LI-004");
	const mine = given<number>(c, "A_contributors");
	const foreign = given<number>(c, "foreign_org_B_contributors");
	const [netA, netB] = [await network("LI-004 Network A"), await network("LI-004 Network B")];
	const ours: Plant[] = [];
	for (let i = 0; i < mine; i++) ours.push(await contributor(netA, `LI-004 Our Church ${i + 1}`, AUSTIN_TX, "12420"));
	const theirs: Plant[] = [];
	for (let i = 0; i < foreign; i++)
		theirs.push(await contributor(netB, `LI-004 Their Church ${i + 1}`, i % 2 ? ROUND_ROCK : AUSTIN_TX, "12420"));
	await refresh(netA);
	await refresh(netB);
	const a = await located(netA, ours);
	for (const level of LEVELS) {
		const view = supportAt(a.views[level]);
		assert.deepEqual(Object.values(view), [at(mine)], `${level}: only A's own plant counts`);
		const text = JSON.stringify(a.views[level]);
		const borrowed = theirs.filter((p) => text.includes(p.id) || text.includes(p.name)).length;
		assert.equal(borrowed, e.foreign_B_support_borrowed, `${level}: no B plant is borrowed`);
	}
	assert.equal(e.A_pattern, null);
	assert.deepEqual(
		a.places.rows.map((r) => r.id),
		ours.map((p) => p.id),
	);
	const b = await located(netB, theirs);
	assert.deepEqual(supportAt(b.views.region), { "12420": at(foreign) }, "B's own read has its ten");
});

test("AC:LI-005 a plant that stops sharing health results contributes nothing and reads Not shared at every level, so one other plant makes no pattern", async () => {
	const { c, e } = li("LI-005");
	assert.equal(given(c, "P_health_results_sharing"), "OFF");
	assert.equal(given(c, "P_location"), "known metro/state");
	const others = given<number>(c, "other_relevant_contributors");
	const net = await network("LI-005 Network");
	const p = await contributor(net, "LI-005 Private Church", AUSTIN_TX, "12420");
	const rest: Plant[] = [];
	for (let i = 0; i < others; i++) rest.push(await contributor(net, `LI-005 Church ${i + 1}`, ROUND_ROCK, "12420"));
	await stopSharingFindings(p, net);
	await refresh(net);
	const l = await located(net, [p, ...rest]);
	for (const level of LEVELS) {
		const groups = Object.values(supportAt(l.views[level]));
		assert.deepEqual(groups, [{ ...at(others), contributors: others + 1 }], `${level}: P contributes 0, no pattern`);
		const rows = l.views[level].groups.flatMap((g) => g.rows).filter((r) => r.plantId === p.id);
		assert.deepEqual(rows, [{ status: "not_shared", plantId: p.id, name: p.name }], level);
	}
	assert.deepEqual([e.P_contribution, e.pattern], [0, null]);
	assert.equal(placeOf(l, p.name).findings, e.P_label);
	assert.equal(placeOf(l, rest[0]!.name).findings, "Shared");
	const history = await invokeRead(c0.db, evryActor(net.admin), readIntelligenceHistory, { level: "region" });
	assert.ok(history.rows.some((r) => String(r.fields.plants).includes(`${p.name} (${e.P_label as string})`)));
});

test("AC:LI-006 a Region with two plants but only one carrying the relevant evidence has support one and no pattern", async () => {
	const { c, e } = li("LI-006");
	assert.equal(given(c, "region_plants"), 2);
	assert.equal(given(c, "relevant_evidence_contributors"), 1);
	const net = await network("LI-006 Network");
	const plants = [
		await contributor(net, "LI-006 Near Launch Church", AUSTIN_TX, "12420"),
		await contributor(net, "LI-006 Early Church", ROUND_ROCK, "12420", false),
	];
	await refresh(net);
	const l = await located(net, plants);
	assert.deepEqual(supportAt(l.views.region), {
		"12420": { placement: "placed", contributors: 2, support: e.support, pattern: e.pattern },
	});
	assert.deepEqual(l.views.region.groups[0]!.patterns, [], "no pattern of any rule");
});

test("AC:LI-007 the location read takes city, state, country and Region only; a street, coordinates or a meeting address is refused and never shown", async () => {
	const { c, e } = li("LI-007");
	assert.deepEqual(given(c, "input_candidate"), [
		"plant city",
		"plant state",
		"street address",
		"coordinates",
		"meeting address",
	]);
	const net = await network("LI-007 Network");
	const p = await contributor(net, "LI-007 Church", AUSTIN_TX, undefined);
	const meeting = await c0.vision(p, 3, []);
	await c0.admin.execute(sql`UPDATE meeting SET venue_address=${VENUE} WHERE id=${meeting}`);
	const current = (await readReportingLocation(c0.db, p.actor))!;
	const offered = await candidates(p, AUSTIN_TX);
	const selected = { kind: "plant" as const, id: p.id };
	await assert.rejects(
		gatedTransaction(c0.db, async (tx) => {
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
						locality: { ...AUSTIN_TX, street: STREET, coordinates: COORDINATES, meetingAddress: VENUE },
						referenceVersionId: current.referenceVersionId,
						regionItemId: offered[0]!.regionItemId,
					},
				} as never,
			);
		}),
		(err: Error) =>
			/unrecognized_keys/.test(err.message) &&
			["street", "coordinates", "meetingAddress"].every((k) => err.message.includes(`"${k}"`)),
	);
	assert.equal((await readReportingLocation(c0.db, p.actor))!.revision, current.revision, "nothing saved");
	await save(p, AUSTIN_TX, "12420");
	await refresh(net);
	const l = await located(net, [p]);
	const FIELD = { city: "city", state: "stateProvince", country: "country", reporting_region: "region" } as const;
	const fields = e.fields as (keyof typeof FIELD)[];
	const extra = ["countsIn", "findings", "href"];
	assert.deepEqual(
		Object.keys(placeOf(l, p.name))
			.filter((k) => !extra.includes(k))
			.sort(),
		fields.map((f) => FIELD[f]).sort(),
	);
	assert.deepEqual(placeOf(l, p.name), {
		city: "Austin",
		stateProvince: "TX",
		country: "US",
		region: "Austin-Round Rock-San Marcos, TX (metro area)",
		countsIn: "Austin-Round Rock-San Marcos, TX (metro area), Texas, United States, Whole portfolio",
		findings: "Shared",
		href: placeOf(l, p.name).href,
	});
	const history = (await readLocationHistory(c0.db, net.admin, p.id))!;
	assert.deepEqual(
		Object.keys(history.locations[0]!).sort(),
		[...fields.map((f) => FIELD[f]), "effectiveAt", "runs"].sort(),
	);
	const evryHistory = await invokeRead(c0.db, evryActor(net.admin), readPlantLocationHistory, { plantId: p.id });
	const planter = (await readReportingLocation(c0.db, p.actor))!;
	assert.deepEqual(Object.keys(planter.locality).sort(), ["city", "country", "stateProvince"]);
	for (const [what, payload] of [
		["location history", history],
		["Evry location history", evryHistory],
		["planter location", planter],
	] as const)
		noStreetOrPeople(payload, [p], what);
	assert.deepEqual([e.street, e.coordinates], [null, null]);
});

test("AC:LI-008 a two-state metro Region counts both plants together while each state alone has no pattern; country and whole portfolio count two", async () => {
	const { c, e } = li("LI-008");
	const metro = given<string>(c, "metro");
	const [, code, type, release] = metro.split(":");
	assert.equal(given(c, "proposed_standard"), "pinned official metro/micro CBSA Region");
	assert.deepEqual(
		[
			given(c, "NY_contributors"),
			given(c, "NJ_contributors"),
			given(c, "metro_contributors"),
			given(c, "whole_org_contributors"),
		],
		[1, 1, 2, 2],
	);
	const net = await network("LI-008 Network");
	const plants = [
		await contributor(net, "LI-008 Harlem Church", NEW_YORK_NY, code!),
		await contributor(net, "LI-008 Newark Church", NEWARK_NJ, code!),
	];
	await refresh(net);
	const l = await located(net, plants);
	assert.deepEqual(supportAt(l.views.region), { [code!]: at(e.region_support as number) });
	assert.match(l.views.region.groups[0]!.label, new RegExp(`\\(${type} area\\)$`));
	assert.equal(release, "2023-07");
	assert.match(l.views.region.geographyReleases[0]!.credit, /July 2023/);
	assert.deepEqual(supportAt(l.views.state), { "US:NJ": at(1), "US:NY": at(1) });
	assert.deepEqual([e.NY_pattern, e.NJ_pattern], [null, null]);
	assert.deepEqual(supportAt(l.views.country), { US: at(e.country_support as number) });
	assert.deepEqual(supportAt(l.views.portfolio), { portfolio: at(e.whole_support as number) });
});

test("AC:LI-009 a plant with no Region assigned has no Region placement but stays eligible for its state and the whole portfolio", async () => {
	const { c, e } = li("LI-009");
	assert.equal(given(c, "plant"), "P");
	assert.equal(given(c, "metro"), "ambiguous/unassigned");
	assert.equal(given(c, "state"), "known authorized fixture state");
	assert.equal(given(c, "another_state_contributor"), "Q");
	const net = await network("LI-009 Network");
	const p = await contributor(net, "LI-009 Unassigned Church", AUSTIN_TX, null);
	const q = await contributor(net, "LI-009 Dallas Church", DALLAS_TX, "19100");
	await refresh(net);
	const l = await located(net, [p, q]);
	assert.deepEqual(supportAt(l.views.region), { "19100": at(1), unresolved: at(1, 1, "unresolved") });
	assert.equal(e.region, null);
	assert.equal(placeOf(l, p.name).region, "No Region set");
	assert.equal(placeOf(l, p.name).countsIn, "Texas, United States, Whole portfolio");
	assert.deepEqual(supportAt(l.views.state), { "US:TX": at(2) });
	assert.equal(e.state_eligible, supportAt(l.views.state)["US:TX"]!.pattern !== null);
	assert.deepEqual(supportAt(l.views.portfolio), { portfolio: at(2) });
	assert.equal(e.whole_eligible, supportAt(l.views.portfolio).portfolio!.pattern !== null);
});

test("AC:LI-010 a plant outside the official list, one with its city unresolved and one with no city or state each show their own status and are never a named metro", async () => {
	const { c, e } = li("LI-010");
	assert.equal(given(c, "proposed_standard"), "pinned official metro/micro CBSA Region");
	assert.deepEqual(given(c, "metro_status"), ["known-outside-CBSA", "unresolved-city-mapping", "missing-city/state"]);
	const net = await network("LI-010 Network");
	const plants = [
		await contributor(net, "LI-010 Prairie Church", NOWHERE_TX, null),
		await contributor(net, "LI-010 Unsure Church", AUSTIN_TX, null),
		await contributor(net, "LI-010 Placeless Church", NO_PLACE, undefined),
	];
	await refresh(net);
	const l = await located(net, plants);
	const STATUS: Record<string, string> = { known_outside_reference: "outside_reference" };
	const region = l.views.region.groups;
	assert.deepEqual(
		plants.map((p) => region.find((g) => g.rows.some((r) => r.plantId === p.id))!.placement),
		(e.statuses as string[]).map((s) => STATUS[s] ?? s),
	);
	assert.equal(
		region.some((g) => g.placement === "placed"),
		e.zero_named_metro,
		"none is shown in a named metro",
	);
	assert.ok(region.every((g) => g.patterns.length === 0));
	assert.deepEqual(supportAt(l.views.state), { "US:TX": at(2), missing: at(1, 1, "missing") });
	assert.deepEqual(supportAt(l.views.portfolio), { portfolio: at(3) });
});

test("AC:LI-011 a plant with no city or state has no regional placement but still counts in the whole portfolio", async () => {
	const { c, e } = li("LI-011");
	assert.equal(given(c, "city_state"), "missing");
	assert.equal(given(c, "plant"), "eligible shared relevant evidence");
	const others = given<number>(c, "whole_org_other_contributors");
	const net = await network("LI-011 Network");
	const p = await contributor(net, "LI-011 Placeless Church", NO_PLACE, undefined);
	const rest: Plant[] = [];
	for (let i = 0; i < others; i++) rest.push(await contributor(net, `LI-011 Church ${i + 1}`, DALLAS_TX, "19100"));
	await refresh(net);
	const l = await located(net, [p, ...rest]);
	for (const level of ["region", "state"] as const) {
		const own = l.views[level].groups.find((g) => g.rows.some((r) => r.plantId === p.id))!;
		assert.equal(own.placement, "missing", `${level}: no placement`);
	}
	assert.equal(e.regional_placement, null);
	assert.equal(placeOf(l, p.name).region, "No Region set");
	assert.deepEqual(supportAt(l.views.portfolio), { portfolio: at(e.whole_support as number) });
});

test("AC:LI-012 a corrected place and Region apply from a new run; the earlier run keeps the location it used", async () => {
	const { c, e } = li("LI-012");
	assert.equal(given(c, "R1_location"), "old city/state/mapping revision");
	assert.equal(given(c, "correction"), "new city/state or mapping version");
	const net = await network("LI-012 Network");
	const p = await contributor(net, "LI-012 Moving Church", AUSTIN_TX, "12420");
	const r1 = await refresh(net);
	const before = await located(net, [p]);
	await save(p, NEW_YORK_NY, "35620");
	const r2 = await refresh(net);
	const now = await located(net, [p]);
	const then = await located(net, [p], r1);
	assert.equal(now.views.region.run!.runId, r2);
	assert.notEqual(r2, r1);
	assert.equal(e.new_run, "R2");
	for (const level of LEVELS) {
		assert.equal(then.views[level].run!.runId, r1);
		assert.deepEqual(supportAt(then.views[level]), supportAt(before.views[level]), `${level}: R1 is not rewritten`);
	}
	assert.equal(e.R1_location_rewritten, false);
	assert.deepEqual(Object.keys(supportAt(then.views.region)), ["12420"]);
	assert.deepEqual(Object.keys(supportAt(then.views.state)), ["US:TX"]);
	assert.deepEqual(Object.keys(supportAt(now.views.region)), ["35620"]);
	assert.deepEqual(Object.keys(supportAt(now.views.state)), ["US:NY"]);
	const ran = Object.fromEntries(now.views.region.history.map((h) => [h.runId, h.ranAt]));
	const history = (await readLocationHistory(c0.db, net.admin, p.id))!;
	assert.deepEqual(
		history.locations.map((x) => [x.city, x.stateProvince, x.region?.code, x.runs]),
		[
			["New York", "NY", "35620", [ran[r2]]],
			["Austin", "TX", "12420", [ran[r1]]],
		],
	);
	const evry = await invokeRead(c0.db, evryActor(net.admin), readPlantLocationHistory, { plantId: p.id });
	assert.deepEqual(
		evry.rows.map((r) => [r.label, r.fields.current]),
		[
			["New York, NY, US", true],
			["Austin, TX, US", false],
		],
	);
});

test("AC:LI-013 the Region, state and whole-portfolio views are slices of the same organization run, not a separate location engine", async () => {
	const { c, e } = li("LI-013");
	assert.equal(given(c, "org_run"), "R1");
	assert.deepEqual(given(c, "views"), ["metro", "state", "whole-org"]);
	const LEVEL: Record<string, Level> = { metro: "region", state: "state", "whole-org": "portfolio" };
	const net = await network("LI-013 Network");
	const plants = [
		await contributor(net, "LI-013 Austin Church", AUSTIN_TX, "12420"),
		await contributor(net, "LI-013 Round Rock Church", ROUND_ROCK, "12420"),
	];
	const r1 = await refresh(net);
	const l = await located(net, plants);
	const views = (c.given.views!.value as string[]).map((v) => l.views[LEVEL[v]!]);
	assert.deepEqual(
		views.map((v) => v.level),
		(e.views as string[]).map((v) => (v === "whole" ? "portfolio" : v)),
	);
	assert.deepEqual(
		views.map((v) => v.run!.runId),
		[r1, r1, r1],
	);
	assert.equal(e.assessment_id, "R1");
	const rowsOf = (v: IntelligenceView) =>
		v.groups.flatMap((g) => g.rows).sort((a, b) => a.plantId.localeCompare(b.plantId));
	for (const v of views) assert.deepEqual(rowsOf(v), rowsOf(views[0]!), `${v.level}: the same contributions`);
	for (const v of views) assert.deepEqual(Object.values(supportAt(v)), [at(2)], `${v.level}: the same pattern support`);
	const pinned = await located(net, plants, r1);
	for (const level of LEVELS) assert.deepEqual(supportAt(pinned.views[level]), supportAt(l.views[level]));
	for (const p of plants)
		assert.equal(
			placeOf(l, p.name).countsIn,
			LEVELS.map((level) => l.views[level].groups.find((g) => g.rows.some((r) => r.plantId === p.id))!.label).join(
				", ",
			),
			"the location read places the plant where the run grouped it",
		);
	assert.equal(e.separate_location_engine, false);
});

test("AC:LI-014 a plant with current relevant evidence counts once at each level, and each level needs two such plants", async () => {
	const { c, e } = li("LI-014");
	assert.equal(given(c, "plant"), "P");
	assert.equal(given(c, "authorized_relevant_evidence"), "current");
	assert.deepEqual(given(c, "levels"), ["metro", "state", "whole-org"]);
	const levels: Level[] = ["region", "state", "portfolio"];
	const net = await network("LI-014 Network");
	const p = await contributor(net, "LI-014 Church", AUSTIN_TX, "12420");
	await refresh(net);
	const alone = await located(net, [p]);
	assert.deepEqual(
		levels.map(
			(level) =>
				alone.views[level].groups.flatMap((g) => g.rows).filter((r) => r.status === "shared" && r.plantId === p.id)
					.length,
		),
		e.P_contribution_per_level,
	);
	const floor = e.support_floor_per_level as number;
	for (const level of levels)
		assert.deepEqual(Object.values(supportAt(alone.views[level])), [at(1)], `${level}: below the floor of ${floor}`);
	const q = await contributor(net, "LI-014 Second Church", ROUND_ROCK, "12420");
	await refresh(net);
	const pair = await located(net, [p, q]);
	for (const level of levels)
		assert.deepEqual(
			Object.values(supportAt(pair.views[level])).map((g) => g.pattern),
			[floor],
			`${level}: the floor reached`,
		);
});

test("AC:LI-015 a plant that turns sharing off leaves its Region's published pattern on every surface; it reads Not shared with no reason and one plant remains", async () => {
	const { c, e } = li("LI-015");
	assert.deepEqual(given(c, "published_region_contributors"), ["P", "Q"]);
	assert.equal(given(c, "Q_permission"), "now OFF");
	assert.deepEqual(given(c, "requested_surface"), ["latest", "history", "export", "Evry", "cache"]);
	const net = await network("LI-015 Network");
	const p = await contributor(net, "LI-015 Staying Church", AUSTIN_TX, "12420");
	const q = await contributor(net, "LI-015 Leaving Church", ROUND_ROCK, "12420");
	const r1 = await refresh(net);
	const published = await located(net, [p, q]);
	assert.deepEqual(supportAt(published.views.region), { "12420": at(2) });
	const oldKey = published.views.region.groups[0]!.patterns.find((x) => x.rule === "NIR-03")!.key;
	await stopSharingFindings(q, net);
	const check = async (l: Located, surface: string) => {
		for (const level of LEVELS) {
			assert.deepEqual(
				Object.values(supportAt(l.views[level])),
				[{ ...at(e.remaining_support as number), contributors: 2 }],
				`${surface} ${level}: the old pattern is gone`,
			);
			const rows = l.views[level].groups.flatMap((g) => g.rows).filter((r) => r.plantId === q.id);
			assert.deepEqual(rows, [{ status: "not_shared", plantId: q.id, name: q.name }], `${surface} ${level}: no reason`);
		}
	};
	const latest = await located(net, [p, q]);
	await check(latest, "latest");
	const history = await located(net, [p, q], r1);
	await check(history, "history");
	assert.equal(await readPattern(c0.db, net.admin, { runId: r1, patternKey: oldKey }), null, "the old pattern link");
	assert.equal(placeOf(latest, q.name).findings, e.Q_label);
	const evry = evryActor(net.admin);
	const label = `${q.name} (${e.Q_label as string})`;
	const evryLatest = await invokeRead(c0.db, evry, readNetworkIntelligence, { level: "region" });
	assert.deepEqual(evryLatest.rows, [], "Evry latest: no pattern");
	assert.equal(evryLatest.facts?.groups, `Austin-Round Rock-San Marcos, TX (metro area): ${p.name}, ${label}`);
	const evryHistory = await invokeRead(c0.db, evry, readIntelligenceHistory, { runId: r1 });
	for (const level of LEVELS) {
		const groups = evryHistory.rows.filter((r) => r.fields.row === "group" && r.id.startsWith(`group:${level}:`));
		assert.deepEqual(
			groups.map((r) => [r.fields.plants, r.fields.patterns]),
			[[`${label}, ${p.name}`, null]],
			`Evry history ${level}`,
		);
	}
	assert.ok(!evryHistory.rows.some((r) => r.fields.row === "pattern"), "Evry history: no pattern");
	for (const [surface, result] of [
		["Evry latest", evryLatest],
		["Evry history", evryHistory],
	] as const)
		noStreetOrPeople(result, [p, q], surface);
	assert.equal(e.Q_reason, null);
	assert.equal(e.old_pattern, null);
	await refresh(net);
	await check(await located(net, [p, q]), "a new run");
});

test("AC:LI-016 a supported Region names its exact code, type and pinned release and links its plants, with no raw reference manifest", async () => {
	const { c, e } = li("LI-016");
	assert.equal(given(c, "region"), "exact confirmed RegionRef code/type/release");
	assert.equal(given(c, "result"), "supported authorized aggregate");
	assert.equal(given(c, "mapping_version"), "V1");
	const net = await network("LI-016 Network");
	const plants = [
		await contributor(net, "LI-016 Austin Church", AUSTIN_TX, "12420"),
		await contributor(net, "LI-016 Round Rock Church", ROUND_ROCK, "12420"),
	];
	await refresh(net);
	const l = await located(net, plants);
	const versions = await Promise.all(
		plants.map(async (p) => (await readReportingLocation(c0.db, p.actor))!.referenceVersionId),
	);
	assert.equal(new Set(versions).size, 1, "both plants saved against the same mapping version");
	const [ref] = await c0.rows<{ key: string; manifest: string; locator: string; approval: string; path: string }>(sql`
		SELECT r.release_key AS key, r.manifest_hash AS manifest, r.artifact_locator AS locator,
		r.approval_locator AS approval, v.artifact_path AS path
		FROM reference_version v JOIN reference_release r ON r.id=v.release_id WHERE v.id=${versions[0]}`);
	const group = l.views.region.groups[0]!;
	assert.deepEqual(
		[group.key, group.label, group.placement],
		["12420", "Austin-Round Rock-San Marcos, TX (metro area)", "placed"],
	);
	assert.deepEqual(
		l.views.region.geographyReleases.map((r) => r.key),
		[ref!.key],
		`the shown release is the mapping version ${e.mapping_version as string} the plants were saved with`,
	);
	const pattern = group.patterns.find((x) => x.rule === "NIR-03")!;
	assert.deepEqual(pattern.plants.map((x) => x.plantId).sort(), plants.map((p) => p.id).sort());
	assert.equal(e.plant_link_allowed, true);
	const evry = await invokeRead(c0.db, evryActor(net.admin), readIntelligenceHistory, { level: "region" });
	const row = evry.rows.find((r) => r.fields.patternKey === pattern.key)!;
	for (const p of plants) assert.ok(String(row.fields.plantLinks).includes(p.id), "the pattern links each plant");
	for (const payload of [...LEVELS.map((level) => l.views[level]), l.places, evry]) {
		const text = JSON.stringify(payload);
		for (const raw of [ref!.manifest, ref!.locator, ref!.approval, ref!.path])
			assert.ok(!text.includes(raw), `no raw manifest value ${raw}`);
		assert.doesNotMatch(text, /manifest/i);
	}
	assert.equal(e.raw_manifest, null);
});

test("AC:LI-017 the US Regions are the July 2023 OMB 23-01 metro and micro areas; each plant has one primary Region and counts once in its country and the whole portfolio", async () => {
	const { c, e } = li("LI-017");
	assert.equal(given(c, "US_reference"), "July 2023/OMB23-01 metro+micro");
	assert.deepEqual(given(c, "country_views"), ["Country", "Whole portfolio"]);
	const primary = given<number>(c, "primary_association_count");
	const net = await network("LI-017 Network");
	const plants = [
		await contributor(net, "LI-017 Austin Church", AUSTIN_TX, "12420"),
		await contributor(net, "LI-017 Kerrville Church", KERRVILLE_TX, "28500"),
	];
	await refresh(net);
	const l = await located(net, plants);
	const release = l.views.region.geographyReleases;
	assert.equal(release.length, 1);
	assert.match(release[0]!.credit, new RegExp(`OMB Bulletin ${(e.reference as string).slice(3)} \\(July 2023\\)`));
	assert.equal(e.reference_release, "2023-07");
	const TYPE: Record<string, string> = { metropolitan: "metro", micropolitan: "micro" };
	assert.deepEqual(
		l.views.region.groups.map((g) => /\((metro|micro) area\)$/.exec(g.label)![1]).sort(),
		(e.region_types as string[]).map((t) => TYPE[t]).sort(),
	);
	for (const p of plants)
		for (const level of LEVELS)
			assert.equal(
				l.views[level].groups.flatMap((g) => g.rows).filter((r) => r.plantId === p.id).length,
				e.primary_associations,
				`${p.name} ${level}: ${primary} primary association`,
			);
	assert.deepEqual(supportAt(l.views.country), { US: at(2) });
	assert.deepEqual(supportAt(l.views.portfolio), { portfolio: at(2) });
	const names = Object.fromEntries(LEVELS.map((level) => [level, l.views[level].groups.map((g) => g.label)]));
	assert.deepEqual([names.country, names.portfolio], [["United States"], ["Whole portfolio"]]);
});

test("AC:LI-018 the whole portfolio counts every eligible plant, one with a known Region and one with none", async () => {
	const { c, e } = li("LI-018");
	assert.equal(given(c, "currently_eligible_contributors"), 2);
	assert.deepEqual(given(c, "regional_placement"), ["known", "unknown"]);
	const net = await network("LI-018 Network");
	const plants = [
		await contributor(net, "LI-018 Placed Church", AUSTIN_TX, "12420"),
		await contributor(net, "LI-018 Unplaced Church", DALLAS_TX, null),
	];
	await refresh(net);
	const l = await located(net, plants);
	assert.deepEqual(supportAt(l.views.region), { "12420": at(1), unresolved: at(1, 1, "unresolved") });
	assert.deepEqual(supportAt(l.views.portfolio), { portfolio: at(e.whole_support as number) });
	assert.equal(
		l.views.portfolio.groups[0]!.rows.some((r) => r.plantId === plants[1]!.id),
		!e.unknown_mapping_excluded_from_whole,
	);
});

test("AC:GEO-010 a newer geography release changes the current view's Regions; the earlier run keeps the release it read", async () => {
	const net = await network("Release Update Network");
	const p = await plant("Adopting Church", AUSTIN_TX);
	await link(p, net);
	await save(p, AUSTIN_TX, "12420");
	const before = await refresh(net);
	const release = randomUUID();
	const hash = randomUUID().replaceAll("-", "").repeat(2);
	await c0.admin
		.execute(sql`INSERT INTO reference_release(id,release_key,artifact_locator,manifest_hash,state,complete_at,
		validated_at,approval_locator,approval_hash,chunker_version,embedding_profile,embedding_dimensions,tenant_id,
		expected_passages) VALUES(${release},'geography/omb-23-01-r2','memory://r2',${hash},'validated',clock_timestamp(),
		clock_timestamp()+interval '1 second','memory://approval',${hash},'none','none',1,'00000000-0000-0000-0000-000000000000',0)`);
	await c0.admin.execute(sql`INSERT INTO reference_version(item_id,release_id,version_number,artifact_path,content_hash,
		source_credit) SELECT i.id,${release},2,'memory://r2/areas.json',${hash},'Release two of the official areas'
		FROM reference_item i WHERE i.kind='geography_dataset' AND i.canonical_key='omb-23-01'`);
	await save(p, AUSTIN_TX, "12420");
	await refresh(net);
	const now = await read(net, "region");
	const then = await read(net, "region", before);
	assert.deepEqual(
		now.geographyReleases.map((r) => r.key),
		["geography/omb-23-01-r2"],
	);
	assert.deepEqual(
		then.geographyReleases.map((r) => r.key),
		[OMB],
	);
	assert.deepEqual(Object.keys(levelOf(then)), ["12420"]);
});
