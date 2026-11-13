import type { Transaction } from "@everyfield/db/client";
import { sql } from "@everyfield/db/query";
import { liveRead } from "@everyfield/domain/access";
import { createTemplateReader, taskReader } from "@everyfield/domain/tasks";
import {
	category,
	countTasksRequest,
	eligibleAssigneesRequest,
	getTaskRequest,
	listPrerequisitesRequest,
	listSubtasksRequest,
	listTasksRequest,
	findOpenOccurrenceRequest,
	prerequisiteCandidatesRequest,
	previewTemplateRequest,
	readPhaseOfferRequest,
	relationOptionsRequest,
	statusHistoryRequest,
	taskStatus,
	type Due,
} from "@everyfield/contracts/tasks";
import { z } from "zod";
import { id } from "../values.ts";
import type { EvryActor } from "../../../context/actor.ts";
import { EvryRefusal } from "../../../context/errors.ts";
import { personRow } from "../../../catalog/person-row.ts";
import type { ReadAdapter, SourceResult, SourceRow } from "../../../catalog/types.ts";

// The Tasks read tools (WP-067): each calls the native Tasks read the Tasks page uses, under the same domain authority,
// whose statements carry the lock-free live access check (C13, C27). A task row names its owners by their account's
// name, never by a Person who shares it (GAP-EVR-407). A follow-up is a task too; its row says so, so an answer can list
// follow-ups apart from other tasks.

export const inPlant = (actor: EvryActor) => actor.owner.kind === "plant" && actor.role !== null;
export const ownerOrAdmin = (actor: EvryActor) =>
	actor.owner.kind === "plant" && (actor.role === "owner" || actor.role === "admin");

type Reply<T> = { status: "ok"; value: T } | { status: "refused"; error: { code: string } };
/** The native value, or the refusal a person can act on: bad input, or a source this actor cannot read now. */
export function value<T>(reply: Reply<T>): T {
	if (reply.status === "ok") return reply.value;
	throw new EvryRefusal(reply.error.code === "invalid_input" ? "invalid_input" : "source_unavailable");
}
export const result = (
	operation: string,
	rows: SourceRow[],
	exclusions: string[],
	paging: Partial<Pick<SourceResult, "total" | "page" | "next" | "completeness">> = {},
): SourceResult => ({
	operation,
	status: rows.length ? "available" : "not_found",
	rows,
	total: paging.total === undefined ? rows.length : paging.total,
	page: paging.page ?? 1,
	next: paging.next ?? null,
	completeness: paging.completeness ?? "complete",
	exclusions,
});

/** A due date as the church reads it: a local date, or a local date and time with its zone. Null when undated. */
export function dueText(due: Due): string | null {
	if (due.kind === "undated") return null;
	if (due.kind === "local_date") return due.date;
	return `${due.local.replace("T", " ").slice(0, 16)} ${due.zone}`;
}
const dueDate = (due: Due) =>
	due.kind === "undated" ? null : due.kind === "local_date" ? due.date : due.local.slice(0, 10);

type Account = { accountId: string; displayName: string };
/** Owners by name, "you" for the signed-in user's own account. Null when the task needs an owner. */
export const ownerNames = (actor: EvryActor, owners: readonly Account[]) =>
	owners.length ? owners.map((o) => (o.accountId === actor.accountId ? "you" : o.displayName)).join(", ") : null;

type Item = {
	id: string;
	revision: string;
	title: string;
	status: string;
	priority: string;
	category: string;
	due: Due;
	overdue: boolean | null;
	assignees: Account[];
	followUpOwners?: { accountId: string; displayName: string; eligible: boolean }[];
	relation?: { kind: string; id: string; label: string } | null;
	parentId?: string | null;
	checklist?: { total: number; complete: number };
	openPrerequisites?: number;
	managed?: { obligationId: string; kind: string } | null;
	completedAt?: string | null;
};
/** A follow-up is a person follow-up task: its row is marked so an answer lists it apart from other tasks. */
const isFollowUp = (t: Pick<Item, "category" | "relation" | "parentId">) =>
	t.category === "follow_up" && t.relation?.kind === "person" && !t.parentId;
/**
 * One task row. `owners` are the accounts the task is assigned to; a follow-up's owner who can no longer own it is not
 * counted, so the row reads Needs owner (REQ-TSK-012). The revision lets a later review name the exact version.
 */
