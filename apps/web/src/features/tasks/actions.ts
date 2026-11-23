"use server";

import * as c from "@everyfield/contracts/tasks";
import { z } from "zod";
import type { BulkResult, OfferAnswered, Outcome, Saved, TemplateImport } from "./model.ts";
import { seated, type PlantSeat } from "@/server/request-context";
import { write } from "./server.ts";

const invalid = { status: "refused", code: "invalid_input" } as const;

const saved = (r: z.infer<typeof c.taskMutation> & { successor?: z.infer<typeof c.taskDetail> | null }): Saved => ({
	task: r.task,
	receiptId: r.receiptId,
	changed: r.outcome === "changed",
	recounted: r.recounted,
	...(r.successor !== undefined ? { successor: r.successor } : {}),
});
const savedOf = <T extends Parameters<typeof saved>[0]>(r: Outcome<T>): Outcome<Saved> =>
	r.status === "ok" ? { status: "ok", value: saved(r.value) } : r;

export async function createTask(requestKey: string, input: unknown): Promise<Outcome<Saved>> {
	return seated("access_denied", async (v) =>
		savedOf(await write(v, (w, tx, ctx) => w.create(tx, ctx, { requestKey, input }))),
	);
}

export async function editTask(
	requestKey: string,
	expectedRevision: string,
	taskId: string,
	patch: unknown,
): Promise<Outcome<Saved>> {
	const request = { requestKey, expectedRevision, input: { taskId, patch } };
	return seated("access_denied", async (v) => savedOf(await write(v, (w, tx, ctx) => w.edit(tx, ctx, request))));
}

export async function deleteTask(
	requestKey: string,
	expectedRevision: string,
	taskId: string,
): Promise<Outcome<Saved>> {
	const request = { requestKey, expectedRevision, input: { taskId } };
	return seated("access_denied", async (v) => savedOf(await write(v, (w, tx, ctx) => w.delete(tx, ctx, request))));
}

const statusAction = z.discriminatedUnion("kind", [
	z.object({ kind: z.literal("complete") }),
	z.object({ kind: z.literal("reopen") }),
	z.object({ kind: z.literal("waive"), reason: z.string().nullable() }),
	z.object({ kind: z.literal("status"), status: z.enum(["not_started", "in_progress", "blocked"]) }),
]);
export type StatusAction = z.input<typeof statusAction>;

export async function changeTaskStatus(
	requestKey: string,
	expectedRevision: string,
	taskId: string,
	raw: unknown,
): Promise<Outcome<Saved>> {
	const parsed = statusAction.safeParse(raw);
	if (!parsed.success) return invalid;
	const action = parsed.data;
	const envelope = { requestKey, expectedRevision };
	const run = <T extends Parameters<typeof saved>[0]>(fn: (v: PlantSeat) => Promise<Outcome<T>>) =>
		seated("access_denied", async (v) => savedOf(await fn(v)));
	switch (action.kind) {
		case "complete":
			return run((v) => write(v, (w, tx, ctx) => w.completeOccurrence(tx, ctx, { ...envelope, input: { taskId } })));
		case "reopen":
			return run((v) => write(v, (w, tx, ctx) => w.reopen(tx, ctx, { ...envelope, input: { taskId } })));
		case "waive": {
			const input = { taskId, reason: action.reason };
			return run((v) => write(v, (w, tx, ctx) => w.waive(tx, ctx, { ...envelope, input })));
		}
		case "status": {
			const input = { taskId, status: action.status };
			return run((v) => write(v, (w, tx, ctx) => w.changeStatus(tx, ctx, { ...envelope, input })));
		}
	}
}

export async function addStep(
	requestKey: string,
	parentRevision: string,
	parentId: string,
	title: string,
	assigneeIds?: unknown,
): Promise<Outcome<Saved>> {
	const input = { parentId, title, ...(assigneeIds !== undefined ? { assigneeIds } : {}) };
	return seated("access_denied", async (v) =>
		savedOf(
			await write(v, (w, tx, ctx) => w.createSubtask(tx, ctx, { requestKey, expectedRevision: parentRevision, input })),
		),
	);
}

export async function setStep(
	requestKey: string,
	expectedRevision: string,
	parentId: string,
	taskId: string,
	complete: boolean,
): Promise<Outcome<Saved>> {
	const input = { parentId, taskId, complete };
	return seated("access_denied", async (v) =>
		savedOf(await write(v, (w, tx, ctx) => w.setSubtaskCompletion(tx, ctx, { requestKey, expectedRevision, input }))),
	);
}

export async function removeStep(
	requestKey: string,
	expectedRevision: string,
	parentId: string,
	taskId: string,
): Promise<Outcome<Saved>> {
	return seated("access_denied", async (v) =>
		savedOf(
			await write(v, (w, tx, ctx) =>
				w.removeSubtask(tx, ctx, { requestKey, expectedRevision, input: { parentId, taskId } }),
			),
		),
	);
}

export async function setPrerequisites(
	requestKey: string,
	expectedRevision: string,
	taskId: string,
	prerequisiteIds: unknown,
): Promise<Outcome<Saved>> {
	return seated("access_denied", async (v) =>
		savedOf(
			await write(v, (w, tx, ctx) =>
				w.replacePrerequisites(tx, ctx, { requestKey, expectedRevision, input: { taskId, prerequisiteIds } }),
			),
		),
	);
}

export async function setRecurrence(
	requestKey: string,
	expectedRevision: string,
	taskId: string,
	rule: unknown,
): Promise<Outcome<Saved>> {
	return seated("access_denied", async (v) =>
		savedOf(
			await write(v, (w, tx, ctx) =>
				w.configureRecurrence(tx, ctx, { requestKey, expectedRevision, input: { taskId, rule } }),
			),
		),
	);
}

export async function bulkComplete(requestKey: string, items: unknown): Promise<Outcome<BulkResult>> {
	return seated("access_denied", (v) => write(v, (w, tx, ctx) => w.bulkComplete(tx, ctx, { requestKey, items })));
}
export async function bulkReschedule(requestKey: string, items: unknown, due: unknown): Promise<Outcome<BulkResult>> {
	return seated("access_denied", (v) =>
		write(v, (w, tx, ctx) => w.bulkReschedule(tx, ctx, { requestKey, items, due })),
	);
}

export async function importTemplate(requestKey: string, input: unknown): Promise<Outcome<TemplateImport>> {
	return seated("access_denied", (v) => write(v, (w, tx, ctx) => w.importTemplate(tx, ctx, { requestKey, input })));
}
const offerAnswer = z.object({ transitionId: z.unknown(), checklistKeys: z.array(z.unknown()) });
export async function answerOffer(requestKey: string, input: unknown): Promise<Outcome<OfferAnswered>> {
	const offer = offerAnswer.safeParse(input);
	if (!offer.success) return invalid;
	const { transitionId, checklistKeys } = offer.data;
	return seated("access_denied", (v) =>
		checklistKeys.length
			? write(v, (w, tx, ctx) => w.acceptPhaseOffer(tx, ctx, { requestKey, input }))
			: write(v, (w, tx, ctx) => w.declinePhaseOffer(tx, ctx, { requestKey, input: { transitionId } })),
	);
}
