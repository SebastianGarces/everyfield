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
export type Step = TaskDetail["checklistItems"][number];
export type Rule = z.infer<typeof c.recurrenceRule>;
export type Frequency = Rule["frequency"];
export type Prerequisites = z.infer<typeof c.prerequisiteList>;
export type Prerequisite = Prerequisites["items"][number];
export type Candidate = z.infer<typeof c.prerequisiteCandidates>["items"][number];
export type Occurrence = z.infer<typeof c.openOccurrence>;
export type BulkResult = z.infer<typeof c.bulkResult>;
export type BulkOutcome = z.infer<typeof c.bulkOutcome>;
/**
 * A confirmed write: the task as saved, its audit record's ID (the history entry), whether anything changed and, for a
 * completed recurring task, the next occurrence it created.
 */
export type Saved = { task: TaskDetail; receiptId: string; changed: boolean; successor?: TaskDetail | null };

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
export const PRIORITY_LABEL: Record<Priority, string> = {
	urgent: "Urgent",
	high: "High",
	medium: "Medium",
	low: "Low",
};
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

/** Why a task panel has no first history page. */
export type HistoryProblem = "unrecorded" | "failed";
/** A refusal as "unavailable" means no status change is recorded; any other miss is a failed read. */
export const historyProblem = (r: Outcome<unknown>): HistoryProblem | null =>
	r.status === "ok" ? null : r.status === "refused" && r.code === "unavailable" ? "unrecorded" : "failed";

export const isSettled = (s: Status) => s === "complete" || s === "no_longer_needed";

/**
 * Who owns a task or step, as text. The owner's own name shows, also for the signed-in person (never "You"). A name
 * that is empty reads the same everywhere: the data cannot tell a former member from a seat with no name, so only
 * the signed-in person, who is a current seat, gets "Unnamed member"; every other empty name reads "A former member".
 */
export function ownerLabel(owner: { accountId: string; displayName: string } | null, you: string): string {
	if (!owner) return "Needs owner";
	const name = owner.displayName.trim();
	if (name) return name;
	return owner.accountId === you ? "Unnamed member" : "A former member";
}

/** What the bulk bar offers for the selected tasks' current statuses (REQ-TSK-008: only open tasks complete or move). */
export type BulkActions = { kind: "open" | "settled" | "mixed"; settled: number };

export function bulkActions(statuses: readonly Status[]): BulkActions {
	const settled = statuses.filter(isSettled).length;
	return { kind: settled === 0 ? "open" : settled === statuses.length ? "settled" : "mixed", settled };
}

// ---------------------------------------------------------------------------------------------------------------
// Task structure (REQ-TSK-005 to 008): steps, what a task waits for, repeats and bulk changes.

export const FREQUENCIES = ["daily", "weekly", "biweekly", "monthly", "quarterly", "yearly"] as const;
export const FREQUENCY_LABEL: Record<Frequency, string> = {
	daily: "Every day",
	weekly: "Every week",
	biweekly: "Every two weeks",
	monthly: "Every month",
	quarterly: "Every three months",
	yearly: "Every year",
};
/** "Every week · 9:00 AM · until Thu Dec 31", or null when the task does not repeat. */
export function repeatText(rule: Pick<Rule, "frequency" | "until" | "localTime"> | null, year?: number): string | null {
	if (!rule) return null;
	return [
		FREQUENCY_LABEL[rule.frequency],
		rule.localTime ? timeText(rule.localTime) : null,
		rule.until ? `until ${dayText(rule.until, year)}` : null,
	]
		.filter(Boolean)
		.join(" · ");
}
/** "Blocked by 2 tasks": the advisory badge from open prerequisites, never the manual Blocked status. */
export const blockedText = (open: number) => `Blocked by ${open} ${open === 1 ? "task" : "tasks"}`;
/** Whether a prerequisite still holds its task back: a deleted, done or no-longer-needed one does not. */
export const blocks = (p: Pick<Prerequisite, "status" | "deleted">) => !p.deleted && !isSettled(p.status);

/** A task that changed whether it holds others back: done, no longer needed, deleted, or reopened. */
export type Blocker = { id: string; status: Status; deleted: boolean };
/**
 * A waiting task's prerequisites after some of them changed, with how many still hold it back, or null when none of
 * the changed tasks is among them (REQ-TSK-006).
 */
