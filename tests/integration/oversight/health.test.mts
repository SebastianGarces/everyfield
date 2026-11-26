import test, { after, before } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { sql } from "../../../packages/db/node_modules/drizzle-orm/index.js";
import * as S from "../organizations/support.mts";
import { RequestActor } from "../../../packages/domain/src/access/index.ts";
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
	submitIntelligenceFeedback,
	readIntelligence,
	requestIntelligenceRefresh,
} from "../../../packages/domain/src/oversight/index.ts";
import {
	LEVELS,
	type IntelligencePattern,
	type IntelligenceView,
} from "../../../packages/contracts/src/oversight/health.ts";

const ALL = ["people", "meetings", "tasks", "ministry_teams", "wiki", "activity", "findings"] as const;
type Category = (typeof ALL)[number];
const COLUMN: Record<Category, string> = {
	people: "share_people",
	meetings: "share_meetings",
	tasks: "share_tasks",
	ministry_teams: "share_ministry_teams",
	wiki: "share_wiki",
	activity: "share_activity",
	findings: "shared_findings",
};
type Owner = Awaited<ReturnType<typeof S.tenant>>;
const api = createOrganizationAdapter(S.effects as never, geographyReference);
const as = async (actor: { session: string }) => RequestActor.resolve(S.runtime, actor.session as never) as never;

async function link(subject: Owner, org: Owner, shared: readonly Category[] = []) {
	const column = subject.kind === "plant" ? "plant_id" : "sending_church_id";
	const r = await S.db.execute(
		sql`INSERT INTO affiliation(${sql.raw(column)},organization_id,accepted_at,${sql.raw(
			ALL.map((c) => COLUMN[c]).join(","),
		)}) VALUES(${subject.id},${org.id},clock_timestamp(),${sql.join(
			ALL.map((c) => sql`${shared.includes(c)}`),
			sql`,`,
		)}) RETURNING id`,
	);
	return r.rows[0]!.id as string;
}
const share = (id: string, category: Category, on: boolean) =>
	S.db.execute(sql`UPDATE affiliation SET ${sql.raw(COLUMN[category])}=${on} WHERE id=${id}`);
async function plant(name: string, city: string) {
	const p = await S.tenant("plant", name);
	await S.db.execute(sql`UPDATE plant SET city=${city}, state_province='TX', country='US', street='12 Private Lane',
		timezone='America/Chicago' WHERE id=${p.id}`);
	return p;
}
async function person(p: Owner, name: string) {
	const id = randomUUID();
	await S.db.execute(sql`INSERT INTO person(id,tenant_id,plant_id,display_name,email,phone,street,source,stage,
		adult_classification,commitment_state,pipeline_position,state,created_at)
		VALUES(${id},${p.id},${p.id},${name},${randomUUID() + "@example.test"},'555-0100','12 Private Lane','other',
		'launch_team','unknown','unknown','1','live',clock_timestamp())`);
	return id;
}
async function responsibility(p: Owner, key: string, holder: string | null) {
	const t = await S.db.execute(
		sql`INSERT INTO team(plant_id,name,state,sort_order) VALUES(${p.id},${key},'active',0) RETURNING id`,
	);
	const r = await S.db.execute(sql`INSERT INTO team_role(plant_id,team_id,name,leadership,sort_order,responsibility_key)
		VALUES(${p.id},${t.rows[0]!.id},${key + " lead"},true,0,${key}) RETURNING id`);
	if (holder)
		await S.db.execute(sql`INSERT INTO team_tenure(plant_id,role_id,person_id,started_on)
			VALUES(${p.id},${r.rows[0]!.id},${holder},'2026-01-01')`);
}
async function training(p: Owner, who: string, done: boolean) {
	const g = await S.db.execute(
		sql`INSERT INTO training_program(plant_id,name,required) VALUES(${p.id},'Safe kids',true) RETURNING id, version`,
	);
	const { id, version } = g.rows[0] as { id: string; version: number };
	await S.db.execute(sql`INSERT INTO training_assignment(plant_id,program_id,person_id,version,state,effective_on)
		VALUES(${p.id},${id},${who},${version},'active','2026-01-01')`);
	if (done)
		await S.db.execute(sql`INSERT INTO training_credit(plant_id,person_id,program_id,kind,version,earned_on)
			VALUES(${p.id},${who},${id},'earned',${version},'2026-02-01')`);
}
async function launch(p: Owner, days: number, completed = 0) {
	await S.db.execute(sql`INSERT INTO launch(plant_id,status,target_date)
		VALUES(${p.id},'scheduled',(clock_timestamp() AT TIME ZONE 'America/Chicago')::date + ${days}::int)`);
	for (let i = 0; i < 9; i++)
		await S.db.execute(sql`INSERT INTO launch_milestone(plant_id,title,area,position,template_key,completed_at)
			VALUES(${p.id},${"Milestone " + i},'operations',${i},${"operations.m" + i},
			${i < completed ? sql`clock_timestamp()` : null})`);
}
async function summary(p: Owner, version: number, body: string, published: boolean) {
	await S.db.execute(sql`INSERT INTO launch_summary(plant_id,version,body,saved_at,published_at)
		VALUES(${p.id},${version},${body},clock_timestamp(),${published ? sql`clock_timestamp()` : null})`);
}

