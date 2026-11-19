"use server";

import * as c from "@everyfield/contracts/people";
import {
	dismissDuplicatePair,
	peopleMerge,
	peopleUnmerge,
	recordCorrections,
	restoreDuplicatePair,
} from "@everyfield/domain/people";
import type { z } from "zod";
import { boundary, outcome, receipt, type Receipt } from "../boundary.ts";
import type { Outcome } from "../../../components/save/model.ts";
import { write } from "../server.ts";
import { readPersonPageNow, type PersonPage } from "./page.ts";

export type PairChange = z.infer<typeof c.duplicatePairChange>;
export async function dismissPair(input: unknown): Promise<Outcome<PairChange>> {
	return boundary(c.duplicatePairRequest, input, async (v, request) =>
		outcome(await write(v, (tx, ctx) => dismissDuplicatePair(tx, ctx, request)), (r) => r),
	);
}
export async function restorePair(input: unknown): Promise<Outcome<PairChange>> {
	return boundary(c.duplicatePairRequest, input, async (v, request) =>
		outcome(await write(v, (tx, ctx) => restoreDuplicatePair(tx, ctx, request)), (r) => r),
	);
}

export type Merged = z.infer<typeof c.mergeResult>;
export async function mergePair(requestKey: string, input: unknown): Promise<Outcome<Merged>> {
	return boundary(c.mergePeopleRequest, { requestKey, input }, async (v, request) =>
		outcome(await write(v, (tx, ctx) => peopleMerge.mergePeople(tx, ctx, request)), (r) => r),
	);
}

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
