import type * as c from "@everyfield/contracts/tasks";
import type { z } from "zod";

// The Tasks screen rules that need no React: the address, labels, due-date words, counts after a change and the
// due-date form value. The screens and the server page share them, and tests/ui/tasks runs them in node.

export type Status = z.infer<typeof c.taskStatus>;
export type Priority = z.infer<typeof c.priority>;
export type Category = z.infer<typeof c.category>;
export type Due = z.infer<typeof c.due>;
export type DueInput = z.infer<typeof c.dueInput>;
export type TaskItem = z.infer<typeof c.taskItem>;
export type TaskDetail = z.infer<typeof c.taskDetail>;
export type TaskCounts = z.infer<typeof c.taskCounts>;
export type TaskHistory = z.infer<typeof c.statusHistory>;
export type TaskError = c.TaskError;
/** A confirmed write: the task as saved, its audit record's ID (the history entry) and whether anything changed. */
export type Saved = { task: TaskDetail; receiptId: string; changed: boolean };

/** A screen action's answer. "lost" means no answer arrived: the same request key may be sent again. */
export type Outcome<T> =
	| { status: "ok"; value: T }
	| { status: "refused"; code: TaskError["code"] | "access_denied"; error?: TaskError }
	| { status: "lost" };

export const STATUSES = ["not_started", "in_progress", "blocked", "complete", "no_longer_needed"] as const;
export const OPEN_STATUSES = ["not_started", "in_progress", "blocked"] as const satisfies readonly Status[];
export const PRIORITIES = ["urgent", "high", "medium", "low"] as const;
export const CATEGORIES = [
	"general",
	"follow_up",
	"vision_meeting",
	"launch_prep",
	"administrative",
	"ministry_team",
	"training",
	"promotion",
	"facilities",
	"recurring",
] as const;
export const RELATIONS = ["person", "meeting", "team", "none"] as const;
export const DUE_KINDS = ["local_date", "resolved_instant", "undated"] as const;
export const SORTS = ["due", "priority", "status", "title", "created"] as const;
export const VIEWS = ["my", "all"] as const;

export const STATUS_LABEL: Record<Status, string> = {
	not_started: "Not started",
	in_progress: "In progress",
	blocked: "Blocked",
	complete: "Done",
	no_longer_needed: "No longer needed",
};
export const PRIORITY_LABEL: Record<Priority, string> = { urgent: "Urgent", high: "High", medium: "Medium", low: "Low" };
export const CATEGORY_LABEL: Record<Category, string> = {
	general: "General",
	follow_up: "Follow-up",
	vision_meeting: "Vision meeting",
	launch_prep: "Launch prep",
	administrative: "Administrative",
	ministry_team: "Ministry team",
	training: "Training",
	promotion: "Promotion",
	facilities: "Facilities",
	recurring: "Recurring",
};
export const RELATION_LABEL = { person: "A person", meeting: "A meeting", team: "A team", none: "Nothing" } as const;
export const DUE_KIND_LABEL = {
	local_date: "Due on a day",
	resolved_instant: "Due at a time",
	undated: "No due date",
} as const;
export const SORT_LABEL: Record<(typeof SORTS)[number], string> = {
	due: "Due date",
	priority: "Priority",
	status: "Status",
	title: "Title",
	created: "Date added",
};

export const isSettled = (s: Status) => s === "complete" || s === "no_longer_needed";

// ---------------------------------------------------------------------------------------------------------------
// The address. View, search, filters, sort and page live in the URL (D67). A filter change goes back to page one and
// keeps the sibling filters. Values outside the closed lists are ignored. With no status in the address the list
// shows open tasks; `status=any` shows every status.

export type TaskQuery = {
	view: (typeof VIEWS)[number];
	search: string;
	statuses: Status[];
	priorities: Priority[];
	categories: Category[];
	relation: (typeof RELATIONS)[number] | "any";
	due: (typeof DUE_KINDS)[number] | "any";
	sort: (typeof SORTS)[number];
	direction: "asc" | "desc";
	page: number;
};
export const PAGE_SIZE = 50;
export const DEFAULT_QUERY: TaskQuery = {
	view: "my",
	search: "",
	statuses: [...OPEN_STATUSES],
	priorities: [],
	categories: [],
	relation: "any",
	due: "any",
	sort: "due",
	direction: "asc",
	page: 1,
};

