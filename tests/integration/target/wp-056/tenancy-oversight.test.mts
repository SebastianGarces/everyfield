import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import test, { after, before } from "node:test";
import { sql } from "../../../../packages/db/src/query.ts";
import {
	getPlant,
	getSendingChurch,
	listPlants,
	listSendingChurches,
} from "../../../../packages/domain/src/oversight/index.ts";
import { ok } from "../../../support/fixture.mts";
import { present, wikiWorld } from "../../wiki/case-world.mts";

type Case = {
	id: string;
	given: Record<string, Record<string, unknown>>;
	clock: { now: string };
	action: { operation: string; arguments: Record<string, unknown> };
	expected: { result: Record<string, unknown>; event: null };
};
const { cases } = JSON.parse(
	readFileSync(new URL("../../../../docs/acceptance/schema.json", import.meta.url), "utf8"),
) as { cases: Case[] };
const caseOf = (id: string) => cases.find((c) => c.id === id) ?? assert.fail(`no case ${id}`);

let w: Awaited<ReturnType<typeof wikiWorld>>;
before(async () => {
	w = await wikiWorld("tenoversight");
});
after(() => w?.close());

const CATEGORIES = [
	"share_people",
	"share_meetings",
	"share_tasks",
	"share_ministry_teams",
	"share_wiki",
	"share_activity",
	"shared_findings",
];
const source = (o: { id: string }) => ({ kind: "organization" as const, organizationId: o.id });

test("AC:TEN-003 each organization sees only what its own current link shares; ending one link leaves the other, and a network infers nothing from its member church", async () => {
	const c = caseOf("TEN-003");
	const input = c.given["case-input"] as {
		affiliations: Record<"S1" | "S2", boolean>;
		sharing: Record<"S1" | "S2", boolean>;
		parent_network: string;
	};
	assert.deepEqual(c.action.arguments.affiliations, input.affiliations);
	assert.equal(input.parent_network, "N1");
	assert.equal(new Date(c.clock.now).toISOString(), "2026-10-13T16:00:00.000Z");
	const { S1, S2, N1 } = w;
	const orgs = { S1, S2 };
	const { P, A, leave } = await w.church([S1, S2]);
	for (const [name, o] of Object.entries(orgs) as ["S1" | "S2", typeof S1][])
		await w.admin.execute(
			sql`UPDATE affiliation SET ${sql.raw(CATEGORIES.map((column) => `${column}=${input.sharing[name]}`).join(","))}
			WHERE plant_id=${P.id} AND organization_id=${o.id}`,
		);
	await w.admin
		.execute(sql`INSERT INTO affiliation(sending_church_id,organization_id,accepted_at,${sql.raw(CATEGORIES.join(","))})
		VALUES(${S2.id},${N1.id},clock_timestamp()-interval '10 minutes',${sql.raw(CATEGORIES.map(() => "false").join(","))})`);
	await w.admin
		.execute(sql`INSERT INTO person(id,tenant_id,plant_id,display_name,email,source,stage,adult_classification,
		commitment_state,pipeline_position,state,created_at)
		VALUES(${randomUUID()},${P.id},${P.id},'Dana Ortiz','dana@example.test','other','core_group','unknown','unknown','1','live',clock_timestamp())`);
	const article = await w.article();
	await w.publish(S1, article.id, "S1 private guidance");
	const cited = present((await w.view(A, article.id, source(S1))).article, "S1 article");
	assert.equal(cited.body, "S1 private guidance");
	await w.open(A, article.id);

	const as = (o: typeof S1) => w.actor(o.editor);
	const before1 = present(await getPlant(w.db, await as(S1), P.id), "S1 view");
	const before2 = present(await getPlant(w.db, await as(S2), P.id), "S2 view");
	assert.equal(before1.sections.people.status, "shared");
	assert.equal(JSON.stringify(before1).includes('"total":1'), true);
	assert.deepEqual(before2.sections.people, { status: "withheld" });
	assert.notDeepEqual(before1.plant.health, before2.plant.health);
	assert.equal(await getPlant(w.db, await as(N1), P.id), null);

	assert.equal(input.affiliations.S1, false);
	await leave(S1);
	const after1 = await getPlant(w.db, await as(S1), P.id);
	const after2 = present(await getPlant(w.db, await as(S2), P.id), "S2 view after S1 ended");
	assert.deepEqual(
		present(await listPlants(w.db, await as(S1)), "S1 directory").plants.map((p) => p.plantId),
		[],
	);
	assert.deepEqual(
		present(await listPlants(w.db, await as(S2)), "S2 directory").plants.map((p) => p.plantId),
		[P.id],
	);
	for (const section of Object.values(after2.sections)) assert.deepEqual(section, { status: "withheld" });
	assert.deepEqual(after2.launch, { status: "withheld" });
	const s2Body = JSON.stringify(after2);
	for (const leak of ['"total"', "Dana Ortiz", "dana@example.test", '"counts"'])
		assert.equal(s2Body.includes(leak), false, leak);

	const network = await as(N1);
	const inferred = {
		plant: await getPlant(w.db, network, P.id),
		directory: present(await listPlants(w.db, network), "N1 directory").plants.map((p) => p.plantId),
		through: present(await getSendingChurch(w.db, network, S2.id), "S2 under N1").plants.map((p) => p.plantId),
		roster: present(await listSendingChurches(w.db, network), "N1 roster").churches.map((r) => [r.name, r.plants]),
	};
	assert.deepEqual(inferred, { plant: null, directory: [], through: [], roster: [["S2", 0]] });

	await w.untouched(async () => {
		assert.deepEqual(await w.view(A, article.id, source(S1)), { article: null, errorCode: "content_access_denied" });
		const excerpt = ok(
			await w.api.referenceExcerpt(w.db, await w.actor(A), { articleId: article.id, source: source(S1) }),
		);
		assert.deepEqual(excerpt, { excerpt: null, errorCode: "content_access_denied" });
		const recent = ok(await w.api.readingRecent(w.db, await w.actor(A), {}));
		assert.equal(JSON.stringify(recent).includes("S1 private guidance"), false);
	});

	assert.deepEqual(
		{
			S1_body: after1,
			S2_withheld_body: after2.sections.people.status === "withheld" ? null : after2.sections.people,
			S2_relationship_retained: after2.plant.plantId === P.id,
			N1_inferred_plant_grant: inferred.plant !== null || inferred.directory.length > 0 || inferred.through.length > 0,
		},
		c.expected.result,
	);
	assert.equal(c.expected.event, null);
});
