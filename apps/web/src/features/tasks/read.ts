import * as c from "@everyfield/contracts/tasks";
import { taskReader } from "@everyfield/domain/tasks";
import "server-only";
import { z } from "zod";
import { defineReads } from "../../server/platform/reads.ts";
import { outcomeOf } from "@everyfield/contracts/common";
import { plantSeat } from "@/server/request-context";
import { readTx } from "../../server/platform/tx.ts";
import { loadTask, reader, templates } from "./server.ts";

export const GET = defineReads(plantSeat, "access_denied", (get) => ({
	task: get(c.getTaskRequest, (viewer, v) => readTx("tasks", (tx) => loadTask(tx, viewer, v.taskId))),
	history: get(c.statusHistoryRequest.omit({ limit: true }), (viewer, v) =>
		readTx("tasks", (tx) => reader.history(tx, viewer, v.taskId, v.page)),
	),
	rows: get(c.taskRowsRequest, (viewer, v) =>
		readTx("tasks", async (tx) => outcomeOf(await taskReader.listRows(tx, viewer.authority, v))),
	),
	seats: get(c.eligibleAssigneesRequest, (viewer, v) =>
		readTx("tasks", async (tx) => outcomeOf(await taskReader.eligibleAssignees(tx, viewer.authority, v))),
	),
	candidates: get(c.prerequisiteCandidatesRequest, (viewer, v) =>
		readTx("tasks", async (tx) => outcomeOf(await taskReader.prerequisiteCandidates(tx, viewer.authority, v))),
	),
	relations: get(c.relationOptionsRequest, (viewer, v) =>
		readTx("tasks", async (tx) => outcomeOf(await taskReader.relationOptions(tx, viewer.authority, v))),
	),
	templates: get(z.undefined(), (viewer) =>
		readTx("tasks", async (tx) => outcomeOf(await templates.listTemplates(tx, viewer.authority, {}))),
	),
	preview: get(c.previewTemplateRequest, (viewer, v) =>
		readTx("tasks", async (tx) => outcomeOf(await templates.previewTemplate(tx, viewer.authority, v))),
	),
	offer: get(c.readPhaseOfferRequest, (viewer, v) => readTx("tasks", (tx) => reader.offer(tx, viewer, v.transitionId))),
}));
