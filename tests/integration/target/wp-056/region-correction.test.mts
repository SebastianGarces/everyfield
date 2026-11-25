import test, { after, before } from "node:test";
import assert from "node:assert/strict";
import "../../platform/setup.mts";
import { sql } from "../../../../packages/db/src/query.ts";
import { RequestActor } from "../../../../packages/domain/src/access/session.ts";
import { gatedTransaction } from "../../../../packages/domain/src/operations/writes.ts";
import {
	createOrganizationAdapter,
	geographyReference,
	installGeographyRelease,
	readReportingLocation,
	suggestRegions,
} from "../../../../packages/domain/src/organizations/index.ts";
import {
	getPlant,
	listPlants,
	placedIn,
	readIntelligence,
	readLocationHistory,
	requestIntelligenceRefresh,
} from "../../../../packages/domain/src/oversight/index.ts";
import type { Level } from "../../../../packages/contracts/src/oversight/health.ts";
import { ok } from "../../../support/fixture.mts";
import { key, world, type Feature, type World } from "./corrections-world.mts";

let w: World;
before(async () => {
	w = await world("corrregion");
	await installGeographyRelease(w.admin);
});
after(() => w?.database.close());

const MAINE = { city: "Portland", stateProvince: "ME", country: "US" };
const OREGON = { city: "Portland", stateProvince: "OR", country: "US" };
const LEVELS: Level[] = ["region", "state", "country", "portfolio"];
const api = createOrganizationAdapter(
	{ async invitation() {}, invalidate: () => sql`UPDATE job SET state=state WHERE false` } as never,
	geographyReference,
);

