"use server";

import type * as tc from "@everyfield/contracts/tasks";
import type { z } from "zod";
import type { HandoffResult, Outcome, OutcomeMutation } from "./model.ts";
import { taskViewer, write } from "./server.ts";

// Server actions for the follow-up screens. Each sends the browser's request to one producer command in one
// transaction; the producer parses it with the WP-023 contract and checks authority inside its statements. The answer
// carries what changed, so the follow-up screen updates from it. Nothing here revalidates: a revalidating action also
// renders the page it was called on again and sends it with the answer (T-234). Tasks stays fresh in the browser
// instead: the follow-up screens count each saved outcome (outcomeSaved in features/tasks/fresh.tsx), and a Tasks page
// that browser back shows from before that outcome reads itself again. A database failure reads as lost: the browser
// sends the same request key again, and the producer returns the first result instead of acting twice.

type TaskMutation = z.infer<typeof tc.taskMutation>;
const denied = { status: "refused", code: "access_denied" } as const;

/** Records what happened on a follow-up, or (Owner/Admin) a contact with a Person (REQ-MTG-022). */
export async function recordOutcome(requestKey: string, input: unknown): Promise<Outcome<OutcomeMutation>> {
	const v = await taskViewer();
	if (!v) return denied;
	return write(v, (w, tx, ctx) => w.recordOutcome(tx, ctx, { requestKey, input }));
}

/** Replaces a recorded outcome with a corrected one, or withdraws it, with a reason (REQ-MTG-022). */
export async function correctOutcome(
	requestKey: string,
	expectedRevision: string,
	input: unknown,
): Promise<Outcome<OutcomeMutation>> {
	const v = await taskViewer();
	if (!v) return denied;
	return write(v, (w, tx, ctx) => w.correctOutcome(tx, ctx, { requestKey, expectedRevision, input }));
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
