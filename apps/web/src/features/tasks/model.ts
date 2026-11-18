import { recordId } from "@everyfield/contracts/common";
import type * as c from "@everyfield/contracts/tasks";
import type { z } from "zod";
import { MONTHS } from "../../components/dates.ts";

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
export type TemplateCatalog = z.infer<typeof c.templateCatalog>;
type ChecklistSummary = TemplateCatalog["checklists"][number];
export type TemplatePreview = z.infer<typeof c.templatePreview>;
export type TemplateImport = z.infer<typeof c.templateImport>;
export type PhaseOffer = z.infer<typeof c.phaseOffer>;
export type OpenOffer = Extract<PhaseOffer, { status: "open" }>;
export type OfferAnswered = z.infer<typeof c.offerAnswered>;
export type Saved = { task: TaskDetail; receiptId: string; changed: boolean; successor?: TaskDetail | null };

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
const VIEWS = ["my", "all"] as const;

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

export const isSettled = (s: Status) => s === "complete" || s === "no_longer_needed";

export const assigneeName = (person: { displayName: string }) => person.displayName.trim() || "Unnamed member";
export function ownerLabel(owner: { displayName: string } | null): string {
	return owner ? assigneeName(owner) : "Needs owner";
}

export type FollowUpOwner = c.FollowUpOwner;
const OWNER_REASON_TEXT: Record<NonNullable<FollowUpOwner["reason"]>, string> = {
	no_seat: "no current seat",
	no_person: "no linked Person",
	not_committed: "Person not in a core group, launch team or leader stage",
};
export function ownerText(owner: Pick<FollowUpOwner, "displayName" | "eligible" | "reason"> | null): string {
	if (!owner) return "Needs owner";
	const warning = ownerWarning(owner);
	return warning ? `${ownerLabel(owner)} · ${warning}` : ownerLabel(owner);
}
export function ownerWarning(owner: Pick<FollowUpOwner, "eligible" | "reason">): string | null {
	return owner.eligible || !owner.reason ? null : `Can't own follow-ups: ${OWNER_REASON_TEXT[owner.reason]}`;
}

export function heldAssignees(
	ids: readonly string[],
	names: Readonly<Record<string, string>>,
	current: readonly { accountId: string; displayName: string }[],
	owners: readonly Pick<FollowUpOwner, "accountId" | "eligible" | "reason">[],
	refused?: string | null,
): { accountId: string; displayName: string; warning: string | null }[] {
	const warningOf = (accountId: string) => {
		const view = owners.find((o) => o.accountId === accountId);
		return (view ? ownerWarning(view) : null) ?? (accountId === refused ? "Can't own follow-ups now" : null);
	};
	const drafted = ids.filter((id) => !current.some((a) => a.accountId === id));
	return [
		...current.map((a) => ({ accountId: a.accountId, displayName: a.displayName, warning: warningOf(a.accountId) })),
		...drafted.map((id) => ({ accountId: id, displayName: names[id] ?? "", warning: warningOf(id) })),
	];
}

export function noticingIneligible<T>(
	send: (key: string) => Promise<Outcome<T>>,
	forget: () => void,
	named: (accountId: string | undefined) => void,
): (key: string) => Promise<Outcome<T>> {
	return async (key) => {
		const r = await send(key);
		if (r.status === "refused" && r.code === "owner_ineligible") {
			forget();
			named(r.error?.code === "owner_ineligible" ? r.error.details.accountId : undefined);
		}
		return r;
	};
}

export const lacksOwner = (owners: readonly Pick<FollowUpOwner, "eligible">[]) => !owners.some((o) => o.eligible);
export const assigneeNames = (people: readonly { displayName: string }[]) => people.map(assigneeName);
export function assigneeSummary(people: readonly { displayName: string }[]) {
	const [first, ...rest] = assigneeNames(people);
	return first === undefined ? null : rest.length ? `${first} +${rest.length}` : first;
}

export type BulkActions = { kind: "open" | "settled" | "mixed"; settled: number };

export function bulkActions(statuses: readonly Status[]): BulkActions {
	const settled = statuses.filter(isSettled).length;
	return { kind: settled === 0 ? "open" : settled === statuses.length ? "settled" : "mixed", settled };
}

export const FREQUENCIES = ["daily", "weekly", "biweekly", "monthly", "quarterly", "yearly"] as const;
export const FREQUENCY_LABEL: Record<Frequency, string> = {
	daily: "Every day",
	weekly: "Every week",
	biweekly: "Every two weeks",
	monthly: "Every month",
	quarterly: "Every three months",
	yearly: "Every year",
};
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
export const blockedText = (open: number) => `Blocked by ${open} ${open === 1 ? "task" : "tasks"}`;
export const blocks = (p: Pick<Prerequisite, "status" | "deleted">) => !p.deleted && !isSettled(p.status);

export type Blocker = { id: string; status: Status; deleted: boolean };
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

