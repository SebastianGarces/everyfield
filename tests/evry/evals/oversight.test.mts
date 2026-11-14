// The organization oversight evals (T-331: WP-073, WP-074) on the scripted model. Each case in oversight.cases.json is
// asked the way the app asks it, as North Texas Network's Admin or Member (intelligence-church.mts), with the database
// clock pinned to Oct 13, 2026. Each answer is checked against what the network's own pages read (oversight.listPlants,
// oversight.getPlant, Network Intelligence), and approved cards are read back through Settings' own read. No tool result
// the model is given holds a person's name or an unpublished summary (SAF-14). No paid model, network or recording.
import test, { after, before } from "node:test";
import assert from "node:assert/strict";
import * as C from "../../../packages/contracts/src/oversight/index.ts";
import { sql } from "../../../packages/db/src/query.ts";
import { RequestActor } from "../../../packages/domain/src/access/session.ts";
import { getPreferences } from "../../../packages/domain/src/notifications/index.ts";
import { getPlant, listPlants, readIntelligence } from "../../../packages/domain/src/oversight/index.ts";
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

const authorityOf = async (who: "director" | "networkMember") =>
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

const SETUP: Record<string, () => Promise<void>> = { redeemerGrows: () => ch.redeemerGrows() };
type Got = Awaited<ReturnType<ReturnType<typeof harness>["ask"]>>;
const SETTLED: Record<string, (got: Got) => Promise<void>> = {
	"OVS-01": async (got) => {
		// Each plant's health as the Plants page shows it, Not shared for the plant that keeps its findings.
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
		// SAF-14: no tool result the model was given holds a person's name.
		for (const name of await ch.names()) assert.ok(!got.results.includes(name), `${name} never reaches the model`);
		const view = (await getPlant(ch.db, await authorityOf("director"), ch.plants["Redeemer Church"]!.id))!;
		assert.equal(view.sections.people.status === "shared" && view.sections.people.counts.total, 3);
	},
	"OVS-03": async (got) => {
		// The pattern as the Network Intelligence page shows it at the state level.
		const view = (await readIntelligence(ch.db, await authorityOf("director"), { level: "state", runId: null }))!;
		const texas = view.groups.find((g) => g.label === "Texas")!;
		assert.equal(texas.patterns.length, 1);
		const text = C.patternText(texas.patterns[0]!);
		assert.ok(got.answer.includes(`**${text.title}**: ${text.lines.join(" ")}`));
		assert.deepEqual(texas.patterns[0]!.plants.map((p) => p.name).sort(), ["Harvest Point", "Redeemer Church"]);
		for (const name of await ch.names()) assert.ok(!got.results.includes(name), name);
	},
	"OVS-04": async (got) => {
		// Hill Country's launch date and draft summary are not shared, and never reach the model.
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
	"OVS-11": async () => {
		const view = (await readIntelligence(ch.db, await authorityOf("director"), { level: "state", runId: null }))!;
		assert.equal(view.groups.find((g) => g.label === "Texas")!.patterns.length, 0, "one plant alone is no pattern");
	},
};

test("AC:EVRY-ORG-CONTEXT AC:NI-010 AC:SAF-14 INV-privacy: an organization seat's Evry reads only what its oversight pages show, never a person, ranks no plant and changes nothing a plant owns", async () => {
	for (const c of cases) {
		if (c.setup) await SETUP[c.setup]!();
		const actor = (await h.freshActor(ch.seats[c.actor as "director" | "networkMember"].session))!;
		const got = await h.ask(actor, c.ask);
		if (process.env.EVRY_EVAL_PRINT) console.log(`## ${c.id} (${c.actor}): ${c.ask}\n${got.answer}\n`);
		const card = checkCase(c, got);
		assert.doesNotMatch(got.answer, /\b(ranked|ranking|top plant|best plant|worst plant|score of)\b/i, c.id);
		if (card && c.approve) assert.equal(await h.approveAndRun(actor, card), "completed", c.id);
		await SETTLED[c.id]?.(got);
	}
});