let N: Owner, GA: Owner, HP: Owner, EC: Owner, MF: Owner, OC: Owner;
type Identity = Awaited<ReturnType<typeof S.identity>>;
let networkOwner: Identity,
	networkAdmin: Identity,
	networkMember: Identity,
	graceOwner: Identity,
	hpOwner: Identity,
	hpAdmin: Identity,
	hpMember: Identity;
let hpToN: string, mfToN: string;
const sharing = ["people", "meetings", "tasks", "ministry_teams", "findings"] as const;

before(async () => {
	await installGeographyRelease(S.db);
	N = await S.tenant("sending_network", "Hill Country Network");
	GA = await S.tenant("sending_church", "Grace Austin");
	HP = await plant("Harvest Point", "Round Rock");
	EC = await plant("Eastside Commons", "Austin");
	MF = await plant("Mueller Fellowship", "Austin");
	OC = await plant("Oak Cliff Church", "Dallas");
	networkOwner = await S.identity(N, "owner");
	networkAdmin = await S.identity(N, "admin");
	networkMember = await S.identity(N, "member");
	graceOwner = await S.identity(GA, "owner");
	hpOwner = await S.identity(HP, "owner");
	hpAdmin = await S.identity(HP, "admin");
	hpMember = await S.identity(HP, "member");
	hpToN = await link(HP, N, sharing);
	await link(HP, GA, ALL);
	await link(EC, N, sharing);
	mfToN = await link(MF, N, ["people"]);
	await link(OC, N, sharing);
	await link(GA, N);

	const ea = await person(EC, "Ana Eastside");
	await responsibility(EC, "worship", ea);
	await training(EC, ea, true);
	await launch(EC, 10);
	const hp = await person(HP, "Hank Harvest");
	await responsibility(HP, "worship", hp);
	await responsibility(HP, "children", null);
	await training(HP, hp, true);
	await launch(HP, 30, 2);
	const oc = await person(OC, "Olive Cliff");
	await responsibility(OC, "worship", oc);
	await training(OC, oc, false);
	await launch(OC, 20);
	await responsibility(MF, "children", null);
	await launch(MF, 5);
});
after(async () => {
	await S.teardown();
});

const homeHealth = async (who: { session: string }) =>
	Object.fromEntries((await listPlants(S.runtime, await as(who)))!.plants.map((p) => [p.name, p.health]));

test("the home shows Limited visibility, Launch readiness and no concern, never On track from silence", async () => {
	assert.deepEqual(await homeHealth(networkAdmin), {
		"Eastside Commons": "not_assessed",
		"Harvest Point": "launch_readiness",
		"Mueller Fellowship": "limited_visibility",
		"Oak Cliff Church": "launch_readiness",
	});
	assert.deepEqual(await homeHealth(networkMember), await homeHealth(networkAdmin));
});

