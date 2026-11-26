import test, { after, before } from "node:test";
import assert from "node:assert/strict";
import { PeopleReadContext } from "../../../../packages/domain/src/people/core.ts";
import { assessments, readPersonPage } from "../../../../packages/domain/src/people/index.ts";
import { attendanceReader, meetingsReader } from "../../../../packages/domain/src/meetings/index.ts";
import { createTemplateReader, taskReader } from "../../../../packages/domain/src/tasks/index.ts";
import { teamsReader } from "../../../../packages/domain/src/teams/index.ts";
import { communicationWriter } from "../../../../packages/domain/src/communication/index.ts";
import { documentsReader, documentsWriter } from "../../../../packages/domain/src/documents/index.ts";
import { createWikiProducer } from "../../../../packages/domain/src/wiki/index.ts";
import { createAssessments, createFacts } from "../../../../packages/domain/src/intelligence/index.ts";
import { getPlant, listPlants, readIntelligence } from "../../../../packages/domain/src/oversight/index.ts";
import { gatedTransaction } from "../../../../packages/domain/src/operations/writes.ts";
import type { RequestActor } from "../../../../packages/domain/src/access/session.ts";
import {
	createConversation,
	evryActor,
	EvryRefusal,
	listConversations,
	readCatalog,
	readConversation,
} from "../../../../packages/evry/src/index.ts";
import { readPeoplePage } from "../../../../apps/web/src/features/people/page-data.ts";
import { listRequest as taskRequest, parseQuery as taskQuery } from "../../../../apps/web/src/features/tasks/model.ts";
import { parseQuery } from "../../../../apps/web/src/features/people/model.ts";
import { personId } from "../../../../packages/contracts/src/common/index.ts";
import { key, rolesWorld, ROLES, type Role, type RolesWorld } from "./roles-world.mts";

let w: RolesWorld;
before(async () => {
	w = await rolesWorld("roles_pages");
});
after(() => w?.close());

const wiki = createWikiProducer();
const templates = createTemplateReader();
const findings = createAssessments();
const facts = createFacts();

type Reply<V> = { status: "ok"; value: V } | { status: "refused"; error: { code: string } };
const shown = <V, S>(reply: Reply<V>, project: (value: V) => S) =>
	reply.status === "ok" ? project(reply.value) : `refused: ${reply.error.code}`;
const locked = <V,>(body: Parameters<typeof gatedTransaction<V>>[1]) => gatedTransaction(w.db, body);
const inPeople = <V,>(
	a: RequestActor,
	body: (tx: Parameters<Parameters<typeof gatedTransaction>[1]>[0], c: PeopleReadContext) => Promise<V>,
) => locked((tx) => body(tx, new PeopleReadContext(a)));
const oversight = async (a: RequestActor, plantId = w.plant.id) => (await getPlant(w.db, a, plantId))?.sections ?? null;

