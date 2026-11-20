import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { instant } from "../../../packages/contracts/src/common/time.ts";
import type { Clock, FeedItem } from "../../../apps/web/src/features/notifications/model.ts";

const root = fileURLToPath(new URL("../../../", import.meta.url));
const web = createRequire(root + "apps/web/package.json");
const { renderToStaticMarkup } = web("react-dom/server");
const { createElement } = web("react");
const { AppRouterContext } = web("next/dist/shared/lib/app-router-context.shared-runtime");
const router = { back() {}, forward() {}, refresh() {}, push() {}, replace() {}, prefetch() {} };
const { NotificationItem } = await import("../../../apps/web/src/features/notifications/parts.tsx");
const { groupByDay } = await import("../../../apps/web/src/features/notifications/model.ts");

const now = Date.parse("2026-11-20T15:00:00.000Z");
const pacific: Clock = { zone: "America/Los_Angeles", now };
const eastern: Clock = { zone: "America/New_York", now };

const notice = (eligibleAt: string, id = "0f6b1c1e-3f43-4f7a-9d83-5d0c2f3e9b11"): FeedItem => ({
	id,
	category: "task_due",
	title: "Call the venue",
	body: null,
	eligibleAt: instant.parse(eligibleAt),
	read: false,
	dueLocalDate: null,
	overdue: false,
	subject: null,
});
const shown = (item: FeedItem, clock: Clock) => {
	const html = renderToStaticMarkup(
		createElement(
			AppRouterContext.Provider,
			{ value: router },
			createElement(NotificationItem, { item, clock, onRead: () => {} }),
		),
	);
	return html.match(/<time dateTime="[^"]+">([^<]+)<\/time>/)?.[1];
};
test("a planter in Pacific time sees a notification's time in Pacific time", () => {
	assert.equal(shown(notice("2026-11-19T20:15:00.000Z"), pacific), "12:15 pm");
});

test("two people in different time zones each see the same notification in their own time", () => {
	const item = notice("2026-11-19T20:15:00.000Z");
	assert.equal(shown(item, pacific), "12:15 pm");
	assert.equal(shown(item, eastern), "3:15 pm");

	const lateNight = notice("2026-11-19T06:30:00.000Z");
	assert.equal(shown(lateNight, pacific), "Nov 18");
	assert.equal(shown(lateNight, eastern), "1:30 am");
});

test("the notifications page puts the same notification under each viewer's own day", () => {
	const items = [notice("2026-11-19T06:30:00.000Z")];
	assert.deepEqual(
		groupByDay(items, pacific).map((g) => g.label),
		["Earlier"],
	);
	assert.deepEqual(
		groupByDay(items, eastern).map((g) => g.label),
		["Yesterday"],
	);
});