export function taskRow(actor: EvryActor, t: Item): SourceRow {
	const followUp = isFollowUp(t);
	const owners = followUp && t.followUpOwners ? t.followUpOwners.filter((o) => o.eligible) : t.assignees;
	return {
		kind: "task",
		id: t.id,
		label: t.title,
		fields: {
			status: t.status,
			due: dueText(t.due),
			overdue: t.overdue,
			owners: ownerNames(actor, owners),
			needsOwner: owners.length === 0,
			yours: t.assignees.some((a) => a.accountId === actor.accountId),
			followUp,
			person: t.relation?.kind === "person" ? t.relation.label : null,
			personId: t.relation?.kind === "person" ? t.relation.id : null,
			relatedTo: t.relation && t.relation.kind !== "person" ? `${t.relation.kind}: ${t.relation.label}` : null,
			priority: t.priority,
			category: t.category,
			parentId: t.parentId ?? null,
			checklist: t.checklist?.total ? `${t.checklist.complete} of ${t.checklist.total} done` : null,
			obligationId: t.managed?.obligationId ?? null,
			revision: t.revision,
		},
	};
}

/**
 * The church's local date today and its ISO weekday (1 Monday … 7 Sunday), at the same clock the native list reads
 * overdue from (its asOf), so a due window and the overdue flag never disagree.
 */
async function churchToday(tx: Transaction, actor: EvryActor) {
	const zone = await churchZone(tx, actor);
	const parts = Object.fromEntries(
		new Intl.DateTimeFormat("en-CA", {
			timeZone: zone,
			year: "numeric",
			month: "2-digit",
			day: "2-digit",
			weekday: "short",
		})
			.formatToParts(new Date())
			.map((p) => [p.type, p.value]),
	);
	const weekday = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"].indexOf(parts.weekday!) + 1;
	return { zone, today: `${parts.year}-${parts.month}-${parts.day}`, weekday };
}
/** The church's own time zone. */
export async function churchZone(tx: Transaction, actor: EvryActor) {
	const r = await tx.execute(sql`SELECT pl.timezone AS zone FROM plant pl WHERE pl.id=${actor.owner.id}::uuid`);
	return z.object({ zone: z.string() }).parse(r.rows[0]).zone;
}
/** An instant as the church reads it: "2026-11-05 15:30 America/Chicago". */
export function localTime(at: string | null, zone: string) {
	if (!at) return null;
	const p = Object.fromEntries(
		new Intl.DateTimeFormat("en-CA", {
			timeZone: zone,
			hourCycle: "h23",
			year: "numeric",
			month: "2-digit",
			day: "2-digit",
			hour: "2-digit",
			minute: "2-digit",
		})
			.formatToParts(new Date(at))
			.map((x) => [x.type, x.value]),
	);
	return `${p.year}-${p.month}-${p.day} ${p.hour}:${p.minute} ${zone}`;
}
const addDays = (date: string, days: number) =>
	new Date(Date.parse(`${date}T00:00:00Z`) + days * 86_400_000).toISOString().slice(0, 10);

const OPEN = ["not_started", "in_progress", "blocked"] as const;
/** At most this many matched tasks are read for a due window; past it the result says it is partial. */
const SCAN = 500;
const listInput = z.strictObject({
	search: z.string().trim().min(1).max(200).optional().describe("Words from the task title"),
	mine: z.boolean().optional().describe("Only tasks assigned to the signed-in user's own account"),
	statuses: z.array(taskStatus).max(5).optional().describe("Default: open tasks (not started, in progress, blocked)"),
	categories: z.array(category).max(10).optional(),
	due: z
		.enum(["any", "overdue", "today", "this_week", "undated"])
		.optional()
		.describe(
			"overdue: past due now in the church's time zone, as the Tasks page's Overdue group. today: due today or overdue. this_week: due by this Sunday or overdue. Default any.",
		),
	followUps: z
		.enum(["include", "exclude", "only"])
		.optional()
		.describe("Person follow-ups are tasks too. exclude or only to list them apart. Default include."),
	page: z.int().min(1).max(100).optional(),
	limit: z.int().min(1).max(100).optional(),
});