async function peoplePage(a: RequestActor) {
	const page = await inPeople(a, (tx, c) => readPeoplePage(tx, c, parseQuery(new URLSearchParams()), { pairs: true }));
	const { data } = page;
	const ben = await readPersonPage(w.db, new PeopleReadContext(a), { personId: w.ids.ben }, 50, { fields: true });
	return {
		list: data.kind === "list" ? [...data.page.items.map((p) => p.displayName), data.page.total] : data.kind,
		ben: shown(ben, (v) => (v.found.status === "available" ? v.found.person.displayName : v.found.status)),
		benAssessment: shown(
			await inPeople(a, (tx, c) => assessments.getAssessments(tx, c, { personId: w.ids.ben })),
			(v) => v.latest?.committed.notes,
		),
		oversight: (await oversight(a))?.people ?? null,
	};
}
async function meetingsPage(a: RequestActor) {
	return {
		list: shown(await meetingsReader.list(w.db, a, {}), (v) => [...v.items.map((m) => m.displayTitle), v.total]),
		planning: shown(await meetingsReader.listGuests(w.db, a, { meetingId: w.ids.planning }), (v) =>
			v.guests.map((g) => g.person.displayName),
		),
		mayMark: shown(
			await attendanceReader.listAttendance(w.db, a, { meetingId: w.ids.planning }),
			(v) => v.viewerCanMarkAttendance,
		),
		compose: shown(
			await meetingsReader.communicationContext(w.db, a, { meetingId: w.ids.planning }),
			(v) => v.guests.length,
		),
		oversight: (await oversight(a))?.meetings ?? null,
	};
}
async function tasksPage(a: RequestActor) {
	const list = (search: string) =>
		locked((tx) => taskReader.list(tx, a, taskRequest(taskQuery(new URLSearchParams(search)))));
	return {
		mine: shown(await locked((tx) => taskReader.list(tx, a, { view: "my" })), (v) => v.items.map((t) => t.title)),
		general: shown(await list("view=all&category=general"), (v) => [...v.items.map((t) => t.title).sort(), v.total]),
		chairs: shown(await locked((tx) => taskReader.get(tx, a, { taskId: w.ids.tasks.lead })), (v) =>
			v.status === "available" ? v.task.title : v.status,
		),
		templates: shown(await locked((tx) => templates.listTemplates(tx, a, {})), (v) => v.checklists[0]!.name),
		oversight: (await oversight(a))?.tasks ?? null,
	};
}
async function teamsPage(a: RequestActor) {
	return {
		list: shown(await teamsReader.list(w.db, a, {}), (v) =>
			v.items.map((t) => [t.name, t.leaderName, t.activeCount] as const),
		),
		welcome: shown(await teamsReader.listMembers(w.db, a, { teamId: w.ids.welcome }), (v) =>
			v.members.map((m) => m.name),
		),
		oversight: (await oversight(a))?.ministryTeams ?? null,
	};
}
async function messagesPage(a: RequestActor) {
	return {
		list: shown(await locked((tx) => communicationWriter.listHistory(tx, a, { limit: 50 })), (v) =>
			v.items.map((m) => [m.subject, m.state] as const),
		),
		letter: shown(
			await locked((tx) => communicationWriter.getDetail(tx, a, { id: w.ids.letter }, w.deliveryKeys)),
			(v) => [v.bodyText, v.deliveryAddress],
		),
		recipients: shown(await locked((tx) => communicationWriter.readRecipients(tx, a, { query: "Ben" })), (v) =>
			v.people.map((p) => p.email),
		),
	};
}
async function documentsPage(a: RequestActor) {
	return {
		template: shown(await documentsReader["templates.get"](w.db, a, { templateId: "commitment-card" }), (v) => v.name),
		church: shown(await documentsWriter.listChurch(w.db, a, {}), (v) => v.documents.map((d) => d.title)),
		written: shown(await documentsWriter.listOwned(w.db, a, {}), (v) => v.documents.map((d) => d.title)),
		open: shown(await documentsWriter.readChurch(w.db, a, { documentId: w.ids.policy }), (v) => v.title),
		edit: shown(await documentsWriter.readChurchForEdit(w.db, a, { documentId: w.ids.policy }), (v) => v.title),
	};
}
async function wikiPage(a: RequestActor) {
	const open = async (articleId: string) =>
		shown(await wiki.getArticle(w.db, a, { articleId }), (v) => v.article?.body ?? v.errorCode);
	return {
		list: shown(await wiki.listArticles(w.db, a, { page: 1 }), (v) => v.articles.map((x) => x.title).sort()),
		global: await open(w.ids.articles.global),
		grace: await open(w.ids.articles.grace),
		cedar: await open(w.ids.articles.cedar),
	};
}
async function intelligencePage(a: RequestActor) {
	return {
		assessment: shown(await findings.readAssessment(w.db, a, {}), (v) => [v.currentPhase, v.current]),
		committed: shown(await facts.readFacts(w.db, a, {}), (v) => v.committedAdults.evidence.map((e) => e.person.name)),
		attested: shown(await w.signals.readAttestations(w.db, a, {}), (v) =>
			v.signals.filter((s) => s.state === "answered").map((s) => [s.key, s.value] as const),
		),
		network: (await readIntelligence(w.db, a, { level: "portfolio", runId: null }))?.groups ?? null,
		plants: (await listPlants(w.db, a))?.plants.map((p) => [p.name, p.health] as const) ?? null,
		released: (await getPlant(w.db, a, w.plant.id))?.assessment.status ?? null,
	};
}
async function launchPage(a: RequestActor) {
	return {
		target: shown(await w.launchReader.readPlan(w.db, a), (v) => v.plan.launch?.targetDate),
		offers: shown(await w.launchReader.readGatheringOffers(w.db, a), (v) => v.length),
		journal: shown(await w.launchReader.readJournal(w.db, a), (v) => v.entries.map((e) => e.change.kind)),
		oversight: (await getPlant(w.db, a, w.plant.id))?.launch ?? null,
	};
}

