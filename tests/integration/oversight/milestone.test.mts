import test, { after, before } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { sql } from "../../../packages/db/node_modules/drizzle-orm/index.js";
import * as S from "../organizations/support.mts";
import { ok } from "../../support/fixture.mts";
import { RequestActor } from "../../../packages/domain/src/access/index.ts";
import { installGeographyRelease } from "../../../packages/domain/src/organizations/index.ts";
import { createLaunchReader, createLaunchWriter } from "../../../packages/domain/src/launch/index.ts";
import {
	getPlant,
	getSendingChurch,
	listPlants,
	readIntelligence,
	requestIntelligenceRefresh,
} from "../../../packages/domain/src/oversight/index.ts";
import { nearLaunch } from "../../../packages/contracts/src/oversight/health.ts";

type Owner = Awaited<ReturnType<typeof S.tenant>>;
type Who = { session: string };
const CONSTITUTED = "Constituted as a church";
const MEANING = "The church adopts its constitution and elects its first leaders.";
const NOTE = "Private milestone note: the vote was close";
const REASON = "Private correction reason: wrong Sunday";
const as = async (who: Who) => RequestActor.resolve(S.runtime, who.session as never) as never;
const reader = createLaunchReader();
const writer = createLaunchWriter({ notices: async () => {} });

const FINDINGS = { shared_findings: true, share_ministry_teams: true };
async function link(subject: Owner, org: Owner, share: Partial<typeof FINDINGS> = {}) {
	if (subject.kind !== "plant") {
		await S.db.execute(sql`INSERT INTO affiliation(sending_church_id,organization_id,accepted_at,share_people,
			share_meetings,share_tasks,share_ministry_teams,share_wiki,share_activity,shared_findings)
			VALUES(${subject.id},${org.id},clock_timestamp()-interval '1 day',false,false,false,false,false,false,false)`);
		return "";
	}
	const r = await S.db.execute(sql`INSERT INTO affiliation(plant_id,organization_id,accepted_at,share_people,
		share_meetings,share_tasks,share_ministry_teams,share_wiki,share_activity,shared_findings)
		VALUES(${subject.id},${org.id},clock_timestamp()-interval '1 day',true,false,false,
		${share.share_ministry_teams ?? false},false,false,${share.shared_findings ?? false}) RETURNING id`);
	return r.rows[0]!.id as string;
}
async function plant(name: string) {
	const p = await S.tenant("plant", name);
	await S.db.execute(sql`UPDATE plant SET city='Austin', state_province='TX', country='US',
		timezone='America/Chicago' WHERE id=${p.id}`);
	return { ...p, owner: await S.identity(p, "owner") };
}
type Plant = Awaited<ReturnType<typeof plant>>;
const offer = (org: Owner, offered: boolean, name = CONSTITUTED) =>
	S.db.execute(sql`UPDATE organization SET gathering_milestone_offered=${offered}, gathering_milestone_name=${name},
		gathering_milestone_description=${MEANING} WHERE id=${org.id}`);

const plan = async (p: Plant) => ok(await reader.readPlan(S.runtime, await as(p.owner))).plan;
const envelope = async (p: Plant, input: unknown) => ({
	requestKey: randomUUID(),
	expectedRevision: (await plan(p)).revision,
	input,
});
const localDay = (days: number) => {
	const today = new Intl.DateTimeFormat("en-CA", { timeZone: "America/Chicago" }).format(new Date());
	const d = new Date(`${today}T12:00:00Z`);
	d.setUTCDate(d.getUTCDate() + days);
	return d.toISOString().slice(0, 10);
};
const schedule = async (p: Plant, days: number) =>
	ok(await writer.schedule(S.runtime, await as(p.owner), await envelope(p, { date: localDay(days), reason: null })));
const useMilestone = async (p: Plant, org: Owner) =>
	ok(
		await writer.choosePath(
			S.runtime,
			await as(p.owner),
			await envelope(p, { path: "milestone", organizationId: org.id }),
		),
	);
const useSunday = async (p: Plant) =>
	ok(await writer.choosePath(S.runtime, await as(p.owner), await envelope(p, { path: "launch_sunday" })));
const record = async (p: Plant, date: string) =>
	ok(await writer.recordGathering(S.runtime, await as(p.owner), await envelope(p, { date, note: NOTE })));

let N: Owner, GA: Owner, HP: Plant, EC: Plant, MF: Plant, OC: Plant;
let networkOwner: Who, networkMember: Who, graceOwner: Who, ocToN: string;