export const listTasks: ReadAdapter<z.infer<typeof listInput>> = {
	operation: "tasks.list",
	description:
		"List this church's top-level tasks as the Tasks page does, in due-date order, with the exact matched total. Each row has the title, status, due date, owners, whether it is overdue and whether it is a person follow-up.",
	input: listInput,
	allowed: inPlant,
	async invoke(tx, actor, input): Promise<SourceResult> {
		const base = {
			view: input.mine ? "my" : "all",
			search: input.search,
			statuses: input.statuses ?? [...OPEN],
			categories: input.categories ?? [],
			due: input.due === "undated" ? "undated" : "any",
			sort: "due",
			direction: "asc",
			limit: 100,
		};
		// Every matched task up to SCAN, in the Tasks page's order, then the due window and the follow-up split.
		const items: Item[] = [];
		let more = true;
		for (let page = 1; more && items.length < SCAN; page++) {
			const reply = await taskReader.list(tx, actor.authority, listTasksRequest.parse({ ...base, page }));
			const found = value(reply);
			items.push(...found.items);
			more = found.next !== null;
		}
		const { today, weekday } = await churchToday(tx, actor);
		const by = input.due === "today" ? today : input.due === "this_week" ? addDays(today, 7 - weekday) : null;
		const inWindow = (t: Item) =>
			input.due === "overdue"
				? t.overdue === true
				: by
					? t.overdue === true || (dueDate(t.due) !== null && dueDate(t.due)! <= by)
					: true;
		const split = input.followUps ?? "include";
		const matched = items.filter((t) => inWindow(t) && (split === "include" || (split === "only") === isFollowUp(t)));
		const limit = input.limit ?? 25,
			page = input.page ?? 1;
		const shown = matched.slice((page - 1) * limit, page * limit);
		const partial = more;
		return result(
			"tasks.list",
			shown.map((t) => taskRow(actor, t)),
			["checklist rows (read them with tasks.listSubtasks)", "deleted tasks", "task descriptions"],
			{
				total: partial ? null : matched.length,
				page,
				next: page * limit < matched.length ? page + 1 : null,
				completeness: partial ? "partial" : "complete",
			},
		);
	},
};

const countInput = z.strictObject({
	mine: z.boolean().optional(),
	search: z.string().trim().min(1).max(200).optional(),
	statuses: z.array(taskStatus).max(5).optional().describe("Default: every status"),
	categories: z.array(category).max(10).optional(),
});
export const countTasks: ReadAdapter<z.infer<typeof countInput>> = {
	operation: "tasks.count",
	description:
		"Count this church's top-level tasks by status, with checklist rows counted apart. The total matches the Tasks page.",
	input: countInput,
	allowed: inPlant,
	async invoke(tx, actor, input): Promise<SourceResult> {
		const counts = value(
			await taskReader.count(
				tx,
				actor.authority,
				countTasksRequest.parse({
					view: input.mine ? "my" : "all",
					search: input.search,
					statuses: input.statuses ?? [],
					categories: input.categories ?? [],
				}),
			),
		);
		const rows: SourceRow[] = [
			...counts.byStatus.map((s) => ({
				kind: "tally" as const,
				id: `status:${s.value}`,
				label: s.value,
				fields: { count: s.count, of: "tasks" },
			})),
			{
				kind: "tally",
				id: "checklist",
				label: "checklist rows",
				fields: { count: counts.childTaskTotal, complete: counts.childTaskComplete, of: "checklist rows" },
			},
		];
		return result("tasks.count", rows, ["deleted tasks"], { total: counts.topLevelTotal });
	},
};

const taskInput = z.strictObject({ taskId: id.describe("A task id from an earlier result") });
export const getTask: ReadAdapter<z.infer<typeof taskInput>> = {
	operation: "tasks.get",
	description:
		"Read one task by id: its fields, recurrence and checklist rows (each a real subtask with its own status and owners).",
	input: taskInput,
	allowed: inPlant,
	async invoke(tx, actor, input): Promise<SourceResult> {
		const found = value(await taskReader.get(tx, actor.authority, getTaskRequest.parse(input)));
		if (found.status !== "available") return result("tasks.get", [], []);
		const t = found.task;
		const head = taskRow(actor, t);
		head.fields.recurrence = t.recurrence
			? `${t.recurrence.frequency}${t.recurrence.until ? ` until ${t.recurrence.until}` : ""}${t.recurrence.stopped ? " (stopped)" : ""}`
			: null;
		head.fields.description = t.description ? t.description.slice(0, 600) : null;
		const children = t.checklistItems.map((k) =>
			taskRow(actor, {
				...k,
				priority: t.priority,
				category: t.category,
				due: { kind: "undated" },
				overdue: null,
				parentId: t.id,
			}),
		);
		return result("tasks.get", [head, ...children], ["status history (read it with tasks.statusHistory)"], {
			total: 1 + children.length,
		});
	},
};

