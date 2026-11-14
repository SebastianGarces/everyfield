// Network Intelligence by Region, state or province, Country and Whole portfolio (organizationIntelligence.read and
// .readLocations, REQ-PI-044), and how it agrees with the oversight plant view and Plant Intelligence on released
// results (REQ-PI-043, PI-032) and on what it never carries (REQ-IDN-023). "The network Admin opens Network
// Intelligence at a level" is readIntelligence at that level as a network Admin seat; "the planter opens Plant
// Intelligence" is intelligence.readAssessment as the plant's Owner. Reporting locations are saved through
// organizations.correctReportingLocation, the settings Region picker's own command, from the official OMB 23-01 list
// the test installs. Assessments are published by the real job with the scripted drafter only.
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
	requestIntelligenceRefresh,
} from "../../../packages/domain/src/oversight/index.ts";
import { scriptedAssessmentDrafter } from "../../../packages/evry/src/runtime/scripted-assessment.ts";
import { ok } from "../../support/fixture.mts";
import { CANARY, church, type Church } from "../intelligence/assessment-church.mts";

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

/** A network and one of its Admin seats. */
async function network(name: string) {
	const org = await c0.database.organization("sending_network", { name, timezone: "America/Chicago" });
	const seat = await c0.database.actor(org, "admin");
	const admin = (await RequestActor.resolve(c0.db, seat.session as never)) as RequestActor;
	return { ...org, admin };
}
type Network = Awaited<ReturnType<typeof network>>;
/** Links `p` to `net` by its own active link, sharing findings and every category unless `share` is false. */
async function link(p: { id: string }, net: { id: string }, share = true) {
	await c0.admin.execute(sql`INSERT INTO affiliation(plant_id,organization_id,accepted_at,share_people,share_meetings,
		share_tasks,share_ministry_teams,share_wiki,share_activity,shared_findings)
		VALUES(${p.id},${net.id},clock_timestamp()-interval '1 day',${share},${share},${share},${share},${share},${share},${share})`);
}
/** Launch Sunday 10 days out with one required responsibility unfilled: the plant qualifies for NIR-03. */
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
/** A plant whose profile is at `where`, qualifying for NIR-03. */
async function plant(name: string, where: Locality) {
	const p = await c0.plant(name, { phase: 2 });
	await c0.admin.execute(sql`UPDATE plant SET city=${where.city},state_province=${where.stateProvince},
		country=${where.country},street='4100 Private Street' WHERE id=${p.id}`);
	await nearLaunch(p);
	return p;
}
/** The official areas the planter's Region picker offers for `where`. */
const candidates = async (p: Plant, where: Locality) => (await suggestRegions(c0.db, p.actor, where))!;
/**
 * The planter saves `where` as the plant's reporting location from the Region picker, with the Region whose CBSA code
 * is `code` (one of the picker's candidates), or none.
 */
async function save(p: Plant, where: Locality, code: string | null) {
	const current = (await readReportingLocation(c0.db, p.actor))!;
	const offered = await candidates(p, where);
	const region = code === null ? null : offered.find((c) => c.area.code === code)!.regionItemId;
	assert.ok(code === null || region, `the picker offers ${code}`);
	const selected = { kind: "plant" as const, id: p.id };
	await c0.db.transaction(async (tx) => {
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
/** Each group at a level: its placement, the sharing plants it counts and its NIR-03 pattern's support (or null). */
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
	// The official list names "Austin" a principal city of two areas: with no state given, the picker offers both.
	const austin = { city: "Austin", stateProvince: null, country: "US" };
	const p = await plant("Two Austins Church", austin);
	const offered = await candidates(p, austin);
	assert.deepEqual(offered.map((c) => c.area.code).sort(), ["12380", "12420"]);
	// The saved location before any choice: no Region, and nothing guessed from the first candidate.
	assert.equal((await readReportingLocation(c0.db, p.actor))!.region, null);
	// The picker's command takes a city, state or province and country only: there is no street to give.
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
	// Unsure Church never saved a location: its profile's Austin, TX is not a choice.
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
	// GEO-012: nothing reads a planting-area attestation, and the saved reporting location says none was made.
	assert.doesNotMatch(JSON.stringify(v), /attest|geographic_?area|planting_?area/i);
	const location = (await readReportingLocation(c0.db, outside.actor))!;
	assert.deepEqual(Object.keys(location).sort(), ["canEdit", "locality", "referenceVersionId", "region", "revision"]);
	assert.equal(location.region, null);
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
	await publish(b);
	assert.notEqual(newest.runId, first.runId);
	await refresh(net);

	const rows = async () =>
		Object.fromEntries(
			(await read(net, "portfolio")).groups[0]!.rows.map((r) => [r.name, r.status === "shared" ? r.assessment : null]),
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

	// The planters open their newest runs: both network pages now show them, with the planter's own concern ids.
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
	const own = ok(await assessments.readAssessment(c0.db, p.actor, {})).current!;
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
	// The approved lead: a live Person holding the onboarding lead role, with contact details of their own.
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
	const own = ok(await assessments.readAssessment(c0.db, p.actor, {})).current!;
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

test("AC:GEO-010 a newer geography release changes the current view's Regions; the earlier run keeps the release it read", async () => {
	const net = await network("Release Update Network");
	const p = await plant("Adopting Church", AUSTIN_TX);
	await link(p, net);
	await save(p, AUSTIN_TX, "12420");
	const before = await refresh(net);
	// A newer validated release of the same official areas, adopted when the planter saves their Region again.
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
