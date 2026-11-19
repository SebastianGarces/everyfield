import { requestDatabase } from "@/server/database";
import { getViewer } from "@/server/request-context";
import type { Transaction } from "@everyfield/db/client";
import type { RequestActor } from "@everyfield/domain/access";
import { followUpReader } from "@everyfield/domain/followups";
import {
	createTemplateReader,
	taskReader,
	withTaskWrite,
	type TaskContext,
	type TaskReply,
	type TaskWriter,
} from "@everyfield/domain/tasks";
import "server-only";
import { HISTORY_PAGE, outcomeOf } from "../followups/model.ts";
import { countRequest, listRequest, pageCount, type Outcome, type TaskQuery } from "./model.ts";
import { tasksMount } from "./mount.ts";
import { LOST, transient } from "@/server/platform/transient";

export type TaskViewer = { authority: RequestActor; accountId: string; role: "owner" | "admin" | "member" };
const administers = (v: Pick<TaskViewer, "role">) => v.role !== "member";

export async function taskViewer(): Promise<TaskViewer | null> {
	const v = await getViewer();
	const authority = v.authority;
	if (!authority) return null;
	const ctx = authority.actor.context;
	if (ctx.kind !== "seat" || ctx.owner.kind !== "plant") return null;
	return { authority, accountId: authority.actor.accountId, role: ctx.role };
}

const outcome = <T>(reply: TaskReply<T>): Outcome<T> =>
	reply.status === "ok"
		? { status: "ok", value: reply.value }
		: { status: "refused", code: reply.error.code, error: reply.error };

export async function read<T>(run: (tx: Transaction) => Promise<Outcome<T>>): Promise<Outcome<T>> {
	const db = requestDatabase();
	return transient({ component: "tasks", outcome: "read_failed" }, () => db.transaction(run), LOST);
}

export async function write<T>(
	viewer: TaskViewer,
	run: (writer: TaskWriter, tx: Transaction, context: TaskContext) => Promise<TaskReply<T>>,
): Promise<Outcome<T>> {
	const mount = tasksMount();
	return transient(
		{ component: "tasks", outcome: "write_failed" },
		async () => {
			return outcome(await withTaskWrite(mount.db, viewer.authority, (tx, ctx) => run(mount.writer, tx, ctx)));
		},
		LOST,
	);
}

export const templates = createTemplateReader();

export const reader = {
	offer: (tx: Transaction, v: TaskViewer, transitionId?: string) =>
		templates.readPhaseOffer(tx, v.authority, transitionId ? { transitionId } : {}).then(outcome),
	list: (tx: Transaction, v: TaskViewer, q: TaskQuery) =>
		taskReader.list(tx, v.authority, listRequest(q)).then(outcome),
	count: (tx: Transaction, v: TaskViewer, q: TaskQuery) =>
		taskReader.count(tx, v.authority, countRequest(q)).then(outcome),
	get: (tx: Transaction, v: TaskViewer, taskId: string) => taskReader.get(tx, v.authority, { taskId }).then(outcome),
	history: (tx: Transaction, v: TaskViewer, taskId: string, page = 1) =>
		taskReader.statusHistory(tx, v.authority, { taskId, page, limit: 50 }).then(outcome),
};

export async function loadTask(tx: Transaction, viewer: TaskViewer, taskId: string) {
	const found = await reader.get(tx, viewer, taskId);
	if (found.status !== "ok") return found;
	if (found.value.status !== "available") return { status: "refused", code: "unavailable" } as const;
	const task = found.value.task;
	const history = await reader.history(tx, viewer, taskId);
	const prerequisites = task.prerequisiteIds.length
		? await taskReader.listPrerequisites(tx, viewer.authority, { taskId }).then(outcome)
		: null;
	const occurrence = task.recurrence
		? await taskReader.findOpenOccurrence(tx, viewer.authority, { taskId }).then(outcome)
		: null;
	const contacts =
		task.relation?.kind === "person" && !task.parentId
			? await followUpReader
					.listContactHistory(tx, viewer.authority, {
						personId: task.relation.id,
						taskId: task.id,
						limit: HISTORY_PAGE,
						page: 1,
					})
					.then(outcomeOf)
			: null;
	const ok = <T>(r: Outcome<T> | null) => (r?.status === "ok" ? r.value : null);
	return {
		status: "ok",
		value: {
			task,
			history,
			contacts,
			prerequisites: task.prerequisiteIds.length ? ok(prerequisites) : { taskId: task.id, items: [], blocked: false },
			occurrence: ok(occurrence),
		},
	} as const;
}

export async function loadTasksPage(viewer: TaskViewer, query: TaskQuery, open: string | null) {
	return read(async (tx) => {
		let list = await reader.list(tx, viewer, query);
		if (list.status === "ok" && list.value.items.length === 0 && query.page > 1) {
			query = { ...query, page: pageCount(list.value.total) };
			list = await reader.list(tx, viewer, query);
		}
		if (list.status !== "ok") return list;
		const counts = await reader.count(tx, viewer, query);
		if (counts.status !== "ok") return counts;
		const opened = open ? await loadTask(tx, viewer, open) : null;
		const offer = administers(viewer) ? await reader.offer(tx, viewer) : null;
		return {
			status: "ok",
			value: {
				query,
				page: list.value,
				counts: counts.value,
				opened: opened?.status === "ok" ? opened.value : null,
				offer: offer?.status === "ok" && offer.value.status === "open" ? offer.value : null,
			},
		};
	});
}
