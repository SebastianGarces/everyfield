// Settings > Notifications offers a choice only for a category something sends. Nothing writes launch milestones yet
// (D-762), so that row stays hidden even when the account has stored choices for it. No browser needed.
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
		[
			"task_due",
			"task_overdue",
			"meeting_announcement",
			"meeting_reminder",
			"planter_digest",
			"oversight_digest",
			"relationship_milestone",
			"sharing_milestone",
			"phase_milestone",
			"wiki_upstream_review",
			"scheduled_email_unsubscribe",
		],
	);
});

test("INV-notification-rows: a stored choice for launch milestones makes no row, and a sent one keeps its pairs", () => {
	const rows = preferenceRows([
		{ category: "launch_milestone", channel: "email", enabled: true },
		{ category: "relationship_milestone", channel: "in_app", enabled: true },
		{ category: "sharing_milestone", channel: "email", enabled: true },
		{ category: "meeting_reminder", channel: "email", enabled: true },
		{ category: "wiki_upstream_review", channel: "in_app", enabled: false },
		{ category: "phase_milestone", channel: "in_app", enabled: true },
	]);
	assert.deepEqual(
		rows.map((row) => [row.category, row.inApp?.enabled, row.email?.enabled]),
		[
			["meeting_reminder", undefined, true],
			["relationship_milestone", true, undefined],
			["sharing_milestone", undefined, true],
			["phase_milestone", true, undefined],
			["wiki_upstream_review", false, undefined],
		],
	);
});
