import test, { after, before } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { listPlants, readIntelligence } from "../../../packages/domain/src/oversight/index.ts";
import { readCatalog } from "../../../packages/evry/src/index.ts";
import type { Actor } from "../../support/fixture.mts";
import { intelligenceChurch, type IntelligenceChurch } from "../evals/intelligence-church.mts";
import { nativePorts } from "../evals/settings-ports.mts";
import { caseWorld, propose, reads, rowsOf, sql, type CaseWorld, type Play } from "./case-world.mts";

let ch: IntelligenceChurch;
let w: CaseWorld;
before(async () => {
	ch = await intelligenceChurch("familyinsight", undefined, new Date("2026-10-13T16:00:00Z"));
	w = await caseWorld("familyinsight", { on: ch.database, native: nativePorts() });
});
after(() => (w ?? ch?.database)?.close());

const churchOf = () =>
	w.church({}, { plant: { kind: "plant", id: ch.cedar.id }, admin: ch.seats.admin as unknown as Actor });
const seat = (who: keyof IntelligenceChurch["seats"]) => ch.seats[who] as unknown as Actor;

async function leadOf(plant: string, account: string, name: string) {
	const person = randomUUID();
	await w.admin
		.execute(sql`INSERT INTO person(id,tenant_id,plant_id,display_name,source,stage,adult_classification,commitment_state,pipeline_position,state,created_at)
		VALUES(${person},${plant},${plant},${name},'other','leader','adult','unknown',900,'live',clock_timestamp())`);
	const { id: created } = await w.one(sql`INSERT INTO audit_event(tenant_id,actor_id,action,kind,subject_id)
		VALUES(${plant},${account},'identity.domain_accepted','create',${plant}) RETURNING id`);
	const { id: teamId } = await w.one(
		sql`INSERT INTO team(plant_id,name,state,sort_order) VALUES(${plant},'Planting','active',1) RETURNING id`,
	);
	const { id: roleId } = await w.one(
		sql`INSERT INTO team_role(plant_id,team_id,name,leadership,sort_order) VALUES(${plant},${teamId},'Lead planter',true,1) RETURNING id`,
	);
	await w.admin.execute(
		sql`INSERT INTO team_tenure(plant_id,role_id,person_id,started_on) VALUES(${plant},${roleId},${person},'2026-01-01')`,
	);
	const assignment = { teamId, roleId, personId: person };
	await w.admin
		.execute(sql`INSERT INTO onboarding_setup(plant_id,account_id,creation_operation_id,lead,journey,launch,people_step)
		VALUES(${plant},${account},${created},${JSON.stringify({ answer: "yes", assignment, savedAt: "2026-01-01T00:00:00.000Z" })}::jsonb,
			'{"status":"pending"}'::jsonb,'{"status":"pending"}'::jsonb,'pending')`);
}

