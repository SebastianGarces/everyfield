// Tasks screen rules (WP-024/ui) that a silent break would turn into a wrong list, a double write or a deadline saved
// at the wrong instant. They run in node against the real module the screens use; no browser.
//   AC:TARGET-TSK-001 INV-url (D67): view, search, filters, sort and page live in the address; a change goes back to
//     page one and keeps the sibling filters; values outside the closed lists are ignored.
//   INV-request-key: a retry after a lost answer reuses the key (the server replays); a refusal, a success or a changed
//     payload gets a new key.
//   AC:B03-008 AC:B03-009 AC:TARGET-TSK-018: a deadline is sent as church-local wall time, with the chosen offset only
//     after the person picks one occurrence of a repeated time; a missing day or time is caught before any request.
//   INV-counts: a confirmed change moves one task between tallies; a deleted task only leaves.
import assert from "node:assert/strict";
import { test } from "node:test";
import {
	countsAfter,
	dueInputOf,
	listRequest,
	parseQuery,
	querySearch,
	RequestKeys,
	withFilters,
} from "../../../apps/web/src/features/tasks/model.ts";

const parse = (s) => parseQuery(new URLSearchParams(s));

test("AC:TARGET-TSK-001 INV-url: filters live in the address, reset the page and keep their siblings", () => {
	const q = parse("view=all&q=call&status=blocked&priority=urgent&category=follow_up&relation=person&sort=title&page=3");
	assert.deepEqual(listRequest(q), {
		view: "all",
		search: "call",
		statuses: ["blocked"],
		priorities: ["urgent"],
		categories: ["follow_up"],
		relation: "person",
		due: "any",
		sort: "title",
		direction: "asc",
		limit: 50,
		page: 3,
	});
	const next = withFilters(q, { priorities: ["high"] });
	assert.equal(
		querySearch(next),
		"?view=all&q=call&status=blocked&priority=high&category=follow_up&relation=person&sort=title",
	);
	// No status in the address is the open list; status=any is every status. Both survive a round trip.
	assert.deepEqual(parse("").statuses, ["not_started", "in_progress", "blocked"]);
	assert.equal(querySearch(parse("")), "");
	assert.deepEqual(parse("status=any").statuses, []);
	assert.equal(querySearch(parse("status=any")), "?status=any");
	// Values outside the closed lists are ignored rather than sent to the server.
	assert.deepEqual(listRequest(parse("view=team&status=lost&priority=x&sort=owner&page=-2&relation=facility")), {
		...listRequest(parse("")),
	});
});

test("INV-request-key: a lost answer keeps the key; a refusal, success or new payload starts a new one", () => {
	let n = 0;
	const keys = new RequestKeys(() => `k${++n}`);
	const first = keys.for("status:t1", { revision: "4", action: { kind: "complete" } });
	keys.settle("status:t1", { status: "lost" });
	assert.equal(keys.for("status:t1", { revision: "4", action: { kind: "complete" } }), first);
	assert.notEqual(keys.for("status:t1", { revision: "4", action: { kind: "reopen" } }), first);
	const third = keys.for("status:t1", { revision: "4", action: { kind: "reopen" } });
	keys.settle("status:t1", { status: "refused", code: "conflict" });
	assert.notEqual(keys.for("status:t1", { revision: "4", action: { kind: "reopen" } }), third);
	const fifth = keys.for("create", { title: "Call Kim" });
	keys.settle("create", { status: "ok", value: null });
	assert.notEqual(keys.for("create", { title: "Call Kim" }), fifth);
});

test("AC:B03-008 AC:B03-009 AC:TARGET-TSK-018: a deadline is church wall time with the chosen occurrence", () => {
	assert.deepEqual(dueInputOf({ kind: "resolved_instant", date: "2026-11-01", time: "01:30" }), {
		ok: true,
		due: { kind: "resolved_instant", local: "2026-11-01T01:30:00" },
	});
	assert.deepEqual(dueInputOf({ kind: "resolved_instant", date: "2026-11-01", time: "01:30", offsetSeconds: -21600 }), {
		ok: true,
		due: { kind: "resolved_instant", local: "2026-11-01T01:30:00", offsetSeconds: -21600 },
	});
	assert.deepEqual(dueInputOf({ kind: "local_date", date: "2026-03-08", time: "" }), {
		ok: true,
		due: { kind: "local_date", date: "2026-03-08" },
	});
	// B03-007: no day or time falls back to today or the epoch; the form asks for it.
	assert.deepEqual(dueInputOf({ kind: "local_date", date: "", time: "" }), { ok: false, field: "date" });
	assert.deepEqual(dueInputOf({ kind: "resolved_instant", date: "2026-03-08", time: "" }), { ok: false, field: "time" });
});

test("INV-counts: a confirmed change moves one task between tallies; a deleted task only leaves", () => {
	const counts = {
		topLevelTotal: 2,
		byStatus: [{ value: "not_started", count: 2 }],
		byPriority: [{ value: "medium", count: 2 }],
		byCategory: [{ value: "general", count: 2 }],
		childTaskTotal: 0,
		childTaskComplete: 0,
		completeness: "complete",
	};
	const before = { status: "not_started", priority: "medium", category: "general" };
	const done = countsAfter(counts, before, { ...before, status: "complete" });
	assert.equal(done.topLevelTotal, 2);
	assert.deepEqual(done.byStatus, [
		{ value: "not_started", count: 1 },
		{ value: "complete", count: 1 },
	]);
	const gone = countsAfter(done, { ...before, status: "complete" }, null);
	assert.equal(gone.topLevelTotal, 1);
	assert.deepEqual(gone.byStatus, [{ value: "not_started", count: 1 }]);
});
