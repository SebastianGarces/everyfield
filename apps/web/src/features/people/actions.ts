"use server";

import { getViewer } from "@/server/request-context";
import { tasksMount } from "../tasks/mount.ts";

import { recordId, revision } from "@everyfield/contracts/common";
import * as c from "@everyfield/contracts/people";
import { peopleReader, peopleWriter, readColumnOrders } from "@everyfield/domain/people";
import type { z } from "zod";
import { columnOf, parseQuery } from "./model.ts";
import type { Outcome } from "../../components/save/model.ts";
import { boundary, invalid, outcome, receipt, type Receipt } from "./boundary.ts";
import { loadPeople, loadPerson, read, write, type PeopleView } from "./server.ts";

type PlantPerson = z.infer<typeof c.plantPerson>;
const unplanned = { status: "refused", code: "unavailable" } as const;
type Saved = { person: PlantPerson; receipt: Receipt };
type NoteSaved = {
	personRevision: z.infer<typeof revision>;
	receipt: Receipt;
	note: { id: z.infer<typeof recordId>; revision: z.infer<typeof revision> };
};
export type { Receipt };

export async function reloadPerson(
	personId: string,
): Promise<Outcome<{ person: PlantPerson; activities: z.infer<typeof c.activitiesResult> | null }>> {
	return boundary(c.personRequest, { personId }, async (v, request) => {
		const r = outcome(await loadPerson(v, request.personId, false), (page) => page);
		if (r.status !== "ok") return r;
		const { found, activities } = r.value;
		if (found.status !== "available" || !("stage" in found.person)) return { status: "refused", code: "unavailable" };
		return {
			status: "ok",
			value: { person: found.person, activities: activities?.status === "ok" ? activities.value : null },
		};
	});
}

export async function loadPeopleView(search: unknown): Promise<PeopleView | null> {
	const v = await getViewer();
	if (!v?.people || typeof search !== "string" || search.length > 16_384) return null;
	return loadPeople(v.people, parseQuery(new URLSearchParams(search)));
}

export async function createPerson(requestKey: string, input: unknown): Promise<Outcome<{ personId: string }>> {
	return boundary(c.createPersonRequest, { requestKey, input }, async (v, request) =>
		outcome(await write(v, (tx, ctx) => peopleWriter.createPerson(tx, ctx, request)), (r) => ({
			personId: r.person.id,
		})),
	);
}

export async function updatePerson(
	requestKey: string,
	expectedRevision: string,
	personId: string,
	patch: unknown,
): Promise<Outcome<Saved>> {
	return boundary(
		c.updatePersonRequest,
		{ requestKey, expectedRevision, input: { personId, patch } },
		async (v, request) =>
			outcome(await write(v, (tx, ctx) => peopleWriter.updatePerson(tx, ctx, request)), (r) => ({
				person: r.person,
				receipt: receipt(r),
			})),
	);
}

export async function statusWarnings(personId: string): Promise<Outcome<z.infer<typeof c.statusWarningsResult>>> {
	return boundary(c.personRequest, { personId }, async (v, request) =>
		outcome(await read(v, (tx, ctx) => peopleReader.getStatusWarnings(tx, ctx, request)), (r) => r),
	);
}

type ColumnOrder = Awaited<ReturnType<typeof readColumnOrders>>[number];

export async function changeStatus(
	requestKey: string,
	expectedRevision: string,
	input: unknown,
	from?: unknown,
): Promise<Outcome<Saved & { columns: ColumnOrder[] }>> {
	const left = c.pipelineColumn.safeParse(from);
	return boundary(c.changeStatusRequest, { requestKey, expectedRevision, input }, async (v, request) => {
		const reminders = tasksMount()?.reminders;
		if (!reminders) return unplanned;
		return outcome(
			await write(v, async (tx, ctx) => {
				const done = await peopleWriter.changeStatus(tx, ctx, request, reminders);
				if (done.status !== "ok") return done;
				const joined = columnOf(done.value.person.stage);
				const touched = left.success && left.data !== joined ? [joined, left.data] : [joined];
				return {
					status: "ok",
					value: {
						person: done.value.person,
						columns: await readColumnOrders(tx, ctx, touched),
						receipt: receipt(done.value),
					},
				};
			}),
			(r) => r,
		);
	});
}