const historyInput = z.strictObject({ taskId: taskInput.shape.taskId, page: z.int().min(1).max(100).optional() });
export const statusHistory: ReadAdapter<z.infer<typeof historyInput>> = {
	operation: "tasks.statusHistory",
	description:
		"Read one task's status changes, oldest first: created, completed, reopened or closed, by whom and when.",
	input: historyInput,
	allowed: inPlant,
	async invoke(tx, actor, input): Promise<SourceResult> {
		const reply = await taskReader.statusHistory(tx, actor.authority, statusHistoryRequest.parse(input));
		if (reply.status !== "ok") return result("tasks.statusHistory", [], []);
		const h = reply.value;
		const zone = await churchZone(tx, actor);
		const rows = h.items.map((e) => ({
			kind: "history" as const,
			id: e.id,
			label: e.to,
			fields: {
				from: e.from,
				to: e.to,
				occurredAt: localTime(e.occurredAt, zone),
				by:
					e.actor.kind === "account"
						? e.actor.accountId === actor.accountId
							? "you"
							: e.actor.displayName
						: e.actor.kind === "system"
							? "Everyfield"
							: "a former member",
				source: e.source,
			},
		}));
		return result("tasks.statusHistory", rows, ["field edits"], {
			total: null,
			page: input.page ?? 1,
			next: h.next,
			completeness: h.next ? "partial" : "complete",
		});
	},
};

/** An account row: a seat that may hold a task, named by its account, never by a Person who shares the name. */
const accountRow = (
	actor: EvryActor,
	a: { accountId: string; displayName: string; role: string },
	follow: boolean,
) => ({
	kind: "account" as const,
	id: a.accountId,
	label: a.displayName,
	fields: { role: a.role, canOwnFollowUps: follow, ...(a.accountId === actor.accountId ? { you: true } : {}) },
});
export const eligibleAssignees: ReadAdapter<Record<string, never>> = {
	operation: "tasks.eligibleAssignees",
	description:
		"List the accounts that may be assigned tasks in this church (current seats), with whether each may own a person follow-up. Use the account id to assign; a Person record without a seat can't be assigned.",
	input: z.strictObject({}),
	allowed: ownerOrAdmin,
	async invoke(tx, actor): Promise<SourceResult> {
		const any = value(await taskReader.eligibleAssignees(tx, actor.authority, eligibleAssigneesRequest.parse({})));
		const follow = value(
			await taskReader.eligibleAssignees(
				tx,
				actor.authority,
				eligibleAssigneesRequest.parse({ purpose: "committed_follow_up" }),
			),
		);
		const owners = new Set(follow.items.map((a) => a.accountId));
		return result(
			"tasks.eligibleAssignees",
			any.items.map((a) => accountRow(actor, a, owners.has(a.accountId))),
			["People with no seat", "ended or unaccepted seats"],
		);
	},
};

const relationInput = relationOptionsRequest.extend({ search: z.string().trim().max(200).optional() });
export const relationOptions: ReadAdapter<z.infer<typeof relationInput>> = {
	operation: "tasks.relationOptions",
	description: "Find a live person, meeting or active team in this church that a task may be linked to, by name.",
	input: relationInput,
	allowed: ownerOrAdmin,
	async invoke(tx, actor, input): Promise<SourceResult> {
		const found = value(await taskReader.relationOptions(tx, actor.authority, relationOptionsRequest.parse(input)));
		return result(
			"tasks.relationOptions",
			found.items.map((o) =>
				input.kind === "person"
					? personRow(actor, o.id, o.label, {})
					: { kind: input.kind, id: o.id, label: o.label, fields: {} },
			),
			["retired people", "archived teams"],
		);
	},
};

const subtasksInput = z.strictObject({
	parentId: id.describe("The parent task id"),
	page: z.int().min(1).max(100).optional(),
});
export const listSubtasks: ReadAdapter<z.infer<typeof subtasksInput>> = {
	operation: "tasks.listSubtasks",
	description: "List one task's checklist rows: each is a real subtask with its own status, owners and revision.",
	input: subtasksInput,
	allowed: inPlant,
	async invoke(tx, actor, input): Promise<SourceResult> {
		const reply = await taskReader.listSubtasks(tx, actor.authority, listSubtasksRequest.parse(input));
		if (reply.status !== "ok") return result("tasks.listSubtasks", [], []);
		const page = reply.value;
		return result(
			"tasks.listSubtasks",
			page.items.map((k) =>
				taskRow(actor, {
					...k,
					priority: "medium",
					category: "general",
					due: { kind: "undated" },
					overdue: null,
					parentId: page.parentId,
				}),
			),
			["deleted rows"],
			{ total: page.total, page: page.page, next: page.next },
		);
	},
};

