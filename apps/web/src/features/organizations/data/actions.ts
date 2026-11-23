"use server";

import { pipelinePeopleWrite, pipelineWrite } from "../pipeline-mount";
import { pipelineDataWriter } from "@everyfield/domain/organizations";
import { peopleMerge, peopleUnmerge } from "@everyfield/domain/people";

export async function removePerson(input: unknown) {
	return pipelineWrite((db, authority) => pipelineDataWriter.removePerson(db, authority, input));
}

export async function mergePeople(input: unknown) {
	return pipelinePeopleWrite((tx, ctx) => peopleMerge.mergePeople(tx, ctx, input));
}

export async function undoMerge(request: unknown) {
	return pipelinePeopleWrite((tx, ctx) => peopleUnmerge.unmergePeople(tx, ctx, request));
}
