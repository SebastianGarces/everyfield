"use server";

import { personId } from "@everyfield/contracts/common";
import * as c from "@everyfield/contracts/people";
import { peopleMerge, peopleUnmerge, recordCorrections } from "@everyfield/domain/people";
import { z } from "zod";
import { boundary, outcome, receipt, type Receipt } from "../boundary.ts";
import type { Outcome } from "../model.ts";
import { loadPerson, read, write } from "../server.ts";
import { readPair, readRecords, readUnmerge, type PairView, type Records, type UnmergeView } from "./server.ts";

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

export type Unmerged = {
	result: z.infer<typeof c.unmergeResult>;
	/** The survivor and their first Activity page as Unmerge left them, so the page shows the change without a reload. */
	person: PlantPerson | null;
	activities: z.infer<typeof c.activitiesResult> | null;
	receipt: Receipt;
};
export async function unmergePair(
	requestKey: string,
	expectedRevision: string,
	mergeId: string,
): Promise<Outcome<Unmerged>> {
	return boundary(c.unmergePeopleRequest, { requestKey, expectedRevision, input: { mergeId } }, async (v, request) => {
		const done = outcome(await write(v, (tx, ctx) => peopleUnmerge.unmergePeople(tx, ctx, request)), (r) => r);
		if (done.status !== "ok") return done;
		const page = await loadPerson(v, done.value.survivorId, false);
		const found = page.status === "ok" ? page.value.found : null;
		return {
			status: "ok",
			value: {
				result: done.value,
				person: found?.status === "available" && "stage" in found.person ? found.person : null,
				activities: page.status === "ok" && page.value.activities?.status === "ok" ? page.value.activities.value : null,
				receipt: receipt(done.value),
			},
		};
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
