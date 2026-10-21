import { requestDatabase } from "@/server/database";
import { getViewer } from "@/server/request-context";
import { tasksMount } from "@/server/tasks";
import type { Transaction } from "@everyfield/db/client";
import type { RequestActor } from "@everyfield/domain/access";
import { taskReader, withTaskWrite, type TaskContext, type TaskReply, type TaskWriter } from "@everyfield/domain/tasks";
import "server-only";
import { countRequest, listRequest, pageCount, type Outcome, type TaskQuery } from "./model.ts";

// The Tasks screens reach the task core here. Pages and actions share the request's one viewer (D59/D60); every read
// statement rechecks the live seat itself (C13), and every write rechecks authority inside its own statement (D70).

export type TaskViewer = { authority: RequestActor; accountId: string; role: "owner" | "admin" | "member" };
export const administers = (v: Pick<TaskViewer, "role">) => v.role !== "member";

/** The request's plant seat, or null for a signed-out reader, an organization seat or an account without a seat. */
export async function taskViewer(): Promise<TaskViewer | null> {
	const v = await getViewer();
	const authority = v?.authority;
	if (!authority) return null;
	const ctx = authority.actor.context;
	if (ctx.kind !== "seat" || ctx.owner.kind !== "plant") return null;
	return { authority, accountId: authority.actor.accountId, role: ctx.role };
}

const outcome = <T>(reply: TaskReply<T>): Outcome<T> =>
	reply.status === "ok"
		? { status: "ok", value: reply.value }
		: { status: "refused", code: reply.error.code, error: reply.error };

/** One short read transaction. A database failure reads as lost, never as a crash or an empty list. */
export async function read<T>(viewer: TaskViewer, run: (tx: Transaction) => Promise<Outcome<T>>): Promise<Outcome<T>> {
	const db = requestDatabase();
	if (!db) return { status: "lost" };
	try {
		return await db.transaction(run);
	} catch (error) {
		console.error(JSON.stringify({ component: "tasks", outcome: "read_failed", error: String(error) }));
		return { status: "lost" };
	}
}

/** One native write: the verified actor is bound once and the writer runs in the same transaction. */
export async function write<T>(
	viewer: TaskViewer,
	run: (writer: TaskWriter, tx: Transaction, context: TaskContext) => Promise<TaskReply<T>>,
): Promise<Outcome<T>> {
	const mount = tasksMount();
	if (!mount) return { status: "lost" };
	try {
		return outcome(await withTaskWrite(mount.db, viewer.authority, (tx, ctx) => run(mount.writer, tx, ctx)));
	} catch (error) {
		console.error(JSON.stringify({ component: "tasks", outcome: "write_failed", error: String(error) }));
		return { status: "lost" };
	}
}

export const reader = {
	list: (tx: Transaction, v: TaskViewer, q: TaskQuery) => taskReader.list(tx, v.authority, listRequest(q)).then(outcome),
	count: (tx: Transaction, v: TaskViewer, q: TaskQuery) => taskReader.count(tx, v.authority, countRequest(q)).then(outcome),
	get: (tx: Transaction, v: TaskViewer, taskId: string) => taskReader.get(tx, v.authority, { taskId }).then(outcome),
	history: (tx: Transaction, v: TaskViewer, taskId: string, page = 1) =>
		taskReader.statusHistory(tx, v.authority, { taskId, page, limit: 50 }).then(outcome),
};

/** One open task with its first history page, read in one transaction: two statements. */
export async function loadTask(tx: Transaction, viewer: TaskViewer, taskId: string) {
	const found = await reader.get(tx, viewer, taskId);
	if (found.status !== "ok") return found;
	if (found.value.status !== "available") return { status: "refused", code: "unavailable" } as const;
	const history = await reader.history(tx, viewer, taskId);
	return { status: "ok", value: { task: found.value.task, history: history.status === "ok" ? history.value : null } } as const;
}

/**
 * The Tasks page in one transaction: the list page and its counts, two statements. A page past the end shows the
 * last page instead (D67). A task named in the address opens with its detail and history, two statements more.
 */
export async function loadTasksPage(viewer: TaskViewer, query: TaskQuery, open: string | null) {
	return read(viewer, async (tx) => {
		let list = await reader.list(tx, viewer, query);
		if (list.status === "ok" && list.value.items.length === 0 && query.page > 1) {
			query = { ...query, page: pageCount(list.value.total) };
			list = await reader.list(tx, viewer, query);
		}
		if (list.status !== "ok") return list;
		const counts = await reader.count(tx, viewer, query);
		if (counts.status !== "ok") return counts;
		const opened = open ? await loadTask(tx, viewer, open) : null;
		return {
			status: "ok",
			value: { query, page: list.value, counts: counts.value, opened: opened?.status === "ok" ? opened.value : null },
		};
	});
}
