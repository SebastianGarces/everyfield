import test, { after, before } from "node:test";
import assert from "node:assert/strict";
import { evryActor, EvryRefusal, invokeRead, READ_DOMAINS } from "../../../../packages/evry/src/index.ts";
import type { ReadAdapter, SourceResult } from "../../../../packages/evry/src/catalog/types.ts";
import { harness } from "../../../evry/evals/intelligence-harness.mts";
import { rolesWorld, ROLES, type Role, type RolesWorld } from "./roles-world.mts";

let w: RolesWorld;
before(async () => {
	w = await rolesWorld("roles_evry");
});
after(() => w?.close());

const adapters = new Map(
	Object.values(READ_DOMAINS)
		.flat()
		.map((a) => [a.operation as string, a as unknown as ReadAdapter<unknown>]),
);
const refusals: EvryRefusal[] = [];
async function read(role: Role, operation: string, input: object): Promise<SourceResult | string> {
	const adapter = adapters.get(operation)!;
	try {
		return await invokeRead(w.db, evryActor(await w.actor(role)), adapter, adapter.input.parse(input));
	} catch (error) {
		assert.ok(error instanceof EvryRefusal, String(error));
		refusals.push(error);
		return `refused: ${error.code}`;
	}
}

type Ids = RolesWorld["ids"];
type Row = {
	operation: string;
	input?: (ids: Ids) => object;
	project?: (r: SourceResult) => unknown;
	expected: Record<Role, unknown>;
};
const DENIED = "refused: access_denied";
const labels = (r: SourceResult) => [r.rows.map((row) => row.label), r.total];
const church = (value: unknown): Record<Role, unknown> => ({
	owner: value,
	admin: value,
	lead: value,
	member: value,
	director: DENIED,
});
const leaders = (value: unknown): Record<Role, unknown> => ({
	owner: value,
	admin: value,
	lead: DENIED,
	member: DENIED,
	director: DENIED,
});
const director = (value: unknown): Record<Role, unknown> => ({
	owner: DENIED,
	admin: DENIED,
	lead: DENIED,
	member: DENIED,
	director: value,
});

