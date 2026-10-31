"use server";

import { revalidatePath } from "next/cache";
import type * as tc from "@everyfield/contracts/tasks";
import type { z } from "zod";
import type { HandoffResult, Outcome, OutcomeMutation } from "./model.ts";
import { taskViewer, write } from "./server.ts";

// Server actions for the follow-up screens. Each sends the browser's request to one producer command in one
// transaction; the producer parses it with the WP-023 contract and checks authority inside its statements. The answer
// carries what changed, so the screen updates from it and never reloads. A database failure reads as lost: the browser
// sends the same request key again, and the producer returns the first result instead of acting twice.

type TaskMutation = z.infer<typeof tc.taskMutation>;
/**
 * A saved outcome changes "What happened" of the task panel. Dropping the client router cache of /tasks makes a return
 * to it, by link or browser back, read the page again, so the panel never opens from a page held before the outcome.
 */
function staleTasks<T>(result: Outcome<T>): Outcome<T> {
	if (result.status === "ok") revalidatePath("/tasks");
	return result;
}
const denied = { status: "refused", code: "access_denied" } as const;

/** Records what happened on a follow-up, or (Owner/Admin) a contact with a Person (REQ-MTG-022). */
export async function recordOutcome(requestKey: string, input: unknown): Promise<Outcome<OutcomeMutation>> {
	const v = await taskViewer();
	if (!v) return denied;
	return staleTasks(await write(v, (w, tx, ctx) => w.recordOutcome(tx, ctx, { requestKey, input })));
}

/** Replaces a recorded outcome with a corrected one, or withdraws it, with a reason (REQ-MTG-022). */
export async function correctOutcome(
	requestKey: string,
	expectedRevision: string,
	input: unknown,
): Promise<Outcome<OutcomeMutation>> {
	const v = await taskViewer();
	if (!v) return denied;
	return staleTasks(await write(v, (w, tx, ctx) => w.correctOutcome(tx, ctx, { requestKey, expectedRevision, input })));
}

/** An explicit follow-up with a Person, undated unless a date is chosen (REQ-PPL-022, REQ-TSK-012). Owner/Admin. */
export async function createFollowUp(requestKey: string, input: unknown): Promise<Outcome<TaskMutation>> {
	const v = await taskViewer();
	if (!v) return denied;
	return write(v, (w, tx, ctx) => w.createFollowUp(tx, ctx, { requestKey, input }));
}

/** Gives an open follow-up to a current eligible owner, or leaves it as Needs owner (REQ-TSK-012). Owner/Admin. */
export async function assignFollowUp(
	requestKey: string,
	expectedRevision: string,
	input: unknown,
): Promise<Outcome<TaskMutation>> {
	const v = await taskViewer();
	if (!v) return denied;
	return write(v, (w, tx, ctx) => w.assignFollowUp(tx, ctx, { requestKey, expectedRevision, input }));
}

/** Moves up to 100 reviewed follow-ups to an eligible owner, all or nothing (REQ-TSK-013). Owner/Admin. */
export async function executeHandoff(requestKey: string, input: unknown): Promise<Outcome<HandoffResult>> {
	const v = await taskViewer();
	if (!v) return denied;
	return write(v, (w, tx, ctx) => w.executeHandoff(tx, ctx, { requestKey, input }));
}
