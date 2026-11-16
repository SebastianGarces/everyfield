"use server";

import type * as tc from "@everyfield/contracts/tasks";
import type { z } from "zod";
import type { HandoffResult, Outcome, OutcomeMutation } from "./model.ts";
import { taskViewer, write } from "./server.ts";

type TaskMutation = z.infer<typeof tc.taskMutation>;
const denied = { status: "refused", code: "access_denied" } as const;

export async function recordOutcome(requestKey: string, input: unknown): Promise<Outcome<OutcomeMutation>> {
	const v = await taskViewer();
	if (!v) return denied;
	return write(v, (w, tx, ctx) => w.recordOutcome(tx, ctx, { requestKey, input }));
}

export async function correctOutcome(
	requestKey: string,
	expectedRevision: string,
	input: unknown,
): Promise<Outcome<OutcomeMutation>> {
	const v = await taskViewer();
	if (!v) return denied;
	return write(v, (w, tx, ctx) => w.correctOutcome(tx, ctx, { requestKey, expectedRevision, input }));
}

export async function createFollowUp(requestKey: string, input: unknown): Promise<Outcome<TaskMutation>> {
	const v = await taskViewer();
	if (!v) return denied;
	return write(v, (w, tx, ctx) => w.createFollowUp(tx, ctx, { requestKey, input }));
}

export async function assignFollowUp(
	requestKey: string,
	expectedRevision: string,
	input: unknown,
): Promise<Outcome<TaskMutation>> {
	const v = await taskViewer();
	if (!v) return denied;
	return write(v, (w, tx, ctx) => w.assignFollowUp(tx, ctx, { requestKey, expectedRevision, input }));
}

export async function executeHandoff(requestKey: string, input: unknown): Promise<Outcome<HandoffResult>> {
	const v = await taskViewer();
	if (!v) return denied;
	return write(v, (w, tx, ctx) => w.executeHandoff(tx, ctx, { requestKey, input }));
}
