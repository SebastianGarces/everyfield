"use server";

import { pipelinePeopleRead, pipelinePeopleWrite, pipelineWrite } from "@/server/organizations/pipeline";
import { pipelineDataWriter } from "@everyfield/domain/organizations";
import { peopleMerge, peopleUnmerge } from "@everyfield/domain/people";

export async function removePerson(input: unknown) {
	return pipelineWrite((db, authority) => pipelineDataWriter.removePerson(db, authority, input));
}

export async function reviewMerge(input: unknown) {
	return pipelinePeopleRead((tx, ctx) => peopleMerge.getMergeReview(tx, ctx, input));
}

export async function mergePeople(input: unknown) {
	return pipelinePeopleWrite((tx, ctx) => peopleMerge.mergePeople(tx, ctx, input));
}

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
