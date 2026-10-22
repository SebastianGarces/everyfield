import "server-only";
import type * as c from "@everyfield/contracts/people";
import type { PeopleContext } from "@everyfield/contracts/people";
import type { Transaction } from "@everyfield/db/client";
import {
	assessments,
	commitments,
	interviews,
	peopleMerge,
	peopleReader,
	peopleUnmerge,
	personFields,
	recordCorrections,
} from "@everyfield/domain/people";
import type { z } from "zod";
import { defaultSurvivor, fieldText, type Households, type MergeField } from "./model.ts";

// The reads behind the duplicate review, Unmerge preview and record corrections. Each one runs inside the caller's single
// read transaction (people/server.ts read()), so a screen read is one transaction with the reads it needs, never one
// request per part. They take the transaction, so the statement census can count them (tests/integration/writes).

type Review = z.infer<typeof c.mergeReview>;
type PersonResult = z.infer<typeof c.personResult>;
type PersonId = z.infer<typeof c.personRequest>["personId"];
export type PairQuery = { person: PersonId; with: PersonId; keep: PersonId | null };
export type PairPerson = { id: string; displayName: string; createdAt: string; linked: boolean };
export type Photos = Partial<Record<"source" | "survivor", string>>;
/** The duplicates page for one pair of people. */
export type PairView =
	| { kind: "ready"; review: Review; households: Households; photos: Photos; added: Record<string, string> }
	/** One of them was already merged into the other: show the result and the way back, never a second review. */
	| { kind: "merged"; source: { id: string; name: string }; survivor: { id: string; name: string } }
	/** Missing, retired, in another church or the same person twice: nothing to review. */
	| { kind: "unavailable" }
	| { kind: "failed" };

const available = (r: { status: string; value?: PersonResult }) =>
	r.status === "ok" && r.value?.status === "available" ? r.value.person : null;

/**
 * The review of `person` and `with`, with the person in `keep` (or the default, see defaultSurvivor) as the survivor.
 * Reads both people, the merge review and, only when those fields differ, the two households' names and photos.
 */
export async function readPair(tx: Transaction, ctx: PeopleContext, q: PairQuery): Promise<PairView> {
	if (q.person === q.with) return { kind: "unavailable" };
	const a = available(await peopleReader.getPerson(tx, ctx, { personId: q.person }));
	const b = available(await peopleReader.getPerson(tx, ctx, { personId: q.with }));
	if (!a || !b) return { kind: "unavailable" };
	for (const [x, y] of [
		[a, b],
		[b, a],
	] as const)
		if (x.lifecycle.state === "merged" && x.lifecycle.survivorId === y.id)
			return {
				kind: "merged",
				source: { id: x.id, name: x.displayName },
				survivor: { id: y.id, name: y.displayName },
			};
	if (a.lifecycle.state !== "live" || b.lifecycle.state !== "live") return { kind: "unavailable" };

	const explicit = q.keep === a.id || q.keep === b.id ? q.keep : null;
	const first = explicit ?? defaultSurvivor({ ...a, linked: false }, { ...b, linked: false });
	const order = (survivor: string) =>
		survivor === a.id ? { sourceId: b.id, survivorId: a.id } : { sourceId: a.id, survivorId: b.id };
	let r = await peopleMerge.getMergeReview(tx, ctx, order(first));
	if (r.status !== "ok") return { kind: "unavailable" };
	// The linked person must survive: without an explicit choice, open the review the merge can actually run.
	if (!explicit && r.value.source.linkedAccount && !r.value.survivor.linkedAccount) {
		r = await peopleMerge.getMergeReview(tx, ctx, order(r.value.source.personId));
		if (r.status !== "ok") return { kind: "unavailable" };
	}
	const review = r.value;
	const differs = (f: MergeField) => review.fields.find((x) => x.field === f);

	const households: Households = {};
	const household = differs("household");
	if (household)
		for (const v of [household.source, household.survivor] as Record<string, unknown>[]) {
			const id = typeof v.household_id === "string" ? v.household_id : null;
			if (!id) continue;
			const h = await personFields.getHousehold(tx, ctx, { householdId: id });
			if (h.status === "ok" && h.value.status === "available") households[id] = h.value.household.name;
		}
	const photos: Photos = {};
	const photo = differs("photo");
	if (photo)
		for (const side of ["source", "survivor"] as const) {
			if (fieldText("photo", photo[side] as Record<string, unknown>) === null) continue;
			const p = await personFields.getPersonPhoto(tx, ctx, { personId: review[side].personId });
			if (p.status === "ok" && p.value.status === "available")
				photos[side] = `/people/${p.value.personId}/photo/${p.value.versionId}`;
		}
	return { kind: "ready", review, households, photos, added: { [a.id]: a.createdAt, [b.id]: b.createdAt } };
}

/** Duplicate hints for one live plant person (REQ-PPL-016), read with the person page. Hints only. */
export type DuplicateHints = z.infer<typeof c.duplicateHints>;

/** The Unmerge preview with both people's names, in one transaction. */
export async function readUnmerge(tx: Transaction, ctx: PeopleContext, mergeId: string) {
	const r = await peopleUnmerge.previewUnmerge(tx, ctx, { mergeId });
	if (r.status !== "ok") return r;
	const name = async (personId: PersonId) =>
		available(await peopleReader.getPerson(tx, ctx, { personId }))?.displayName;
	const source = await name(r.value.sourceId);
	const survivor = await name(r.value.survivorId);
	return {
		status: "ok" as const,
		value: { preview: r.value, names: { source: source ?? "The other person", survivor: survivor ?? "This person" } },
	};
}
export type UnmergeView = Extract<Awaited<ReturnType<typeof readUnmerge>>, { status: "ok" }>["value"];

/**
 * Everything the correction dialog shows for one person, in one transaction: their assessments, interviews and cards
 * (latest first, the first 100 of each) and every correction already made to them.
 */
export async function readRecords(tx: Transaction, ctx: PeopleContext, personId: PersonId) {
	const request = { personId, limit: 100 };
	const a = await assessments.getAssessments(tx, ctx, request);
	if (a.status !== "ok") return a;
	const i = await interviews.getInterviews(tx, ctx, request);
	if (i.status !== "ok") return i;
	const m = await commitments.getCommitments(tx, ctx, request);
	if (m.status !== "ok") return m;
	const x = await recordCorrections.listRecordCorrections(tx, ctx, request);
	if (x.status !== "ok") return x;
	return {
		status: "ok" as const,
		value: {
			assessments: a.value.items,
			interviews: i.value.items,
			commitments: m.value.items,
			corrections: x.value.items,
			partial: Boolean(a.value.next || i.value.next || m.value.next || x.value.next),
		},
	};
}
export type Records = Extract<Awaited<ReturnType<typeof readRecords>>, { status: "ok" }>["value"];
