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
const { ActivityCard, LaunchCard, MetricsCards } = await import("../../../apps/web/src/features/overview/cards.tsx");

const text = (element: unknown) =>
	renderToStaticMarkup(createElement(AppRouterContext.Provider, { value: router }, element))
		.replace(/<[^>]+>/g, " ")
		.replace(/\s+/g, " ")
		.trim();
const lost = { status: "lost" };

test("AC:CASE-ADM-005 a card whose read failed says so, with no zero or empty feed in its place", () => {
	const metrics = text(createElement(MetricsCards, { loaded: lost }));
	assert.match(metrics, /Your numbers could not load/);
	assert.doesNotMatch(metrics, /\d/);
	const feed = text(createElement(ActivityCard, { loaded: lost }));
	assert.match(feed, /Recent changes could not load/);
	assert.doesNotMatch(feed, /Nothing has changed yet/);
	const launch = text(createElement(LaunchCard, { loaded: lost, admin: true }));
	assert.match(launch, /Launch Sunday could not load/);
	assert.doesNotMatch(launch, /days|No date|of 9/);
	const zeros = text(
		createElement(MetricsCards, {
			loaded: { status: "ok", value: { recruited: 0, people: 0, myOverdueTasks: 0, visionMeetings: 0 } },
		}),
	);
	assert.match(zeros, /Recruited 0 .* People 0 .* My overdue tasks 0 .* Vision Meetings 0/);
	assert.doesNotMatch(zeros, /met|target|goal/i);
	assert.match(
		text(
			createElement(ActivityCard, { loaded: { status: "ok", value: { timeZone: "UTC", entries: [], more: false } } }),
		),
		/Nothing has changed yet/,
	);
});

const milestone = (id: number, done: boolean) => ({
	id: `00000000-0000-4000-8000-00000000000${id}`,
	templateKey: `m${id}`,
	area: "operations",
	title: `M${id}`,
	description: null,
	revision: "1",
	completion: done ? { at: "2026-10-01T12:00:00.000Z", by: null } : null,
	needsReview: false,
	tasks: [],
	practices: null,
});
const plan = (launch: { status: string; targetDate: string | null } | null, outcome: object | null = null) => ({
	today: "2026-10-13",
	timeZone: "America/Chicago",
	launch: launch && { revision: "2", ...launch },
	path: { kind: "launch_sunday" },
	revision: "2",
	milestones: [1, 2, 3, 4, 5, 6, 7, 8, 9].map((i) => milestone(i, i <= 4)),
	outcome,
	guests: { count: 0, named: null },
	evidence: {},
	debrief: null,
	summary: null,
});
const card = (p: ReturnType<typeof plan>, admin = true) =>
	text(createElement(LaunchCard, { loaded: { status: "ok", value: p }, admin }));

test("AC:CASE-ADM-005 the launch card counts church-local days and shows the Launch plan's readiness", () => {
	const ahead = card(plan({ status: "scheduled", targetDate: "2026-11-10" }));
	assert.match(ahead, /28 days Until Tue, Nov 10, 2026/);
	assert.match(ahead, /Readiness milestones 4 of 9/);
	assert.match(ahead, /Open Launch plan/);

	const postponed = card(plan({ status: "postponed", targetDate: null }));
	assert.match(postponed, /Postponed/);
	assert.doesNotMatch(postponed, /days/);

	assert.match(card(plan(null)), /No date yet .*Set Launch Sunday to start the countdown.* Set Launch Sunday/);
	const member = card(plan(null), false);
	assert.match(member, /Set Launch Sunday to start the countdown/);
	assert.doesNotMatch(member, /readiness milestones\. Set Launch Sunday/);

	const overdue = card({ ...plan({ status: "scheduled", targetDate: "2026-11-10" }), today: "2026-11-12" });
	assert.match(overdue, /Overdue .*Tue, Nov 10, 2026 This date has passed and no Launch Sunday is recorded yet/);
	assert.doesNotMatch(overdue, /Launched/);

	const held = card({
		...plan(
			{ status: "completed", targetDate: "2026-11-10" },
			{
				actualDate: "2026-11-10",
				attendance: 140,
				decisions: null,
				note: null,
				recordedAt: "2026-11-11T15:00:00.000Z",
				recordedBy: null,
			},
		),
		today: "2026-11-12",
	});
	assert.match(held, /Launched .*Tue, Nov 10, 2026 Held · Attendance 140/);
	assert.doesNotMatch(held, /days/);
});
