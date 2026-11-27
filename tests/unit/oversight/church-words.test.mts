import "../runs-in/render-module-mocks.mjs";
import assert from "node:assert/strict";
import { mock, test } from "node:test";
import { LENSES } from "../../../packages/contracts/src/intelligence/views.ts";
import {
	citationOf,
	intelligencePattern,
	intelligenceView,
	LEVELS,
	patternText,
	PERSON_STAGES,
	plantDirectory,
	plantView,
	RULE_IDS,
	type IntelligencePattern,
	type IntelligenceView,
	type Level,
	type PlantDirectoryRow,
} from "../../../packages/contracts/src/oversight/index.ts";
import { HEALTH, LAUNCH_STATE } from "../../../apps/web/src/features/oversight/model.ts";
import { mount } from "../evry/fake-dom.mts";

const at = (path: string) => new URL(`../../../apps/web/src/${path}`, import.meta.url).href;
const ID = "11111111-1111-4111-8111-111111111111";
const CHURCH = "Grace Austin";
let signedIn: { organization: { organizationKind: "sending_church" } } | null = null;
const church = { organization: { organizationKind: "sending_church" as const } };
let loaded: unknown = { status: "lost" };
const load = async () => loaded;
type Action = { status: "refused" } | { status: "lost" } | { status: "ok"; view: unknown } | Error;
let refreshed: Action = { status: "lost" };
let rated: Action = { status: "lost" };
const answer = (action: () => Action) => async () => {
	const reply = action();
	if (reply instanceof Error) throw reply;
	return reply;
};
mock.module(at("server/request-context.ts"), {
	namedExports: { organizationSeat: async () => signedIn, getViewer: async () => ({ status: "active" }) },
});
mock.module(at("server/sign-in.ts"), { namedExports: { requireActor: async () => {} } });
mock.module(at("features/oversight/server.ts"), {
	namedExports: {
		loadDirectory: load,
		loadIntelligence: load,
		loadPlant: load,
		loadRoster: load,
		loadSendingChurch: load,
	},
});
mock.module(at("features/oversight/actions.ts"), {
	namedExports: { refreshIntelligence: answer(() => refreshed), ratePattern: answer(() => rated) },
});
const routes = await import("../../../apps/web/src/features/oversight/routes.tsx");
const { IntelligenceScreen } = await import("../../../apps/web/src/features/oversight/screens.tsx");
const { default: Missing } = await import("../../../apps/web/src/app/(product)/(frame)/not-found.tsx");
const { default: Failed } = await import("../../../apps/web/src/app/(product)/(frame)/error.tsx");

const says = (lines: readonly string[], where: string) => {
	assert.ok(lines.length > 0, `${where} shows nothing`);
	for (const line of lines) assert.doesNotMatch(line, /network/i, where);
};
async function seen(element: unknown) {
	const page = await mount(() => element, {});
	const lines = page.lines();
	await page.unmount();
	return lines;
}
const params = Promise.resolve({ plantId: ID });
const searched = (shownLevel: Level = "portfolio") => ({ searchParams: Promise.resolve({ level: shownLevel }) });

const plantNumber = (n: number) =>
	`33333333-3333-4333-8333-${String(n).padStart(12, "0")}` as PlantDirectoryRow["plantId"];
const row = (over: Partial<PlantDirectoryRow> = {}): PlantDirectoryRow => ({
	plantId: plantNumber(0),
	name: "Harvest Point",
	city: "Round Rock",
	stateProvince: "TX",
	country: "US",
	phase: 3,
	path: { kind: "launch_sunday", date: "2027-03-14" as never },
	provenance: { kind: "direct" },
	leadPlanter: "Marcus Hill",
	region: { code: "12420", title: "Austin", type: "metro" },
	health: "watch",
	...over,
});
const milestone = (progress: object, chosenBy: string | null = null) =>
	({ kind: "milestone", name: "Constituted", chosenBy, progress }) as PlantDirectoryRow["path"];
const rows = [
	...(Object.keys(HEALTH) as PlantDirectoryRow["health"][]).map((health) => row({ health })),
	row({ leadPlanter: null, city: null, stateProvince: null, country: null, region: null }),
	row({ provenance: { kind: "through", sendingChurches: ["A", "B", "C"] } }),
	row({ path: { kind: "launch_sunday", date: null } }),
	...[
		{ status: "withheld" },
		{ status: "not_reached" },
		{ status: "withdrawn" },
		{ status: "reached", date: "2026-10-11" },
	].flatMap((progress) => [row({ path: milestone(progress) }), row({ path: milestone(progress, CHURCH) })]),
].map((plant, n) => ({ ...plant, plantId: plantNumber(n) }));