before(async () => {
	await installGeographyRelease(S.db);
	N = await S.tenant("sending_network", "Hill Country Network");
	GA = await S.tenant("sending_church", "Grace Austin");
	await offer(N, true);
	networkOwner = await S.identity(N, "owner");
	networkMember = await S.identity(N, "member");
	graceOwner = await S.identity(GA, "owner");
	await link(GA, N);
	HP = await plant("Harvest Point");
	EC = await plant("Eastside Commons");
	MF = await plant("Mueller Fellowship");
	OC = await plant("Oak Cliff Church");
	await link(HP, N, FINDINGS);
	await link(HP, GA, FINDINGS);
	await link(EC, N, FINDINGS);
	await link(MF, N);
	ocToN = await link(OC, N, FINDINGS);
	await link(OC, GA, FINDINGS);

	await schedule(HP, 40);
	await useMilestone(HP, N);
	await record(HP, "2026-10-10");
	ok(
		await writer.correctGathering(
			S.runtime,
			await as(HP.owner),
			await envelope(HP, { date: "2026-10-11", note: NOTE, reason: REASON }),
		),
	);
	await schedule(EC, 25);
	await useMilestone(MF, N);
	await record(MF, "2026-10-04");
	await useMilestone(OC, N);
});
after(async () => {
	await S.teardown();
});

const rows = async (who: Who) =>
	Object.fromEntries((await listPlants(S.runtime, await as(who)))!.plants.map((p) => [p.name, p]));
const reached = (date: string) => ({ status: "reached", date });

test("the home shows each plant's path: the milestone reached or not, Launch Sunday's date, and nothing withheld", async () => {
	const home = await rows(networkOwner);
	assert.deepEqual(home["Harvest Point"]!.path, {
		kind: "milestone",
		name: CONSTITUTED,
		chosenBy: "Hill Country Network",
		progress: reached("2026-10-11"),
	});
	assert.deepEqual(home["Oak Cliff Church"]!.path, {
		kind: "milestone",
		name: CONSTITUTED,
		chosenBy: "Hill Country Network",
		progress: { status: "not_reached" },
	});
	assert.deepEqual(home["Eastside Commons"]!.path, { kind: "launch_sunday", date: localDay(25) });
	assert.deepEqual(home["Mueller Fellowship"]!.path, {
		kind: "milestone",
		name: CONSTITUTED,
		chosenBy: "Hill Country Network",
		progress: { status: "withheld" },
	});
	assert.equal(home["Mueller Fellowship"]!.health, "limited_visibility");
	assert.doesNotMatch(JSON.stringify(home["Mueller Fellowship"]), /2026-10-04/);
	assert.deepEqual(await rows(networkMember), home);
});

test("the plant view carries the same path, and the sending-church page lists it as the home does", async () => {
	const hp = (await getPlant(S.runtime, await as(networkOwner), HP.id))!;
	assert.deepEqual(hp.plant.path, (await rows(networkOwner))["Harvest Point"]!.path);
	const oc = (await getPlant(S.runtime, await as(networkMember), OC.id))!;
	assert.deepEqual(oc.plant.path.kind === "milestone" && oc.plant.path.progress, { status: "not_reached" });
	const mf = (await getPlant(S.runtime, await as(networkOwner), MF.id))!;
	assert.deepEqual(mf.plant.path.kind === "milestone" && mf.plant.path.progress, { status: "withheld" });
	assert.deepEqual(mf.launch, { status: "withheld" });

	const church = (await getSendingChurch(S.runtime, await as(networkOwner), GA.id))!;
	const listed = Object.fromEntries(church.plants.map((p) => [p.name, p.path]));
	assert.deepEqual(listed["Harvest Point"], hp.plant.path);
});

test("Grace Austin reads the same path and date, chosen by another organization it never names", async () => {
	const home = await rows(graceOwner);
	const expected = { kind: "milestone", name: CONSTITUTED, chosenBy: null, progress: reached("2026-10-11") };
	assert.deepEqual(home["Harvest Point"]!.path, expected);
	const view = (await getPlant(S.runtime, await as(graceOwner), HP.id))!;
	assert.deepEqual(view.plant.path, expected);
	assert.doesNotMatch(JSON.stringify(home), /Hill Country/);
	assert.doesNotMatch(JSON.stringify(view), /Hill Country/);
});

test("no organization read carries the milestone's note, description, correction reason or Launch history", async () => {
	const network = await as(networkOwner);
	const reads = [
		await listPlants(S.runtime, network),
		await getPlant(S.runtime, network, HP.id),
		await getPlant(S.runtime, network, MF.id),
		await getSendingChurch(S.runtime, network, GA.id),
		await listPlants(S.runtime, await as(graceOwner)),
		await getPlant(S.runtime, await as(graceOwner), HP.id),
	];
	const { path } = await plan(HP);
	assert.equal(path.kind === "milestone" && path.reached?.note, NOTE);
	const json = JSON.stringify(reads);
	assert.doesNotMatch(json, /Private milestone note|Private correction reason|adopts its constitution/);
	assert.doesNotMatch(json, /"(note|reason|history|entries|recordedBy|correctedBy|clearedBy)"/);
});