const CHURCH_PEOPLE = {
	list: ["Alma Reyes", "Ben Cole", "Lena Lead", "Max Member", 4],
	ben: "Ben Cole",
	oversight: null,
};
const CHURCH_MEETINGS = {
	list: ["Welcome planning", "Orientation dinner", 2],
	planning: ["Lena Lead", "Max Member"],
	oversight: null,
};
const CHURCH_TASKS = {
	general: ["Call Ben", "Print programs", "Set out chairs", "Sign the lease", 4],
	chairs: "Set out chairs",
	oversight: null,
};
const CHURCH_TEAMS = {
	list: [
		["Welcome Team", "Lena Lead", 1],
		["Kitchen Team", null, 0],
	],
	welcome: ["Max Member"],
	oversight: null,
};
const CHURCH_MESSAGES = {
	list: [
		["Welcome letter", "sending"],
		["Draft about the budget", "draft"],
	],
	letter: ["Glad you came", "alma@example.test"],
};
const CHURCH_DOCUMENTS = {
	template: "Core Group Commitment Card",
	church: ["Harvest conflict policy"],
	written: ["Core values"],
	open: "Harvest conflict policy",
};
const CHURCH_WIKI = {
	list: ["Gathering core groups", "Grace gathering guide"],
	global: "Gather a core group of adults.",
	grace: "Gather the Grace way.",
	cedar: "content_access_denied",
};
const LEADERS_INTELLIGENCE = {
	assessment: [1, null],
	committed: ["Alma Reyes"],
	attested: [["prayer_rhythm_established", "yes"]],
	network: null,
	plants: null,
	released: null,
};
const MEMBERS_INTELLIGENCE = {
	assessment: "refused: access_denied",
	committed: "refused: access_denied",
	attested: "refused: access_denied",
	network: null,
	plants: null,
	released: null,
};
const LEADERS_LAUNCH = { target: "2027-09-12", offers: 0, journal: ["date"], oversight: null };
const MEMBERS_LAUNCH = {
	target: "2027-09-12",
	offers: "refused: access_denied",
	journal: "refused: access_denied",
	oversight: null,
};
const NO = "refused: unavailable";
const DENIED = "refused: access_denied";
const WITHHELD = { status: "withheld" };