test("a near launch alone, a far one with a gap and a gap the plant does not share raise no concern", async () => {
	const far = await plant("Far Out", "Austin");
	const id = await link(far, N, sharing);
	await responsibility(far, "children", null);
	await launch(far, 31);
	assert.equal((await homeHealth(networkAdmin))["Far Out"], "not_assessed");
	await S.db.execute(sql`UPDATE launch SET target_date=target_date-5 WHERE plant_id=${far.id}`);
	assert.equal((await homeHealth(networkAdmin))["Far Out"], "launch_readiness");
	await share(id, "ministry_teams", false);
	assert.equal((await homeHealth(networkAdmin))["Far Out"], "not_assessed");
	await S.db.execute(sql`UPDATE affiliation SET ended_at=clock_timestamp() WHERE id=${id}`);
});

test("the plant view shows Launch status and readiness, then the recorded outcome", async () => {
	const view = await getPlant(S.runtime, await as(networkAdmin), HP.id);
	const launch = view!.launch;
	assert.equal(launch.status, "shared");
	if (launch.status !== "shared") return;
	assert.equal(launch.state, "scheduled");
	const planned = view!.plant.path.kind === "launch_sunday" ? view!.plant.path.date : null;
	assert.equal(launch.plannedDate, planned);
	assert.deepEqual(launch.milestones, { completed: 2, total: 9 });
	assert.equal(launch.outcome, null);
	assert.deepEqual(launch.preparation, { launched: false, daysToLaunch: 30, unfilledRoles: 1, outstandingTraining: 0 });

	await S.db.execute(sql`INSERT INTO audit_event(tenant_id,actor_id,action,kind,subject_type,subject_id,metadata)
		VALUES(${HP.id},${hpOwner.account},'launch.changed','edit','launch',${HP.id},'{"event":"moved"}'::jsonb)`);
	const moved = (await getPlant(S.runtime, await as(networkAdmin), HP.id))!.launch;
	assert.equal(moved.status === "shared" && moved.state, "moved");

	await S.db.execute(sql`UPDATE launch SET status='completed', actual_date=target_date-30, attendance=212, decisions=9,
		outcome_note='Private planter words', outcome_recorded_at=clock_timestamp() WHERE plant_id=${HP.id}`);
	const done = (await getPlant(S.runtime, await as(networkAdmin), HP.id))!;
	assert.equal(done.launch.status === "shared" && done.launch.state, "completed");
	assert.deepEqual(done.launch.status === "shared" && done.launch.outcome, {
		actualDate: planned && shiftDays(planned, -30),
		attendance: 212,
		decisions: 9,
	});
	assert.doesNotMatch(JSON.stringify(done), /Private planter words|Hank Harvest|12 Private Lane|555-0100/);
	await S.db.execute(sql`UPDATE launch SET status='scheduled', actual_date=NULL, attendance=NULL, decisions=NULL,
		outcome_note=NULL, outcome_recorded_at=NULL WHERE plant_id=${HP.id}`);
});
const shiftDays = (date: string, days: number) => {
	const d = new Date(`${date}T12:00:00Z`);
	d.setUTCDate(d.getUTCDate() + days);
	return d.toISOString().slice(0, 10);
};

test("a plant that does not share findings shows only the directory's planned date and Limited visibility", async () => {
	const view = (await getPlant(S.runtime, await as(networkAdmin), MF.id))!;
	assert.deepEqual(view.launch, { status: "withheld" });
	assert.equal(view.summary, null);
	const row = (await listPlants(S.runtime, await as(networkAdmin)))!.plants.find((p) => p.plantId === MF.id)!;
	assert.deepEqual(view.plant.path, row.path);
	assert.equal(row.path.kind === "launch_sunday" && row.path.date !== null, true);
	assert.equal(view.plant.health, "limited_visibility");
});