export const listPrerequisites: ReadAdapter<z.infer<typeof taskInput>> = {
	operation: "tasks.listPrerequisites",
	description: "List the tasks one task waits on, with whether each still blocks it. Prerequisites are advisory.",
	input: taskInput,
	allowed: inPlant,
	async invoke(tx, _actor, input): Promise<SourceResult> {
		const reply = await taskReader.listPrerequisites(tx, _actor.authority, listPrerequisitesRequest.parse(input));
		if (reply.status !== "ok") return result("tasks.listPrerequisites", [], []);
		return result(
			"tasks.listPrerequisites",
			reply.value.items.map((p) => ({
				kind: "task" as const,
				id: p.id,
				label: p.title,
				fields: { status: p.status, blocking: p.blocking, deleted: p.deleted },
			})),
			[],
		);
	},
};

const candidatesInput = z.strictObject({
	taskId: taskInput.shape.taskId,
	search: z.string().trim().max(200).optional(),
});
export const prerequisiteCandidates: ReadAdapter<z.infer<typeof candidatesInput>> = {
	operation: "tasks.prerequisiteCandidates",
	description: "Find tasks that one task could wait on, by title words. A task that already depends on it is left out.",
	input: candidatesInput,
	allowed: ownerOrAdmin,
	async invoke(tx, actor, input): Promise<SourceResult> {
		const found = value(
			await taskReader.prerequisiteCandidates(tx, actor.authority, prerequisiteCandidatesRequest.parse(input)),
		);
		return result(
			"tasks.prerequisiteCandidates",
			found.items.map((p) => ({ kind: "task" as const, id: p.id, label: p.title, fields: { status: p.status } })),
			["tasks that would make a cycle"],
		);
	},
};

export const findOpenOccurrence: ReadAdapter<z.infer<typeof taskInput>> = {
	operation: "tasks.findOpenOccurrence",
	description:
		"For a recurring task, find its series' open occurrence: the one to complete now. Not found when the task does not recur or every occurrence is settled.",
	input: taskInput,
	allowed: inPlant,
	async invoke(tx, actor, input): Promise<SourceResult> {
		const found = value(
			await taskReader.findOpenOccurrence(tx, actor.authority, findOpenOccurrenceRequest.parse(input)),
		);
		if (found.status !== "series" || !found.open) return result("tasks.findOpenOccurrence", [], []);
		const open = value(await taskReader.listRows(tx, actor.authority, { taskIds: [found.open.taskId] }));
		const rows = open.items.map((t) => {
			const row = taskRow(actor, t);
			row.fields.occurrence = found.open!.occurrence;
			return row;
		});
		return result("tasks.findOpenOccurrence", rows, ["settled occurrences"]);
	},
};

const templates = createTemplateReader();
const templateRow = (
	k: { key: string; name: string; phase: number; category: string; taskCount: number },
	extra: Record<string, string | number | null> = {},
) => ({
	kind: "template" as const,
	id: k.key,
	label: k.name,
	fields: { phase: k.phase, category: k.category, taskCount: k.taskCount, ...extra },
});
export const listTemplates: ReadAdapter<Record<string, never>> = {
	operation: "tasks.listTemplates",
	description: "List Everyfield's task checklists for church planting phases, with the church's current phase.",
	input: z.strictObject({}),
	allowed: ownerOrAdmin,
	async invoke(tx, actor): Promise<SourceResult> {
		const found = value(await templates.listTemplates(tx, actor.authority, {}));
		return result(
			"tasks.listTemplates",
			found.checklists.map((k) => templateRow(k, { currentPhase: found.currentPhase })),
			[],
		);
	},
};