const AREAS: Record<string, { read(a: RequestActor): Promise<unknown>; expected: Record<Role, unknown> }> = {
	People: {
		read: peoplePage,
		expected: {
			owner: { ...CHURCH_PEOPLE, benAssessment: "Private assessment words" },
			admin: { ...CHURCH_PEOPLE, benAssessment: "Private assessment words" },
			lead: { ...CHURCH_PEOPLE, benAssessment: NO },
			member: { ...CHURCH_PEOPLE, benAssessment: NO },
			director: {
				list: "failed",
				ben: NO,
				benAssessment: NO,
				oversight: {
					status: "shared",
					counts: {
						total: 4,
						byStage: {
							prospect: 0,
							attendee: 0,
							following_up: 0,
							interviewed: 1,
							core_group: 1,
							launch_team: 1,
							leader: 1,
						},
					},
				},
			},
		},
	},
	Meetings: {
		read: meetingsPage,
		expected: {
			owner: { ...CHURCH_MEETINGS, mayMark: true, compose: 2 },
			admin: { ...CHURCH_MEETINGS, mayMark: true, compose: 2 },
			lead: { ...CHURCH_MEETINGS, mayMark: true, compose: NO },
			member: { ...CHURCH_MEETINGS, mayMark: false, compose: NO },
			director: { list: NO, planning: NO, mayMark: NO, compose: NO, oversight: WITHHELD },
		},
	},
	Tasks: {
		read: tasksPage,
		expected: {
			owner: { ...CHURCH_TASKS, mine: ["Call Ben"], templates: "Discernment & Preparation" },
			admin: { ...CHURCH_TASKS, mine: ["Sign the lease"], templates: "Discernment & Preparation" },
			lead: { ...CHURCH_TASKS, mine: ["Set out chairs"], templates: NO },
			member: { ...CHURCH_TASKS, mine: ["Print programs"], templates: NO },
			director: { mine: NO, general: NO, chairs: NO, templates: NO, oversight: WITHHELD },
		},
	},
	Teams: {
		read: teamsPage,
		expected: {
			owner: CHURCH_TEAMS,
			admin: CHURCH_TEAMS,
			lead: CHURCH_TEAMS,
			member: CHURCH_TEAMS,
			director: { list: NO, welcome: NO, oversight: WITHHELD },
		},
	},
	Messages: {
		read: messagesPage,
		expected: {
			owner: { ...CHURCH_MESSAGES, recipients: ["ben@example.test"] },
			admin: { ...CHURCH_MESSAGES, recipients: ["ben@example.test"] },
			lead: { ...CHURCH_MESSAGES, recipients: DENIED },
			member: { ...CHURCH_MESSAGES, recipients: DENIED },
			director: { list: NO, letter: NO, recipients: NO },
		},
	},
	Documents: {
		read: documentsPage,
		expected: {
			owner: { ...CHURCH_DOCUMENTS, edit: "Harvest conflict policy" },
			admin: { ...CHURCH_DOCUMENTS, edit: "Harvest conflict policy" },
			lead: { ...CHURCH_DOCUMENTS, edit: DENIED },
			member: { ...CHURCH_DOCUMENTS, edit: DENIED },
			director: {
				template: "Core Group Commitment Card",
				church: DENIED,
				written: NO,
				open: DENIED,
				edit: DENIED,
			},
		},
	},
	Wiki: {
		read: wikiPage,
		expected: {
			owner: CHURCH_WIKI,
			admin: CHURCH_WIKI,
			lead: CHURCH_WIKI,
			member: CHURCH_WIKI,
			director: CHURCH_WIKI,
		},
	},
	"Plant Intelligence": {
		read: intelligencePage,
		expected: {
			owner: LEADERS_INTELLIGENCE,
			admin: LEADERS_INTELLIGENCE,
			lead: MEMBERS_INTELLIGENCE,
			member: MEMBERS_INTELLIGENCE,
			director: {
				...MEMBERS_INTELLIGENCE,
				network: [],
				plants: [
					["Harvest Point", "limited_visibility"],
					["Hidden Hollow", "limited_visibility"],
				],
				released: "withheld",
			},
		},
	},
	Launch: {
		read: launchPage,
		expected: {
			owner: LEADERS_LAUNCH,
			admin: LEADERS_LAUNCH,
			lead: MEMBERS_LAUNCH,
			member: MEMBERS_LAUNCH,
			director: { target: DENIED, offers: DENIED, journal: DENIED, oversight: WITHHELD },
		},
	},
};

