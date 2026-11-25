import test, { after, before } from "node:test";
import assert from "node:assert/strict";
import { listPeopleRequest } from "../../../../packages/contracts/src/people/index.ts";
import { PeopleReadContext } from "../../../../packages/domain/src/people/core.ts";
import { peopleCsv, peopleReader, searchPeople } from "../../../../packages/domain/src/people/index.ts";
import { meetingsReader } from "../../../../packages/domain/src/meetings/index.ts";
import { taskReader } from "../../../../packages/domain/src/tasks/index.ts";
import { teamsReader } from "../../../../packages/domain/src/teams/index.ts";
import { communicationWriter } from "../../../../packages/domain/src/communication/index.ts";
import { dashboardReader } from "../../../../packages/domain/src/dashboard/index.ts";
import { createWikiProducer } from "../../../../packages/domain/src/wiki/index.ts";
import { getPlant, listPlants } from "../../../../packages/domain/src/oversight/index.ts";
import { gatedTransaction } from "../../../../packages/domain/src/operations/writes.ts";
import type { RequestActor } from "../../../../packages/domain/src/access/session.ts";
import { rolesWorld, ROLES, type Role, type RolesWorld } from "./roles-world.mts";

let w: RolesWorld;
before(async () => {
	w = await rolesWorld("roles_search");
});
after(() => w?.close());

const wiki = createWikiProducer();
type Reply<V> = { status: "ok"; value: V } | { status: "refused"; error: { code: string } };
const shown = <V, S>(reply: Reply<V>, project: (value: V) => S) =>
	reply.status === "ok" ? project(reply.value) : `refused: ${reply.error.code}`;
const locked = <V,>(body: Parameters<typeof gatedTransaction<V>>[1]) => gatedTransaction(w.db, body);
const inPeople = <V,>(
	a: RequestActor,
	body: (tx: Parameters<Parameters<typeof gatedTransaction>[1]>[0], c: PeopleReadContext) => Promise<V>,
) => locked((tx) => body(tx, new PeopleReadContext(a)));

const SEARCHES: Record<string, (a: RequestActor, term: string) => Promise<unknown>> = {
	people: async (a, search) =>
		shown(await inPeople(a, (tx, c) => peopleReader.listPeople(tx, c, listPeopleRequest.parse({ search }))), (v) => [
			v.items.map((p) => p.displayName),
			v.total,
		]),
	"people picker": async (a, term) =>
		shown(await inPeople(a, (tx, c) => searchPeople(tx, c, term, 8)), (v) => v.map((p) => p.name)),
	pipeline: async (a, search) =>
		shown(await inPeople(a, (tx, c) => peopleReader.getPipelineData(tx, c, listPeopleRequest.parse({ search }))), (v) =>
			v.groups.flatMap((g) => g.cards.map((c) => [g.column, c.person.displayName, g.total])),
		),
	"people export count": async (a, search) =>
		shown(await inPeople(a, (tx, c) => peopleCsv.countExport(tx, c, { search })), (v) => v.receipt.matched),
	tasks: async (a, search) =>
		shown(await locked((tx) => taskReader.list(tx, a, { search })), (v) => [v.items.map((t) => t.title), v.total]),
	"task count": async (a, search) =>
		shown(await locked((tx) => taskReader.count(tx, a, { search })), (v) => v.topLevelTotal),
	"team members": async (a, q) =>
		shown(await teamsReader.searchMembers(w.db, a, { q }), (v) => v.items.map((m) => m.name)),
	"leader candidates": async (a, q) =>
		shown(await teamsReader.listLeaderCandidates(w.db, a, { q }), (v) => v.people.map((p) => p.name)),
	messages: async (a, query) =>
		shown(await locked((tx) => communicationWriter.listHistory(tx, a, { query, limit: 10 })), (v) => [
			v.items.map((m) => m.subject),
			v.visibleCount,
		]),
	"message recipients": async (a, query) =>
		shown(await locked((tx) => communicationWriter.readRecipients(tx, a, { query })), (v) =>
			v.people.map((p) => p.displayName),
		),
	"launch guests": async (a, query) =>
		shown(await w.launchReader.suggestGuests(w.db, a, query), (v) => v.map((g) => g.displayName)),
	wiki: async (a, query) =>
		shown(await wiki.search(w.db, a, { query }), (v) => v.results?.map((h) => h.title).sort() ?? v.status),
};

const NO = "refused: unavailable";
const DENIED = "refused: access_denied";
const everyone = (church: unknown, director: unknown = NO): Record<Role, unknown> => ({
	owner: church,
	admin: church,
	lead: church,
	member: church,
	director,
});
const leaders = (church: unknown, director: unknown = DENIED): Record<Role, unknown> => ({
	owner: church,
	admin: church,
	lead: DENIED,
	member: DENIED,
	director,
});

