"use server";

import {
	loadPipelineBoard,
	loadPipelineGoals,
	loadPipelinePerson,
	pipelineActor,
	pipelineWrite,
} from "@/server/organizations/pipeline";
import { pipelineWriter } from "@everyfield/domain/organizations";

// Server actions behind the Pipeline page and a person's record. Each one rebuilds the request actor; the domain
// parses the input and rechecks the seat. A write's answer is its result or refusal; the screen then reads again only
// the part that changed (the record, or the board after a stage edit).

export async function addPerson(input: unknown) {
	return pipelineWrite((db, authority) => pipelineWriter.addPerson(db, authority, input));
}
export async function editPerson(input: unknown) {
	return pipelineWrite((db, authority) => pipelineWriter.editPerson(db, authority, input));
}
export async function movePerson(input: unknown) {
	return pipelineWrite((db, authority) => pipelineWriter.movePerson(db, authority, input));
}
export async function recordAssessment(input: unknown) {
	return pipelineWrite((db, authority) => pipelineWriter.recordAssessment(db, authority, input));
}
export async function retirePerson(input: unknown) {
	return pipelineWrite((db, authority) => pipelineWriter.retirePerson(db, authority, input));
}
export async function restorePerson(input: unknown) {
	return pipelineWrite((db, authority) => pipelineWriter.restorePerson(db, authority, input));
}
export async function saveStages(input: unknown) {
	return pipelineWrite((db, authority) => pipelineWriter.saveStages(db, authority, input));
}
export async function addNote(input: unknown) {
	return pipelineWrite((db, authority) => pipelineWriter.addNote(db, authority, input));
}
export async function editNote(input: unknown) {
	return pipelineWrite((db, authority) => pipelineWriter.editNote(db, authority, input));
}
export async function removeNote(input: unknown) {
	return pipelineWrite((db, authority) => pipelineWriter.removeNote(db, authority, input));
}
export async function saveGoal(input: unknown) {
	return pipelineWrite((db, authority) => pipelineWriter.saveGoal(db, authority, input));
}
export async function logConversation(input: unknown) {
	return pipelineWrite((db, authority) => pipelineWriter.logConversation(db, authority, input));
}
export async function correctConversation(input: unknown) {
	return pipelineWrite((db, authority) => pipelineWriter.correctConversation(db, authority, input));
}

/** The goals area again, after a goal is saved. */
export async function readGoals() {
	const who = await pipelineActor();
	if (who.kind !== "seat") return { status: "refused", refusal: { code: "unavailable" } } as const;
	return loadPipelineGoals(who.authority);
}

/** The board again under the same filters, after a change that reshapes it. */
export async function readBoard(query: unknown) {
	const who = await pipelineActor();
	if (who.kind !== "seat") return { status: "refused", refusal: { code: "unavailable" } } as const;
	return loadPipelineBoard(who.authority, query);
}

/** One person's record again, after a change to it. */
export async function readPerson(personId: string) {
	const who = await pipelineActor();
	if (who.kind !== "seat") return { status: "refused", refusal: { code: "unavailable" } } as const;
	return loadPipelinePerson(who.authority, personId);
}