for (const [area, { read, expected }] of Object.entries(AREAS))
	test(`INV-roles: each of the five roles opens only its own part of ${area}`, async () => {
		for (const role of ROLES) assert.deepEqual(await read(await w.actor(role)), expected[role], role);
	});

test("INV-roles: an article of an organization the church is not linked to opens only for that organization", async () => {
	const found = await wiki.getArticle(w.db, await w.as(w.cedarOwner), { articleId: w.ids.articles.cedar });
	assert.equal(
		shown(found, (v) => v.article?.body),
		"Gather the Cedar way.",
	);
});

test("INV-roles: the director sees a linked church that shares nothing as a name with every section withheld", async () => {
	const director = await w.actor("director");
	const view = await getPlant(w.db, director, w.hidden.id);
	assert.deepEqual(
		[view?.plant.name, view?.sections, view?.launch, view?.assessment],
		[
			"Hidden Hollow",
			{
				people: WITHHELD,
				tasks: WITHHELD,
				meetings: WITHHELD,
				ministryTeams: WITHHELD,
				wiki: WITHHELD,
			},
			WITHHELD,
			WITHHELD,
		],
	);
	for (const role of ["owner", "admin", "lead", "member"] as const)
		assert.equal(await getPlant(w.db, await w.actor(role), w.hidden.id), null, role);
	assert.equal(await getPlant(w.db, await w.as(w.cedarOwner), w.plant.id), null);
});

test("INV-roles: a person of another church opens for that church and for none of the five roles", async () => {
	const open = async (a: RequestActor) =>
		shown(await readPersonPage(w.db, new PeopleReadContext(a), { personId: personId.parse(w.ids.quinn) }, 50), (v) =>
			v.found.status === "available" ? v.found.person.displayName : v.found.status,
		);
	for (const role of ROLES) assert.equal(await open(await w.actor(role)), NO, role);
	assert.equal(await open(await w.as(w.hiddenOwner)), "Quinn Hidden");
});

const EVERYONE_IN_CHURCH = [
	"people",
	"peopleOrganization",
	"communication",
	"tasks",
	"followups",
	"notifications",
	"teams",
	"meetings",
	"workflows",
	"seats",
	"sharing",
	"dashboard",
	"feedback",
	"calendar",
	"wiki",
	"documents",
	"launch",
	"connections",
	"settings",
];
const LEADERS_ONLY = ["peopleAssessments", "phases", "signals", "intelligence", "geography"];
test("INV-roles: each of the five roles opens Evry with its own conversations and its own reads", async () => {
	const church = (...more: string[]) => [...EVERYONE_IN_CHURCH, ...more].sort();
	const expected: Record<Role, { context: string; domains: string[] }> = {
		owner: { context: "plant", domains: church(...LEADERS_ONLY, "onboarding") },
		admin: { context: "plant", domains: church(...LEADERS_ONLY) },
		lead: { context: "plant", domains: church() },
		member: { context: "plant", domains: church() },
		director: {
			context: "sending_church",
			domains: ["connections", "notifications", "oversight", "pipeline", "settings"],
		},
	};
	const own = {} as Record<Role, string>;
	for (const role of ROLES)
		own[role] = (await createConversation(w.db, evryActor(await w.actor(role)), { requestKey: key() })).id;
	for (const role of ROLES) {
		const a = evryActor(await w.actor(role));
		const catalog = readCatalog(a);
		assert.deepEqual(
			{ context: catalog.context, domains: catalog.domains.map((d) => d.domain).sort() },
			expected[role],
			role,
		);
		assert.deepEqual(
			(await listConversations(w.db, a, {})).items.map((c) => c.id),
			[own[role]],
			role,
		);
		for (const other of ROLES) {
			const opened = readConversation(w.db, a, own[other]);
			if (other === role) assert.equal((await opened).conversation.id, own[role]);
			else await assert.rejects(opened, (e) => e instanceof EvryRefusal && e.code === "not_found", `${role} ${other}`);
		}
	}
});
