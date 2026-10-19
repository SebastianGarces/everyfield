"use server";

import * as c from "@everyfield/contracts/people";
import { peopleReader, peopleWriter } from "@everyfield/domain/people";
import type { z } from "zod";
import { parseQuery, type Outcome } from "./model.ts";
import { loadPeople, read, resolveViewer, write, type PeopleView, type Viewer } from "./server.ts";

// Server actions behind the People screens: the browser boundary. Each one rebuilds the viewer from the request,
// parses the browser's input with the WP-011 contract schemas (a strict schema refuses any owner, account or authority
// field), calls the producer and answers with an Outcome. A database failure reads as "lost": the browser may retry
// with the same request key, and the producer replays a write that did commit instead of acting twice.

type PlantPerson = z.infer<typeof c.plantPerson>;
type PersonId = z.infer<typeof c.personRequest>["personId"];
type Reply<T> = Awaited<ReturnType<typeof read<T>>>;
const denied = { status: "refused", code: "access_denied" } as const;
const invalid = { status: "refused", code: "invalid_input" } as const;

function outcome<T, U>(reply: Reply<T>, map: (value: T) => U): Outcome<U> {
	if (reply.status === "failed") return { status: "lost" };
	if (reply.status === "refused") return { status: "refused", code: reply.error.code };
	return { status: "ok", value: map(reply.value) };
}

/** Rebuilds the viewer and parses the raw input; refuses before any database work when either fails. */
async function boundary<S extends z.ZodType, T>(
	schema: S,
	raw: unknown,
	run: (viewer: Viewer, input: z.output<S>) => Promise<Outcome<T>>,
): Promise<Outcome<T>> {
	const v = await resolveViewer();
	if (v.status !== "viewer") return denied;
	const input = schema.safeParse(raw);
	if (!input.success) return invalid;
	return run(v.viewer, input.data);
}

/** A fresh read of one plant person, for answers whose producer result has no person (classification, notes). */
async function plantPerson(v: Viewer, personId: PersonId): Promise<Outcome<PlantPerson>> {
	const r = outcome(await read(v, (tx, ctx) => peopleReader.getPerson(tx, ctx, { personId })), (r) => r);
	if (r.status !== "ok") return r;
	return r.value.status === "available" && "stage" in r.value.person
		? { status: "ok", value: r.value.person }
		: { status: "refused", code: "unavailable" };
}

/**
 * The People view for an address the screen has not loaded yet: the pipeline from the list, or the list from the
 * pipeline. Null when the viewer cannot read People; the screen then loads the page, which shows sign-in or the lock.
 */
export async function loadPeopleView(search: unknown): Promise<PeopleView | null> {
	const v = await resolveViewer();
	if (v.status !== "viewer" || typeof search !== "string" || search.length > 16_384) return null;
	return loadPeople(v.viewer, parseQuery(new URLSearchParams(search)));
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
): Promise<Outcome<PlantPerson>> {
	return boundary(
		c.updatePersonRequest,
		{ requestKey, expectedRevision, input: { personId, patch } },
		async (v, request) =>
			outcome(await write(v, (tx, ctx) => peopleWriter.updatePerson(tx, ctx, request)), (r) => r.person),
	);
}

export async function statusWarnings(personId: string): Promise<Outcome<z.infer<typeof c.statusWarningsResult>>> {
	return boundary(c.personRequest, { personId }, async (v, request) =>
		outcome(await read(v, (tx, ctx) => peopleReader.getStatusWarnings(tx, ctx, request)), (r) => r),
	);
}

export async function changeStatus(
	requestKey: string,
	expectedRevision: string,
	input: unknown,
): Promise<Outcome<PlantPerson>> {
	return boundary(c.changeStatusRequest, { requestKey, expectedRevision, input }, async (v, request) =>
		outcome(await write(v, (tx, ctx) => peopleWriter.changeStatus(tx, ctx, request)), (r) => r.person),
	);
}

export async function retirePerson(
	requestKey: string,
	expectedRevision: string,
	input: unknown,
): Promise<Outcome<PlantPerson>> {
	return boundary(c.retirePersonRequest, { requestKey, expectedRevision, input }, async (v, request) =>
		outcome(await write(v, (tx, ctx) => peopleWriter.retirePerson(tx, ctx, request)), (r) => r.person),
	);
}

export async function restorePerson(
	requestKey: string,
	expectedRevision: string,
	personId: string,
): Promise<Outcome<PlantPerson>> {
	return boundary(c.restorePersonRequest, { requestKey, expectedRevision, input: { personId } }, async (v, request) =>
		outcome(await write(v, (tx, ctx) => peopleWriter.restorePerson(tx, ctx, request)), (r) => r.person),
	);
}