const oneOf = <T extends string>(list: readonly T[], v: string | null): T | undefined =>
	list.find((x) => x === v) as T | undefined;
const manyOf = <T extends string>(list: readonly T[], vs: string[]): T[] => list.filter((x) => vs.includes(x));
const sameSet = (a: readonly string[], b: readonly string[]) => a.length === b.length && a.every((x) => b.includes(x));

export function parseQuery(p: URLSearchParams): TaskQuery {
	const raw = p.getAll("status"),
		statuses = manyOf(STATUSES, raw);
	const page = Number(p.get("page"));
	return {
		view: oneOf(VIEWS, p.get("view")) ?? DEFAULT_QUERY.view,
		search: (p.get("q") ?? "").trim().slice(0, 200),
		statuses: statuses.length > 0 ? statuses : raw.includes("any") ? [] : [...OPEN_STATUSES],
		priorities: manyOf(PRIORITIES, p.getAll("priority")),
		categories: manyOf(CATEGORIES, p.getAll("category")),
		relation: oneOf(RELATIONS, p.get("relation")) ?? "any",
		due: oneOf(DUE_KINDS, p.get("due")) ?? "any",
		sort: oneOf(SORTS, p.get("sort")) ?? "due",
		direction: p.get("dir") === "desc" ? "desc" : "asc",
		page: Number.isInteger(page) && page >= 1 && page <= 100_000 ? page : 1,
	};
}

/** The address for a query, without the defaults; "" for the default list. */
export function querySearch(q: TaskQuery): string {
	const p = new URLSearchParams();
	if (q.view !== DEFAULT_QUERY.view) p.set("view", q.view);
	if (q.search) p.set("q", q.search);
	if (q.statuses.length === 0) p.set("status", "any");
	else if (!sameSet(q.statuses, OPEN_STATUSES)) for (const s of q.statuses) p.append("status", s);
	for (const v of q.priorities) p.append("priority", v);
	for (const v of q.categories) p.append("category", v);
	if (q.relation !== "any") p.set("relation", q.relation);
	if (q.due !== "any") p.set("due", q.due);
	if (q.sort !== "due") p.set("sort", q.sort);
	if (q.direction !== "asc") p.set("dir", q.direction);
	if (q.page > 1) p.set("page", String(q.page));
	const s = p.toString();
	return s ? `?${s}` : "";
}

/** A filter, search, view or sort change: the other filters stay and the list goes back to page one. */
export const withFilters = (q: TaskQuery, patch: Partial<Omit<TaskQuery, "page">>): TaskQuery => ({
	...q,
	...patch,
	page: 1,
});
export const isFiltered = (q: TaskQuery) =>
	q.search !== "" ||
	!sameSet(q.statuses, OPEN_STATUSES) ||
	q.priorities.length > 0 ||
	q.categories.length > 0 ||
	q.relation !== "any" ||
	q.due !== "any";
export const clearFilters = (q: TaskQuery): TaskQuery =>
	withFilters(q, {
		search: "",
		statuses: [...OPEN_STATUSES],
		priorities: [],
		categories: [],
		relation: "any",
		due: "any",
	});

/** The tasks.count request for the query: the same scope as the list. */
export function countRequest(q: TaskQuery) {
	return {
		view: q.view,
		...(q.search ? { search: q.search } : {}),
		statuses: q.statuses,
		priorities: q.priorities,
		categories: q.categories,
		relation: q.relation,
		due: q.due,
	};
}
/** The tasks.list request for the query. */
export const listRequest = (q: TaskQuery) => ({
	...countRequest(q),
	sort: q.sort,
	direction: q.direction,
	limit: PAGE_SIZE,
	page: q.page,
});
export const pageCount = (total: number) => Math.max(1, Math.ceil(total / PAGE_SIZE));
export function rangeText(q: TaskQuery, shown: number, total: number): string {
	if (total === 0) return "No tasks";
	const first = (q.page - 1) * PAGE_SIZE + 1;
	return shown === total ? `${total} ${total === 1 ? "task" : "tasks"}` : `${first}–${first + shown - 1} of ${total} tasks`;
}

