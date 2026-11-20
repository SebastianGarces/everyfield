"use server";

import { seated } from "@/server/request-context";
import { tasksMount } from "../tasks/mount.ts";

import { recordId, revision } from "@everyfield/contracts/common";
import * as c from "@everyfield/contracts/people";
import { peopleWriter, readColumnOrders } from "@everyfield/domain/people";
import { z } from "zod";
import { columnOf } from "./model.ts";
import type { Outcome } from "../../components/save/model.ts";
import { outcome, parsed, receipt, type Receipt } from "./boundary.ts";
import { write } from "./server.ts";

type PlantPerson = z.infer<typeof c.plantPerson>;
type Saved = { person: PlantPerson; receipt: Receipt };
type NoteSaved = {
	personRevision: z.infer<typeof revision>;
	receipt: Receipt;
	note: { id: z.infer<typeof recordId>; revision: z.infer<typeof revision> };
};
export type { Receipt };

export async function createPerson(requestKey: string, input: unknown): Promise<Outcome<{ personId: string }>> {
	return seated("access_denied", async (v) =>
		outcome(await write(v, (tx, ctx) => peopleWriter.createPerson(tx, ctx, { requestKey, input })), (r) => ({
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
	return seated("access_denied", async (v) =>
		outcome(
			await write(v, (tx, ctx) =>
				peopleWriter.updatePerson(tx, ctx, { requestKey, expectedRevision, input: { personId, patch } }),
			),
			(r) => ({
				person: r.person,
				receipt: receipt(r),
			}),
		),
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
	return seated("access_denied", async (v) => {
		const { reminders } = tasksMount();
		return outcome(
			await write(v, async (tx, ctx) => {
				const done = await peopleWriter.changeStatus(tx, ctx, { requestKey, expectedRevision, input }, reminders);
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
	return seated("access_denied", async (v) => {
		const { reminders } = tasksMount();
		return outcome(
			await write(v, (tx, ctx) =>
				peopleWriter.retirePerson(tx, ctx, { requestKey, expectedRevision, input }, reminders),
			),
			(r) => ({
				person: r.person,
				receipt: receipt(r),
			}),
		);
	});
}

export async function restorePerson(
	requestKey: string,
	expectedRevision: string,
	personId: string,
): Promise<Outcome<Saved>> {
	return seated("access_denied", async (v) =>
		outcome(
			await write(v, (tx, ctx) =>
				peopleWriter.restorePerson(tx, ctx, { requestKey, expectedRevision, input: { personId } }),
			),
			(r) => ({
				person: r.person,
				receipt: receipt(r),
			}),
		),
	);
}

export async function classifyAdult(
	requestKey: string,
	expectedRevision: string,
	correction: boolean,
	input: unknown,
): Promise<Outcome<Saved>> {
	return seated("access_denied", async (v) => {
		const method = correction ? peopleWriter.correctAdultClassification : peopleWriter.recordAdultClassification;
		return outcome(await write(v, (tx, ctx) => method(tx, ctx, { requestKey, expectedRevision, input })), (r) => ({
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
	return seated("access_denied", async (v) =>
		outcome(
			await write(v, (tx, ctx) => peopleWriter.addNote(tx, ctx, { requestKey, expectedRevision, input })),
			noteSaved,
		),
	);
}
export async function editNote(
	requestKey: string,
	expectedRevision: string,
	input: unknown,
): Promise<Outcome<NoteSaved>> {
	return seated("access_denied", async (v) =>
		outcome(
			await write(v, (tx, ctx) => peopleWriter.editNote(tx, ctx, { requestKey, expectedRevision, input })),
			noteSaved,
		),
	);
}
export async function deleteNote(
	requestKey: string,
	expectedRevision: string,
	input: unknown,
): Promise<Outcome<NoteSaved>> {
	return seated("access_denied", async (v) =>
		outcome(
			await write(v, (tx, ctx) => peopleWriter.deleteNote(tx, ctx, { requestKey, expectedRevision, input })),
			noteSaved,
		),
	);
}

const reorderedColumn = z.object({ column: c.pipelineColumn });

export async function reorderPipeline(
	requestKey: string,
	expectedRevision: string,
	input: unknown,
): Promise<Outcome<{ outcome: "changed" | "noop" } & ColumnOrder>> {
	return parsed(reorderedColumn, input, async (v, { column: moved }) =>
		outcome(
			await write(v, async (tx, ctx) => {
				const done = await peopleWriter.reorderPipeline(tx, ctx, { requestKey, expectedRevision, input });
				if (done.status !== "ok") return done;
				const [column] = await readColumnOrders(tx, ctx, [moved]);
				if (!column) throw new Error("The reordered pipeline column has no order");
				return { status: "ok", value: { outcome: done.value.outcome, ...column } };
			}),
			(r) => r,
		),
	);
}
