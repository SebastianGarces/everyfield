"use server";

import { getViewer } from "@/server/request-context";
import { tasksMount } from "@/server/tasks";

import { recordId, revision } from "@everyfield/contracts/common";
import * as c from "@everyfield/contracts/people";
import { peopleReader, peopleWriter, readColumnOrders } from "@everyfield/domain/people";
import type { z } from "zod";
import { columnOf, parseQuery } from "./model.ts";
import type { Outcome } from "../../components/save/model.ts";
import { boundary, invalid, outcome, receipt, type Receipt } from "./boundary.ts";
import { loadPeople, loadPerson, read, write, type PeopleView, type Viewer } from "./server.ts";

// Server actions behind the People screens: the browser boundary. Each one rebuilds the viewer from the request,
// parses the browser's input with the WP-011 contract schemas (a strict schema refuses any owner, account or authority
// field), calls the producer and answers with an Outcome. A database failure reads as "lost": the browser may retry
// with the same request key, and the producer replays a write that did commit instead of acting twice.

type PlantPerson = z.infer<typeof c.plantPerson>;
/**
 * A stage change or a retirement hands the person's open tasks to someone else, and their owed reminders follow them
 * through the tasks mount in the same transaction. A deployment without it cannot replan reminders, so these writes
 * are refused there and nothing is saved.
 */
const unplanned = { status: "refused", code: "unavailable" } as const;
type PersonId = z.infer<typeof c.personRequest>["personId"];
type Saved = { person: PlantPerson; receipt: Receipt };
/** A note change: the person as saved now, the note's ID and revision, and the receipt. */
type NoteSaved = Saved & { note: { id: z.infer<typeof recordId>; revision: z.infer<typeof revision> } };
export type { Receipt };

/** A fresh read of one plant person, for answers whose producer result has no person (classification, notes). */
async function plantPerson(v: Viewer, personId: PersonId): Promise<Outcome<PlantPerson>> {
	const r = outcome(await read(v, (tx, ctx) => peopleReader.getPerson(tx, ctx, { personId })), (r) => r);
	if (r.status !== "ok") return r;
	return r.value.status === "available" && "stage" in r.value.person
		? { status: "ok", value: r.value.person }
		: { status: "refused", code: "unavailable" };
}

/** A saved write whose producer result has no person: the person read again, then the answer built from both. */
async function withPerson<T, U>(
	v: Viewer,
	personId: PersonId,
	done: Outcome<T>,
	answer: (person: PlantPerson, value: T) => U,
): Promise<Outcome<U>> {
	if (done.status !== "ok") return done;
	const p = await plantPerson(v, personId);
	return p.status === "ok" ? { status: "ok", value: answer(p.value, done.value) } : p;
}

/**
 * The person page again after this screen's change was refused as out of date: the person and the first Activity page,
 * so the next try uses the latest revision. Only this person is read, never the whole page.
 */
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

/**
 * The People view for an address the screen has not loaded yet: the pipeline from the list, or the list from the
 * pipeline. Null when the viewer cannot read People; the screen then loads the page, which shows sign-in or the lock.
 */
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

/**
 * Changes a person's stage. The answer is the saved person and the columns the move touched, read in the same
 * transaction (D68): the column they joined and, when the pipeline names it, the column they left. Both revisions
 * move on with a change of column, so the pipeline shows what a reload would show, and its next move sends the
 * current revisions.
 */
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
		const done = outcome(await write(v, (tx, ctx) => method(tx, ctx, request)), (r) => r);
		return withPerson(v, request.input.personId, done, (person, r) => ({ person, receipt: receipt(r) }));
	});
}

// A note changes the person revision, so a note answer is the person as saved now, with the note's own revision.
const noteSaved = (person: PlantPerson, r: z.infer<typeof c.noteMutationResult>): NoteSaved => ({
	person,
	receipt: receipt(r),
	note: { id: r.noteId, revision: r.revision },
});
export async function addNote(
	requestKey: string,
	expectedRevision: string,
	input: unknown,
): Promise<Outcome<NoteSaved>> {
	return boundary(c.addNoteRequest, { requestKey, expectedRevision, input }, async (v, request) => {
		const done = outcome(await write(v, (tx, ctx) => peopleWriter.addNote(tx, ctx, request)), (r) => r);
		return withPerson(v, request.input.personId, done, noteSaved);
	});
}
export async function editNote(
	requestKey: string,
	expectedRevision: string,
	input: unknown,
): Promise<Outcome<NoteSaved>> {
	return boundary(c.editNoteRequest, { requestKey, expectedRevision, input }, async (v, request) => {
		const done = outcome(await write(v, (tx, ctx) => peopleWriter.editNote(tx, ctx, request)), (r) => r);
		return withPerson(v, request.input.personId, done, noteSaved);
	});
}
export async function deleteNote(
	requestKey: string,
	expectedRevision: string,
	input: unknown,
): Promise<Outcome<NoteSaved>> {
	return boundary(c.deleteNoteRequest, { requestKey, expectedRevision, input }, async (v, request) => {
		const done = outcome(await write(v, (tx, ctx) => peopleWriter.deleteNote(tx, ctx, request)), (r) => r);
		return withPerson(v, request.input.personId, done, noteSaved);
	});
}

export async function loadActivities(personId: string, page = 1): Promise<Outcome<z.infer<typeof c.activitiesResult>>> {
	return boundary(c.activityRequest, { personId, limit: 50, page }, async (v, request) =>
		outcome(await read(v, (tx, ctx) => peopleReader.getActivities(tx, ctx, request)), (r) => r),
	);
}

/** One page of one pipeline column. */
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

/**
 * Places one person in a pipeline column, after another person or first. The
 * answer is that column as it stands after the command, read in the same transaction after the producer locked the
 * column row: its order and its revision, never the whole pipeline (D68). A replayed request (same key after a lost
 * answer) may answer with a later actor's order; the pair still matches, so a next move can never pair an old order
 * with a newer revision.
 */
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
