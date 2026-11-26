import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test, { after } from "node:test";
import { sql } from "../../../../packages/db/src/query.ts";
import { getPlant, listPlants, requestIntelligenceRefresh } from "../../../../packages/domain/src/oversight/index.ts";
import {
	as,
	bodies,
	connect,
	endOnce,
	linkNow,
	NO_BODY,
	one,
	S,
	silent,
	world,
	type Org,
	type World,
} from "./affiliation-world.mts";
import { schemaCase } from "./schema-probe.mts";

after(S.teardown);
const owned = (o: Org["o"]) => ({
	kind: "organization",
	id: o.id,
	organizationKind: o.kind === "organization" ? o.organizationKind : null,
});
const refusal = (attempt: Promise<unknown>) =>
	attempt.then(
		() => "accepted",
		(error: unknown) => String((error as Error).message),
	);
const insertRefused = async (statement: ReturnType<typeof sql>) => {
	try {
		await S.db.transaction(async (tx) => {
			await tx.execute(statement);
			await tx.execute(sql`SET CONSTRAINTS ALL IMMEDIATE`);
			throw Error("probe rolled back");
		});
	} catch (error) {
		return (error as { cause?: { code?: string } }).cause?.code ?? String((error as Error).message);
	}
	return "committed";
};
const plantRead = async (w: World, side: Org) => {
	const authority = await as(side.admin);
	return {
		page: await getPlant(S.runtime, authority, w.p.id),
		row: (await listPlants(S.runtime, authority))?.plants.some((p) => p.plantId === w.p.id) ?? false,
	};
};

test("AC:SCHEMA-003 AC:SCHEMA-001 one plant keeps separate bridges to two sending churches and a network; ending one keeps the others, a wrong kind or a plant id is refused, and a parent network alone reaches nothing", async () => {
	const c = schemaCase("SCHEMA-003");
	assert.deepEqual([c.action.arguments.plant_links, c.action.arguments.end], [["S1", "S2", "N1"], "S1"]);
	const w = await world();
	const links = { S1: await connect(w, w.S1), S2: await connect(w, w.S2), N1: await connect(w, w.N1) };
	const types = await one<{ kinds: string[] }>(sql`SELECT array_agg(o.kind ORDER BY o.kind) AS kinds FROM affiliation a
		JOIN organization o ON o.id=a.organization_id WHERE a.plant_id=${w.p.id} AND a.ended_at IS NULL`);
	assert.deepEqual(types.kinds, ["sending_church", "sending_church", "sending_network"]);
	for (const side of [w.S1, w.S2, w.N1]) assert.ok((await plantRead(w, side)).page, "each bridge reads the plant");

	await silent(async () => {
		const asChurch = { kind: "sending_church", subject: owned(w.S1.o) };
		for (const pair of [
			{ ...asChurch, organization: owned(w.S2.o) },
			{ ...asChurch, organization: { ...owned(w.S2.o), organizationKind: "sending_network" } },
			{ ...asChurch, organization: { kind: "organization", id: w.p.id, organizationKind: "sending_network" } },
			{
				kind: "plant",
				subject: { kind: "plant", id: w.p.id },
				organization: { ...owned(w.N2.o), organizationKind: "sending_church" },
			},
			{
				kind: "plant",
				subject: { kind: "plant", id: w.p.id },
				organization: { kind: "organization", id: w.p.id, organizationKind: "sending_church" },
			},
			{
				kind: "plant",
				subject: { kind: "organization", id: w.S1.o.id, organizationKind: "sending_church" },
				organization: owned(w.N2.o),
			},
		]) {
			const who = pair.kind === "plant" ? w.owner : w.S1.owner;
			assert.notEqual(
				await refusal(S.call("associations.invite", who, S.command({ pair, recipientEmail: "x@example.test" }, "1"))),
				"accepted",
				JSON.stringify(pair),
			);
		}
	});
	const flags =
		"accepted_at,share_people,share_meetings,share_tasks,share_ministry_teams,share_wiki,share_activity,shared_findings";
	assert.equal(
		await insertRefused(
			sql`INSERT INTO affiliation(plant_id,organization_id,${sql.raw(flags)}) VALUES(${w.p.id},${w.p.id},clock_timestamp(),false,false,false,false,false,false,false)`,
		),
		"23503",
	);
	assert.equal(
		await insertRefused(
			sql`INSERT INTO network_intelligence_run(id,organization_id,rubric_version) VALUES(${randomUUID()},${w.p.id},'everyfield-network/v1')`,
		),
		"23503",
	);
	assert.equal(
		await insertRefused(
			sql`INSERT INTO affiliation(plant_id,organization_id,${sql.raw(flags)}) VALUES(${w.p.id},${w.S2.o.id},clock_timestamp(),false,false,false,false,false,false,false)`,
		),
		"23505",
	);
	assert.deepEqual(await requestIntelligenceRefresh(S.runtime, await as(w.owner), { runId: randomUUID() }), {
		status: "refused",
		refusal: { code: "unavailable" },
	});

	assert.equal(
		await insertRefused(sql`INSERT INTO affiliation(sending_church_id,organization_id,${sql.raw(flags)})
		VALUES(${w.S1.o.id},${w.N2.o.id},clock_timestamp(),true,true,true,true,true,true,true)`),
		"23514",
	);
	await S.db.execute(sql`INSERT INTO affiliation(sending_church_id,organization_id,${sql.raw(flags)})
		VALUES(${w.S1.o.id},${w.N2.o.id},clock_timestamp(),false,false,false,false,false,false,false)`);
	const parentOnly = await plantRead(w, w.N2);
	assert.deepEqual(parentOnly, { page: null, row: false });

	await endOnce(w, w.S1, links.S1, w.owner, [w.S2, w.N1]);
	const s1 = await bodies(w, w.S1, await as(w.S1.admin));
	const s2 = await plantRead(w, w.S2);
	const n1 = await plantRead(w, w.N1);
	assert.deepEqual(await plantRead(w, w.N2), { page: null, row: false });
	assert.deepEqual(
		{
			state: {},
			result: {
				S1_body: JSON.stringify(s1) === JSON.stringify(NO_BODY) ? null : s1,
				S2_active: !(await linkNow(links.S2)).ended && s2.page !== null && s2.row,
				N1_active: !(await linkNow(links.N1)).ended && n1.page !== null && n1.row,
				network_parent_infers_grant: parentOnly.page !== null || parentOnly.row,
			},
			event: null,
		},
		{ state: c.expected.state, result: c.expected.result, event: c.expected.event },
	);
});
