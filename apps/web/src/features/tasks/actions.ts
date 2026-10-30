"use server";

import * as c from "@everyfield/contracts/tasks";
import type { z } from "zod";
import type { BulkResult, Outcome, Rule, Saved } from "./model.ts";
import { taskViewer, write, type TaskViewer } from "./server.ts";

// Server actions behind the Tasks screens' writes: the browser boundary. Reads go through read.ts, a GET handler, because
// Next runs one server action at a time and a read must never hold up a save. Each one rebuilds the viewer from the request and
// hands the browser's input to the writer, which parses it with the WP-024 contract, whose strict schemas refuse any
// owner, creator or authority field, and rechecks authority inside its statement. A lost answer may be retried with the
// same request key: the writer replays a write that did commit instead of acting twice.

const denied = { status: "refused", code: "access_denied" } as const;
const invalid = { status: "refused", code: "invalid_input" } as const;

async function boundary<T>(run: (viewer: TaskViewer) => Promise<Outcome<T>>): Promise<Outcome<T>> {
	const viewer = await taskViewer();
	return viewer ? run(viewer) : denied;
}

/** The saved task after a write, as the screen shows it from now on, with the audit record that is its history entry. */
const saved = (r: z.infer<typeof c.taskMutation> & { successor?: z.infer<typeof c.taskDetail> | null }): Saved => ({
	task: r.task,
	receiptId: r.receiptId,
	changed: r.outcome === "changed",
	...(r.successor !== undefined ? { successor: r.successor } : {}),
});
const savedOf = <T extends Parameters<typeof saved>[0]>(r: Outcome<T>): Outcome<Saved> =>
	r.status === "ok" ? { status: "ok", value: saved(r.value) } : r;

export async function createTask(requestKey: string, input: unknown): Promise<Outcome<Saved>> {
	return boundary(async (v) => savedOf(await write(v, (w, tx, ctx) => w.create(tx, ctx, { requestKey, input }))));
}

export async function editTask(
	requestKey: string,
	expectedRevision: string,
	taskId: string,
	patch: unknown,
): Promise<Outcome<Saved>> {
	const request = { requestKey, expectedRevision, input: { taskId, patch } };
	return boundary(async (v) => savedOf(await write(v, (w, tx, ctx) => w.edit(tx, ctx, request))));
}

export async function deleteTask(
	requestKey: string,
	expectedRevision: string,
	taskId: string,
): Promise<Outcome<Saved>> {
	const request = { requestKey, expectedRevision, input: { taskId } };
	return boundary(async (v) => savedOf(await write(v, (w, tx, ctx) => w.delete(tx, ctx, request))));
}

export type StatusAction =
	| { kind: "complete" }
	| { kind: "reopen" }
	| { kind: "waive"; reason: string | null }
	| { kind: "status"; status: "not_started" | "in_progress" | "blocked" };

/**
 * Complete, reopen, close as no longer needed or set an open status. Every path uses the one status writer. Complete
 * goes through tasks.completeOccurrence, the same completion, which also returns the next occurrence of a recurring
 * task so the screen can show it without reading the list again.
 */
export async function changeTaskStatus(
	requestKey: string,
	expectedRevision: string,
	taskId: string,
	action: StatusAction,
): Promise<Outcome<Saved>> {
	const envelope = { requestKey, expectedRevision };
	const run = <T extends Parameters<typeof saved>[0]>(fn: (v: TaskViewer) => Promise<Outcome<T>>) =>
		boundary(async (v) => savedOf(await fn(v)));
	switch (action?.kind) {
		case "complete":
			return run((v) => write(v, (w, tx, ctx) => w.completeOccurrence(tx, ctx, { ...envelope, input: { taskId } })));
		case "reopen":
			return run((v) => write(v, (w, tx, ctx) => w.reopen(tx, ctx, { ...envelope, input: { taskId } })));
		case "waive": {
			const input = { taskId, reason: action.reason };
			return run((v) => write(v, (w, tx, ctx) => w.waive(tx, ctx, { ...envelope, input })));
		}
		case "status": {
			// This action sets an open status only; completion and closing have their own paths above.
			if (!["not_started", "in_progress", "blocked"].includes(action.status)) return invalid;
			const input = { taskId, status: action.status };
			return run((v) => write(v, (w, tx, ctx) => w.changeStatus(tx, ctx, { ...envelope, input })));
		}
		default:
			return invalid;
	}
}

