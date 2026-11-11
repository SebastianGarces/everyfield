// D-517: Settings > Notifications offers a choice only for a category something sends. The notification worker that
// would send meeting announcements and reminders, connection, sharing and launch milestones and wiki review requests
// is a follow-up, so those rows stay hidden even when the account has stored choices for them. No browser needed.
import assert from "node:assert/strict";
import { test } from "node:test";
import { notificationCategory } from "../../../packages/contracts/src/settings/values.ts";
import { preferenceRows } from "../../../apps/web/src/features/settings/model.ts";

const every = notificationCategory.options.flatMap((category) =>
	["in_app", "email"].map((channel) => ({ category, channel, enabled: true })),
);

test("INV-notification-rows: only categories with a producer are offered, in matrix order", () => {
	assert.deepEqual(
		preferenceRows(every).map((row) => row.category),
		["task_due", "task_overdue", "planter_digest", "oversight_digest", "phase_milestone"],
	);
});

test("INV-notification-rows: a stored choice for a hidden category makes no row, and a sent one keeps its pairs", () => {
	const rows = preferenceRows([
		{ category: "meeting_reminder", channel: "email", enabled: true },
		{ category: "wiki_upstream_review", channel: "in_app", enabled: false },
		{ category: "phase_milestone", channel: "in_app", enabled: true },
	]);
	assert.deepEqual(
		rows.map((row) => [row.category, row.inApp?.enabled, row.email]),
		[["phase_milestone", true, undefined]],
	);
});