test("a published summary shows at once, its edit replaces it, and turning findings off removes it", async () => {
	await summary(HP, 1, "We launched with 212 people.", true);
	await summary(HP, 2, "Draft: guest Jane Doe came", false);
	const read = async (who: { session: string }) => (await getPlant(S.runtime, await as(who), HP.id))!.summary;
	assert.equal((await read(networkAdmin))?.body, "We launched with 212 people.");
	assert.equal((await read(networkAdmin))?.version, 1);
	assert.doesNotMatch(JSON.stringify(await getPlant(S.runtime, await as(networkAdmin), HP.id)), /Jane Doe|Draft/);
	await S.db.execute(sql`UPDATE launch_summary SET body='We launched with 214 people.', published_at=clock_timestamp()
		WHERE plant_id=${HP.id} AND version=2`);
	assert.equal((await read(networkAdmin))?.body, "We launched with 214 people.");

	await share(hpToN, "findings", false);
	assert.equal(await read(networkAdmin), null);
	assert.deepEqual((await getPlant(S.runtime, await as(networkAdmin), HP.id))!.launch, { status: "withheld" });
	assert.equal((await read(graceOwner))?.body, "We launched with 214 people.");
	await share(hpToN, "findings", true);
});

test("the Region picker suggests official areas, makes an ambiguous place choose and allows unresolved", async () => {
	const owner = await as(hpOwner);
	const austin = await suggestRegions(S.runtime, owner, { city: "Round Rock", stateProvince: "TX", country: "US" });
	assert.deepEqual(
		austin!.map((c) => c.area),
		[{ code: "12420", title: "Austin-Round Rock-San Marcos, TX", type: "metro" }],
	);
	const springfield = await suggestRegions(S.runtime, owner, {
		city: "Springfield",
		stateProvince: null,
		country: null,
	});
	assert.ok(springfield!.length > 1);
	assert.deepEqual(await suggestRegions(S.runtime, owner, { city: "Nowhere", stateProvince: "TX", country: "US" }), []);
	const kerrville = await suggestRegions(S.runtime, owner, {
		city: "Kerrville",
		stateProvince: "Texas",
		country: null,
	});
	assert.deepEqual(
		kerrville!.map((c) => c.area),
		[{ code: "28500", title: "Kerrville, TX", type: "micro" }],
	);

	const current = (await readReportingLocation(S.runtime, owner))!;
	assert.equal(current.canEdit, true);
	assert.deepEqual(current.locality, { city: "Round Rock", stateProvince: "TX", country: "US" });
	assert.equal(current.region, null);
	const save = (who: S.Actor, region: string | null, revision: string, city = "Round Rock") =>
		S.write(who, (c) =>
			api["organizations.correctReportingLocation"](c, who.session, who.selected, {
				requestKey: randomUUID(),
				expectedRevision: revision,
				input: {
					plant: HP,
					locality: { city, stateProvince: "TX", country: "US" },
					referenceVersionId: current.referenceVersionId,
					regionItemId: region,
				},
			} as never),
		);
	await assert.rejects(save(hpOwner, springfield![0]!.regionItemId, current.revision), /region_unavailable/);
	await assert.rejects(save(hpMember, austin![0]!.regionItemId, current.revision), /unavailable/);
	await assert.rejects(save(networkAdmin, austin![0]!.regionItemId, current.revision), /unavailable/);
	await save(hpAdmin, null, current.revision);
	assert.equal((await readReportingLocation(S.runtime, owner))!.region, null);
	await save(hpOwner, austin![0]!.regionItemId, String(BigInt(current.revision) + 1n));
	const saved = (await readReportingLocation(S.runtime, await as(hpMember)))!;
	assert.equal(saved.region?.code, "12420");
	assert.equal(saved.canEdit, false);

	const row = (await listPlants(S.runtime, await as(networkAdmin)))!.plants.find((p) => p.plantId === HP.id)!;
	assert.deepEqual(
		[row.city, row.stateProvince, row.region?.title],
		["Round Rock", "TX", "Austin-Round Rock-San Marcos, TX"],
	);
	assert.doesNotMatch(JSON.stringify(await listPlants(S.runtime, await as(networkAdmin))), /Private Lane/);
});