const READS: Row[] = [
	{ operation: "people.listPeople", expected: church([["Alma Reyes", "Ben Cole", "Lena Lead", "Max Member"], 4]) },
	{ operation: "people.listPeople", input: () => ({ search: "quinn" }), expected: church([[], 0]) },
	{
		operation: "people.getPerson",
		input: (i) => ({ personId: i.ben }),
		project: (r) => [r.rows[0]?.label, r.rows[0]?.fields.email],
		expected: church(["Ben Cole", "ben@example.test"]),
	},
	{
		operation: "people.getPerson",
		input: (i) => ({ personId: i.quinn }),
		project: (r) => [r.status, r.rows],
		expected: church(["not_found", []]),
	},
	{
		operation: "people.getAssessments",
		input: (i) => ({ personId: i.ben }),
		project: (r) => r.rows.map((row) => [row.label, row.fields.committedNotes]),
		expected: leaders([["4 C's on 2026-10-01", "Private assessment words"]]),
	},
	{
		operation: "people.getInterviews",
		input: (i) => ({ personId: i.ben }),
		project: (r) => r.rows.map((row) => [row.label, row.fields.maturityNotes]),
		expected: leaders([["Interview on 2026-10-02", "Private interview words"]]),
	},
	{
		operation: "meetings.list",
		expected: church([["Welcome planning", "Orientation dinner"], 2]),
	},
	{
		operation: "meetings.listGuests",
		input: (i) => ({ meetingId: i.planning }),
		expected: church([["Lena Lead", "Max Member"], 2]),
	},
	{
		operation: "tasks.list",
		input: () => ({ mine: true }),
		expected: {
			owner: [["Call Ben"], 1],
			admin: [["Sign the lease"], 1],
			lead: [["Set out chairs"], 1],
			member: [["Print programs"], 1],
			director: DENIED,
		},
	},
	{
		operation: "tasks.list",
		input: () => ({ categories: ["general"] }),
		project: (r) => [r.rows.map((row) => row.label).sort(), r.total],
		expected: church([["Call Ben", "Print programs", "Set out chairs", "Sign the lease"], 4]),
	},
	{
		operation: "tasks.listTemplates",
		project: (r) => r.rows[0]?.label,
		expected: leaders("Discernment & Preparation"),
	},
	{ operation: "teams.list", expected: church([["Welcome Team", "Kitchen Team"], 2]) },
	{
		operation: "teams.exportOrgChart",
		project: (r) => [r.rows[0]?.label, r.rows[0]?.fields.ministries],
		expected: church(["Organization view (PDF)", 2]),
	},
	{
		operation: "communication.list",
		project: (r) => r.rows.map((row) => row.label),
		expected: church(["Welcome letter", "Draft about the budget"]),
	},
	{
		operation: "communication.get",
		input: (i) => ({ communicationId: i.letter }),
		project: (r) => r.rows.map((row) => row.label),
		expected: church(["Welcome letter", "Alma Reyes"]),
	},
	{
		operation: "communication.searchRecipients",
		input: () => ({ query: "Ben" }),
		expected: leaders([["Ben Cole"], 1]),
	},
	{
		operation: "documents.listOwned",
		project: (r) => r.rows.map((row) => row.label).sort(),
		expected: church(["Core values", "Harvest conflict policy"]),
	},
	{
		operation: "documents.read",
		input: (i) => ({ documentId: i.values }),
		project: (r) => r.rows[0]?.fields.text,
		expected: church("We love our city"),
	},
	{
		operation: "wiki.search",
		input: () => ({ query: "gather" }),
		project: (r) => r.rows.map((row) => row.label).sort(),
		expected: church(["Gathering core groups", "Grace gathering guide"]),
	},
	{ operation: "wiki.search", input: () => ({ query: "cedar" }), expected: church([[], 0]) },
	{
		operation: "launch.readCountdown",
		project: (r) => r.rows.map((row) => [row.label, row.fields.plannedDate]),
		expected: church([["Launch Sunday", "Sun, Sep 12, 2027"]]),
	},
	{
		operation: "launch.readJournal",
		project: (r) => r.rows.map((row) => [row.label, row.fields.by]),
		expected: leaders([["Launch Sunday set", "Olivia Owner"]]),
	},
	{
		operation: "intelligence.readCommittedAdultCohort",
		project: (r) => [r.rows[0]?.label, r.rows[0]?.fields.known],
		expected: leaders(["Committed adults", 1]),
	},
	{
		operation: "intelligence.readAssessment",
		project: (r) => [r.status, r.exclusions],
		expected: leaders(["not_found", ["an assessment, because none has been published yet"]]),
	},
	{
		operation: "phases.readHistory",
		project: (r) => r.rows.map((row) => row.label),
		expected: leaders(["Core Group Development"]),
	},
	{
		operation: "dashboard.metrics",
		project: (r) => Object.fromEntries(r.rows.map((row) => [row.id, row.fields.count])),
		expected: {
			owner: { recruited: 1, people: 4, myOverdueTasks: 1, visionMeetings: 0 },
			admin: { recruited: 1, people: 4, myOverdueTasks: 1, visionMeetings: 0 },
			lead: { recruited: 1, people: 4, myOverdueTasks: 0, visionMeetings: 0 },
			member: { recruited: 1, people: 4, myOverdueTasks: 0, visionMeetings: 0 },
			director: DENIED,
		},
	},
	{
		operation: "notifications.previewPlanterDigest",
		project: (r) => r.rows.slice(1).map((row) => row.label),
		expected: {
			...leaders(null),
			owner: ["Overdue task, due Oct 24, 2026: Call Ben."],
			admin: ["Overdue task, due Oct 30, 2026: Sign the lease."],
		},
	},
	{
		operation: "notifications.previewOversightDigest",
		project: (r) => r.rows[0]?.id,
		expected: director("next"),
	},
	{
		operation: "oversight.listPlants",
		project: (r) => r.rows.map((row) => [row.label, row.fields.health, row.fields.launch]),
		expected: director([
			["Harvest Point", "Not shared", "Not shared"],
			["Hidden Hollow", "Not shared", "Not shared"],
		]),
	},
	{
		operation: "oversight.getPlant",
		input: () => ({ plantId: w.plant.id }),
		project: (r) => {
			const { people, coreGroup, tasks, meetings, ministryTeams, concerns } = r.rows[0]!.fields;
			return { people, coreGroup, tasks, meetings, ministryTeams, concerns };
		},
		expected: director({
			people: 4,
			coreGroup: 1,
			tasks: "Not shared",
			meetings: "Not shared",
			ministryTeams: "Not shared",
			concerns: "Not shared",
		}),
	},
	{
		operation: "oversight.getPlant",
		input: () => ({ plantId: w.hidden.id }),
		project: (r) => [r.rows[0]?.label, r.rows[0]?.fields.people],
		expected: director(["Hidden Hollow", "Not shared"]),
	},
];
const RECORD_WORDS = ["Ben", "Alma", "@example.test", "Private", "letter", "Harvest", "Hollow", "Welcome", "Call"];