export function withBlockers(items: readonly Prerequisite[], changed: readonly Blocker[]) {
	const by = new Map(changed.map((c) => [c.id, c]));
	if (!items.some((p) => by.has(p.id))) return null;
	const next = items.map((p) => {
		const c = by.get(p.id);
		if (!c) return p;
		const q = { ...p, status: c.status, deleted: p.deleted || c.deleted };
		return { ...q, blocking: blocks(q) };
	});
	return { items: next, open: next.filter(blocks).length };
}

/**
 * The page's "Blocked by" badge reads (REQ-TSK-006). Only the newest read for the list still on screen applies, also
 * when it failed: a newer read or a new list (search, filters, page) ends every earlier read and its retries. Opening
 * a task panel adds `task` to the address but does not change the list.
 */
export class BadgeReads {
	#newest = 0;
	start(search: string) {
		return { n: ++this.#newest, scope: listScopeOf(search) };
	}
	/** A new list ends every read of the old one. */
	end() {
		this.#newest++;
	}
	applies(read: { n: number; scope: string }, search: string) {
		return read.n === this.#newest && listScopeOf(search) === read.scope;
	}
}
const listScopeOf = (search: string) => {
	const p = new URLSearchParams(search);
	p.delete("task");
	return p.toString();
};

/** Why one task of a bulk change did not change, in words. The same request again changes nothing twice. */
export function bulkOutcomeText(outcome: BulkOutcome, kind: "complete" | "reschedule"): string {
	switch (outcome) {
		case "changed":
			return kind === "complete" ? "Done" : "Rescheduled";
		case "noop":
			return kind === "complete" ? "It was already done." : "It already had that due date.";
		case "closed":
			return kind === "complete"
				? "It was closed as no longer needed, so it was not marked done."
				: "It is closed, so its due date stays.";
		case "deleted":
			return "Someone deleted it.";
		case "stale":
			return "It changed after you selected it. We loaded the latest version; check it and try again.";
		case "unauthorized":
			return "Your seat cannot change it.";
		case "ineligible":
			return "It is a checklist step, and steps have no due date.";
		default:
			return "We could not find it. Reload the page.";
	}
}

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
	/** One church team; a team the church does not have matches no task (the server decides). */
	teamId: string | null;
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
	teamId: null,
	sort: "due",
	direction: "asc",
	page: 1,
};

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
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
		teamId: UUID.test(p.get("team") ?? "") ? p.get("team")!.toLowerCase() : null,
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
	if (q.teamId) p.set("team", q.teamId);
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
	q.due !== "any" ||
	q.teamId !== null;
