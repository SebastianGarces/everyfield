import assert from "node:assert/strict";
import { test } from "node:test";
import { instant } from "../../../packages/contracts/src/common/time.ts";
import type { FeedItem } from "../../../apps/web/src/features/notifications/model.ts";
import type { StandingMark } from "../../../apps/web/src/features/notifications/account.store.ts";

const { createAccountStore } = await import("../../../apps/web/src/features/notifications/account.store.ts");
const { withStandingMarks } = await import("../../../apps/web/src/features/notifications/model.ts");

const item = (id: string, at: string): FeedItem => ({
	id,
	category: "scheduled_email_unsubscribe",
	title: `Notice ${id}`,
	body: null,
	eligibleAt: instant.parse(at),
	read: false,
	dueLocalDate: null,
	overdue: false,
	subject: null,
});

const early = item("early", "2026-11-10T09:00:00.000Z");
const middle = item("middle", "2026-11-11T09:00:00.000Z");
const late = item("late", "2026-11-12T09:00:00.000Z");
const elsewhere = item("elsewhere", "2026-11-09T09:00:00.000Z");
const fresh = item("fresh", "2026-11-13T09:00:00.000Z");
const all = [fresh, late, middle, early, elsewhere];

const mark = (items: readonly FeedItem[], cutoff: string | null = null): StandingMark => ({
	token: {},
	ids: new Set(items.map((i) => i.id)),
	cutoff,
	eligible: new Map(items.map((i) => [i.id, i.eligibleAt])),
});
const readElsewhere = (ids: string[]): StandingMark => ({
	token: {},
	ids: new Set(ids),
	cutoff: null,
	eligible: new Map(),
});

const unpruned = (marks: readonly StandingMark[]) => {
	const confirmedIds = new Set(marks.flatMap((m) => [...m.ids]));
	const cutoffs = marks.map((m) => m.cutoff).filter((c): c is string => c !== null);
	const cutoff = cutoffs.length ? cutoffs.reduce((a, b) => (Date.parse(a) >= Date.parse(b) ? a : b)) : null;
	return [{ ids: confirmedIds, cutoff }];
};

const confirmAll = (marks: readonly StandingMark[]) => {
	const store = createAccountStore("account");
	const { stand, confirm } = store.getState().actions;
	for (const m of marks) stand(m);
	for (const m of marks) confirm(m.token);
	return store.getState().marks;
};

test("a confirmed mark-all drops the ids its cutoff covers and keeps the rest", () => {
	const marks = confirmAll([
		mark([early]),
		mark([late]),
		readElsewhere(["elsewhere"]),
		mark([middle, early], middle.eligibleAt),
	]);
	assert.equal(marks.length, 1);
	const [only] = marks;
	assert.ok(only);
	assert.deepEqual([...only.ids].sort(), ["elsewhere", "late"]);
	assert.equal(only.cutoff, middle.eligibleAt);
	assert.deepEqual([...only.eligible.keys()], ["late"]);
});

const cases: [string, StandingMark[]][] = [
	["items before the cutoff", [mark([early]), mark([middle]), mark([middle, early], middle.eligibleAt)]],
	["items after the cutoff", [mark([late]), mark([fresh]), mark([early], early.eligibleAt)]],
	["items read elsewhere", [readElsewhere(["elsewhere", "late"]), mark([middle], middle.eligibleAt)]],
	[
		"a later cutoff confirming after an earlier one",
		[mark([early], early.eligibleAt), mark([fresh]), mark([middle, late], late.eligibleAt)],
	],
];

for (const [name, marks] of cases) {
	test(`pruning leaves what the reader sees unchanged: ${name}`, () => {
		const after = confirmAll(marks);
		for (const items of [
			all,
			all.slice(1),
			all.slice(2, 4),
			all.map((i) => (i.id === "middle" ? { ...i, read: true } : i)),
		]) {
			assert.deepEqual(withStandingMarks(items, after), withStandingMarks(items, unpruned(marks)));
		}
	});
}