export const previewTemplate: ReadAdapter<z.infer<typeof previewTemplateRequest>> = {
	operation: "tasks.previewTemplate",
	description:
		"Preview one checklist's tasks with the dates they would be due from today. Nothing is created by a preview.",
	input: previewTemplateRequest,
	allowed: ownerOrAdmin,
	async invoke(tx, actor, input): Promise<SourceResult> {
		const found = value(await templates.previewTemplate(tx, actor.authority, input));
		const k = found.checklist;
		return result(
			"tasks.previewTemplate",
			[
				templateRow(k, { anchorDate: found.anchorDate }),
				...k.tasks.map((t) => ({
					kind: "template" as const,
					id: `${k.key}/${t.key}`,
					label: t.title,
					fields: { due: t.due, priority: t.priority },
				})),
			],
			["item descriptions"],
		);
	},
};

export const readPhaseOffer: ReadAdapter<z.infer<typeof readPhaseOfferRequest>> = {
	operation: "tasks.readPhaseOffer",
	description:
		"Read the checklists offered after the church's latest phase move, or what an earlier answer decided. Not found when nothing is offered.",
	input: readPhaseOfferRequest,
	allowed: ownerOrAdmin,
	async invoke(tx, actor, input): Promise<SourceResult> {
		const offer = value(await templates.readPhaseOffer(tx, actor.authority, input));
		if (offer.status === "none") return result("tasks.readPhaseOffer", [], []);
		const move = { fromPhase: offer.transition.fromPhase, toPhase: offer.transition.toPhase };
		if (offer.status === "answered")
			return result(
				"tasks.readPhaseOffer",
				offer.answer.tasks.map((t) => ({
					kind: "task" as const,
					id: t.id,
					label: t.title,
					fields: { ...move, answer: offer.answer.answer, answeredAt: offer.answer.answeredAt },
				})),
				[],
			);
		return result(
			"tasks.readPhaseOffer",
			offer.checklists.map((k) => templateRow(k, { ...move, offered: "open" })),
			["Wiki reading list"],
		);
	},
};

const receiptInput = z.strictObject({
	receiptId: id.optional().describe("One import's receipt id; omitted lists the latest imports"),
});
const receiptRow = z.object({
	id: id,
	occurred_at: z.coerce.date(),
	kind: z.string(),
	checklists: z.string().nullable(),
	created: z.int(),
});
/**
 * tasks.importReceipt: what a checklist import or a phase offer answer created, read back from its audit record (D70),
 * the same record the native import writes. Owner/Admin, with the lock-free live check in the statement (C27).
 */
export const importReceipt: ReadAdapter<z.infer<typeof receiptInput>> = {
	operation: "tasks.importReceipt",
	description:
		"Read what a checklist import or a phase offer answer created: the checklist, when and how many tasks. Omit the id for the latest ten.",
	input: receiptInput,
	allowed: ownerOrAdmin,
	async invoke(tx, actor, input): Promise<SourceResult> {
		const r = await tx.execute(sql`
			SELECT a.id,a.occurred_at,a.kind,
				coalesce(a.after_value->>'checklistKey',(SELECT string_agg(k,', ') FROM jsonb_array_elements_text(a.after_value->'accepted') k)) AS checklists,
				coalesce(jsonb_array_length(a.after_value->'taskIds'),0)::int AS created
			FROM audit_event a
			WHERE a.tenant_id=${actor.owner.id}::uuid AND a.action='tasks.changed'
				AND a.subject_type IN ('checklist_import','phase_transition') AND a.kind IN ('create','offer_answer')
				AND (${input.receiptId ?? null}::uuid IS NULL OR a.id=${input.receiptId ?? null}::uuid)
				AND ${liveRead({ session: actor.session, owner: actor.owner, seatId: actor.seatId ?? undefined }, true)}
			ORDER BY a.occurred_at DESC,a.id DESC LIMIT 10`);
		const rows = r.rows.map((raw) => {
			const a = receiptRow.parse(raw);
			return {
				kind: "template" as const,
				id: a.id,
				label: a.checklists ?? (a.kind === "offer_answer" ? "Phase offer declined" : "Checklist import"),
				fields: {
					receipt: a.kind === "offer_answer" ? "phase offer answer" : "checklist import",
					at: a.occurred_at.toISOString(),
					tasksCreated: a.created,
				},
			};
		});
		return result("tasks.importReceipt", rows, ["imports older than the latest ten"]);
	},
};

/** The installed Tasks read tools, in catalog order. */
export const TASK_READS = [
	listTasks,
	countTasks,
	getTask,
	statusHistory,
	listSubtasks,
	listPrerequisites,
	prerequisiteCandidates,
	findOpenOccurrence,
	eligibleAssignees,
	relationOptions,
	listTemplates,
	previewTemplate,
	readPhaseOffer,
	importReceipt,
] as const;
