import test, { after, before } from "node:test";
import assert from "node:assert/strict";
import "../../platform/setup.mts";
import { sql } from "../../../../packages/db/src/query.ts";
import { communicationWriter } from "../../../../packages/domain/src/communication/index.ts";
import { readIntelligence, requestIntelligenceRefresh } from "../../../../packages/domain/src/oversight/index.ts";
import { peopleCsv, peopleReader, peopleWriter, personFields } from "../../../../packages/domain/src/people/index.ts";
import { ok } from "../../../support/fixture.mts";
import { atSendTime } from "../../communication/scheduled-support.mts";
import { emailsIn } from "../../communication/resend-recorder.mts";
import { key, sorted, world, type Feature, type World } from "./corrections-world.mts";

let w: World;
before(async () => {
	w = await world("corradult");
});
after(() => w?.database.close());

test("INV-corrections: correcting a child recorded as an adult moves every recipient list, held message, guardian route, list, export, household, adult count, Plant Intelligence, Network Intelligence and Evry read, keeps the old status in history and rewrites nothing sent", async () => {
	const ann = await w.committed(w.p, "Ann Adult", 60, { adultClassification: "adult", email: "ann@example.test" });
	const gail = await w.person(w.p, "Gail Grown", { adultClassification: "adult", email: "gail@example.test" });
	const kay = await w.committed(w.p, "Kay Kidd", 5, { adultClassification: "adult", email: "kay@example.test" });
	const tim = await w.person(w.p, "Tim Tiny", { adultClassification: "child", email: "tim@example.test" });
	const home = key();
	await w.admin.execute(sql`INSERT INTO household(id,plant_id,name) VALUES(${home},${w.p.id},'Kidd home')`);
	for (const [who, role] of [
		[gail, "head"],
		[kay, "other"],
		[tim, "child"],
	] as const)
		await w.admin.execute(sql`UPDATE person SET household_id=${home},household_role=${role} WHERE id=${who.id}`);
	ok(
		await w.people(personFields.setGuardianContact as never, {
			requestKey: key(),
			expectedRevision: await w.revision("person", tim.id),
			input: { personId: tim.id, guardianPersonId: kay.id, contact: true },
		}),
	);
	await w.admin.execute(sql`INSERT INTO guardian_contact(plant_id,child_person_id,guardian_person_id,household_id)
		VALUES(${w.p.id},${kay.id},${gail.id},${home})`);
	const held = await w.schedule({ personIds: [ann.id, kay.id] });
	const published = await w.publish({ personIds: [kay.id] });
	const unchanged = await w.freeze([
		"mail",
		"communication",
		"assessment_run",
		"network_intelligence_run",
		"network_intelligence_plant",
		"audit_event",
	]);
	const names = { [ann.id]: "Ann", [gail.id]: "Gail", [kay.id]: "Kay", [tim.id]: "Tim" };
	const audienceOf = async (personIds: string[]) => {
		const a = await w.audience({ personIds });
		return {
			recipients: a.recipients.map((r) => [r.displayName, r.guardianOf]),
			children: a.childExclusions.map((r) => r.displayName),
			routes: a.guardianRoutes.map((r) => [r.displayName, r.guardians.map((g) => g.displayName)]),
		};
	};
	const features: Feature[] = [
		{
			name: "the person's page",
			read: async () => {
				const { person } = ok(await w.people(peopleReader.getPerson as never, { personId: kay.id })) as {
					person: { adultClassification: string; adultClassificationSource: string };
				};
				return [person.adultClassification, person.adultClassificationSource];
			},
			before: ["adult", "recorded"],
			after: ["child", "recorded"],
		},
		{
			name: "the people list filters",
			read: () =>
				Promise.all(
					(["adult", "child"] as const).map(async (adultClassification) =>
						(
							ok(await w.people(peopleReader.listPeople as never, { adultClassification, limit: 25, page: 1 })) as {
								items: { displayName: string }[];
							}
						).items
							.map((x) => x.displayName)
							.sort(),
					),
				),
			before: [["Adam Admin", "Ann Adult", "Gail Grown", "Kay Kidd"], ["Tim Tiny"]],
			after: [
				["Adam Admin", "Ann Adult", "Gail Grown"],
				["Kay Kidd", "Tim Tiny"],
			],
		},
		{
			name: "the people export filter",
			read: async () => {
				const x = ok(await w.people(peopleCsv.exportPeople as never, { adultClassification: "child" })) as {
					text: string;
					receipt: { matched: number };
				};
				return [x.receipt.matched, x.text.includes("Kidd"), x.text.includes("Tiny")];
			},
			before: [1, false, true],
			after: [2, true, true],
		},
		{
			name: "the household",
			read: async () => {
				const h = ok(await w.people(personFields.getHousehold as never, { householdId: home })) as {
					members: { personId: string; adult: string }[];
					guardians: { childPersonId: string; guardianPersonId: string }[];
				};
				return [
					sorted(h.members.map((m) => [names[m.personId], m.adult])),
					sorted(h.guardians.map((g) => [names[g.childPersonId], names[g.guardianPersonId]])),
				];
			},
			before: [
				[
					["Gail", "adult"],
					["Kay", "adult"],
					["Tim", "child"],
				],
				[
					["Kay", "Gail"],
					["Tim", "Kay"],
				],
			],
			after: [
				[
					["Gail", "adult"],
					["Kay", "child"],
					["Tim", "child"],
				],
				[["Kay", "Gail"]],
			],
		},
		{
			name: "a message to the person",
			read: () => audienceOf([ann.id, kay.id]),
			before: {
				recipients: [
					["Ann Adult", []],
					["Kay Kidd", []],
				],
				children: [],
				routes: [],
			},
			after: {
				recipients: [
					["Ann Adult", []],
					["Gail Grown", ["Kay Kidd"]],
				],
				children: [],
				routes: [["Kay Kidd", ["Gail Grown"]]],
			},
		},
		{
			name: "a message to a child the person was a guardian of",
			read: () => audienceOf([tim.id]),
			before: { recipients: [["Kay Kidd", ["Tim Tiny"]]], children: [], routes: [["Tim Tiny", ["Kay Kidd"]]] },
			after: { recipients: [], children: ["Tim Tiny"], routes: [] },
		},
		{
			name: "the message waiting to be sent",
			read: async () => {
				const t = ok(await w.read(communicationWriter.getDeliveryTotals as never, { communicationId: held })) as {
					selected: number;
					reachable: number;
					guardian: number;
				};
				const r = ok(
					await w.read(communicationWriter.listHistoryRecipients as never, { communicationId: held, limit: 100 }),
				) as { items: { personId: string; deliveryStatus: string }[] };
				return [
					[t.selected, t.reachable, t.guardian],
					r.items.map((x) => [names[x.personId], x.deliveryStatus]).sort(),
				];
			},
			before: [
				[2, 2, 0],
				[
					["Ann", "scheduled"],
					["Kay", "scheduled"],
				],
			],
			after: [
				[2, 2, 1],
				[
					["Ann", "scheduled"],
					["Kay", "guardian"],
				],
			],
		},
		{
			name: "Plant Intelligence facts",
			read: async () => {
				const f = await w.factsNow();
				return [
					f.committedAdults.known,
					f.committedAdults.children,
					f.growth.current,
					f.growth.prior,
					f.growth.daysSince,
					f.growth.status,
				];
			},
			before: [2, 0, 1, 0, 5, "on_track"],
			after: [1, 1, 0, 0, 60, "stalled"],
		},
		{
			name: "Plant Intelligence freshness",
			read: async () => (await w.stale()) === published.run.runId,
			before: false,
			after: true,
		},
		{
			name: "Network Intelligence after its next run",
			read: async () => {
				const runId = key();
				ok(await requestIntelligenceRefresh(w.db, w.director, { runId }));
				const v = (await readIntelligence(w.db, w.director, { level: "portfolio", runId }))!;
				const [row] = v.groups.flatMap((g) => g.rows);
				return [
					row?.status === "shared" && row.results["NIR-05"],
					await w.rows(sql`SELECT growth_days FROM network_intelligence_plant WHERE run_id=${runId}`),
				];
			},
			before: ["clear", [{ growth_days: 5 }]],
			after: ["stalled", [{ growth_days: 60 }]],
		},
		{
			name: "Evry: the people list",
			read: async () => [...(await w.shown("people.listPeople", { adultClassification: "child" }, ["stage"])).sort()],
			before: [["Tim Tiny", "prospect"]],
			after: [
				["Kay Kidd", "core_group"],
				["Tim Tiny", "prospect"],
			],
		},
		{
			name: "Evry: the recipient search",
			read: () => w.shown("communication.searchRecipients", { query: "Kay" }, ["email"]),
			before: [["Kay Kidd", "can_email"]],
			after: [["Kay Kidd", "sent to a parent or guardian instead"]],
		},
		{
			name: "Evry: the recipient search for a child the person was a guardian of",
			read: () => w.shown("communication.searchRecipients", { query: "Tim" }, ["email"]),
			before: [["Tim Tiny", "sent to a parent or guardian instead"]],
			after: [["Tim Tiny", "marked as a child"]],
		},
		{
			name: "the recipient picker",
			read: async () => {
				const r = ok(await w.read(communicationWriter.readRecipients as never, { query: "Kay" })) as {
					people: { displayName: string; guardians: string[] }[];
				};
				return r.people.map((x) => [x.displayName, x.guardians]);
			},
			before: [["Kay Kidd", []]],
			after: [["Kay Kidd", ["Gail Grown"]]],
		},
		{
			name: "Evry: the message preview",
			read: async () =>
				(
					await w.evry("communication.preview", {
						subject: "Hello",
						body: "Hello",
						audience: { groups: [], teamIds: [], personIds: [ann.id, kay.id] },
					})
				).rows.map((r) => [r.label, r.fields]),
			before: [
				["Ann Adult", { leftOut: null }],
				["Kay Kidd", { leftOut: null }],
			],
			after: [
				["Kay Kidd", { leftOut: "sent to a parent or guardian instead" }],
				["Ann Adult", { leftOut: null }],
				["Gail Grown", { leftOut: null }],
			],
		},
		{
			name: "Evry: the committed adults and phase criteria",
			read: async () => [
				...(await w.shown("intelligence.readCommittedAdultCohort", {}, ["known", "exact"])),
				...(await w.shown("intelligence.readExitCriteria", {}, ["status", "reading"])),
			],
			before: [
				["Committed adults", 2, 2],
				["Core Group Development", null, null],
				["30 committed adults", "not met", "2 of 30 committed adults"],
				["Growth still moving", "met", `5 days since the newest committed adult, on ${w.day(-5)}`],
				["Launch funding viable", "no data yet", null],
				["Worship leader identified", "no data yet", null],
				["Geographic area set", "no data yet", null],
			],
			after: [
				["Committed adults", 1, 1],
				["Core Group Development", null, null],
				["30 committed adults", "not met", "1 of 30 committed adults"],
				["Growth still moving", "not met", `60 days since the newest committed adult, on ${w.day(-60)}`],
				["Launch funding viable", "no data yet", null],
				["Worship leader identified", "no data yet", null],
				["Geographic area set", "no data yet", null],
			],
		},
		{
			name: "Evry: the phase readiness",
			read: () => w.shown("phases.readReadiness", {}, ["status"]),
			before: [
				["Core Group Development", null],
				["30 committed adults", "not met"],
				["Growth still moving", "met"],
				["Launch funding viable", "no data yet"],
				["Worship leader identified", "no data yet"],
				["Geographic area set", "no data yet"],
			],
			after: [
				["Core Group Development", null],
				["30 committed adults", "not met"],
				["Growth still moving", "not met"],
				["Launch funding viable", "no data yet"],
				["Worship leader identified", "no data yet"],
				["Geographic area set", "no data yet"],
			],
		},
	];
	await w.check(features, "before");

	ok(
		await w.people(peopleWriter.correctAdultClassification as never, {
			requestKey: key(),
			expectedRevision: await w.revision("person", kay.id),
			input: {
				personId: kay.id,
				classification: "child",
				occurredOn: w.today,
				reason: "Kay is twelve",
			},
		}),
	);

	await w.check(features, "after");
	const feed = ok(await w.people(peopleReader.getActivities as never, { personId: kay.id, page: 1, limit: 25 })) as {
		items: { kind: string; action?: string; actor: { accountId?: string }; occurredAt: string }[];
	};
	assert.deepEqual(
		[feed.items[0]?.action, feed.items[0]?.actor],
		["classification_corrected", { kind: "current_account", accountId: w.boss.id }],
	);
	assert.deepEqual((await w.shown("people.getActivities", { personId: kay.id }, ["action"]))[0], [
		"classification_corrected",
		"classification_corrected",
	]);
	assert.deepEqual(await w.auditOf(sql`subject_id=${kay.id} AND action='people.corrected'`), [
		{
			actor_id: w.boss.id,
			before: { adult_classification: "adult" },
			after: { adult_classification: "child" },
			reason: "Kay is twelve",
			recent: true,
		},
	]);
	await unchanged();

	const posts = w.resend.requests.length;
	await atSendTime(w.admin, w.db, held, w.resend.transport, w.keys);
	assert.deepEqual(
		w.resend.requests.slice(posts).flatMap((r) => emailsIn(r).map((m) => m.to)),
		[["ann@example.test"], ["gail@example.test"]],
		"the waiting message goes to the guardian, never to the child",
	);
	assert.deepEqual(
		await w.rows(sql`SELECT p.display_name AS name,m.state,m.refusal FROM mail m JOIN person p ON p.id=m.recipient_person_id
			WHERE m.communication_id=${held} ORDER BY p.display_name`),
		[
			{ name: "Ann Adult", state: "accepted", refusal: null },
			{ name: "Gail Grown", state: "accepted", refusal: null },
			{ name: "Kay Kidd", state: "refused", refusal: "guardian" },
		],
	);
});
