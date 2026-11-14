"use server";

import { pipelinePeopleRead, pipelinePeopleWrite, pipelineWrite } from "@/server/organizations/pipeline";
import { pipelineDataWriter } from "@everyfield/domain/organizations";
import { peopleMerge, peopleUnmerge } from "@everyfield/domain/people";

// Server actions behind removal on request and the duplicate review (REQ-MUL-005, -017). Each one rebuilds the request
// actor; the producers parse the input and recheck the Owner or Admin seat inside their own statements.

/** Removes one pipeline person on their request; the answer is the report of what was removed and kept. */
export async function removePerson(input: unknown) {
	return pipelineWrite((db, authority) => pipelineDataWriter.removePerson(db, authority, input));
}

/** The merge review for one order of a pair: what differs, what moves and anything that blocks it. */
export async function reviewMerge(input: unknown) {
	return pipelinePeopleRead((tx, ctx) => peopleMerge.getMergeReview(tx, ctx, input));
}

/** Merges the reviewed source into the reviewed survivor with the reviewer's field choices. */
export async function mergePeople(input: unknown) {
	return pipelinePeopleWrite((tx, ctx) => peopleMerge.mergePeople(tx, ctx, input));
}

/** Undoes a merge, only while nothing has changed since it (the producer compares the exact reviewed state). */
export async function undoMerge(requestKey: string, mergeId: string) {
	const preview = await pipelinePeopleRead((tx, ctx) => peopleUnmerge.previewUnmerge(tx, ctx, { mergeId }));
	if (preview.status !== "ok") return preview;
	return pipelinePeopleWrite((tx, ctx) =>
		peopleUnmerge.unmergePeople(tx, ctx, {
			requestKey,
			expectedRevision: preview.value.reviewRevision,
			input: { mergeId },
		}),
	);
}