const CASES: [search: string, term: string, expected: Record<Role, unknown>, elsewhere?: unknown][] = [
	["people", "cole", everyone([["Ben Cole"], 1])],
	["people", "ben@example", everyone([["Ben Cole"], 1])],
	["people", "quinn", everyone([[], 0]), [["Quinn Hidden"], 1]],
	["people", "quinn@example", everyone([[], 0]), [["Quinn Hidden"], 1]],
	["people picker", "cole", everyone(["Ben Cole"])],
	["people picker", "quinn", everyone([]), ["Quinn Hidden"]],
	["pipeline", "cole", everyone([["interviewed", "Ben Cole", 1]])],
	["pipeline", "quinn", everyone([]), [["prospect", "Quinn Hidden", 1]]],
	["people export count", "cole", everyone(1)],
	["people export count", "quinn", everyone(0), 1],
	["tasks", "chairs", everyone([["Set out chairs"], 1])],
	["tasks", "hollow", everyone([[], 0]), [["Walk the hollow"], 1]],
	["task count", "chairs", everyone(1)],
	["task count", "hollow", everyone(0), 1],
	["team members", "max", everyone(["Max Member"])],
	["team members", "quinn", everyone([]), ["Quinn Hidden"]],
	["leader candidates", "ben", everyone(["Ben Cole"])],
	["leader candidates", "quinn", everyone([]), ["Quinn Hidden"]],
	["messages", "glad", everyone([["Welcome letter"], 1])],
	["messages", "hollow", everyone([[], 0]), [["Hollow letter"], 1]],
	["message recipients", "cole", leaders(["Ben Cole"], NO)],
	["message recipients", "quinn", leaders([], NO), ["Quinn Hidden"]],
	["launch guests", "cole", leaders(["Ben Cole"])],
	["launch guests", "quinn", leaders([]), ["Quinn Hidden"]],
	[
		"wiki",
		"gather",
		everyone(["Gathering core groups", "Grace gathering guide"], ["Gathering core groups", "Grace gathering guide"]),
	],
	["wiki", "cedar", everyone([], [])],
];

test("INV-roles: each role's search returns only rows and totals it may see, and another church's record is found only there", async () => {
	for (const [search, term, expected, elsewhere] of CASES) {
		const run = SEARCHES[search]!;
		for (const role of ROLES)
			assert.deepEqual(await run(await w.actor(role), term), expected[role], `${search} ${term} ${role}`);
		if (elsewhere !== undefined)
			assert.deepEqual(await run(await w.as(w.hiddenOwner), term), elsewhere, `${search} ${term} in its own church`);
	}
	assert.deepEqual(await SEARCHES.wiki!(await w.as(w.cedarOwner), "cedar"), ["Cedar gathering guide"]);
});

const COUNTS: Record<string, (a: RequestActor) => Promise<unknown>> = {
	overview: async (a) => shown(await dashboardReader.readMetrics(w.db, a), (v) => v),
	tasks: async (a) =>
		shown(await locked((tx) => taskReader.count(tx, a, { categories: ["general"] })), (v) => v.topLevelTotal),
	"own tasks": async (a) =>
		shown(await locked((tx) => taskReader.count(tx, a, { view: "my" })), (v) => v.topLevelTotal),
	meetings: async (a) => shown(await meetingsReader.list(w.db, a, {}), (v) => v.total),
	stages: async (a) =>
		shown(await inPeople(a, (tx, c) => peopleReader.getPipelineData(tx, c, listPeopleRequest.parse({}))), (v) =>
			Object.fromEntries(v.groups.filter((g) => g.total).map((g) => [g.column, g.total])),
		),
	staffing: async (a) =>
		shown(await teamsReader.staffingSummary(w.db, a, {}), ({ roles, filledRoles, openRoles, people }) => ({
			roles,
			filledRoles,
			openRoles,
			people,
		})),
	directory: async (a) => (await listPlants(w.db, a))?.plants.length ?? null,
	"shared people": async (a) => {
		const shared = (await getPlant(w.db, a, w.plant.id))?.sections.people;
		return shared?.status === "shared" ? shared.counts.total : null;
	},
};
const metrics = (myOverdueTasks: number) => ({ recruited: 1, people: 4, myOverdueTasks, visionMeetings: 0 });
const EXPECTED_COUNTS: Record<string, Record<Role, unknown>> = {
	overview: { owner: metrics(1), admin: metrics(1), lead: metrics(0), member: metrics(0), director: DENIED },
	tasks: everyone(4),
	"own tasks": everyone(1),
	meetings: everyone(2),
	stages: everyone({ interviewed: 1, core_group: 3 }),
	staffing: everyone({ roles: 1, filledRoles: 1, openRoles: 0, people: 1 }),
	directory: everyone(null, 2),
	"shared people": everyone(null, 4),
};

test("INV-roles: each role's counts include only rows it may see", async () => {
	for (const [name, read] of Object.entries(COUNTS))
		for (const role of ROLES)
			assert.deepEqual(await read(await w.actor(role)), EXPECTED_COUNTS[name]![role], `${name} ${role}`);
});