test("INV-roles: each role's Evry reads return only its own rows, and a refused read carries nothing from the record", async () => {
	for (const { operation, input = () => ({}), project = labels, expected } of READS) {
		refusals.length = 0;
		for (const role of ROLES) {
			const got = await read(role, operation, input(w.ids));
			assert.deepEqual(typeof got === "string" ? got : project(got), expected[role], `${operation} ${role}`);
		}
		const text = JSON.stringify(refusals.map((r) => [r.message, r.code, Object.entries(r)]));
		assert.equal(refusals.length, Object.values(expected).filter((v) => v === DENIED).length, operation);
		for (const word of RECORD_WORDS) assert.equal(text.includes(word), false, `${operation} ${word}`);
	}
});

const INTERVIEW_REFUSED =
	"Interviews, 4 C's assessments and commitments are for the church's Owners and Admins, so I can't show or change them for you.";
const INTERVIEW = [
	["people.listPeople", "people.getInterviews"],
	"Ben Cole's interview on Oct 2, 2026: spiritual maturity pass (Private interview words), gifted pass, chemistry pass, right reasons pass, season pass. Result: qualified.",
];
const EVERYONE = [["people.listPeople"], "4 matched. Showing 4: Alma Reyes, Ben Cole, Lena Lead, Max Member."];
const NO_PLANTS = [[], "Ask me about the people in this church, for example: find Alex."];
const TURNS: [ask: string, expected: Record<Role, unknown>, withheld: string[]][] = [
	[
		"Show Ben Cole's interviews",
		{
			owner: INTERVIEW,
			admin: INTERVIEW,
			lead: [[], INTERVIEW_REFUSED],
			member: [[], INTERVIEW_REFUSED],
			director: [[], INTERVIEW_REFUSED],
		},
		["Private interview words"],
	],
	[
		"Who are the people in this church?",
		{
			owner: EVERYONE,
			admin: EVERYONE,
			lead: EVERYONE,
			member: EVERYONE,
			director: [["oversight.listPlants"], "I can't find this church among your plants."],
		},
		["Alma Reyes", "Ben Cole"],
	],
	[
		"How are our plants doing?",
		{
			owner: NO_PLANTS,
			admin: NO_PLANTS,
			lead: NO_PLANTS,
			member: NO_PLANTS,
			director: [
				["oversight.listPlants"],
				"Here is how your 2 plants look on your oversight pages:\n- **Harvest Point**: health Not shared. Launch: Not shared.\n- **Hidden Hollow**: health Not shared. Launch: Not shared.\n\nI don't rank or score plants against each other.",
			],
		},
		["Hidden Hollow"],
	],
];

for (const [ask, expected, withheld] of TURNS)
	test(`INV-roles: asked "${ask}", Evry reads and answers only what the role may see`, async () => {
		const evry = harness(w.db, new Date());
		for (const role of ROLES) {
			const got = await evry.ask(evryActor(await w.actor(role)), ask);
			assert.deepEqual([got.reads, got.answer], expected[role], role);
			const allowed = withheld.every((word) => JSON.stringify(expected[role]).includes(word));
			for (const word of withheld) assert.equal(got.results.includes(word), allowed, `${role} ${word}`);
		}
	});