// ---------------------------------------------------------------------------------------------------------------
// Due dates. A date-only task shows its church-local day; a deadline shows the wall time it was entered in the church
// zone. Both are written in the church's own terms, so no browser time zone changes them.

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
/** "Tue Oct 14" for a church-local date, with the year when it is not `year`. */
export function dayText(date: string, year?: number): string {
	const [y, m, d] = date.split("-").map(Number) as [number, number, number];
	const weekday = WEEKDAYS[new Date(Date.UTC(y, m - 1, d)).getUTCDay()];
	return `${weekday} ${MONTHS[m - 1]} ${d}${year !== undefined && y !== year ? `, ${y}` : ""}`;
}
/** "6:30 PM" for a wall time "18:30:00". */
export function timeText(time: string): string {
	const [h, m] = time.split(":").map(Number) as [number, number];
	return `${h % 12 === 0 ? 12 : h % 12}:${String(m).padStart(2, "0")} ${h < 12 ? "AM" : "PM"}`;
}
/** The due words for a row: "Tue Oct 14", "Tue Oct 14 · 6:30 PM" or null when undated. */
export function dueText(due: Due, year?: number): string | null {
	if (due.kind === "undated") return null;
	if (due.kind === "local_date") return dayText(due.date, year);
	return `${dayText(due.local.slice(0, 10), year)} · ${timeText(due.local.slice(11))}`;
}
/** "UTC−5" or "UTC+5:30" for an offset in seconds. */
export function offsetText(seconds: number): string {
	const sign = seconds < 0 ? "−" : "+";
	const abs = Math.abs(seconds),
		h = Math.floor(abs / 3600),
		m = Math.round((abs % 3600) / 60);
	return `UTC${sign}${h}${m ? `:${String(m).padStart(2, "0")}` : ""}`;
}

/** The due-date form value. `offsetSeconds` is the occurrence chosen for a time the clocks repeat. */
export type DueDraft = { kind: "undated" | "local_date" | "resolved_instant"; date: string; time: string; offsetSeconds?: number };
export function dueDraftOf(due: Due): DueDraft {
	if (due.kind === "undated") return { kind: "undated", date: "", time: "" };
	if (due.kind === "local_date") return { kind: "local_date", date: due.date, time: "" };
	return { kind: "resolved_instant", date: due.local.slice(0, 10), time: due.local.slice(11, 16), offsetSeconds: due.offsetSeconds };
}
/** The contract's due input, or a field problem the form shows before any request. */
export function dueInputOf(d: DueDraft): { ok: true; due: DueInput } | { ok: false; field: "date" | "time" } {
	if (d.kind === "undated") return { ok: true, due: { kind: "undated" } };
	if (!/^\d{4}-\d{2}-\d{2}$/.test(d.date)) return { ok: false, field: "date" };
	if (d.kind === "local_date") return { ok: true, due: { kind: "local_date", date: d.date as never } };
	if (!/^\d{2}:\d{2}$/.test(d.time)) return { ok: false, field: "time" };
	return {
		ok: true,
		due: {
			kind: "resolved_instant",
			local: `${d.date}T${d.time}:00` as never,
			...(d.offsetSeconds !== undefined ? { offsetSeconds: d.offsetSeconds } : {}),
		},
	};
}
export const sameDue = (a: DueDraft, b: DueDraft) =>
	a.kind === b.kind &&
	(a.kind === "undated" ||
		(a.date === b.date && (a.kind === "local_date" || (a.time === b.time && a.offsetSeconds === b.offsetSeconds))));

// ---------------------------------------------------------------------------------------------------------------
// Counts after a confirmed change. The count is the list's own scope, so a change moves one task between tallies
// instead of reading the counts again. A task that leaves the scope (deleted) only leaves.

