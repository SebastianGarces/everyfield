import test, { after, before } from "node:test";
import assert from "node:assert/strict";
import * as C from "../../../packages/contracts/src/oversight/index.ts";
import { sql } from "../../../packages/db/src/query.ts";
import { RequestActor } from "../../../packages/domain/src/access/session.ts";
import { getPreferences } from "../../../packages/domain/src/notifications/index.ts";
import { getPlant, listPlants, readIntelligence } from "../../../packages/domain/src/oversight/index.ts";
import {
	OVERSIGHT_READS,
	readIntelligenceHistory,
	readPlantLocationHistory,
	readPlantLocations,
} from "../../../packages/evry/src/adapters/oversight/reads/index.ts";
import { invokeRead } from "../../../packages/evry/src/catalog/invoke.ts";
import type { SourceResult } from "../../../packages/evry/src/catalog/types.ts";
import { ok } from "../../support/fixture.mts";
import { checkCase, harness, loadCases } from "./intelligence-harness.mts";
import { intelligenceChurch, TODAY, type IntelligenceChurch } from "./intelligence-church.mts";

const cases = loadCases("./oversight.cases.json");
let ch: IntelligenceChurch;
let h: ReturnType<typeof harness>;

before(async () => {
	ch = await intelligenceChurch("evryovs");
	h = harness(ch.db, TODAY);
});
after(() => ch?.database.close());

type Who = "director" | "networkMember" | "otherDirector";
const authorityOf = async (who: Who) =>
	(await RequestActor.resolve(ch.db, ch.seats[who].session as never)) as RequestActor;
const HEALTH: Record<C.Health, string> = {
	limited_visibility: "Limited visibility",
	launch_readiness: "Launch readiness",
	watch: "Watch",
	on_track: "On track",
	not_assessed: "Not yet assessed",
};
const geography = async () =>
	ch.rows(
		sql`SELECT id,region_item_id FROM plant_geography WHERE plant_id=${ch.plants["Harvest Point"]!.id} ORDER BY id`,
	);
let region: unknown;

const SETUP: Record<string, () => Promise<void>> = {
	redeemerGrows: () => ch.redeemerGrows(),
	harvestRegionCorrected: () => ch.harvestRegionCorrected(),
};
const PLACE_READS = new Set(OVERSIGHT_READS.slice(3).map((a) => a.operation));
const id = (name: string) => ch.plants[name]!.id;
const link = (name: string) => `[${name}](/network/plants/${id(name)})`;
const view = async (level: C.Level, runId: string | null = null, who: Who = "director") =>
	(await readIntelligence(ch.db, await authorityOf(who), { level, runId }))!;
const runLabel = (at: string) =>
	new Intl.DateTimeFormat("en-US", { dateStyle: "medium", timeStyle: "medium", timeZone: "America/Chicago" }).format(
		new Date(at),
	);
const LEVEL_NAME = { region: "Region", state: "State", country: "Country", portfolio: "Whole portfolio" } as const;
const answers = new Map<string, string>();

