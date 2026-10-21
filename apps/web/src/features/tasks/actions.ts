"use server";

import * as c from "@everyfield/contracts/tasks";
import { taskReader } from "@everyfield/domain/tasks";
import type { z } from "zod";
import type { Outcome, Saved, TaskDetail, TaskHistory } from "./model.ts";
import { loadTask as readTask, read, reader, taskViewer, write, type TaskViewer } from "./server.ts";

// Server actions behind the Tasks screens: the browser boundary. Each one rebuilds the viewer from the request and
// parses the browser's input with the WP-024 contract, whose strict schemas refuse any owner, creator or authority
// field. The writer then rechecks authority inside its statement. A lost answer may be retried with the same request
// key: the writer replays a write that did commit instead of acting twice.

const denied = { status: "refused", code: "access_denied" } as const;
const invalid = { status: "refused", code: "invalid_input" } as const;

async function boundary<S extends z.ZodType, T>(
	schema: S,
	raw: unknown,
	run: (viewer: TaskViewer, input: z.output<S>) => Promise<Outcome<T>>,
): Promise<Outcome<T>> {
	const viewer = await taskViewer();
	if (!viewer) return denied;
	const input = schema.safeParse(raw);
	if (!input.success) return invalid;
	return run(viewer, input.data);
}

/** The saved task after a write, as the screen shows it from now on, with the audit record that is its history entry. */
const saved = (r: z.infer<typeof c.taskMutation>): Saved => ({
	task: r.task,
	receiptId: r.receiptId,
	changed: r.outcome === "changed",
});

export async function createTask(requestKey: string, input: unknown): Promise<Outcome<Saved>> {
	return boundary(c.createTaskRequest, { requestKey, input }, async (v, request) => {
		const r = await write(v, (w, tx, ctx) => w.create(tx, ctx, request));
		return r.status === "ok" ? { status: "ok", value: saved(r.value) } : r;
	});
}

export async function editTask(
	requestKey: string,
	expectedRevision: string,
	taskId: string,
	patch: unknown,
): Promise<Outcome<Saved>> {
	return boundary(c.editTaskRequest, { requestKey, expectedRevision, input: { taskId, patch } }, async (v, request) => {
		const r = await write(v, (w, tx, ctx) => w.edit(tx, ctx, request));
		return r.status === "ok" ? { status: "ok", value: saved(r.value) } : r;
	});
}

export async function deleteTask(requestKey: string, expectedRevision: string, taskId: string): Promise<Outcome<Saved>> {
	return boundary(c.taskCommandRequest, { requestKey, expectedRevision, input: { taskId } }, async (v, request) => {
		const r = await write(v, (w, tx, ctx) => w.delete(tx, ctx, request));
		return r.status === "ok" ? { status: "ok", value: saved(r.value) } : r;
	});
}

export type StatusAction =
	| { kind: "complete" }
	| { kind: "reopen" }
	| { kind: "waive"; reason: string | null }
	| { kind: "status"; status: "not_started" | "in_progress" | "blocked" };

/** Complete, reopen, close as no longer needed or set an open status. Every path uses the one status writer. */
export async function changeTaskStatus(
	requestKey: string,
	expectedRevision: string,
	taskId: string,
	action: StatusAction,
): Promise<Outcome<Saved>> {
	const envelope = { requestKey, expectedRevision };
	const run = async (fn: (v: TaskViewer) => ReturnType<typeof write<z.infer<typeof c.taskMutation>>>) => {
		const viewer = await taskViewer();
		if (!viewer) return denied;
		const r = await fn(viewer);
		return r.status === "ok" ? ({ status: "ok", value: saved(r.value) } as const) : r;
	};
	switch (action?.kind) {
		case "complete":
		case "reopen": {
			const request = c.taskCommandRequest.safeParse({ ...envelope, input: { taskId } });
			if (!request.success) return invalid;
			return run((v) => write(v, (w, tx, ctx) => w[action.kind](tx, ctx, request.data)));
		}
		case "waive": {
			const request = c.waiveTaskRequest.safeParse({ ...envelope, input: { taskId, reason: action.reason } });
			if (!request.success) return invalid;
			return run((v) => write(v, (w, tx, ctx) => w.waive(tx, ctx, request.data)));
		}
		case "status": {
			const request = c.changeStatusRequest.safeParse({ ...envelope, input: { taskId, status: action.status } });
			if (!request.success || !["not_started", "in_progress", "blocked"].includes(request.data.input.status))
				return invalid;
			return run((v) => write(v, (w, tx, ctx) => w.changeStatus(tx, ctx, request.data)));
		}
		default:
			return invalid;
	}
}

/** A task with its first history page, for the detail panel. */
export async function loadTask(taskId: string): Promise<Outcome<{ task: TaskDetail; history: TaskHistory | null }>> {
	return boundary(c.getTaskRequest, { taskId }, (v, request) => read(v, (tx) => readTask(tx, v, request.taskId)));
}

export async function loadHistory(taskId: string, page: number): Promise<Outcome<TaskHistory>> {
	return boundary(c.statusHistoryRequest, { taskId, page, limit: 50 }, (v, request) =>
		read(v, (tx) => reader.history(tx, v, request.taskId, request.page)),
	);
}

export async function assigneeOptions(): Promise<Outcome<z.infer<typeof c.assigneeOptions>>> {
	const v = await taskViewer();
	if (!v) return denied;
	return read(v, async (tx) => {
		const r = await taskReader.eligibleAssignees(tx, v.authority);
		return r.status === "ok" ? { status: "ok", value: r.value } : { status: "refused", code: r.error.code };
	});
}

export async function relationOptions(kind: unknown, search: unknown): Promise<Outcome<z.infer<typeof c.relationOptions>>> {
	return boundary(c.relationOptionsRequest, { kind, search }, (v, request) =>
		read(v, async (tx) => {
			const r = await taskReader.relationOptions(tx, v.authority, request);
			return r.status === "ok" ? { status: "ok", value: r.value } : { status: "refused", code: r.error.code };
		}),
	);
}