test("INV-corrections: correcting a church's wrong Region moves its location, every regional pattern, the oversight directory, plant view and Evry reads, keeps the old place in history and rewrites no earlier run", async () => {
	async function save(
		who: { session: string; actor: RequestActor; selected: { kind: "plant"; id: string } },
		where: typeof MAINE,
		code: string,
	) {
		const now = (await readReportingLocation(w.db, who.actor))!;
		const region = (await suggestRegions(w.db, who.actor, where))!.find((c) => c.area.code === code);
		assert.ok(region, `the picker offers ${code}`);
		await gatedTransaction(w.db, async (tx) => {
			assert.ok(await RequestActor.claimWrite(tx, who.session as never, who.selected as never));
			return api["organizations.correctReportingLocation"](
				tx,
				who.session as never,
				who.selected as never,
				{
					requestKey: key(),
					expectedRevision: now.revision,
					input: {
						plant: who.selected,
						locality: where,
						referenceVersionId: now.referenceVersionId,
						regionItemId: region.regionItemId,
					},
				} as never,
			);
		});
	}
	const launchSoon = async (p: { id: string }) => {
		await w.admin.execute(
			sql`INSERT INTO launch(plant_id,status,target_date) VALUES(${p.id},'scheduled',${w.day(10)}::date)`,
		);
		await w.role(p as never, "children", null);
	};
	const admin = { ...w.boss, session: w.boss.ctx.session, selected: w.boss.ctx.selected };
	const sister = await w.plant("Sister Church", { network: w.org });
	await w.admin.execute(sql`UPDATE affiliation SET share_people=true,share_meetings=true,share_tasks=true,
		share_ministry_teams=true WHERE id=${sister.affiliation}`);
	for (const p of [w.p, sister]) await launchSoon(p);
	await save(
		{ actor: sister.actor, session: sister.owner.session, selected: { kind: "plant", id: sister.id } },
		OREGON,
		"38900",
	);
	await save(admin, MAINE, "38860");
	const pat = await w.person(w.p, "Pat Reader", { email: "pat@example.test" });
	const published = await w.publish({ personIds: [pat.id] });
	const unchanged = await w.freeze([
		"mail",
		"assessment_run",
		"network_intelligence_run",
		"network_intelligence_plant",
		"audit_event",
	]);
	const groups = async (level: Level, runId: string) => {
		const v = (await readIntelligence(w.db, w.director, { level, runId }))!;
		return v.groups.map((g) => [
			g.label,
			g.rows.map((r) => r.name),
			g.patterns.map((x) => [x.rule, x.plants.map((y) => y.name)]),
		]);
	};
	const nextRun = async () => {
		const runId = key();
		ok(await requestIntelligenceRefresh(w.db, w.director, { runId }));
		return runId;
	};
	const row = async () => (await listPlants(w.db, w.director))!.plants.find((x) => x.plantId === w.p.id)!;
	const features: Feature[] = [
		{
			name: "the church's own location",
			read: async () => {
				const l = (await readReportingLocation(w.db, w.boss.actor))!;
				return [l.locality, l.region];
			},
			before: [
				{ city: "Portland", stateProvince: "ME", country: "US" },
				{ code: "38860", title: "Portland-South Portland, ME", type: "metro" },
			],
			after: [
				{ city: "Portland", stateProvince: "OR", country: "US" },
				{ code: "38900", title: "Portland-Vancouver-Hillsboro, OR-WA", type: "metro" },
			],
		},
		{
			name: "the oversight directory",
			read: async () => {
				const r = await row();
				return [r.city, r.stateProvince, r.region?.code, placedIn(r)];
			},
			before: [
				"Portland",
				"ME",
				"38860",
				["Portland-South Portland, ME (metro area)", "Maine", "United States", "Whole portfolio"],
			],
			after: [
				"Portland",
				"OR",
				"38900",
				["Portland-Vancouver-Hillsboro, OR-WA (metro area)", "Oregon", "United States", "Whole portfolio"],
			],
		},
		{
			name: "the oversight plant view",
			read: async () => {
				const { plant } = (await getPlant(w.db, w.director, w.p.id))!;
				return [plant.city, plant.stateProvince, plant.region?.code];
			},
			before: ["Portland", "ME", "38860"],
			after: ["Portland", "OR", "38900"],
		},
		{
			name: "the location history",
			read: async () =>
				(await readLocationHistory(w.db, w.director, w.p.id))!.locations.map((l) => [l.stateProvince, l.region?.code]),
			before: [["ME", "38860"]],
			after: [
				["OR", "38900"],
				["ME", "38860"],
			],
		},
		{
			name: "the regional patterns of the next run",
			read: async () => {
				const runId = await nextRun();
				return Promise.all(LEVELS.map((level) => groups(level, runId)));
			},
			before: [
				[
					["Portland-South Portland, ME (metro area)", ["Grace Harbor"], []],
					["Portland-Vancouver-Hillsboro, OR-WA (metro area)", ["Sister Church"], []],
				],
				[
					["Maine", ["Grace Harbor"], []],
					["Oregon", ["Sister Church"], []],
				],
				[["United States", ["Grace Harbor", "Sister Church"], [["NIR-03", ["Grace Harbor", "Sister Church"]]]]],
				[["Whole portfolio", ["Grace Harbor", "Sister Church"], [["NIR-03", ["Grace Harbor", "Sister Church"]]]]],
			],
			after: [
				[
					[
						"Portland-Vancouver-Hillsboro, OR-WA (metro area)",
						["Grace Harbor", "Sister Church"],
						[["NIR-03", ["Grace Harbor", "Sister Church"]]],
					],
				],
				[["Oregon", ["Grace Harbor", "Sister Church"], [["NIR-03", ["Grace Harbor", "Sister Church"]]]]],
				[["United States", ["Grace Harbor", "Sister Church"], [["NIR-03", ["Grace Harbor", "Sister Church"]]]]],
				[["Whole portfolio", ["Grace Harbor", "Sister Church"], [["NIR-03", ["Grace Harbor", "Sister Church"]]]]],
			],
		},
		{
			name: "Plant Intelligence freshness, which reads no location",
			read: async () => (await w.stale()) === published.run.runId,
			before: false,
			after: false,
		},
		{
			name: "Evry: Network Intelligence",
			read: async () => {
				await nextRun();
				return w.shown("organizationIntelligence.read", { level: "region" }, ["plants", "pattern"], w.director);
			},
			before: [],
			after: [
				[
					"Near-launch preparation",
					"Grace Harbor, Sister Church",
					"2 plants within 30 calendar days of an uncompleted launch have a recorded assignment or required-training gap.",
				],
			],
		},
		{
			name: "Evry: the locations",
			read: () =>
				w.shown(
					"organizationIntelligence.readLocations",
					{},
					["city", "stateProvince", "region", "countsIn"],
					w.director,
				),
			before: [
				[
					"Grace Harbor",
					"Portland",
					"ME",
					"Portland-South Portland, ME (metro area)",
					"Portland-South Portland, ME (metro area), Maine, United States, Whole portfolio",
				],
				[
					"Sister Church",
					"Portland",
					"OR",
					"Portland-Vancouver-Hillsboro, OR-WA (metro area)",
					"Portland-Vancouver-Hillsboro, OR-WA (metro area), Oregon, United States, Whole portfolio",
				],
			],
			after: [
				[
					"Grace Harbor",
					"Portland",
					"OR",
					"Portland-Vancouver-Hillsboro, OR-WA (metro area)",
					"Portland-Vancouver-Hillsboro, OR-WA (metro area), Oregon, United States, Whole portfolio",
				],
				[
					"Sister Church",
					"Portland",
					"OR",
					"Portland-Vancouver-Hillsboro, OR-WA (metro area)",
					"Portland-Vancouver-Hillsboro, OR-WA (metro area), Oregon, United States, Whole portfolio",
				],
			],
		},
		{
			name: "Evry: the location history",
			read: () =>
				w.shown("organizationIntelligence.readLocationHistory", { plantId: w.p.id }, ["region", "current"], w.director),
			before: [["Portland, ME, US", "Portland-South Portland, ME (metro area)", true]],
			after: [
				["Portland, OR, US", "Portland-Vancouver-Hillsboro, OR-WA (metro area)", true],
				["Portland, ME, US", "Portland-South Portland, ME (metro area)", false],
			],
		},
		{
			name: "Evry: the plant and directory",
			read: async () => [
				...(await w.shown("oversight.getPlant", { plantId: w.p.id }, ["region"], w.director)),
				...(await w.shown("oversight.listPlants", {}, ["region", "place"], w.director)),
			],
			before: [
				["Grace Harbor", "Portland-South Portland, ME (metro area)"],
				["Grace Harbor", "Portland-South Portland, ME (metro area)", "Portland, ME"],
				["Sister Church", "Portland-Vancouver-Hillsboro, OR-WA (metro area)", "Portland, OR"],
			],
			after: [
				["Grace Harbor", "Portland-Vancouver-Hillsboro, OR-WA (metro area)"],
				["Grace Harbor", "Portland-Vancouver-Hillsboro, OR-WA (metro area)", "Portland, OR"],
				["Sister Church", "Portland-Vancouver-Hillsboro, OR-WA (metro area)", "Portland, OR"],
			],
		},
	];
	await w.check(features, "before");

	await save(admin, OREGON, "38900");

	await w.check(features, "after");
	assert.deepEqual(
		await groups("region", published.networkRunId),
		[
			["Portland-South Portland, ME (metro area)", ["Grace Harbor"], []],
			["Portland-Vancouver-Hillsboro, OR-WA (metro area)", ["Sister Church"], []],
		],
		"the earlier run keeps the Region it read",
	);
	assert.deepEqual(
		await w.rows(sql`SELECT g.state_province AS state,
			(SELECT o.state_province FROM plant_geography o WHERE o.id=g.supersedes_id) AS replaced
			FROM plant_geography g WHERE g.plant_id=${w.p.id} ORDER BY g.effective_at`),
		[
			{ state: "ME", replaced: null },
			{ state: "OR", replaced: "ME" },
		],
	);
	assert.deepEqual(
		(await w.auditOf(sql`subject_id=${w.p.id} AND action='plant.profile_changed' AND kind='correct'`)).map((a) => [
			a.actor_id,
			a.recent,
		]),
		[
			[w.boss.id, false],
			[w.boss.id, true],
		],
	);
	await unchanged();
});