async function bounded(caseId: string, got: Got) {
	const bodies = (JSON.parse(got.results) as { operation: string; result: SourceResult }[]).filter((b) =>
		PLACE_READS.has(b.operation),
	);
	const text = JSON.stringify(bodies);
	for (const name of await ch.names()) assert.ok(!text.includes(name), `${caseId}: ${name} never reaches the model`);
	assert.doesNotMatch(text, /street|address|latitude|longitude|coordinat|"(?:lat|lng|lon)"/i, caseId);
	for (const { result } of bodies)
		for (const row of result.rows) {
			const f = row.fields;
			if (row.label === "Hill Country Church") {
				assert.equal(f.findings, "Not shared", caseId);
				assert.ok(!("health" in f) && !("reason" in f), caseId);
			}
			if (f.row === "pattern" || f.row === "change") {
				assert.ok(String(f.plants).split(", ").length >= 2, `${caseId}: one plant alone is never a pattern`);
				assert.ok(!String(f.plants).includes("Hill Country Church"), caseId);
			}
			if (f.row === "group" && String(f.plants).includes("Hill Country Church"))
				assert.ok(String(f.plants).includes("Hill Country Church (Not shared)"), caseId);
		}
	for (const line of got.answer.split("\n").filter((l) => l.includes("Hill Country Church")))
		assert.match(line, /Not shared/, `${caseId}: ${line}`);
}
type Got = Awaited<ReturnType<ReturnType<typeof harness>["ask"]>>;
const SETTLED: Record<string, (got: Got) => Promise<void>> = {
	"OVS-01": async (got) => {
		const directory = (await listPlants(ch.db, await authorityOf("director")))!;
		assert.equal(directory.plants.length, 4);
		for (const p of directory.plants) {
			const view = (await getPlant(ch.db, await authorityOf("director"), p.plantId))!;
			const health = view.assessment.status === "withheld" ? "Not shared" : HEALTH[p.health];
			assert.ok(got.answer.includes(`**${p.name}**: health ${health}.`), p.name);
		}
		region = await geography();
	},
	"OVS-02": async (got) => {
		for (const name of await ch.names()) assert.ok(!got.results.includes(name), `${name} never reaches the model`);
		const view = (await getPlant(ch.db, await authorityOf("director"), ch.plants["Redeemer Church"]!.id))!;
		assert.equal(view.sections.people.status === "shared" && view.sections.people.counts.total, 3);
	},
	"OVS-03": async (got) => {
		const view = (await readIntelligence(ch.db, await authorityOf("director"), { level: "state", runId: null }))!;
		const texas = view.groups.find((g) => g.label === "Texas")!;
		assert.equal(texas.patterns.length, 1);
		const text = C.patternText(texas.patterns[0]!);
		assert.ok(got.answer.includes(`**${text.title}**: ${text.lines.join(" ")}`));
		assert.deepEqual(texas.patterns[0]!.plants.map((p) => p.name).sort(), ["Harvest Point", "Redeemer Church"]);
		for (const name of await ch.names()) assert.ok(!got.results.includes(name), name);
	},
	"OVS-04": async (got) => {
		assert.ok(!got.results.includes("HILL-DRAFT"));
		assert.ok(!got.results.includes("2026-10-23") && !got.results.includes("Oct 23, 2026"));
	},
	"OVS-05": async () => assert.deepEqual(await geography(), region, "the region is unchanged"),
	"OVS-06": async () => {
		const prefs = ok(await getPreferences(ch.db, await authorityOf("director")));
		assert.equal((prefs as { oversightCadence?: string }).oversightCadence, "weekly");
	},
	"OVS-07": async () => {
		const prefs = ok(await getPreferences(ch.db, await authorityOf("director"))) as {
			choices: { category: string; channel: string; enabled: boolean }[];
		};
		const digest = prefs.choices.filter((x) => x.category === "oversight_digest").map((x) => [x.channel, x.enabled]);
		assert.deepEqual(digest.sort(), [
			["email", true],
			["in_app", false],
		]);
	},
	"OVS-09": async () => assert.deepEqual(await geography(), region, "the region is unchanged"),
	"OVS-12": async (got) => {
		const region = await view("region");
		const dfw = region.groups.find((g) => g.key === "19100")!;
		assert.deepEqual(
			dfw.rows.map((r) => r.name),
			["Harvest Point"],
		);
		assert.equal(dfw.patterns.length, 0);
		assert.ok(got.answer.includes(`Plants in this group: ${link("Harvest Point")}`));
		assert.ok(got.answer.includes(`Regions from ${region.geographyReleases[0]!.credit}.`));
		assert.ok(
			got.answer.includes(`- ${link("Redeemer Church")} still counts in Texas, United States and Whole portfolio.`),
		);
		assert.ok(got.answer.includes(`- ${link("Hill Country Church")} (Not shared) still counts in`));
	},
	"OVS-13": async (got) => {
		for (const level of C.LEVELS) {
			for (const g of (await view(level)).groups) {
				const stalled = g.patterns.find((p) => p.rule === "NIR-05" && p.theme === "stalled");
				const label = g.key === "portfolio" ? "Whole portfolio" : g.label;
				if (stalled)
					assert.ok(
						got.answer.includes(
							`- ${LEVEL_NAME[level]}, [${label}](/network/intelligence?level=${level}): ${stalled.plants.map((p) => link(p.name)).join(", ")}`,
						),
						`${level} ${label}`,
					);
				else assert.ok(got.answer.includes(`- ${LEVEL_NAME[level]}, ${label}: `), `${level} ${label} doesn't hold`);
			}
		}
		const texas = (await view("state")).groups.find((g) => g.label === "Texas")!;
		assert.equal(texas.patterns.length, 1, "it holds in Texas");
	},
	"OVS-14": async (got) => {
		const [whole] = (await view("portfolio")).groups;
		assert.ok(
			got.answer.includes(
				`Plants in this group: ${whole!.rows.map((r) => link(r.name) + (r.status === "shared" ? "" : " (Not shared)")).join(", ")}`,
			),
		);
		assert.ok(whole!.rows.some((r) => r.name === "Grace Tulsa"));
	},
	"OVS-15": async (got) => {
		const us = (await view("country")).groups.find((g) => g.key === "US")!;
		assert.ok(
			got.answer.includes(
				`Plants in this group: ${us.rows.map((r) => link(r.name) + (r.status === "shared" ? "" : " (Not shared)")).join(", ")}`,
			),
		);
		const texas = (await view("state")).groups.find((g) => g.label === "Texas")!;
		assert.ok(!texas.rows.some((r) => r.name === "Grace Tulsa"), "Grace Tulsa never counts in Texas");
	},
	"OVS-16": async (got) => {
		const directory = (await listPlants(ch.db, await authorityOf("director")))!;
		for (const p of directory.plants) {
			const region = p.region ? C.regionLabel(p.region) : "No Region set";
			assert.ok(
				got.answer.includes(`- ${link(p.name)}: ${p.city}, ${p.stateProvince}, ${p.country}. Region: ${region}.`),
				p.name,
			);
		}
	},
	"OVS-17": async (got) => assert.ok(got.answer.startsWith(`${link("Harvest Point")} is in Fort Worth, TX, US.`)),
	"OVS-18": async (got) => {
		const directory = (await listPlants(ch.db, await authorityOf("director")))!;
		const none = directory.plants.filter((p) => !p.region).map((p) => p.name);
		assert.deepEqual(none, ["Grace Tulsa", "Hill Country Church", "Redeemer Church"]);
		for (const name of none) assert.ok(got.answer.includes(`- ${link(name)} (`), name);
		assert.ok(
			got.answer.includes(
				`- ${link("Grace Tulsa")} (Tulsa, OK, US): still counts in Oklahoma, United States and Whole portfolio.`,
			),
		);
	},
	"OVS-21": async (got) => assert.equal(got.answer, answers.get("OVS-12")),
	"OVS-22": async (got) => assert.equal(got.answer, answers.get("OVS-16")),
	"OVS-23": async () => {
		const actor = (await h.freshActor(ch.seats.otherDirector.session))!;
		const results = [
			await invokeRead(ch.db, actor, readPlantLocations, {}),
			await invokeRead(ch.db, actor, readIntelligenceHistory, {}),
			await invokeRead(ch.db, actor, readPlantLocationHistory, { plantId: id("Harvest Point") }),
		];
		assert.deepEqual(
			results.map((r) => [r.status, r.rows.length]),
			[
				["available", 0],
				["available", 0],
				["not_found", 0],
			],
		);
		const text = JSON.stringify(results);
		for (const name of Object.keys(ch.plants)) assert.ok(!text.includes(name), name);
		for (const name of Object.keys(ch.plants)) assert.ok(!text.includes(id(name)), name);
	},
	"OVS-25": async (got) => {
		const latest = await view("state");
		const earlier = await view("state", latest.history[1]!.runId);
		const texas = earlier.groups.find((g) => g.label === "Texas")!;
		assert.ok(
			got.answer.includes(`In the earlier run, on ${runLabel(earlier.run!.ranAt)}, Network Intelligence showed:`),
		);
		assert.ok(got.answer.includes(`(/network/intelligence?level=state&run=${earlier.run!.runId})`));
		const text = C.patternText(texas.patterns[0]!);
		assert.ok(
			got.answer.includes(
				`- **${text.title}**: ${text.lines.join(" ")} Plants: ${link("Harvest Point")}, ${link("Redeemer Church")}.`,
			),
		);
	},
	"OVS-26": async (got) => {
		const latest = await view("state");
		const earlier = await view("state", latest.history[1]!.runId);
		const keys = (v: C.IntelligenceView) =>
			new Set(v.groups.find((g) => g.label === "Texas")!.patterns.map((p) => C.patternText(p).title));
		const gone = [...keys(earlier)].filter((t) => !keys(latest).has(t));
		assert.deepEqual(gone, ["Acquisition growth stalled"]);
		assert.equal([...keys(latest)].filter((t) => !keys(earlier).has(t)).length, 0);
		assert.ok(
			got.answer.startsWith(
				`Between the run on [${runLabel(earlier.run!.ranAt)}](/network/intelligence?level=state&run=${earlier.run!.runId}) and the latest run on [${runLabel(latest.run!.ranAt)}](/network/intelligence?level=state), in **Texas**:`,
			),
		);
	},
	"OVS-27": async (got) => assert.equal(got.answer, answers.get("OVS-25")),
	"OVS-28": async (got) => {
		const saved = await ch.rows(
			sql`SELECT to_char(effective_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS at FROM plant_geography
			WHERE plant_id=${id("Harvest Point")} ORDER BY effective_at DESC`,
		);
		assert.equal(saved.length, 2);
		for (const r of saved) assert.ok(got.answer.includes(`Took effect ${runLabel(String(r.at))}.`));
		const latest = await view("region");
		assert.equal(latest.history.length, 3);
		const placed = async (runId: string | null) =>
			(await view("region", runId)).groups.find((g) => g.rows.some((r) => r.name === "Harvest Point"))!.key;
		assert.equal(await placed(null), "12420", "the run after the correction uses the new Region");
		for (const run of latest.history.slice(1)) {
			assert.equal(await placed(run.runId), "19100", "an earlier run keeps the Region it used then");
			assert.ok(got.answer.includes(runLabel(run.ranAt)));
		}
		const [now, before] = got.answer.split("\n").filter((l) => l.startsWith("- "));
		assert.ok(now!.endsWith(`runs that used it: ${runLabel(latest.history[0]!.ranAt)}.`));
		assert.ok(
			before!.includes(runLabel(latest.history[1]!.ranAt)) && before!.includes(runLabel(latest.history[2]!.ranAt)),
		);
		assert.ok(got.answer.startsWith(`${link("Harvest Point")} has 2 saved locations`));
	},
	"OVS-29": async (got) => assert.equal(got.answer, answers.get("OVS-28")),
	"OVS-11": async () => {
		const view = (await readIntelligence(ch.db, await authorityOf("director"), { level: "state", runId: null }))!;
		assert.equal(view.groups.find((g) => g.label === "Texas")!.patterns.length, 0, "one plant alone is no pattern");
	},
};

test("AC:EVRY-ORG-CONTEXT AC:NI-010 AC:NI-041 AC:NI-044 AC:LI-001 AC:LI-007 AC:LI-012 AC:LI-015 AC:NEX-019 AC:NEX-020 AC:NEX-022 AC:SAF-14 INV-privacy: an organization seat's Evry reads only what its oversight pages show, never a person, a street or a coordinate, ranks no plant or place and changes nothing a plant owns", async () => {
	for (const c of cases) {
		if (c.setup) await SETUP[c.setup]!();
		const actor = (await h.freshActor(ch.seats[c.actor as Who].session))!;
		const got = await h.ask(actor, c.ask);
		answers.set(c.id, got.answer);
		if (process.env.EVRY_EVAL_PRINT) console.log(`## ${c.id} (${c.actor}): ${c.ask}\n${got.answer}\n`);
		const card = checkCase(c, got);
		assert.doesNotMatch(got.answer, /\b(ranked|ranking|top plant|best plant|worst plant|score of)\b/i, c.id);
		if (card && c.approve) assert.equal(await h.approveAndRun(actor, card), "completed", c.id);
		await bounded(c.id, got);
		await SETTLED[c.id]?.(got);
	}
});