type Tallied = Pick<TaskItem, "status" | "priority" | "category">;
function bump<V extends string>(tally: { value: V; count: number }[], value: V, by: number) {
	const found = tally.some((t) => t.value === value);
	const next = found ? tally.map((t) => (t.value === value ? { ...t, count: t.count + by } : t)) : [...tally, { value, count: by }];
	return next.filter((t) => t.count > 0);
}
export function countsAfter(counts: TaskCounts, before: Tallied | null, after: Tallied | null): TaskCounts {
	let next = counts;
	for (const [t, by] of [
		[before, -1],
		[after, 1],
	] as const) {
		if (!t) continue;
		next = {
			...next,
			topLevelTotal: next.topLevelTotal + by,
			byStatus: bump(next.byStatus, t.status, by),
			byPriority: bump(next.byPriority, t.priority, by),
			byCategory: bump(next.byCategory, t.category, by),
		};
	}
	return next;
}
export const tallyOf = <V extends string>(tally: { value: V; count: number }[], value: V) =>
	tally.find((t) => t.value === value)?.count ?? 0;

// ---------------------------------------------------------------------------------------------------------------
// Groups. When the list is ordered by due date, open tasks group into Overdue, Upcoming and No due date, in the
// server's order; overdue is the server's own answer in the church zone (REQ-TSK-018).

export type Group = { key: "overdue" | "upcoming" | "undated" | "settled" | "all"; items: TaskItem[] };
export function groupsOf(items: TaskItem[], sort: TaskQuery["sort"]): Group[] {
	if (sort !== "due") return [{ key: "all", items }];
	const by: Record<Group["key"], TaskItem[]> = { overdue: [], upcoming: [], undated: [], settled: [], all: [] };
	for (const t of items) {
		if (isSettled(t.status)) by.settled.push(t);
		else if (t.overdue) by.overdue.push(t);
		else if (t.due.kind === "undated") by.undated.push(t);
		else by.upcoming.push(t);
	}
	return (["overdue", "upcoming", "undated", "settled"] as const)
		.map((key) => ({ key, items: by[key] }))
		.filter((g) => g.items.length > 0);
}

// ---------------------------------------------------------------------------------------------------------------
// Words for refusals. Nothing here reveals another church's records.

export function problemText(code: Outcome<unknown>["status"] | TaskError["code"] | "access_denied"): string {
	switch (code) {
		case "conflict":
			return "This task changed while you were working. We loaded the latest version; check it and try again.";
		case "lost":
			return "We did not hear back from the server. Try again; it will not save twice.";
		case "invalid_input":
			return "Some details are not valid. Check them and try again.";
		case "invalid_subject":
			return "That person, meeting, team or assignee cannot be chosen here. Pick another one.";
		case "protected_source":
			return "This task was created by a meeting, so its category and link stay as they are.";
		case "nonexistent_local_time":
			return "That time does not exist on this day because the clocks move forward. Pick another time.";
		case "ambiguous_local_time":
			return "That time happens twice on this day because the clocks move back. Choose which one you mean.";
		case "open_successor":
			return "A later occurrence of this task is still open. Close that one first, or work on it instead.";
		case "temporary":
			return "The server is busy. Try again in a moment.";
		case "unavailable":
			return "This task is no longer here, or your seat cannot change it. Reload the page.";
		default:
			return "You cannot make this change. Your seat may have changed; reload the page.";
	}
}

// ---------------------------------------------------------------------------------------------------------------
// Request keys. One key per action slot ("status:<task>", "edit:<task>", "create"). A retry after a lost answer sends
// the same payload with the same key, so the server replays a write that did commit. A refusal, a success or a
// changed payload starts a new key.

export class RequestKeys {
	#keys = new Map<string, { key: string; payload: string }>();
	readonly #fresh: () => string;
	constructor(fresh: () => string = () => crypto.randomUUID()) {
		this.#fresh = fresh;
	}
	for(slot: string, payload: unknown): string {
		const p = JSON.stringify(payload);
		const known = this.#keys.get(slot);
		if (known && known.payload === p) return known.key;
		const key = this.#fresh();
		this.#keys.set(slot, { key, payload: p });
		return key;
	}
	settle(slot: string, outcome: Outcome<unknown>) {
		if (outcome.status !== "lost") this.#keys.delete(slot);
	}
}