export class BadgeReads {
	#newest = 0;
	start(search: string) {
		return { n: ++this.#newest, scope: listScopeOf(search) };
	}
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

export type TaskQuery = {
	view: (typeof VIEWS)[number];
	search: string;
	statuses: Status[];
	priorities: Priority[];
	categories: Category[];
	relation: (typeof RELATIONS)[number] | "any";
	due: (typeof DUE_KINDS)[number] | "any";
	teamId: string | null;
	sort: (typeof SORTS)[number];
	direction: "asc" | "desc";
	page: number;
};
const PAGE_SIZE = 50;
const DEFAULT_QUERY: TaskQuery = {
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

const oneOf = <T extends string>(list: readonly T[], v: string | null): T | undefined =>
	list.find((x) => x === v) as T | undefined;
const manyOf = <T extends string>(list: readonly T[], vs: string[]): T[] => list.filter((x) => vs.includes(x));
const sameSet = (a: readonly string[], b: readonly string[]) => a.length === b.length && a.every((x) => b.includes(x));

function teamOf(raw: string | null): string | null {
	const id = raw?.toLowerCase() ?? "";
	return recordId.safeParse(id).success ? id : null;
}

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
		teamId: teamOf(p.get("team")),
		sort: oneOf(SORTS, p.get("sort")) ?? "due",
		direction: p.get("dir") === "desc" ? "desc" : "asc",
		page: Number.isInteger(page) && page >= 1 && page <= 100_000 ? page : 1,
	};
}

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

const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
export function dayText(date: string, year?: number): string {
	const [y, m, d] = date.split("-").map(Number) as [number, number, number];
	const weekday = WEEKDAYS[new Date(Date.UTC(y, m - 1, d)).getUTCDay()];
	return `${weekday} ${MONTHS[m - 1]} ${d}${year !== undefined && y !== year ? `, ${y}` : ""}`;
}
export function timeText(time: string): string {
	const [h, m] = time.split(":").map(Number) as [number, number];
	return `${h % 12 === 0 ? 12 : h % 12}:${String(m).padStart(2, "0")} ${h < 12 ? "AM" : "PM"}`;
}
export function dueText(due: Due, year?: number): string | null {
	if (due.kind === "undated") return null;
	if (due.kind === "local_date") return dayText(due.date, year);
	return `${dayText(due.local.slice(0, 10), year)} · ${timeText(due.local.slice(11))}`;
}

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
export function previewOverdue(due: DueInput, today = new Date().toLocaleDateString("en-CA")): boolean | null {
	if (due.kind === "undated") return null;
	if (due.kind === "local_date") return due.date < today;
	return null;
}
export const sameDue = (a: DueDraft, b: DueDraft) =>
	a.kind === b.kind &&
	(a.kind === "undated" ||
		(a.date === b.date && (a.kind === "local_date" || (a.time === b.time && a.offsetSeconds === b.offsetSeconds))));

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

export function problemText(
	code: Outcome<unknown>["status"] | TaskError["code"] | "access_denied",
	name?: string | null,
): string {
	switch (code) {
		case "owner_ineligible":
			return `${name?.trim() || "Someone you assigned"} cannot own follow-ups now. Remove them from Assigned to or choose someone else, then save again.`;
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
		case "stale_catalog":
			return "The checklists were updated since you opened them. We loaded the current version; check it and try again.";
		case "offer_answered":
			return "This phase offer was already answered, on another device or by someone else.";
		default:
			return "You cannot make this change. Your seat may have changed; reload the page.";
	}
}

export type Pending = {
	status: Readonly<Record<string, Status>>;
	rows: Readonly<Record<string, TaskItem | null>>;
	added: readonly TaskItem[];
	steps: Readonly<Record<string, readonly Step[]>>;
	panel: Readonly<Record<string, Partial<Panel>>>;
};
type Panel = { recurrence: TaskDetail["recurrence"]; prerequisites: Prerequisite[] };
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
export function shownSteps(saved: readonly Step[], parentId: string, p: Pending): Step[] {
	return [...saved, ...(p.steps[parentId] ?? [])]
		.filter((s) => !(s.id in p.rows && p.rows[s.id] === null))
		.map((s) => (p.status[s.id] ? { ...s, status: p.status[s.id]! } : s));
}
export function shownRows(items: readonly TaskItem[], p: Pending): TaskItem[] {
	return [...p.added, ...items].flatMap((r) => {
		const row = r.id in p.rows ? p.rows[r.id] : r;
		if (!row) return [];
		const status = p.status[r.id];
		return [status ? { ...row, status } : row];
	});
}

export function matches(q: TaskQuery, t: TaskItem, you: string): boolean {
	if (t.deleted || t.parentId) return false;
	if (q.view === "my" && !t.assignees.some((a) => a.accountId === you)) return false;
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

export function rebase<T extends object>(mine: T, base: T, latest: T): T {
	const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
	const out = { ...latest };
	for (const k of Object.keys(mine) as (keyof T)[]) if (!same(mine[k], base[k])) out[k] = mine[k];
	return out;
}

export function checklistGroups(list: readonly ChecklistSummary[]) {
	const phases = new Map<number, Map<Category, ChecklistSummary[]>>();
	for (const k of list) {
		const byCategory = phases.get(k.phase) ?? new Map<Category, ChecklistSummary[]>();
		byCategory.set(k.category, [...(byCategory.get(k.category) ?? []), k]);
		phases.set(k.phase, byCategory);
	}
	return [...phases.entries()]
		.sort(([a], [b]) => a - b)
		.map(([phase, byCategory]) => ({
			phase,
			categories: [...byCategory.entries()].map(([category, checklists]) => ({ category, checklists })),
		}));
}
export const taskCount = (n: number) => (n === 1 ? "1 task" : `${n} tasks`);

export type Viewer = { accountId: string; role: "owner" | "admin" | "member"; name: string | null };
