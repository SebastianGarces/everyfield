import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../../../", import.meta.url));
const web = createRequire(root + "apps/web/package.json");
const { renderToStaticMarkup } = web("react-dom/server");
const { createElement } = web("react");
const { AppRouterContext } = web("next/dist/shared/lib/app-router-context.shared-runtime");
const router = { back() {}, forward() {}, refresh() {}, push() {}, replace() {}, prefetch() {} };
const { ToastProvider } = await import("../../../packages/ui/src/controls/index.ts");
const { GatheringCard, GatheringChoice } = await import("../../../apps/web/src/features/launch/Gathering.tsx");

const text = (element) =>
	renderToStaticMarkup(
		createElement(AppRouterContext.Provider, { value: router }, createElement(ToastProvider, null, element)),
	)
		.replace(/<[^>]+>/g, " ")
		.replace(/&#x27;/g, "'")
		.replace(/\s+/g, " ")
		.trim();
const HILL = "00000000-0000-4000-8000-0000000000a1";
const plan = (path) => ({
	today: "2026-10-12",
	timeZone: "America/Chicago",
	launch: null,
	path,
	revision: "1",
	milestones: [],
	outcome: null,
	guests: { count: 0, named: [] },
	evidence: {
		guestNamesEntered: { status: "unknown", remaining: null },
		debriefDone: { status: "unknown" },
		submittedAt: null,
	},
	debrief: { draft: null, submitted: null },
	summary: { draft: null, published: [] },
	preparation: { launched: false, daysToLaunch: null, unfilledRoles: null, outstandingTraining: null },
});
const milestone = {
	kind: "milestone",
	organizationId: HILL,
	organizationName: "Hill Country Network",
	offered: { name: "Constituted as a church", description: "Adopts its constitution." },
	reached: { name: "Constituted as a church", date: "2026-10-11", note: "Voted in." },
};
const act = {
	choose: async () => ({ status: "lost" }),
	save: async () => ({ status: "lost" }),
	offers: async () => null,
};
const keys = { keyFor: () => "k", settle() {} };
const screen = (p, offers, admin = true) =>
	text(
		createElement(
			"div",
			null,
			p.path.kind === "milestone"
				? createElement(GatheringCard, { act, plan: p, path: p.path, admin, keys, onPlan() {}, onOffers() {} })
				: "Launch Sunday countdown",
			createElement(GatheringChoice, { act, plan: p, offers: admin ? offers : null, keys, onPlan() {}, onOffers() {} }),
		),
	);
const lost = { status: "lost" };
const offered = {
	status: "ok",
	value: [
		{
			organizationId: HILL,
			organizationName: "Hill Country Network",
			name: "Constituted as a church",
			description: null,
		},
	],
};

test("when the offered milestones can't load, the Launch plan says so and still shows the milestone the church uses", () => {
	const page = screen(plan(milestone), lost);
	assert.match(page, /The milestones your network or sending church offer could not load/);
	assert.match(page, /Constituted as a church — reached Oct 11, 2026/);
	assert.match(page, /chosen by Hill Country Network/);
	assert.match(page, /Voted in\./);
	assert.doesNotMatch(page, /Launch Sunday countdown/);
});

test("when the offered milestones can't load on Launch Sunday, the countdown stays and no choice is shown as missing", () => {
	const page = screen(plan({ kind: "launch_sunday" }), lost);
	assert.match(page, /could not load/);
	assert.match(page, /Launch Sunday countdown/);
	assert.doesNotMatch(page, /End the gathering phase another way/);
	assert.match(
		screen(plan({ kind: "launch_sunday" }), offered),
		/End the gathering phase another way .*Constituted as a church \(chosen by Hill Country Network\)/,
	);
	const none = screen(plan({ kind: "launch_sunday" }), { status: "ok", value: [] });
	assert.doesNotMatch(none, /gathering|milestone offered|could not load/i);
});

test("a Member reads the path and the record with no control to switch, record, correct or clear", () => {
	const page = screen(plan(milestone), null, false);
	assert.match(page, /Constituted as a church — reached Oct 11, 2026/);
	assert.doesNotMatch(page, /Record reached|Correct|Clear record|Use Launch Sunday instead|Use this milestone/);
	const gone = screen(plan({ ...milestone, offered: null, reached: null }), null, false);
	assert.match(gone, /No longer offered by Hill Country Network/);
	assert.doesNotMatch(gone, /Use Launch Sunday instead/);
});