async function placeIn(p: Owner, city: string) {
	const owner = await S.identity(p, "owner");
	const a = await as(owner);
	const where = (await readReportingLocation(S.runtime, a))!;
	const [c] = (await suggestRegions(S.runtime, a, { city, stateProvince: "TX", country: "US" }))!;
	await S.write(owner, (tx) =>
		api["organizations.correctReportingLocation"](tx, owner.session, owner.selected, {
			requestKey: randomUUID(),
			expectedRevision: where.revision,
			input: {
				plant: p,
				locality: { city, stateProvince: "TX", country: "US" },
				referenceVersionId: where.referenceVersionId,
				regionItemId: c!.regionItemId,
			},
		} as never),
	);
}
async function placeOthers() {
	await placeIn(OC, "Dallas");
	await placeIn(EC, "Austin");
}

const near = (g: { patterns: { rule: string }[] }) =>
	(g.patterns.find((p) => p.rule === "NIR-03") as Extract<IntelligencePattern, { rule: "NIR-03" }> | undefined) ?? null;

test("Network Intelligence names the near-launch pattern only where two sharing plants qualify", async () => {
	await placeOthers();
	const admin = await as(networkAdmin);
	const empty = await readIntelligence(S.runtime, admin, { level: "portfolio", runId: null });
	assert.deepEqual(
		{ ...empty, timeZone: undefined },
		{
			status: "ready",
			organizationName: "Hill Country Network",
			timeZone: undefined,
			level: "portfolio",
			run: null,
			history: [],
			groups: [],
			geographyReleases: [],
			canRefresh: true,
		},
	);
	const run = await requestIntelligenceRefresh(S.runtime, admin, { runId: randomUUID() });
	assert.equal(run.status, "ok");

	const whole = (await readIntelligence(S.runtime, admin, { level: "portfolio", runId: null }))!;
	assert.equal(whole.groups.length, 1);
	const [portfolio] = whole.groups;
	const nir03 = near(portfolio!);
	assert.deepEqual(nir03 && { ...nir03, plants: nir03.plants.map((p) => p.name) }, {
		key: "NIR-03:portfolio:portfolio",
		rule: "NIR-03",
		theme: "near_launch",
		support: 2,
		observed: 3,
		plants: ["Harvest Point", "Oak Cliff Church"],
		rating: null,
		citation: { rubric: "everyfield-network/v1", rule: "NIR-03", source: "docs/reference/network-rubric-v1.json" },
	});
	assert.deepEqual(
		portfolio!.rows.map((r) => [r.name, r.status === "shared" ? r.results["NIR-03"] : r.status]),
		[
			["Eastside Commons", "clear"],
			["Harvest Point", "gap"],
			["Mueller Fellowship", "not_shared"],
			["Oak Cliff Church", "gap"],
		],
	);
	assert.deepEqual(Object.keys(portfolio!.rows.find((r) => r.name === "Mueller Fellowship")!).sort(), [
		"name",
		"plantId",
		"status",
	]);

	const at = async (level: "region" | "state" | "country") =>
		Object.fromEntries(
			(await readIntelligence(S.runtime, admin, { level, runId: null }))!.groups.map((g) => [
				g.label,
				near(g)?.support ?? null,
			]),
		);
	assert.deepEqual(await at("state"), { Texas: 2 });
	assert.deepEqual(await at("country"), { "United States": 2 });
	assert.deepEqual(await at("region"), {
		"Austin-Round Rock-San Marcos, TX (metro area)": null,
		"Dallas-Fort Worth-Arlington, TX (metro area)": null,
		"Region unresolved": null,
	});
	assert.doesNotMatch(JSON.stringify(whole), /Round Rock"|Private Lane|Hank|Olive|Ana Eastside/);
});

test("in one Region two sharing plants make a pattern citing the network rubric; the plant that doesn't share reads Not shared", async () => {
	const region = await S.tenant("sending_network", "Capital Region Network");
	const director = await as(await S.identity(region, "admin"));
	const plants: Owner[] = [];
	for (const [name, shares] of [
		["North Austin Church", true],
		["South Austin Church", true],
		["Central Austin Church", false],
	] as const) {
		const p = await plant(name, "Austin");
		await placeIn(p, "Austin");
		await link(p, region, shares ? sharing : ["people"]);
		await responsibility(p, "children", null);
		await launch(p, 12);
		plants.push(p);
	}
	await requestIntelligenceRefresh(S.runtime, director, { runId: randomUUID() });
	const [g] = (await readIntelligence(S.runtime, director, { level: "region", runId: null }))!.groups;
	assert.equal(g!.label, "Austin-Round Rock-San Marcos, TX (metro area)");
	assert.deepEqual(
		g!.rows.map((r) => [r.name, r.status === "shared" ? r.results["NIR-03"] : r.status]),
		[
			["Central Austin Church", "not_shared"],
			["North Austin Church", "gap"],
			["South Austin Church", "gap"],
		],
	);
	const pattern = near(g!)!;
	assert.deepEqual(
		{ ...pattern, plants: pattern.plants.map((p) => p.name) },
		{
			key: `NIR-03:region:${g!.key}`,
			rule: "NIR-03",
			theme: "near_launch",
			support: 2,
			observed: 2,
			plants: ["North Austin Church", "South Austin Church"],
			rating: null,
			citation: { rubric: "everyfield-network/v1", rule: "NIR-03", source: "docs/reference/network-rubric-v1.json" },
		},
	);
	assert.deepEqual(Object.keys(pattern.plants[0]!).sort(), ["name", "plantId"]);
	assert.doesNotMatch(JSON.stringify(g), /Private Lane|lead"|personId|"body"|"summary"|"title"/);
	assert.deepEqual(
		g!.rows.find((r) => r.name === "Central Austin Church"),
		{
			status: "not_shared",
			plantId: plants[2]!.id,
			name: "Central Austin Church",
		},
	);
	await S.db.execute(sql`UPDATE affiliation SET shared_findings=false WHERE plant_id=${plants[1]!.id}`);
	const [single] = (await readIntelligence(S.runtime, director, { level: "region", runId: null }))!.groups;
	assert.deepEqual(single!.patterns, []);
});

test("a sharing plant with no launch date is Unknown, and one qualifying plant makes no pattern", async () => {
	const lone = await S.tenant("sending_network", "Lone Star Network");
	const loneAdmin = await as(await S.identity(lone, "admin"));
	await link(OC, lone, sharing);
	const unknown = await plant("No Date Yet", "Austin");
	await link(unknown, lone, sharing);
	await requestIntelligenceRefresh(S.runtime, loneAdmin, { runId: randomUUID() });
	const [g] = (await readIntelligence(S.runtime, loneAdmin, { level: "portfolio", runId: null }))!.groups;
	assert.equal(near(g!), null);
	assert.deepEqual(
		g!.rows.map((r) => [r.name, r.status === "shared" && r.results["NIR-03"]]),
		[
			["No Date Yet", "unknown"],
			["Oak Cliff Church", "gap"],
		],
	);
});

test("Refresh keeps history, a Member cannot refresh, and turning sharing off leaves every run", async () => {
	const admin = await as(networkAdmin);
	const member = await as(networkMember);
	const before = (await readIntelligence(S.runtime, admin, { level: "portfolio", runId: null }))!;
	const second = randomUUID();
	await requestIntelligenceRefresh(S.runtime, admin, { runId: second });
	assert.deepEqual(await requestIntelligenceRefresh(S.runtime, admin, { runId: second }), {
		status: "ok",
		value: { runId: second, outcome: "noop" },
	});
	const after = (await readIntelligence(S.runtime, member, { level: "portfolio", runId: null }))!;
	assert.equal(after.history.length, before.history.length + 1);
	assert.equal(after.run!.runId, second);
	assert.equal(after.canRefresh, false);
	assert.deepEqual(await requestIntelligenceRefresh(S.runtime, member, { runId: randomUUID() }), {
		status: "refused",
		refusal: { code: "unavailable" },
	});
	assert.deepEqual(await readIntelligence(S.runtime, member, { level: "portfolio", runId: null }), after);

	await share(hpToN, "findings", false);
	for (const run of after.history) {
		const view = (await readIntelligence(S.runtime, admin, { level: "portfolio", runId: run.runId }))!;
		const hp = view.groups[0]!.rows.find((r) => r.plantId === HP.id)!;
		assert.equal(hp.status, "not_shared");
		assert.equal(near(view.groups[0]!), null);
	}
	await share(hpToN, "findings", true);
	const other = await as(graceOwner);
	assert.equal(await readIntelligence(S.runtime, other, { level: "portfolio", runId: second }), null);
	void mfToN;
});

const ratingsOf = async (o: Owner) =>
	(
		await S.db.execute(sql`SELECT f.account_id, f.pattern_key, f.rating FROM network_intelligence_feedback f
			JOIN network_intelligence_run r ON r.id=f.run_id WHERE r.organization_id=${o.id} ORDER BY 1,2`)
	).rows;
const ratingAudit = async (o: Owner) =>
	(
		await S.db.execute(sql`SELECT metadata FROM audit_event WHERE tenant_id=${o.id}
			AND metadata->>'category'='network_intelligence_feedback'`)
	).rows;
const readAll = async (who: Identity) => {
	const authority = await as(who);
	const latest = (await readIntelligence(S.runtime, authority, { level: "portfolio", runId: null }))!;
	const views = [];
	for (const { runId } of latest.history)
		for (const level of LEVELS) views.push((await readIntelligence(S.runtime, authority, { level, runId }))!);
	return views;
};
const unrated = (views: IntelligenceView[]) =>
	views.map((v) => ({
		...v,
		groups: v.groups.map((g) => ({ ...g, patterns: g.patterns.map((p) => ({ ...p, rating: null })) })),
	}));

async function ratesPrivately(
	o: Owner,
	seats: { rater: Identity; second: Identity; admin: Identity; others: Identity[] },
) {
	const { rater, second, admin, others } = seats;
	const first = (await readIntelligence(S.runtime, await as(rater), { level: "state", runId: null }))!;
	const runId = first.run!.runId;
	const key = near(first.groups[0]!)!.key;
	const rate = async (who: Identity, rating: string) =>
		submitIntelligenceFeedback(S.runtime, await as(who), { runId, patternKey: key, rating });
	const seen = async (who: Identity) =>
		near((await readIntelligence(S.runtime, await as(who), { level: "state", runId }))!.groups[0]!)!.rating;
	const everyone = [rater, second, admin, ...others];
	const before = await Promise.all(everyone.map(readAll));
	const stored = async () =>
		(
			await S.db.execute(sql`SELECT to_jsonb(r) AS run, (SELECT jsonb_agg(to_jsonb(c) ORDER BY c.plant_id)
				FROM network_intelligence_plant c WHERE c.run_id=r.id) AS plants
				FROM network_intelligence_run r WHERE r.organization_id=${o.id} ORDER BY r.id`)
		).rows;
	const kept = await stored();
	const changed = { status: "ok", value: { outcome: "changed" } };

	assert.deepEqual(await rate(rater, "useful"), changed);
	assert.equal(await seen(rater), "useful");
	assert.deepEqual(await rate(rater, "useful"), { status: "ok", value: { outcome: "noop" } });
	for (const [i, who] of [second, admin, ...others].entries()) assert.deepEqual(await readAll(who), before[i + 1]);
	assert.deepEqual(unrated(await readAll(rater)), before[0]);
	assert.deepEqual(await rate(rater, "not_useful"), changed);
	assert.deepEqual(await rate(second, "useful"), changed);
	assert.deepEqual(await rate(admin, "useful"), changed);
	assert.deepEqual(
		[await seen(rater), await seen(second), await seen(admin), ...(await Promise.all(others.map(seen)))],
		["not_useful", "useful", "useful", ...others.map(() => null)],
	);
	for (const [i, who] of everyone.entries()) assert.deepEqual(unrated(await readAll(who)), before[i]);
	assert.deepEqual(await stored(), kept);
	const audit = await ratingAudit(o);
	assert.equal(audit.length, 4);
	assert.doesNotMatch(JSON.stringify(audit), /useful/);
	return { runId, patternKey: key };
}

test("INV-privacy: a Member's rating of a pattern is their own, no other seat sees it and it changes nothing else", async () => {
	await ratesPrivately(N, {
		rater: networkMember,
		second: await S.identity(N, "member"),
		admin: networkAdmin,
		others: [networkOwner, await S.identity(N, "member")],
	});
});

test("INV-privacy: a sending church's Member rates under the same limits, and only a pattern its author reads now takes a rating", async () => {
	const church = await S.tenant("sending_church", "Cedar Sending Church");
	const churchAdmin = await S.identity(church, "admin");
	const churchMember = await S.identity(church, "member");
	const links: string[] = [];
	for (const name of ["Cedar East", "Cedar West"]) {
		const p = await plant(name, "Austin");
		links.push(await link(p, church, sharing));
		await responsibility(p, "children", null);
		await launch(p, 12);
	}
	await requestIntelligenceRefresh(S.runtime, await as(churchAdmin), { runId: randomUUID() });
	const own = await ratesPrivately(church, {
		rater: churchMember,
		second: await S.identity(church, "member"),
		admin: churchAdmin,
		others: [await S.identity(church, "owner")],
	});
	const refused = { status: "refused", refusal: { code: "unavailable" } };
	assert.deepEqual(
		await requestIntelligenceRefresh(S.runtime, await as(churchMember), { runId: randomUUID() }),
		refused,
	);
	const network = (await readIntelligence(S.runtime, await as(networkMember), { level: "state", runId: null }))!;
	const theirs = { runId: network.run!.runId, patternKey: near(network.groups[0]!)!.key };

	const kept = [await ratingsOf(church), await ratingsOf(N), await ratingAudit(church), await ratingAudit(N)];
	const refuses = async (authority: never, input: { runId: string; patternKey: string }, why: string) => {
		for (const rating of ["useful", "not_useful"])
			assert.deepEqual(await submitIntelligenceFeedback(S.runtime, authority, { ...input, rating }), refused, why);
	};
	for (const [role, seat] of [
		["member", churchMember],
		["admin", churchAdmin],
	] as const) {
		const authority = await as(seat);
		for (const [why, input] of [
			["a run that is missing", { ...own, runId: randomUUID() }],
			["a state the run does not show", { ...own, patternKey: "NIR-03:state:US:OK" }],
			["a rule the run does not show", { ...own, patternKey: "NIR-04:overdue_followup:state:US:TX" }],
			["a key of no level", { ...own, patternKey: "made up" }],
			["another organization's run", theirs],
		] as const)
			await refuses(authority, input, `${role}: ${why}`);
		await share(links[0]!, "findings", false);
		await refuses(authority, own, `${role}: one plant stopped sharing`);
		await share(links[0]!, "findings", true);
		const leaver = await S.identity(church, role);
		const held = await as(leaver);
		await S.db.execute(sql`UPDATE seat SET ended_at=clock_timestamp() WHERE account_id=${leaver.account}`);
		await refuses(held, own, `${role}: a seat that ended`);
	}
	await refuses(await as(hpMember), theirs, "a plant's Member");
	await refuses(await as(hpAdmin), theirs, "a plant's Admin");
	assert.deepEqual(
		[await ratingsOf(church), await ratingsOf(N), await ratingAudit(church), await ratingAudit(N)],
		kept,
		"no refusal stores a row",
	);
});