test("a kept Launch Sunday date on the milestone path is never Launch readiness, on any read", async () => {
	const LP = await plant("Leander Church");
	await link(LP, N, FINDINGS);
	const t = await S.db.execute(
		sql`INSERT INTO team(plant_id,name,state,sort_order) VALUES(${LP.id},'Kids','active',0) RETURNING id`,
	);
	await S.db.execute(sql`INSERT INTO team_role(plant_id,team_id,name,leadership,sort_order,responsibility_key)
		VALUES(${LP.id},${t.rows[0]!.id},'Kids lead',true,0,'children')`);
	await schedule(LP, 10);

	const network = await as(networkOwner);
	const readAll = async () => {
		await requestIntelligenceRefresh(S.runtime, network, { runId: randomUUID() });
		const intelligence = (await readIntelligence(S.runtime, network, { level: "portfolio", runId: null }))!;
		const row = intelligence.groups.flatMap((g) => g.rows).find((r) => r.plantId === LP.id)!;
		const own = await plan(LP);
		return {
			home: (await rows(networkOwner))["Leander Church"]!.health,
			view: (await getPlant(S.runtime, network, LP.id))!.plant.health,
			intelligence: row.status === "shared" ? [row.health, row.results["NIR-03"]] : null,
			notice: nearLaunch(own.preparation) === "gap",
		};
	};
	assert.deepEqual(await readAll(), {
		home: "launch_readiness",
		view: "launch_readiness",
		intelligence: ["launch_readiness", "gap"],
		notice: true,
	});
	await useMilestone(LP, N);
	assert.equal((await plan(LP)).launch?.targetDate, localDay(10));
	const milestone = await readAll();
	assert.notEqual(milestone.home, "launch_readiness");
	assert.notEqual(milestone.view, "launch_readiness");
	assert.notEqual(milestone.intelligence?.[0], "launch_readiness");
	assert.notEqual(milestone.intelligence?.[1], "gap");
	assert.equal(milestone.notice, false);
	await S.db.execute(sql`UPDATE affiliation SET ended_at=clock_timestamp() WHERE plant_id=${LP.id}`);
});

test("a renamed milestone keeps the name it was reached under; one turned off or unlinked reads as no longer offered", async () => {
	await offer(N, true, "Church constituted");
	const path = async (who: Who, name: string) => (await rows(who))[name]!.path;
	const progressOf = async (who: Who, name: string) => {
		const p = await path(who, name);
		return p.kind === "milestone" && p.progress;
	};
	assert.deepEqual(await path(networkOwner, "Harvest Point"), {
		kind: "milestone",
		name: CONSTITUTED,
		chosenBy: "Hill Country Network",
		progress: reached("2026-10-11"),
	});
	assert.deepEqual(await path(networkOwner, "Oak Cliff Church"), {
		kind: "milestone",
		name: "Church constituted",
		chosenBy: "Hill Country Network",
		progress: { status: "not_reached" },
	});

	await offer(N, false, "Church constituted");
	const withdrawn = {
		kind: "milestone",
		name: "Church constituted",
		chosenBy: "Hill Country Network",
		progress: { status: "withdrawn" },
	};
	assert.deepEqual(await path(networkOwner, "Oak Cliff Church"), withdrawn);
	assert.deepEqual((await getPlant(S.runtime, await as(networkOwner), OC.id))!.plant.path, withdrawn);
	assert.deepEqual(await progressOf(networkOwner, "Harvest Point"), reached("2026-10-11"));

	await offer(N, true, "Church constituted");
	assert.deepEqual(await progressOf(graceOwner, "Oak Cliff Church"), { status: "not_reached" });
	await S.db.execute(sql`UPDATE affiliation SET ended_at=clock_timestamp() WHERE id=${ocToN}`);
	assert.equal((await rows(networkOwner))["Oak Cliff Church"], undefined);
	assert.deepEqual(await path(graceOwner, "Oak Cliff Church"), {
		kind: "milestone",
		name: "Church constituted",
		chosenBy: null,
		progress: { status: "withdrawn" },
	});
	assert.deepEqual((await getPlant(S.runtime, await as(graceOwner), OC.id))!.plant.path, {
		kind: "milestone",
		name: "Church constituted",
		chosenBy: null,
		progress: { status: "withdrawn" },
	});
});

test("a plant that clears its record and switches back reads as Launch Sunday again, with its date and status", async () => {
	ok(await writer.clearGathering(S.runtime, await as(HP.owner), await envelope(HP, { reason: REASON })));
	await useSunday(HP);
	const row = (await rows(networkOwner))["Harvest Point"]!;
	assert.deepEqual(row.path, { kind: "launch_sunday", date: localDay(40) });
	const view = (await getPlant(S.runtime, await as(networkOwner), HP.id))!;
	assert.deepEqual(view.plant.path, row.path);
	assert.equal(view.launch.status === "shared" && view.launch.state, "scheduled");
	assert.equal(view.launch.status === "shared" && view.launch.plannedDate, localDay(40));
});