export const clearFilters = (q: TaskQuery): TaskQuery =>
	withFilters(q, {
		search: "",
		statuses: [...OPEN_STATUSES],
		priorities: [],
		categories: [],
		relation: "any",
		due: "any",
		teamId: null,
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
		...(q.teamId ? { teamId: q.teamId } : {}),
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
	return shown === total
		? `${total} ${total === 1 ? "task" : "tasks"}`
		: `${first}–${first + shown - 1} of ${total} tasks`;
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
export type DueDraft = {
	kind: "undated" | "local_date" | "resolved_instant";
	date: string;
	time: string;
	offsetSeconds?: number;
};
export function dueDraftOf(due: Due): DueDraft {
	if (due.kind === "undated") return { kind: "undated", date: "", time: "" };
	if (due.kind === "local_date") return { kind: "local_date", date: due.date, time: "" };
	return {
		kind: "resolved_instant",
		date: due.local.slice(0, 10),
		time: due.local.slice(11, 16),
		offsetSeconds: due.offsetSeconds,
	};
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
/**
 * Whether a due date the screen sets before the server answers is already past. A day is past when it is before today
 * in this browser; the server's own answer in the church zone replaces it on the next read.
 */
export function previewOverdue(due: DueInput, today = new Date().toLocaleDateString("en-CA")): boolean | null {
	if (due.kind === "undated") return null;
	if (due.kind === "local_date") return due.date < today;
	return null;
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
	const next = found
		? tally.map((t) => (t.value === value ? { ...t, count: t.count + by } : t))
		: [...tally, { value, count: by }];
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
		case "dependency_cycle":
			return "One of these tasks already waits for this one, directly or through other tasks. Remove it and save again.";
		case "temporary":
			return "The server is busy. Try again in a moment.";
		case "unavailable":
			return "This task is no longer here, or your seat cannot change it. Reload the page.";
		default:
			return "You cannot make this change. Your seat may have changed; reload the page.";
	}
}

// ---------------------------------------------------------------------------------------------------------------
// Changes in flight. Each one shows at once and falls away when its write settles; the confirmed answer then stands in
// the rows (patterns.md, optimistic updates). A new task waits under a temporary ID until the server names it.

export type Pending = {
	status: Readonly<Record<string, Status>>;
	/** A row as it will be after an edit, or null for a row being deleted. A step being removed is null here too. */
	rows: Readonly<Record<string, TaskItem | null>>;
	added: readonly TaskItem[];
	/** New steps by parent, shown under it until the server names them. */
	steps: Readonly<Record<string, readonly Step[]>>;
	/** A task's panel facts as they will be: its repeat rule and what it waits for. */
	panel: Readonly<Record<string, Partial<Panel>>>;
};
/** What the task panel shows beyond the task itself. */
export type Panel = { recurrence: TaskDetail["recurrence"]; prerequisites: Prerequisite[] };
export type Change =
	| { kind: "status"; id: string; status: Status }
	| { kind: "row"; id: string; row: TaskItem | null }
	| { kind: "add"; row: TaskItem }
	| { kind: "step"; parentId: string; step: Step }
	| { kind: "panel"; id: string; panel: Partial<Panel> };
export const NO_PENDING: Pending = { status: {}, rows: {}, added: [], steps: {}, panel: {} };
export const PENDING_PREFIX = "pending:";
export function withChange(p: Pending, c: Change): Pending {
	if (c.kind === "status") return { ...p, status: { ...p.status, [c.id]: c.status } };
	if (c.kind === "row") return { ...p, rows: { ...p.rows, [c.id]: c.row } };
	if (c.kind === "step") return { ...p, steps: { ...p.steps, [c.parentId]: [...(p.steps[c.parentId] ?? []), c.step] } };
	if (c.kind === "panel") return { ...p, panel: { ...p.panel, [c.id]: { ...p.panel[c.id], ...c.panel } } };
	return { ...p, added: [c.row, ...p.added] };
}
/** A parent's steps as the person sees them: saved ones with removals hidden and ticks shown, then new ones. */
export function shownSteps(saved: readonly Step[], parentId: string, p: Pending): Step[] {
	return [...saved, ...(p.steps[parentId] ?? [])]
		.filter((s) => !(s.id in p.rows && p.rows[s.id] === null))
		.map((s) => (p.status[s.id] ? { ...s, status: p.status[s.id]! } : s));
}
/** The rows as the person sees them: new tasks first, edits applied, deletes hidden, statuses in flight shown. */
export function shownRows(items: readonly TaskItem[], p: Pending): TaskItem[] {
	return [...p.added, ...items].flatMap((r) => {
		const row = r.id in p.rows ? p.rows[r.id] : r;
		if (!row) return [];
		const status = p.status[r.id];
		return [status ? { ...row, status } : row];
	});
}

/**
 * Whether a task belongs in the list the query shows, by the same rules as the server's scope: view, title search,
 * status, priority, category, link, due kind and team. A saved task that does not belong stays out of the rows and the
 * counts.
 */
export function matches(q: TaskQuery, t: TaskItem, you: string): boolean {
	if (t.deleted || t.parentId) return false;
	if (q.view === "my" && t.assignee?.accountId !== you) return false;
	if (q.search && !t.title.toLowerCase().includes(q.search.toLowerCase())) return false;
	if (q.statuses.length && !q.statuses.includes(t.status)) return false;
	if (q.priorities.length && !q.priorities.includes(t.priority)) return false;
	if (q.categories.length && !q.categories.includes(t.category)) return false;
	if (q.relation === "none" ? t.relation !== null : q.relation !== "any" && t.relation?.kind !== q.relation)
		return false;
	if (q.due !== "any" && t.due.kind !== q.due) return false;
	if (q.teamId && !(t.relation?.kind === "team" && t.relation.id === q.teamId)) return false;
	return true;
}

/**
 * A refused form's values on top of a newer copy of the record (C58, R4-2): a field the person changed keeps their
 * value; a field they did not change takes the newer value, so saving again never writes back what someone else
 * changed in the meantime.
 */
export function rebase<T extends object>(mine: T, base: T, latest: T): T {
	const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
	const out = { ...latest };
	for (const k of Object.keys(mine) as (keyof T)[]) if (!same(mine[k], base[k])) out[k] = mine[k];
	return out;
}