export async function classifyAdult(
	requestKey: string,
	expectedRevision: string,
	correction: boolean,
	input: unknown,
): Promise<Outcome<PlantPerson>> {
	return boundary(c.classifyAdultRequest, { requestKey, expectedRevision, input }, async (v, request) => {
		const method = correction ? peopleWriter.correctAdultClassification : peopleWriter.recordAdultClassification;
		const done = outcome(await write(v, (tx, ctx) => method(tx, ctx, request)), () => null);
		return done.status === "ok" ? plantPerson(v, request.input.personId) : done;
	});
}

// A note changes the person revision, so a note answer is the person as saved now.
export async function addNote(
	requestKey: string,
	expectedRevision: string,
	input: unknown,
): Promise<Outcome<PlantPerson>> {
	return boundary(c.addNoteRequest, { requestKey, expectedRevision, input }, async (v, request) => {
		const done = outcome(await write(v, (tx, ctx) => peopleWriter.addNote(tx, ctx, request)), () => null);
		return done.status === "ok" ? plantPerson(v, request.input.personId) : done;
	});
}
export async function editNote(
	requestKey: string,
	expectedRevision: string,
	input: unknown,
): Promise<Outcome<PlantPerson>> {
	return boundary(c.editNoteRequest, { requestKey, expectedRevision, input }, async (v, request) => {
		const done = outcome(await write(v, (tx, ctx) => peopleWriter.editNote(tx, ctx, request)), () => null);
		return done.status === "ok" ? plantPerson(v, request.input.personId) : done;
	});
}
export async function deleteNote(
	requestKey: string,
	expectedRevision: string,
	input: unknown,
): Promise<Outcome<PlantPerson>> {
	return boundary(c.deleteNoteRequest, { requestKey, expectedRevision, input }, async (v, request) => {
		const done = outcome(await write(v, (tx, ctx) => peopleWriter.deleteNote(tx, ctx, request)), () => null);
		return done.status === "ok" ? plantPerson(v, request.input.personId) : done;
	});
}

export async function loadActivities(
	personId: string,
	after?: string,
): Promise<Outcome<z.infer<typeof c.activitiesResult>>> {
	return boundary(c.activityRequest, { personId, limit: 50, ...(after ? { after } : {}) }, async (v, request) =>
		outcome(await read(v, (tx, ctx) => peopleReader.getActivities(tx, ctx, request)), (r) => r),
	);
}

/** The next page of one pipeline column. The producer advances only the column the cursor belongs to. */
export async function loadColumn(
	query: Record<string, unknown>,
	column: string,
	after: string,
): Promise<Outcome<z.infer<typeof c.pipelineResult>["groups"][number]>> {
	const col = c.pipelineColumn.safeParse(column);
	if (!col.success) return invalid;
	return boundary(c.listPeopleRequest, { ...query, view: "pipeline", after }, async (v, request) =>
		outcome(await read(v, (tx, ctx) => peopleReader.getPipelineData(tx, ctx, request)), (r) =>
			r.groups.find((g) => g.column === col.data)!,
		),
	);
}

/**
 * Saves a new order for one pipeline column. The list holds every live person in that column, in the new order. The
 * answer is the column as it stands after the command: its order and its revision, from one read in the same
 * transaction, after the producer has locked the column row (FOR UPDATE). The page shows exactly that pair. A replayed
 * request (same key after a lost answer) may answer with a later actor's order; the pair still matches, so a next move
 * can never pair an old order with a newer revision.
 */
export async function reorderPipeline(
	requestKey: string,
	expectedRevision: string,
	input: unknown,
): Promise<Outcome<{ outcome: "changed" | "noop"; revision: string; personIds: string[] }>> {
	return boundary(c.reorderPipelineRequest, { requestKey, expectedRevision, input }, async (v, request) =>
		outcome(
			await write(v, async (tx, ctx) => {
				const done = await peopleWriter.reorderPipeline(tx, ctx, request);
				if (done.status !== "ok") return done;
				const now = await peopleReader.getPipelineData(
					tx,
					{ session: ctx.session, selected: ctx.selected, purpose: "native" },
					c.listPeopleRequest.parse({ limit: 100, view: "pipeline" }),
				);
				if (now.status !== "ok") return now;
				const group = now.value.groups.find((g) => g.column === request.input.column)!;
				return {
					status: "ok",
					value: {
						outcome: done.value.outcome,
						revision: group.revision,
						personIds: group.cards.map((x) => x.person.id),
					},
				};
			}),
			(r) => r,
		),
	);
}
