"use server";

import {
	loadPipelineBoard,
	loadPipelineGoals,
	loadPipelinePerson,
	pipelineActor,
	pipelineWrite,
} from "../pipeline-mount";
import { invitationService } from "@/server/invitations";
import { pipelineWriter, reviewWriter } from "@everyfield/domain/organizations";
import { answer, refused, type Reply } from "../../identity/server";

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
export async function sendAnswers(input: unknown) {
	return pipelineWrite((db, authority) => reviewWriter.sendAnswers(db, authority, input));
}
export async function withdrawReview(input: unknown) {
	return pipelineWrite((db, authority) => reviewWriter.withdrawReview(db, authority, input));
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

export async function readGoals() {
	const who = await pipelineActor();
	if (who.kind !== "seat") return { status: "refused", refusal: { code: "unavailable" } } as const;
	return loadPipelineGoals(who.authority);
}

export async function readBoard(query: unknown) {
	const who = await pipelineActor();
	if (who.kind !== "seat") return { status: "refused", refusal: { code: "unavailable" } } as const;
	return loadPipelineBoard(who.authority, query);
}

export async function readPerson(personId: string) {
	const who = await pipelineActor();
	if (who.kind !== "seat") return { status: "refused", refusal: { code: "unavailable" } } as const;
	return loadPipelinePerson(who.authority, personId);
}

export async function runLinkInvitation(
	operation: "invite" | "resend" | "revoke",
	command: { requestKey: string; expectedRevision: string; input: Record<string, unknown> },
): Promise<Reply> {
	const who = await pipelineActor();
	const service = invitationService();
	if (who.kind !== "seat" || !service) return refused("unavailable");
	const organization = who.authority.actor.context.owner;
	if (operation === "invite")
		return answer(() =>
			service.inviteResident(who.authority, { ...command, input: { ...command.input, organization } }),
		);
	return answer(() => (operation === "resend" ? service.resend : service.revoke)(who.authority, command));
}
