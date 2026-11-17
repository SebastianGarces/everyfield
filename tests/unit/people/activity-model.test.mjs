import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { test } from "node:test";
import { describe } from "../../../apps/web/src/features/people/activity.ts";

const web = createRequire(new URL("../../../apps/web/package.json", import.meta.url));
const { UserMultiple02Icon } = web("@hugeicons/core-free-icons");

const entry = (action) => ({
	id: "1c7d4f2a-3b8e-4d4c-8a6f-2e3d4c5b6a71",
	occurredAt: "2026-11-01T15:00:00.000Z",
	recordedAt: "2026-11-01T15:00:00.000Z",
	actor: { kind: "current_account", accountId: "5b0f6c1e-2a7d-4c3b-9f5e-1d2c3b4a5f60" },
	kind: "activity",
	action,
	withPerson: { id: "7d2e4a1b-3c8f-4e5d-9a6b-2f3e4d5c6b72", displayName: "Iris Existing" },
});

test("a dismissal and its restore each name the other person in their own words", () => {
	assert.deepEqual(describe(entry("duplicate_dismissed"), "You"), {
		title: "Marked not a duplicate of Iris Existing",
		icon: UserMultiple02Icon,
		tone: "violet",
	});
	assert.deepEqual(describe(entry("duplicate_restored"), "You"), {
		title: "Restored as a possible duplicate of Iris Existing",
		icon: UserMultiple02Icon,
		tone: "violet",
	});
});
