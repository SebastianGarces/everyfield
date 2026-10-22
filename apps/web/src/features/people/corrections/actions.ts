"use server";

import { personId } from "@everyfield/contracts/common";
import * as c from "@everyfield/contracts/people";
import { peopleMerge, peopleUnmerge, recordCorrections } from "@everyfield/domain/people";
import { z } from "zod";
import { boundary, outcome, receipt, type Receipt } from "../boundary.ts";
import type { Outcome } from "../model.ts";
import { loadPerson, read, write, type Viewer } from "../server.ts";
import type { PersonFields } from "../fields/model.ts";
import type { PersonRecords } from "../assessments/model.ts";
import {
	readPair,
	readRecords,
	readUnmerge,
	type DuplicateHints,
	type PairView,
	type Records,
	type UnmergeView,
} from "./server.ts";

// Server actions behind the duplicate review, merge, Unmerge and correction screens. Each one rebuilds the viewer, parses
// the browser's input with the WP-015 contract schemas, calls the producer and answers with an Outcome. A database
// failure reads as "lost": the screen may send the same request key again, and the producer replays a write that did
// commit instead of acting twice.

type PlantPerson = z.infer<typeof c.plantPerson>;
const pairRequest = z.strictObject({ person: personId, with: personId, keep: personId.nullable() });

/** The review again, after the reviewed state changed or the reviewer chose the other person to keep. */
export async function reviewPair(query: unknown): Promise<Outcome<PairView>> {
	return boundary(pairRequest, query, async (v, q): Promise<Outcome<PairView>> => {
		const r = await read(v, async (tx, ctx) => ({ status: "ok", value: await readPair(tx, ctx, q) }));
		return r.status === "ok" ? { status: "ok", value: r.value } : { status: "lost" };
	});
}

export type Merged = z.infer<typeof c.mergeResult>;
export async function mergePair(requestKey: string, input: unknown): Promise<Outcome<Merged>> {
	return boundary(c.mergePeopleRequest, { requestKey, input }, async (v, request) =>
		outcome(await write(v, (tx, ctx) => peopleMerge.mergePeople(tx, ctx, request)), (r) => r),
	);
}

/**
 * Where a person's links lead now. After a merge whose answer was lost, this says whether the merge happened, so the
 * screen never claims a merge failed when it did not.
 */
export async function mergeDestination(sourceId: string): Promise<Outcome<z.infer<typeof c.mergedPersonDestination>>> {
	return boundary(c.mergedPersonDestinationRequest, { personId: sourceId }, async (v, request) =>
		outcome(await read(v, (tx, ctx) => peopleMerge.mergedPersonDestination(tx, ctx, request)), (r) => r),
	);
}

export async function unmergePreview(mergeId: string): Promise<Outcome<UnmergeView>> {
	return boundary(c.unmergePreviewRequest, { mergeId }, async (v, request) =>
		outcome(await read(v, (tx, ctx) => readUnmerge(tx, ctx, request.mergeId)), (r) => r),
	);
}

type PersonId = z.infer<typeof c.personRequest>["personId"];
export type PersonPage = {
	person: PlantPerson;
	activities: z.infer<typeof c.activitiesResult> | null;
	fields: PersonFields | null;
	records: PersonRecords | null;
	duplicates: DuplicateHints | null;
};
/**
 * The whole person page again, after an Unmerge moved records, tags, skills and the household back to the other person:
 * the same one-statement read as the page itself (C84: Unmerge with its refresh stays under one second). Null when it
 * did not read.
 */
async function readPersonPageNow(v: Viewer, personId: PersonId): Promise<PersonPage | null> {
	const r = await loadPerson(v, personId);
	if (r.status !== "ok") return null;
	const { found, activities, fields, records, duplicates } = r.value;
	if (found.status !== "available" || !("stage" in found.person)) return null;
	return {
		person: found.person,
		activities: activities?.status === "ok" ? activities.value : null,
		fields,
		records,
		duplicates,
	};
}

/**
 * The Unmerge answer carries the survivor's page as the Unmerge left it, so one request both confirms the Unmerge and
 * lets the page show what moved back (C84). `page` is null when the write is saved but the page did not read.
 */
export type Unmerged = { result: z.infer<typeof c.unmergeResult>; receipt: Receipt; page: PersonPage | null };
export async function unmergePair(
	requestKey: string,
	expectedRevision: string,
	mergeId: string,
): Promise<Outcome<Unmerged>> {
	return boundary(c.unmergePeopleRequest, { requestKey, expectedRevision, input: { mergeId } }, async (v, request) => {
		const done = outcome(await write(v, (tx, ctx) => peopleUnmerge.unmergePeople(tx, ctx, request)), (r) => r);
		if (done.status !== "ok") return done;
		const page = await readPersonPageNow(v, done.value.survivorId).catch(() => null);
		return { status: "ok", value: { result: done.value, receipt: receipt(done.value), page } };
	});
}

/** The person page again, for an Unmerge found to have run after its own answer was lost. */
export async function loadPersonPage(personId: string): Promise<Outcome<PersonPage>> {
	return boundary(c.personRequest, { personId }, async (v, request): Promise<Outcome<PersonPage>> => {
		const page = await readPersonPageNow(v, request.personId).catch(() => null);
		return page ? { status: "ok", value: page } : { status: "lost" };
	});
}

export async function loadRecords(id: string): Promise<Outcome<Records>> {
	return boundary(c.personRequest, { personId: id }, async (v, request) =>
		outcome(await read(v, (tx, ctx) => readRecords(tx, ctx, request.personId)), (r) => r),
	);
}

export type Corrected = { result: z.infer<typeof c.correctionResult>; receipt: Receipt };
export async function correctRecord(
	requestKey: string,
	expectedRevision: string,
	input: unknown,
): Promise<Outcome<Corrected>> {
	return boundary(c.correctPersonRecordRequest, { requestKey, expectedRevision, input }, async (v, request) =>
		outcome(await write(v, (tx, ctx) => recordCorrections.correctPersonRecord(tx, ctx, request)), (r) => ({
			result: r,
			receipt: receipt(r),
		})),
	);
}
