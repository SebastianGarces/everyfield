import test, { after, before } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { sql } from "../../../packages/db/src/query.ts";
import { RequestActor, type WriteTx } from "../../../packages/domain/src/access/session.ts";
import { gatedTransaction } from "../../../packages/domain/src/operations/writes.ts";
import { createOrganizationAdapter, geographyReference } from "../../../packages/domain/src/organizations/index.ts";
import { requestIntelligenceRefresh } from "../../../packages/domain/src/oversight/index.ts";
import { listConversations, readConversation } from "../../../packages/evry/src/index.ts";
import {
	listOverseenPlants,
	readIntelligenceHistory,
	readNetworkIntelligence,
	readOverseenPlant,
	readPlantLocationHistory,
	readPlantLocations,
} from "../../../packages/evry/src/adapters/oversight/reads/index.ts";
import { invokeRead } from "../../../packages/evry/src/catalog/invoke.ts";
import { ok, type Actor } from "../../support/fixture.mts";
import { harness } from "../evals/intelligence-harness.mts";
import { intelligenceChurch, TODAY, type IntelligenceChurch } from "../evals/intelligence-church.mts";

type Kind = "sending_church" | "sending_network";
const SCENARIOS: [Kind, "church" | "organization"][] = [
	["sending_church", "church"],
	["sending_church", "organization"],
	["sending_network", "church"],
	["sending_network", "organization"],
];
let ch: IntelligenceChurch;
let h: ReturnType<typeof harness>;
const api = createOrganizationAdapter(
	{ async invitation() {}, invalidate: () => sql`UPDATE job SET state=state WHERE false` } as never,
	geographyReference,
);

before(async () => {
	ch = await intelligenceChurch("evrylinkend");
	h = harness(ch.db, TODAY);
});
after(() => ch?.database.close());

async function reads(director: Actor, plantId: string, runId: string) {
	const actor = (await h.freshActor(director.session))!;
	return {
		list: await invokeRead(ch.db, actor, listOverseenPlants, {}),
		plant: await invokeRead(ch.db, actor, readOverseenPlant, { plantId }),
		intelligence: await invokeRead(ch.db, actor, readNetworkIntelligence, { level: "portfolio" }),
		run: await invokeRead(ch.db, actor, readIntelligenceHistory, { level: "portfolio", runId }),
		places: await invokeRead(ch.db, actor, readPlantLocations, {}),
		place: await invokeRead(ch.db, actor, readPlantLocationHistory, { plantId }),
	};
}

for (const [kind, side] of SCENARIOS) {
	const label = `${kind === "sending_church" ? "sending church" : "network"} link ended by the ${side}`;
	test(`INV-link-end: ${label}: Evry shows the director nothing of the church from that moment, and an earlier answer stays as it was`, async () => {
		const harvest = ch.plants["Harvest Point"]!;
		const redeemer = ch.plants["Redeemer Church"]!;
		const org = await ch.database.organization(kind, { name: `${label} org`, timezone: "America/Chicago" });
		const director = await ch.database.actor(org, "admin");
		const links: Record<string, string> = {};
		for (const p of [harvest, redeemer])
			links[p.id] = String(
				(
					await ch.rows(sql`INSERT INTO affiliation(plant_id,organization_id,accepted_at,share_people,share_meetings,
					share_tasks,share_ministry_teams,share_wiki,share_activity,shared_findings)
					VALUES(${p.id},${org.id},clock_timestamp()-interval '1 day',true,true,true,true,true,true,true) RETURNING id`)
				)[0]!.id,
			);
		const authority = (await RequestActor.resolve(ch.db, director.session)) as RequestActor;
		const runId = randomUUID();
		for (const id of [runId, randomUUID()]) ok(await requestIntelligenceRefresh(ch.db, authority, { runId: id }));

		const named = (value: unknown, name: string) => JSON.stringify(value).includes(name);
		const before = await reads(director, harvest.id, runId);
		for (const [route, shown] of Object.entries(before)) assert.ok(named(shown, "Harvest Point"), route);
		assert.deepEqual(
			before.list.rows.map((r) => [r.label, r.fields.publishedSummary]),
			[
				["Harvest Point", "Our venue is booked and the launch team meets every week."],
				["Redeemer Church", null],
			],
		);
		const people = Number(before.plant.rows[0]!.fields.people);
		assert.ok(people >= 3);
		const actor = (await h.freshActor(director.session))!;
		const answered = await h.ask(actor, "how are our plants doing?");
		assert.ok(answered.answer.includes("**Harvest Point**"));
		const saved = async () => {
			const list = await listConversations(ch.db, actor, {});
			const [first] = list.items;
			return JSON.stringify((await readConversation(ch.db, actor, first!.id)).events);
		};
		const kept = await saved();
		assert.ok(kept.includes("Harvest Point"));

		const ender = side === "church" ? harvest.owner : director;
		let reached!: () => void;
		const held = new Promise<void>((resolve) => (reached = resolve));
		let release!: () => void;
		const released = new Promise<void>((resolve) => (release = resolve));
		const ending = gatedTransaction(ch.db, async (tx: WriteTx) => {
			assert.ok(await RequestActor.claimWrite(tx, ender.session, ender.selected as never));
			await api["associations.end"](
				tx,
				ender.session,
				ender.selected as never,
				{
					requestKey: randomUUID(),
					expectedRevision: "1",
					input: {
						relationshipId: links[harvest.id],
						pair: {
							kind: "plant",
							subject: { kind: "plant", id: harvest.id },
							organization: { kind: "organization", id: org.id, organizationKind: kind },
						},
						confirmed: true,
						reason: null,
					},
				} as never,
			);
			reached();
			await released;
		});
		await Promise.race([held, ending]);
		try {
			assert.deepEqual(await reads(director, harvest.id, runId), before, "a read before the end commits");
		} finally {
			release();
			await ending;
		}

		await ch.committed(harvest, `Harvest Newcomer ${label}`, 1);
		const later = await reads(director, harvest.id, runId);
		for (const [route, shown] of Object.entries(later)) {
			assert.ok(!named(shown, "Harvest Point") && !named(shown, "venue is booked"), route);
			if (route !== "plant" && route !== "place") assert.ok(named(shown, "Redeemer Church"), route);
		}
		assert.deepEqual([later.plant.status, later.plant.rows], ["not_found", []]);
		assert.deepEqual([later.place.status, later.place.rows], ["not_found", []]);
		assert.deepEqual(
			later.list.rows.map((r) => r.label),
			["Redeemer Church"],
		);
		const other = await reads(
			ch.seats.director,
			harvest.id,
			String(
				(
					await ch.rows(sql`SELECT id FROM
			network_intelligence_run WHERE organization_id=${ch.network.id} ORDER BY ran_at LIMIT 1`)
				)[0]!.id,
			),
		);
		assert.equal(other.plant.rows[0]!.fields.people, people + 1, "another linked organization still sees the church");

		assert.equal(await saved(), kept, "the earlier answer reads as it did, with nothing added");
		const again = await h.ask(actor, "how are our plants doing?");
		assert.ok(again.answer.includes("**Redeemer Church**"));
		assert.ok(!named(again, "Harvest Point"));
	});
}