// Task structure (WP-025). Each is one command with its own request key; the writer rechecks authority in its statement.

/** Add a step under `parentId`. `assigneeIds` undefined takes the task's assignees; only an Owner or Admin may name them. */
export async function addStep(
	requestKey: string,
	parentRevision: string,
	parentId: string,
	title: string,
	assigneeIds?: string[],
): Promise<Outcome<Saved>> {
	const input = { parentId, title, ...(assigneeIds !== undefined ? { assigneeIds } : {}) };
	return boundary(async (v) =>
		savedOf(
			await write(v, (w, tx, ctx) => w.createSubtask(tx, ctx, { requestKey, expectedRevision: parentRevision, input })),
		),
	);
}

/** Tick or untick a step. Its own assignee or an Owner/Admin; holding the parent does not count. */
export async function setStep(
	requestKey: string,
	expectedRevision: string,
	parentId: string,
	taskId: string,
	complete: boolean,
): Promise<Outcome<Saved>> {
	const input = { parentId, taskId, complete };
	return boundary(async (v) =>
		savedOf(await write(v, (w, tx, ctx) => w.setSubtaskCompletion(tx, ctx, { requestKey, expectedRevision, input }))),
	);
}

/** Remove a step. Its history stays. Owner/Admin. */
export async function removeStep(
	requestKey: string,
	expectedRevision: string,
	parentId: string,
	taskId: string,
): Promise<Outcome<Saved>> {
	return boundary(async (v) =>
		savedOf(
			await write(v, (w, tx, ctx) =>
				w.removeSubtask(tx, ctx, { requestKey, expectedRevision, input: { parentId, taskId } }),
			),
		),
	);
}

/** Replace what a task waits for, as a whole set. A loop refuses with dependency_cycle. Owner/Admin. */
export async function setPrerequisites(
	requestKey: string,
	expectedRevision: string,
	taskId: string,
	prerequisiteIds: string[],
): Promise<Outcome<Saved>> {
	return boundary(async (v) =>
		savedOf(
			await write(v, (w, tx, ctx) =>
				w.replacePrerequisites(tx, ctx, { requestKey, expectedRevision, input: { taskId, prerequisiteIds } }),
			),
		),
	);
}

/** Make a task repeat, change its rule, or stop it with null. Stopping keeps every occurrence. Owner/Admin. */
export async function setRecurrence(
	requestKey: string,
	expectedRevision: string,
	taskId: string,
	rule: Rule | null,
): Promise<Outcome<Saved>> {
	return boundary(async (v) =>
		savedOf(
			await write(v, (w, tx, ctx) =>
				w.configureRecurrence(tx, ctx, { requestKey, expectedRevision, input: { taskId, rule } }),
			),
		),
	);
}

type BulkItems = { taskId: string; expectedRevision: string }[];
/** Complete up to 100 reviewed tasks. Each gets its own outcome; a retry with the same key changes nothing twice. */
export async function bulkComplete(requestKey: string, items: BulkItems): Promise<Outcome<BulkResult>> {
	return boundary((v) => write(v, (w, tx, ctx) => w.bulkComplete(tx, ctx, { requestKey, items })));
}
/** Give up to 100 reviewed open tasks the same due date. Owner/Admin. */
export async function bulkReschedule(requestKey: string, items: BulkItems, due: unknown): Promise<Outcome<BulkResult>> {
	return boundary((v) => write(v, (w, tx, ctx) => w.bulkReschedule(tx, ctx, { requestKey, items, due })));
}