const SHARED = {
	people: { total: 7, byStage: Object.fromEntries(PERSON_STAGES.map((s) => [s, 1])) },
	tasks: { open: 2, overdue: 1 },
	meetings: {
		meetings: [
			{ date: "2026-10-11", attended: 12 },
			{ date: "2026-10-18", attended: null },
		],
		averageDaysBetween: 7,
		attendedTotal: 12,
	},
	ministryTeams: { teams: 2, roles: 4, rolesFilled: 3, trainingAssigned: 2, trainingComplete: 1 },
	wiki: { finished: 3, inProgress: 1 },
};
const sections = (status: string) =>
	Object.fromEntries(
		Object.entries(SHARED).map(([key, counts]) => [key, status === "shared" ? { status, counts } : { status }]),
	);
const launched = (state: string, over: object = {}) => ({
	status: "shared",
	state,
	plannedDate: "2026-11-22",
	milestones: { completed: 1, total: 3 },
	outcome: null,
	preparation: { launched: false, daysToLaunch: 10, unfilledRoles: 1, outstandingTraining: 2 },
	...over,
});
const concern = (ordinal: number, lens: string | null, severity: string) => ({
	id: `${ID}:${ordinal}`,
	ordinal,
	severity,
	lens,
	evidence: [],
});
const released = (concerns: object[], withheld: number) => ({
	status: "released",
	runId: ID,
	asOf: "2026-11-01T00:00:00.000Z",
	phase: 3,
	concerns,
	strengths: [],
	withheld,
});
const raised = [
	...LENSES.map((lens, n) => concern(n, lens.key, n % 2 ? "high" : "medium")),
	concern(LENSES.length, null, "high"),
];
const view = (over: object) =>
	plantView.parse({
		plant: row(),
		timeZone: "America/Chicago",
		sections: sections("shared"),
		launch: launched("scheduled"),
		summary: { version: 1, body: "We launched.", publishedAt: "2026-11-01T00:00:00.000Z" },
		assessment: released(raised, 2),
		...over,
	});
const PLANTS = [
	...rows.map((plant) => view({ plant })),
	...["withheld", "empty", "shared", "unavailable"].map((status) =>
		view({ sections: sections(status), summary: null }),
	),
	...Object.keys(LAUNCH_STATE).map((state) => view({ launch: launched(state) })),
	view({ launch: { status: "withheld" }, assessment: { status: "withheld" } }),
	view({ assessment: { status: "not_assessed" } }),
	view({ assessment: released([], 0) }),
	...[0, 1, 9].map((daysToLaunch) =>
		view({
			plant: row({ health: "launch_readiness" }),
			launch: launched("scheduled", {
				preparation: { launched: false, daysToLaunch, unfilledRoles: 1, outstandingTraining: 2 },
			}),
		}),
	),
	view({
		launch: launched("completed", { outcome: { actualDate: "2026-11-08", attendance: 120, decisions: null } }),
	}),
];

const base = {
	support: 2,
	observed: 3,
	plants: [{ plantId: ID, name: "Harvest Point" }],
	rating: null,
};
const PATTERNS: IntelligencePattern[] = [
	...LENSES.map((lens) => ({ rule: "NIR-01", theme: "shared_concern", lens: lens.key })),
	{ rule: "NIR-03", theme: "near_launch" },
	{ rule: "NIR-04", theme: "overdue_followup", overdue: 4, unowned: { support: 2, overdue: 2 } },
	{ rule: "NIR-05", theme: "slowed", asOf: "2026-11-01" },
	{ rule: "NIR-05", theme: "stalled", asOf: "2026-11-01" },
	{ rule: "NIR-06", theme: "required_training", outstanding: 3, applicable: 5, complete: 2 },
].map((p, n) => intelligencePattern.parse({ ...base, ...p, key: `p${n}`, citation: citationOf(p.rule as "NIR-01") }));
const RESULTS = [
	["gap", "gap", "slowed", "gap"],
	["clear", "clear", "stalled", "clear"],
	["unknown", "unknown", "unknown", "unknown"],
];
const findings = [
	{ status: "not_shared", plantId: ID, name: "Mueller" },
	...RESULTS.map((results) => ({
		status: "shared",
		plantId: ID,
		name: "Harvest Point",
		health: "watch",
		assessment: released(raised, 0),
		results: Object.fromEntries(RULE_IDS.map((id, n) => [id, results[n]])),
	})),
].map((finding, n) => ({ ...finding, plantId: plantNumber(n) }));
const run = { runId: ID, ranAt: "2026-11-01T00:00:00.000Z" };
const intelligence = (shownLevel: Level, over: object = {}): IntelligenceView =>
	intelligenceView.parse({
		status: "ready",
		organizationName: CHURCH,
		timeZone: "America/Chicago",
		level: shownLevel,
		run,
		history: [run, { ...run, runId: "22222222-2222-4222-8222-222222222222" }],
		groups: [
			{ key: "portfolio", label: "portfolio", rows: findings, patterns: PATTERNS, placement: "placed" },
			{ key: "r1", label: "Austin", rows: findings, patterns: [], placement: "placed" },
			{ key: "r2", label: "No place", rows: findings, patterns: [], placement: "missing" },
		],
		geographyReleases: [{ key: "g", credit: "US Census Bureau" }],
		canRefresh: true,
		...over,
	});