export async function retirePerson(
	requestKey: string,
	expectedRevision: string,
	input: unknown,
): Promise<Outcome<Saved>> {
	return boundary(c.retirePersonRequest, { requestKey, expectedRevision, input }, async (v, request) => {
		const reminders = tasksMount()?.reminders;
		if (!reminders) return unplanned;
		return outcome(await write(v, (tx, ctx) => peopleWriter.retirePerson(tx, ctx, request, reminders)), (r) => ({
			person: r.person,
			receipt: receipt(r),
		}));
	});
}

export async function restorePerson(
	requestKey: string,
	expectedRevision: string,
	personId: string,
): Promise<Outcome<Saved>> {
	return boundary(c.restorePersonRequest, { requestKey, expectedRevision, input: { personId } }, async (v, request) =>
		outcome(await write(v, (tx, ctx) => peopleWriter.restorePerson(tx, ctx, request)), (r) => ({
			person: r.person,
			receipt: receipt(r),
		})),
	);
}

export async function classifyAdult(
	requestKey: string,
	expectedRevision: string,
	correction: boolean,
	input: unknown,
): Promise<Outcome<Saved>> {
	return boundary(c.classifyAdultRequest, { requestKey, expectedRevision, input }, async (v, request) => {
		const method = correction ? peopleWriter.correctAdultClassification : peopleWriter.recordAdultClassification;
		return outcome(await write(v, (tx, ctx) => method(tx, ctx, request)), (r) => ({
			person: r.person,
			receipt: receipt(r),
		}));
	});
}

const noteSaved = (r: z.infer<typeof c.noteMutationResult>): NoteSaved => ({
	personRevision: r.personRevision,
	receipt: receipt(r),
	note: { id: r.noteId, revision: r.revision },
});
export async function addNote(
	requestKey: string,
	expectedRevision: string,
	input: unknown,
): Promise<Outcome<NoteSaved>> {
	return boundary(c.addNoteRequest, { requestKey, expectedRevision, input }, async (v, request) =>
		outcome(await write(v, (tx, ctx) => peopleWriter.addNote(tx, ctx, request)), noteSaved),
	);
}
export async function editNote(
	requestKey: string,
	expectedRevision: string,
	input: unknown,
): Promise<Outcome<NoteSaved>> {
	return boundary(c.editNoteRequest, { requestKey, expectedRevision, input }, async (v, request) =>
		outcome(await write(v, (tx, ctx) => peopleWriter.editNote(tx, ctx, request)), noteSaved),
	);
}
export async function deleteNote(
	requestKey: string,
	expectedRevision: string,
	input: unknown,
): Promise<Outcome<NoteSaved>> {
	return boundary(c.deleteNoteRequest, { requestKey, expectedRevision, input }, async (v, request) =>
		outcome(await write(v, (tx, ctx) => peopleWriter.deleteNote(tx, ctx, request)), noteSaved),
	);
}

export async function loadActivities(personId: string, page = 1): Promise<Outcome<z.infer<typeof c.activitiesResult>>> {
	return boundary(c.activityRequest, { personId, limit: 50, page }, async (v, request) =>
		outcome(await read(v, (tx, ctx) => peopleReader.getActivities(tx, ctx, request)), (r) => r),
	);
}

export async function loadColumn(
	query: Record<string, unknown>,
	column: string,
	page: number,
): Promise<Outcome<z.infer<typeof c.pipelineResult>["groups"][number]>> {
	const col = c.pipelineColumn.safeParse(column);
	if (!col.success) return invalid;
	return boundary(c.listPeopleRequest, { ...query, view: "pipeline", page, column: col.data }, async (v, request) =>
		outcome(await read(v, (tx, ctx) => peopleReader.getPipelineData(tx, ctx, request)), (r) =>
			r.groups.find((g) => g.column === col.data)!,
		),
	);
}

export async function reorderPipeline(
	requestKey: string,
	expectedRevision: string,
	input: unknown,
): Promise<Outcome<{ outcome: "changed" | "noop" } & ColumnOrder>> {
	return boundary(c.reorderPipelineRequest, { requestKey, expectedRevision, input }, async (v, request) =>
		outcome(
			await write(v, async (tx, ctx) => {
				const done = await peopleWriter.reorderPipeline(tx, ctx, request);
				if (done.status !== "ok") return done;
				const [column] = await readColumnOrders(tx, ctx, [request.input.column]);
				return { status: "ok", value: { outcome: done.value.outcome, ...column! } };
			}),
			(r) => r,
		),
	);
}
