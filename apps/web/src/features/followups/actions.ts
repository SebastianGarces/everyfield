"use server";

import type * as tc from "@everyfield/contracts/tasks";
import type { z } from "zod";
import type { Outcome } from "@everyfield/contracts/common";
import type { HandoffResult, OutcomeMutation } from "./model.ts";
import { seated } from "@/server/request-context";
import { write } from "./server.ts";

type TaskMutation = z.infer<typeof tc.taskMutation>;

export async function recordOutcome(requestKey: string, input: unknown): Promise<Outcome<OutcomeMutation>> {
	return seated("access_denied", (v) => write(v, (w, tx, ctx) => w.recordOutcome(tx, ctx, { requestKey, input })));
}

export async function correctOutcome(
	requestKey: string,
	expectedRevision: string,
	input: unknown,
): Promise<Outcome<OutcomeMutation>> {
	return seated("access_denied", (v) =>
		write(v, (w, tx, ctx) => w.correctOutcome(tx, ctx, { requestKey, expectedRevision, input })),
	);
}

export async function createFollowUp(requestKey: string, input: unknown): Promise<Outcome<TaskMutation>> {
	return seated("access_denied", (v) => write(v, (w, tx, ctx) => w.createFollowUp(tx, ctx, { requestKey, input })));
}

export async function assignFollowUp(
	requestKey: string,
	expectedRevision: string,
	input: unknown,
): Promise<Outcome<TaskMutation>> {
	return seated("access_denied", (v) =>
		write(v, (w, tx, ctx) => w.assignFollowUp(tx, ctx, { requestKey, expectedRevision, input })),
	);
}

export async function executeHandoff(requestKey: string, input: unknown): Promise<Outcome<HandoffResult>> {
	return seated("access_denied", (v) => write(v, (w, tx, ctx) => w.executeHandoff(tx, ctx, { requestKey, input })));
}