const VIEWS = LEVELS.flatMap((l) => [
	intelligence(l),
	intelligence(l, { canRefresh: false }),
	intelligence(l, { groups: [] }),
	intelligence(l, { run: null, history: [], groups: [] }),
	intelligence(l, { run: null, history: [], groups: [], canRefresh: false }),
]);

test("AC:TARGET-IDN-024 a sending church's plants home, plant page and Intelligence page never say network, filled or empty", async () => {
	signedIn = church;
	for (const plants of [[], rows]) {
		loaded = { status: "ok", value: plantDirectory.parse({ organizationName: CHURCH, plants }) };
		const lines = await seen(await routes.NetworkPage());
		says(lines, `plants home with ${plants.length}`);
		assert.ok(lines.includes("Your plants"));
	}
	for (const value of PLANTS) {
		loaded = { status: "ok", value };
		says(await seen(await routes.PlantPage({ params })), "plant page");
	}
	for (const value of VIEWS) {
		loaded = { status: "ok", value };
		const lines = await seen(await routes.IntelligencePage(searched(value.level)));
		says(lines, `Intelligence by ${value.level}`);
		assert.ok(lines.includes(`${CHURCH} Intelligence`));
	}
	for (const p of PATTERNS) {
		const text = patternText(p);
		says([text.title, ...text.lines, text.nextStep, text.evidence], p.theme);
	}
});

test("AC:TARGET-IDN-024 a sending church's refused, missing and failed oversight states and page titles never say network", async () => {
	const pages = [
		() => routes.NetworkPage(),
		() => routes.PlantPage({ params }),
		() => routes.IntelligencePage(searched()),
	];
	signedIn = null;
	for (const page of pages) says(await seen(await page()), "no organization seat");
	signedIn = church;
	says(await seen(await routes.RosterPage()), "the sending churches list");
	says(await seen(await routes.SendingChurchPage({ params: Promise.resolve({ churchId: ID }) })), "one sending church");
	loaded = { status: "lost" };
	for (const page of pages) says(await seen(await page()), "a page that did not load");
	loaded = { status: "missing" };
	for (const page of pages) await assert.rejects(page(), /NEXT_HTTP_ERROR_FALLBACK;404/);
	says(await seen(await Missing()), "a page that is missing");
	const failed = await mount(Failed, { error: new Error("x"), unstable_retry() {} });
	says(failed.lines(), "a page that failed");
	await failed.unmount();

	const titles: { title?: unknown }[] = [
		routes.networkMetadata,
		routes.plantMetadata,
		routes.rosterMetadata,
		routes.sendingChurchMetadata,
	];
	for (const seat of [null, church])
		for (const value of [
			{ status: "lost" },
			{ status: "missing" },
			{ status: "ok", value: intelligence("portfolio") },
		]) {
			signedIn = seat;
			loaded = value;
			titles.push(await routes.intelligenceMetadata(searched()));
		}
	says(
		titles.map((m) => JSON.stringify(m)),
		"page titles",
	);
	assert.equal(titles.at(-1)!.title, `${CHURCH} Intelligence`);
});

test("AC:TARGET-IDN-024 a sending church's Intelligence refresh and rating never say network, whatever they answer", async () => {
	const answers: Action[] = [
		{ status: "refused" },
		{ status: "lost" },
		new Error("offline"),
		{ status: "ok", view: intelligence("portfolio") },
	];
	for (const reply of answers) {
		refreshed = reply;
		rated = reply;
		const page = await mount(IntelligenceScreen, { view: intelligence("portfolio"), kind: "sending_church" });
		const before = page.lines();
		const problem = () => page.lines().filter((line) => !before.includes(line));
		await page.click("Refresh");
		says(page.lines(), "refresh");
		assert.equal(problem().length > 0, reply instanceof Error || reply.status !== "ok");
		await page.click("Useful");
		says(page.lines(), "rating");
		await page.unmount();
	}
});
