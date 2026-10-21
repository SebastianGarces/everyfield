// Tasks screen rules (WP-024/ui) that a silent break would turn into a wrong list, a double write or a deadline saved
// at the wrong instant. They run in node against the real module the screens use; no browser.
//   AC:TARGET-TSK-001 INV-url (D67): view, search, filters, sort and page live in the address; a change goes back to
//     page one and keeps the sibling filters; values outside the closed lists are ignored.
//   INV-request-key: a retry after a lost answer reuses the key (the server replays); a refusal, a success or a changed
//     payload gets a new key.
//   AC:B03-008 AC:B03-009 AC:TARGET-TSK-018: a deadline is sent as church-local wall time, with the chosen offset only
//     after the person picks one occurrence of a repeated time; a missing day or time is caught before any request.
//   INV-counts: a confirmed change moves one task between tallies; a deleted task only leaves.
//   AC:TARGET-TSK-001 INV-membership: a saved task joins the list only when it matches the query (view, search, status,
//     priority, category, link, due kind, team), as the server's scope would.
//   INV-intent: each save keeps the key and revision of its first send; a retry resends both even after other saves
//     (BUG #189 round 2: a retried lost create after another create sent a new key and saved twice).
//   INV-optimistic: changes in flight show at once (new task first, edit applied, delete hidden, status shown) and the
//     confirmed rows stand when they fall away. AC:TARGET-TSK-005 (WP-025/ui): the same holds for a task's steps: a new
//     step shows under its own task, a removed one hides and a tick shows.
import assert from "node:assert/strict";
import { test } from "node:test";
import {
	countsAfter,
	dueInputOf,
	Intent,
	listRequest,
	matches,
	NO_PENDING,
	shownRows,
	shownSteps,
	withChange,
	parseQuery,
	querySearch,
	RequestKeys,
	withFilters,
} from "../../../apps/web/src/features/tasks/model.ts";

const parse = (s) => parseQuery(new URLSearchParams(s));

test("AC:TARGET-TSK-001 INV-url: filters live in the address, reset the page and keep their siblings", () => {
	const q = parse(
		"view=all&q=call&status=blocked&priority=urgent&category=follow_up&relation=person&sort=title&page=3",
	);
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
	// The Team filter (My and All) joins the others and survives a sibling change.
	const team = "0b6c3f1e-2a7d-4c3b-9f5e-1d2c3b4a5f60";
	const withTeam = withFilters(q, { teamId: team });
	assert.equal(listRequest(withTeam).teamId, team);
	assert.equal(withFilters(withTeam, { search: "x" }).teamId, team);
	assert.equal(parse(querySearch(withTeam).slice(1)).teamId, team);
	assert.equal(parse("team=not-a-uuid").teamId, null);
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
	assert.deepEqual(dueInputOf({ kind: "resolved_instant", date: "2026-03-08", time: "" }), {
		ok: false,
		field: "time",
	});
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

test("INV-optimistic: changes in flight show at once; the confirmed rows stand when they fall away", () => {
	const row = (id, extra = {}) => ({ id, title: id, status: "not_started", ...extra });
	const items = [row("a"), row("b"), row("c")];
	let p = withChange(NO_PENDING, { kind: "add", row: row("pending:n", { title: "New" }) });
	p = withChange(p, { kind: "row", id: "a", row: row("a", { title: "Renamed" }) });
	p = withChange(p, { kind: "row", id: "b", row: null });
	p = withChange(p, { kind: "status", id: "c", status: "complete" });
	assert.deepEqual(
		shownRows(items, p).map((r) => [r.id, r.title, r.status]),
		[
			["pending:n", "New", "not_started"],
			["a", "Renamed", "not_started"],
			["c", "c", "complete"],
		],
	);
	assert.deepEqual(shownRows(items, NO_PENDING), items);
	// Steps (AC:TARGET-TSK-005): one parent's changes never show under another parent.
	const steps = [row("s1"), row("s2"), row("s3")];
	let q = withChange(NO_PENDING, { kind: "step", parentId: "p", step: row("pending:s", { title: "Bring napkins" }) });
	q = withChange(q, { kind: "step", parentId: "other", step: row("pending:o") });
	q = withChange(q, { kind: "row", id: "s2", row: null });
	q = withChange(q, { kind: "status", id: "s3", status: "complete" });
	assert.deepEqual(
		shownSteps(steps, "p", q).map((s) => [s.id, s.title, s.status]),
		[
			["s1", "s1", "not_started"],
			["s3", "s3", "complete"],
			["pending:s", "Bring napkins", "not_started"],
		],
	);
	assert.deepEqual(shownSteps(steps, "p", NO_PENDING), steps);
});

test("AC:TARGET-TSK-001 INV-membership: a saved task joins the list only when it matches the query", () => {
	const me = "a1",
		ruth = "r1";
	const task = (extra = {}) => ({
		id: "t",
		title: "Order chairs",
		status: "not_started",
		priority: "medium",
		category: "general",
		due: { kind: "undated" },
		assignee: { accountId: me, displayName: "Me" },
		relation: null,
		parentId: null,
		deleted: false,
		...extra,
	});
	const q = parse("q=order&status=any");
	assert.equal(matches(q, task(), me), true);
	assert.equal(
		matches(q, task({ assignee: { accountId: ruth, displayName: "Ruth" } }), me),
		false,
		"Mine excludes Ruth's task",
	);
	assert.equal(matches(parse("view=all&q=order"), task({ assignee: null }), me), true);
	assert.equal(matches(parse("view=all&q=order"), task({ title: "Call James" }), me), false, "search");
	assert.equal(matches(parse("view=all"), task({ status: "complete" }), me), false, "open statuses by default");
	assert.equal(matches(parse("view=all&priority=urgent"), task(), me), false, "priority");
	assert.equal(
		matches(parse("view=all&relation=none"), task({ relation: { kind: "team", id: "x", label: "T" } }), me),
		false,
	);
	const team = "0b6c3f1e-2a7d-4c3b-9f5e-1d2c3b4a5f60";
	assert.equal(
		matches(parse(`view=all&team=${team}`), task({ relation: { kind: "team", id: team, label: "T" } }), me),
		true,
	);
	assert.equal(matches(parse(`view=all&team=${team}`), task(), me), false, "team");
	assert.equal(matches(parse("view=all&due=local_date"), task(), me), false, "due kind");
});

test("INV-intent: a retry resends its own first key and revision, whatever other saves happened since", () => {
	let n = 0;
	const fresh = () => `k${++n}`;
	const a = new Intent(fresh);
	const first = a.send(() => "4");
	const b = new Intent(fresh);
	assert.notEqual(b.send(() => "5").key, first.key, "another save has its own key");
	assert.deepEqual(
		a.send(() => "9"),
		{ key: first.key, basis: "4" },
		"the retry of A is identical to its first send",
	);
});