test("AC:EVRY-FAMILY-ORGANIZATION-INTELLIGENCE an organization reads patterns of two directly linked sharing plants only, with no person, street, rank or lead, and loses them when sharing ends", async () => {
	const c = await churchOf();
	const [P, Q, R] = ["Harvest Point", "Redeemer Church", "Hill Country Church"].map((n) => ch.plants[n]!) as [
		IntelligenceChurch["cedar"],
		IntelligenceChurch["cedar"],
		IntelligenceChurch["cedar"],
	];
	const [director, member] = [seat("director"), seat("networkMember")];
	await w.admin.execute(
		sql`UPDATE affiliation SET ended_at=clock_timestamp() WHERE id=${ch.plants["Grace Tulsa"]!.affiliation}`,
	);
	await w.admin.execute(sql`UPDATE affiliation SET share_meetings=false,share_tasks=false WHERE id=${Q.affiliation}`);
	await w.admin.execute(sql`UPDATE plant SET street='12 Private Lane' WHERE id IN(${P.id},${Q.id},${R.id})`);
	await ch.churchLinked();
	const { id: grace } = await w.one<{ id: string }>(sql`SELECT id FROM organization WHERE name='Grace Austin'`);
	await leadOf(P.id, P.owner.id, "Alex Leadname");

	const qOwner = Q.owner as unknown as Actor;
	const places = rowsOf(
		await w.look(qOwner, "geography.listReportingRegionCandidates", { city: "Springfield", country: "US" }),
	);
	assert.ok(places.length > 1, "Springfield fits more than one Region");
	await w.apply(qOwner, "plant.updateProfile", { patch: { city: "Springfield", stateProvince: "TX", country: "US" } });
	for (const who of [director, member])
		assert.equal(
			(await w.ask(who, "Set the region", [() => propose("organizations.correctReportingLocation", {})])).replies[0]
				.error,
			"not_offered",
		);

	await w.apply(director, "organizationIntelligence.requestRefresh", {});
	for (const who of [director, member]) {
		for (const level of ["portfolio", "country", "state", "region"] as const) {
			const got = await w.look(who, "organizationIntelligence.read", { level });
			assert.deepEqual(
				rowsOf(got).map((r) => [r.fields.plants, r.fields.evidence]),
				level === "region"
					? []
					: [["Harvest Point, Redeemer Church", "From 2 plants with first-adult-acquisition evidence available."]],
				level,
			);
			assert.match(got.facts.patternRule, /two or more distinct plants/);
			assert.match(got.facts.groups, /Hill Country Church \(Not shared\)/);
		}
		const region = await w.look(who, "organizationIntelligence.read", { level: "region" });
		assert.match(region.facts.groups, /Region unresolved: Redeemer Church, Hill Country Church \(Not shared\)/);
		const placed = rowsOf(await w.look(who, "organizationIntelligence.readLocations", {}));
		assert.deepEqual(
			placed.map((r) => [r.id, r.fields.city, r.fields.region, r.fields.findings]).sort(),
			[
				[P.id, "Fort Worth", "Dallas-Fort Worth-Arlington, TX (metro area)", "Shared"],
				[Q.id, "Springfield", "No Region set", "Shared"],
				[R.id, "Austin", "No Region set", "Not shared"],
			].sort(),
		);
		assert.deepEqual(
			rowsOf(await w.look(who, "organizationIntelligence.readLocationHistory", { plantId: Q.id })),
			[],
			"an unresolved place is never guessed",
		);
	}

	const history = await w.look(member, "organizationIntelligence.readHistory", { level: "portfolio" });
	const pattern = rowsOf(history).find((r) => r.fields.row === "pattern")!;
	assert.deepEqual(
		rowsOf(history)
			.filter((r) => r.fields.row === "group")
			.map((r) => r.fields.plants),
		["Harvest Point, Hill Country Church (Not shared), Redeemer Church"],
	);
	assert.equal(pattern.fields.plants, "Harvest Point, Redeemer Church", "R is in no arithmetic");
	assert.deepEqual(Object.keys(pattern.fields).sort(), [
		"evidence",
		"group",
		"href",
		"level",
		"nextStep",
		"pattern",
		"patternKey",
		"plantLinks",
		"plants",
		"row",
		"yourRating",
	]);
	const whole = (await readIntelligence(w.db, await w.authorityOf(member), { level: "portfolio", runId: null }))!;
	assert.deepEqual(
		whole.groups[0]!.rows.map((r) => [r.name, r.status === "shared" ? r.results["NIR-04"] : r.status]),
		[
			["Harvest Point", "clear"],
			["Hill Country Church", "not_shared"],
			["Redeemer Church", "unknown"],
		],
		"an unshared category is Unknown",
	);
	assert.deepEqual(
		(await w.rows(sql`SELECT plant_id FROM network_intelligence_plant WHERE run_id=${history.facts.runId}`))
			.map((r) => r.plant_id)
			.sort(),
		[P.id, Q.id].sort(),
	);
	const directory = rowsOf(await w.look(member, "oversight.listPlants", {}));
	assert.deepEqual(
		directory.map((r) => [r.label, r.fields.health, r.fields.launch]),
		[
			["Harvest Point", "Watch", "Scheduled"],
			["Hill Country Church", "Not shared", "Not shared"],
			["Redeemer Church", "Not yet assessed", "Not set"],
		],
		"plants are listed by name, never ranked",
	);
	const [shared] = rowsOf(await w.look(member, "oversight.getPlant", { plantId: P.id }));
	assert.deepEqual(
		[shared.fields.health, shared.fields.launch, shared.fields.daysToLaunch, shared.fields.plannedDate],
		["Watch", "Scheduled", 20, "Nov 2, 2026"],
	);
	assert.equal(shared.fields.publishedSummary, "Our venue is booked and the launch team meets every week.");
	const [hidden] = rowsOf(await w.look(member, "oversight.getPlant", { plantId: R.id }));
	assert.deepEqual([hidden.fields.health, hidden.fields.publishedSummary ?? null], ["Not shared", null]);
	assert.deepEqual(
		rowsOf(await w.look(member, "oversight.listSendingChurches", {})).map((r) => [r.label, r.fields.plants]),
		[["Grace Austin", 2]],
	);

	const said = "What do the network's patterns say?";
	const look: Play = [
		reads("organizationIntelligence.read", { level: "portfolio" }),
		reads("organizationIntelligence.readHistory", { level: "portfolio" }),
		reads("organizationIntelligence.readLocations", {}),
	];
	const older = await w.ask(member, "Who leads our plants?", [
		reads("oversight.getSendingChurch", { churchId: grace }),
		() => "Alex Leadname leads it.",
	]);
	assert.ok(
		rowsOf(older.replies[0]).some((r) => r.fields.leadPlanter === "Alex Leadname"),
		"the directory names its lead",
	);
	assert.match(
		JSON.stringify((await w.ask(member, "Thanks", [], { conversation: older.conversation })).prompts.at(-1)),
		/Alex Leadname/,
		"and an ordinary turn keeps the answer",
	);
	const asked = await w.quiet(() =>
		w.ask(member, said, [...look, () => "PATTERN-BODY"], { conversation: older.conversation }),
	);
	assert.equal(asked.prompts.length, 5);
	for (const prompt of asked.prompts.slice(2)) assert.doesNotMatch(prompt, /Alex Leadname/, "no lead beside a pattern");
	const told = JSON.stringify([asked.replies, asked.saved, directory, shared, hidden, history]);
	for (const name of [...(await ch.names()), "Alex Leadname", "12 Private Lane", "HILL-DRAFT", "unpublished"])
		assert.equal(told.includes(name), false, name);
	assert.doesNotMatch(told, /"(rank|position|score|place_in)"/i);
	assert.deepEqual(
		asked.offered.filter((o) => /^people\.|care|interview|intake|^intelligence\./i.test(o)),
		[],
	);

	const rate = "organizationIntelligence.submitFeedback";
	const feedback = { runId: history.facts.runId, patternKey: pattern.fields.patternKey, rating: "useful" };
	const ratings = async () => {
		const seen = [];
		for (const who of [member, director]) {
			const got = await w.look(who, "organizationIntelligence.readHistory", { level: "portfolio" });
			seen.push(rowsOf(got).find((r) => r.fields.row === "pattern")!.fields.yourRating);
		}
		return seen;
	};
	assert.ok(asked.offered.includes(rate), "a Member may rate what it reads");
	await w.apply(member, rate, feedback);
	assert.deepEqual(await ratings(), ["Useful", null], "only its own author's");
	const unsaved = await w.prepare(member, rate, { ...feedback, rating: "not_useful" });
	await c.failedWrite(unsaved, "network_intelligence_feedback", { as: member, atApproval: true });
	assert.deepEqual(await ratings(), ["Useful", null], "the saved rating stays");
	await w.apply(director, rate, { ...feedback, rating: "not_useful" });
	assert.deepEqual(await ratings(), ["Useful", "Not useful"]);
	for (const [operation, input] of [
		["organizationIntelligence.requestRefresh", {}],
		["organizations.updateProfile", { patch: { description: "Admin words" } }],
	] as const) {
		assert.equal(asked.offered.includes(operation), false);
		const tried = await w.quiet(() => w.ask(member, said, [() => propose(operation, input)]));
		assert.deepEqual([tried.replies[0].error, tried.proposals], ["not_offered", []], operation);
	}
	await w.apply(director, "organizations.updateProfile", { patch: { description: "Admin words" } });

	await c.foreign(
		said,
		[...look, () => propose(rate, feedback), () => propose("organizationIntelligence.requestRefresh", {})],
		{ secrets: ["Harvest Point", "Alex Leadname", "Springfield"], on: { onError: "go_on" } },
	);
	const refresh = await w.prepare(director, "organizationIntelligence.requestRefresh", {});
	await c.foreignReview(refresh);
	const runs = () => w.rows(sql`SELECT id FROM network_intelligence_run ORDER BY ran_at,id`);
	const kept = await runs();
	await c.failedWrite(refresh, "network_intelligence_run", { as: director, atApproval: true });
	assert.deepEqual(await runs(), kept);
	await w.apply(director, "organizationIntelligence.requestRefresh", {});
	assert.equal((await runs()).length, kept.length + 1, "only the failed write stood in the way");

	const saved = (await listPlants(w.db, (await w.actorOf(member)).authority))!.plants.length;
	const pending = await w.prepare(member, rate, { ...feedback, rating: "not_useful" });
	const ratingRows = () => w.rows(sql`SELECT * FROM network_intelligence_feedback ORDER BY account_id`);
	const rated = await ratingRows();
	await w.admin.execute(sql`UPDATE affiliation SET shared_findings=false WHERE id=${P.affiliation}`);
	const then = await w.ask(member, "Continue", look, { conversation: asked.conversation });
	assert.doesNotMatch(JSON.stringify(then.prompts), /Alex Leadname/);
	assert.deepEqual(rowsOf(then.replies[0]), [], "one sharing plant is no pattern");
	for (const runId of [history.facts.runId, then.replies[1].facts.runId]) {
		const old = await w.look(member, "organizationIntelligence.readHistory", { level: "portfolio", runId });
		assert.deepEqual(
			rowsOf(old).filter((r) => r.fields.row === "pattern"),
			[],
			"no old pattern either",
		);
	}
	for (const who of [member, director]) {
		const lost = await w.ask(who, "Rate it", [() => propose(rate, feedback)]);
		assert.deepEqual([lost.replies[0].error, lost.proposals], ["not_found", []]);
	}
	const { review: late } = await w.approve(member, pending);
	assert.deepEqual([late.outcome, late.receipt?.code], ["refused", "access_denied"]);
	assert.deepEqual(await ratingRows(), rated, "a rating of the old pattern saves nothing");
	await w.admin.execute(sql`UPDATE affiliation SET ended_at=clock_timestamp() WHERE id=${P.affiliation}`);
	const ended = await w.ask(member, "Continue", look, { conversation: asked.conversation });
	assert.doesNotMatch(JSON.stringify(ended.prompts), /PATTERN-BODY|Harvest Point/, "no cached answer names it");
	assert.equal((await w.look(member, "oversight.getPlant", { plantId: P.id })).status, "not_found");
	assert.equal((await listPlants(w.db, (await w.actorOf(member)).authority))!.plants.length, saved - 1);
	assert.ok(readCatalog(await w.actorOf(member)).reviewedWrites.every((x) => !/requestRefresh/.test(x.operation)));
});
