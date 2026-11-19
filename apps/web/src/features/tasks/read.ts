import * as c from "@everyfield/contracts/tasks";
import { taskReader } from "@everyfield/domain/tasks";
import "server-only";
import { z } from "zod";
import { defineReads } from "../../server/platform/reads.ts";
import { type Outcome } from "./model.ts";
import { loadTask, read, reader, taskViewer, templates } from "./server.ts";

const refusalOf = <T>(r: { status: "ok"; value: T } | { status: "refused"; error: c.TaskError }): Outcome<T> =>
	r.status === "ok" ? r : { status: "refused", code: r.error.code };

export const GET = defineReads(taskViewer, "access_denied", (get) => ({
	task: get(c.getTaskRequest, (viewer, v) => read((tx) => loadTask(tx, viewer, v.taskId))),
	history: get(c.statusHistoryRequest.omit({ limit: true }), (viewer, v) =>
		read((tx) => reader.history(tx, viewer, v.taskId, v.page)),
	),
	blocking: get(c.taskRowsRequest, async (viewer, v) => {
		const r = await read(async (tx) => refusalOf(await taskReader.listRows(tx, viewer.authority, v)));
		return r.status === "ok"
			? {
					status: "ok" as const,
					value: r.value.items.map((t) => ({ id: t.id, openPrerequisites: t.openPrerequisites })),
				}
			: r;
	}),
	rows: get(c.taskRowsRequest, (viewer, v) =>
		read(async (tx) => refusalOf(await taskReader.listRows(tx, viewer.authority, v))),
	),
	seats: get(c.eligibleAssigneesRequest, (viewer, v) =>
		read(async (tx) => refusalOf(await taskReader.eligibleAssignees(tx, viewer.authority, v))),
	),
	candidates: get(c.prerequisiteCandidatesRequest, (viewer, v) =>
		read(async (tx) => refusalOf(await taskReader.prerequisiteCandidates(tx, viewer.authority, v))),
	),
	relations: get(c.relationOptionsRequest, (viewer, v) =>
		read(async (tx) => refusalOf(await taskReader.relationOptions(tx, viewer.authority, v))),
	),
	templates: get(z.undefined(), (viewer) =>
		read(async (tx) => refusalOf(await templates.listTemplates(tx, viewer.authority, {}))),
	),
	preview: get(c.previewTemplateRequest, (viewer, v) =>
		read(async (tx) => refusalOf(await templates.previewTemplate(tx, viewer.authority, v))),
	),
	offer: get(c.readPhaseOfferRequest, (viewer, v) => read((tx) => reader.offer(tx, viewer, v.transitionId))),
}));
